import { createHash } from "node:crypto";
import { z } from "zod";
import { type CapabilityId, CapabilityIdSchema } from "../capability/id.js";
import { ChangeProfileInputError, type ChangeProfileInputIssue } from "../errors.js";
import {
  CHANGE_PROFILE_RULE_TABLE_VERSION,
  CHANGE_PROFILE_RULES,
  type ChangeProfileCategory,
} from "./change-profile-rules.js";

export const CHANGE_PROFILE_SCHEMA_VERSION = 1 as const;
export const CHANGE_PROFILE_CLASSIFIER_VERSION = "1.0.0" as const;
export const MAX_CHANGE_PROFILE_CHANGES = 10_000;
export const MAX_CHANGE_PROFILE_TEXT_BYTES = 262_144;
export const MAX_CHANGE_PROFILE_TOTAL_TEXT_BYTES = 16_777_216;

const TextFactSchema = z
  .object({ kind: z.literal("text"), text: z.string(), byteLength: z.number() })
  .strict();
const SafeSignalSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/);
const ContentFactSchema = z.discriminatedUnion("kind", [
  TextFactSchema,
  z.object({ kind: z.literal("binary"), byteLength: z.number() }).strict(),
  z.object({ kind: z.literal("submodule"), revision: z.string() }).strict(),
  z.object({ kind: z.literal("unreadable"), reason: SafeSignalSchema }).strict(),
  z.object({ kind: z.literal("oversized"), byteLength: z.number() }).strict(),
  z.object({ kind: z.literal("unknown"), code: SafeSignalSchema }).strict(),
]);
export const ChangeFactSchema = z
  .object({
    scope: z.enum(["staged", "unstaged", "untracked"]),
    status: z.enum(["added", "modified", "deleted", "renamed"]),
    path: z.string(),
    previousPath: z.string().nullable(),
    before: ContentFactSchema.nullable(),
    after: ContentFactSchema.nullable(),
    beforeRevision: z.string().optional(),
    afterRevision: z.string().optional(),
  })
  .strict();
export const ChangeProfileInputSchema = z
  .object({
    schemaVersion: z.literal(1),
    source: z.enum(["diff", "worktree"]),
    expectRuleTableVersion: z.literal(CHANGE_PROFILE_RULE_TABLE_VERSION).optional(),
    changes: z.array(ChangeFactSchema).min(1).max(MAX_CHANGE_PROFILE_CHANGES),
  })
  .strict();

export type ContentFact = z.infer<typeof ContentFactSchema>;
export type ChangeFact = z.infer<typeof ChangeFactSchema>;
export type ChangeProfileInput = z.infer<typeof ChangeProfileInputSchema>;

export interface ChangeProfileEvidence {
  ruleId: CapabilityId;
  path: string;
  side: "before" | "after" | "change";
  signal: string;
}
export interface ChangeProfileReason {
  ruleId: CapabilityId;
  scope: ChangeFact["scope"];
  path: string;
  side: ChangeProfileEvidence["side"];
  signal: string;
}
export interface ChangeProfileItem {
  id: CapabilityId;
  reasons: ChangeProfileReason[];
  evidence: ChangeProfileEvidence[];
}
export interface ChangeProfile {
  schemaVersion: 1;
  classifierVersion: typeof CHANGE_PROFILE_CLASSIFIER_VERSION;
  ruleTableVersion: typeof CHANGE_PROFILE_RULE_TABLE_VERSION;
  inputIdentity: string;
  baseline: ChangeProfileItem[];
  overlays: ChangeProfileItem[];
  triggers: ChangeProfileItem[];
  exclusions: ChangeProfileItem[];
  escalations: ChangeProfileItem[];
}

const codeUnitCompare = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const scopeRank = { staged: 0, unstaged: 1, untracked: 2 } as const;
const sideRank = { before: 0, after: 1, change: 2 } as const;
const ordinal = new Map(CHANGE_PROFILE_RULES.map((rule) => [rule.id, rule.ordinal]));

function issueCompare(a: ChangeProfileInputIssue, b: ChangeProfileInputIssue): number {
  return codeUnitCompare(a.issueCode, b.issueCode) || codeUnitCompare(a.path, b.path);
}
function validUnicode(value: string): boolean {
  if (value.includes("\0")) return false;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}
function unsafePathCharacter(character: string): boolean {
  const codePoint = character.codePointAt(0) ?? 0;
  return (
    codePoint <= 0x1f ||
    (codePoint >= 0x7f && codePoint <= 0x9f) ||
    codePoint === 0x061c ||
    codePoint === 0x200e ||
    codePoint === 0x200f ||
    (codePoint >= 0x202a && codePoint <= 0x202e) ||
    (codePoint >= 0x2066 && codePoint <= 0x2069)
  );
}
function validPath(path: string): boolean {
  return (
    validUnicode(path) &&
    path.length > 0 &&
    path === path.trim() &&
    ![...path].some(unsafePathCharacter) &&
    !path.includes("\\") &&
    !path.startsWith("/") &&
    !/^[A-Za-z]:/.test(path) &&
    path.split("/").every((part) => part !== "" && part !== "." && part !== "..")
  );
}
function deniedPath(path: string): boolean {
  if (path === "secrets" || path.startsWith("secrets/")) return true;
  const base = path.split("/").at(-1) ?? "";
  return (
    (base === ".env" || base.startsWith(".env.")) &&
    !base.endsWith(".example") &&
    !base.endsWith(".sample")
  );
}
function unavailablePolicyFact(fact: ContentFact | null): boolean {
  return fact === null || (fact.kind === "unreadable" && fact.reason === "policy-denied");
}
function addIssue(issues: ChangeProfileInputIssue[], issueCode: string, path: string): void {
  issues.push({ issueCode, path });
}

function validateInput(value: unknown): ChangeProfileInput {
  const parsed = ChangeProfileInputSchema.safeParse(value);
  const issues: ChangeProfileInputIssue[] = [];
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const path = issue.path.map(String).join(".");
      let code = "input.invalid";
      if (issue.code === "unrecognized_keys") code = "input.unknown-key";
      else if (path === "schemaVersion") code = "input.schema-version";
      else if (path === "source") code = "input.source";
      else if (path === "expectRuleTableVersion") code = "input.rule-table-version";
      else if (path === "changes" && issue.code === "too_small") code = "changes.empty";
      else if (path === "changes" && issue.code === "too_big") code = "changes.too-many";
      else if (path.endsWith(".status")) code = "change.status";
      else if (path.endsWith(".scope")) code = "change.scope";
      else if (path.endsWith("Revision")) code = "change.revision";
      else if (/\.(?:before|after)(?:\.|$)/.test(path)) code = "content.invalid";
      else if (path.startsWith("changes.")) code = "change.invalid";
      addIssue(issues, code, path);
    }
    throw new ChangeProfileInputError(issues.sort(issueCompare));
  }
  const input = parsed.data;
  let totalTextBytes = 0;
  const factKeys = new Set<string>();
  const paths = new Map<string, ChangeFact[]>();
  for (const [index, change] of input.changes.entries()) {
    const base = `changes.${index}`;
    if (!validPath(change.path)) addIssue(issues, "change.path", `${base}.path`);
    if (change.previousPath !== null && !validPath(change.previousPath)) {
      addIssue(issues, "change.previous-path", `${base}.previousPath`);
    }
    if ((change.status === "renamed") !== (change.previousPath !== null)) {
      addIssue(issues, "change.previous-path", `${base}.previousPath`);
    }
    const revisionPattern = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
    if (change.beforeRevision !== undefined && !revisionPattern.test(change.beforeRevision)) {
      addIssue(issues, "change.revision", `${base}.beforeRevision`);
    }
    if (change.afterRevision !== undefined && !revisionPattern.test(change.afterRevision)) {
      addIssue(issues, "change.revision", `${base}.afterRevision`);
    }
    const sidesValid =
      (change.status === "added" && change.before === null && change.after !== null) ||
      (change.status === "deleted" && change.before !== null && change.after === null) ||
      ((change.status === "modified" || change.status === "renamed") &&
        change.before !== null &&
        change.after !== null);
    if (!sidesValid) addIssue(issues, "change.sides", base);
    if (input.source === "diff" && change.scope === "untracked") {
      addIssue(issues, "change.diff-untracked", base);
    }
    if (change.scope === "untracked" && change.status !== "added") {
      addIssue(issues, "change.untracked-status", base);
    }
    if (
      deniedPath(change.path) &&
      (!unavailablePolicyFact(change.before) || !unavailablePolicyFact(change.after))
    ) {
      addIssue(issues, "content.denied-path", base);
    }
    if (
      change.previousPath !== null &&
      deniedPath(change.previousPath) &&
      !unavailablePolicyFact(change.before)
    ) {
      addIssue(issues, "content.denied-path", base);
    }
    for (const [side, fact] of [
      ["before", change.before],
      ["after", change.after],
    ] as const) {
      if (fact === null) continue;
      if ("byteLength" in fact && (!Number.isSafeInteger(fact.byteLength) || fact.byteLength < 0)) {
        addIssue(issues, "content.byte-length", `${base}.${side}.byteLength`);
      }
      if (fact.kind === "text") {
        const actual = Buffer.byteLength(fact.text, "utf8");
        totalTextBytes += actual;
        if (!validUnicode(fact.text)) addIssue(issues, "content.unicode", `${base}.${side}.text`);
        if (fact.byteLength !== actual)
          addIssue(issues, "content.byte-length", `${base}.${side}.byteLength`);
        if (actual > MAX_CHANGE_PROFILE_TEXT_BYTES)
          addIssue(issues, "content.too-large", `${base}.${side}`);
      }
      if (fact.kind === "submodule" && !revisionPattern.test(fact.revision)) {
        addIssue(issues, "content.revision", `${base}.${side}.revision`);
      }
    }
    const key = canonicalJson(change);
    if (factKeys.has(key)) addIssue(issues, "change.duplicate", base);
    factKeys.add(key);
    const samePath = paths.get(change.path) ?? [];
    samePath.push(change);
    paths.set(change.path, samePath);
  }
  if (totalTextBytes > MAX_CHANGE_PROFILE_TOTAL_TEXT_BYTES) {
    addIssue(issues, "content.total-too-large", "changes");
  }
  for (const facts of paths.values()) {
    if (facts.length < 2) continue;
    const allowed =
      facts.length === 2 &&
      facts.some((fact) => fact.scope === "staged" && fact.status === "deleted") &&
      facts.some((fact) => fact.scope === "untracked" && fact.status === "added");
    if (!allowed) {
      for (const fact of facts) addIssue(issues, "change.conflict", fact.path);
    }
  }
  if (issues.length > 0) throw new ChangeProfileInputError(issues.sort(issueCompare));
  return input;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort(codeUnitCompare)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}
function canonicalInput(input: ChangeProfileInput): string {
  const changes = input.changes
    .map((change) => {
      const value = {
        scope: change.scope,
        status: change.status,
        path: change.path,
        previousPath: change.previousPath,
        before: change.before,
        after: change.after,
        ...(change.beforeRevision === undefined ? {} : { beforeRevision: change.beforeRevision }),
        ...(change.afterRevision === undefined ? {} : { afterRevision: change.afterRevision }),
      };
      return { key: canonicalJson(value), value };
    })
    .sort((a, b) => codeUnitCompare(a.key, b.key))
    .map(({ value }) => value);
  return canonicalJson({
    schemaVersion: input.schemaVersion,
    source: input.source,
    ...(input.expectRuleTableVersion === undefined
      ? {}
      : { expectRuleTableVersion: input.expectRuleTableVersion }),
    changes,
  });
}

type Accumulator = Map<string, { category: ChangeProfileCategory; reasons: ChangeProfileReason[] }>;
function emit(
  acc: Accumulator,
  id: string,
  fact: Pick<ChangeFact, "scope" | "path">,
  signal: string,
  side: ChangeProfileEvidence["side"] = "change",
): void {
  const rule = CHANGE_PROFILE_RULES.find((candidate) => candidate.id === id);
  if (!rule) throw new Error(`unknown change-profile rule: ${id}`);
  CapabilityIdSchema.parse(id);
  const entry = acc.get(id) ?? { category: rule.category, reasons: [] };
  entry.reasons.push({ ruleId: id, scope: fact.scope, path: fact.path, side, signal });
  acc.set(id, entry);
}
function textSides(fact: ChangeFact): Array<["before" | "after", string]> {
  const sides: Array<["before" | "after", string]> = [];
  if (fact.before?.kind === "text") sides.push(["before", fact.before.text]);
  if (fact.after?.kind === "text") sides.push(["after", fact.after.text]);
  return sides;
}
function plainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function dependencyNames(value: unknown): Set<string> | null {
  if (!plainObject(value)) return null;
  const pkg = value as Record<string, unknown>;
  for (const field of ["dependencies", "devDependencies"]) {
    if (Object.hasOwn(pkg, field) && !plainObject(pkg[field])) return null;
  }
  const names = new Set<string>();
  for (const field of [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ]) {
    const section = pkg[field];
    if (plainObject(section)) {
      for (const name of Object.keys(section)) names.add(name);
    }
  }
  return names;
}

export function classifyChangeProfile(value: unknown): ChangeProfile {
  const input = validateInput(value);
  const acc: Accumulator = new Map();
  const neutral = { scope: "staged" as const, path: "<change-set>" };
  emit(acc, "review.correctness", neutral, "baseline");
  emit(acc, "review.maintainability", neutral, "baseline");
  emit(acc, "review.verification", neutral, "baseline");
  const languageRules: Array<[RegExp, string]> = [
    [/\.(?:ts|tsx|mts|cts)$/, "language.typescript"],
    [/\.(?:js|jsx|mjs|cjs)$/, "language.javascript"],
    [/\.py$/, "language.python"],
    [/\.go$/, "language.go"],
    [/\.rs$/, "language.rust"],
    [/\.java$/, "language.java"],
    [/\.(?:cs|fs|vb)$/, "language.dotnet"],
  ];
  for (const fact of input.changes) {
    let matched = false;
    const emitFact = (
      id: string,
      signal: string,
      side: ChangeProfileEvidence["side"] = "change",
    ): void => {
      emit(acc, id, fact, signal, side);
      matched = true;
    };
    const lower = fact.path.toLowerCase();
    for (const [pattern, id] of languageRules)
      if (pattern.test(lower)) emitFact(id, "path-extension");
    if (/\.(?:tsx|jsx)$/.test(lower)) emitFact("risk.ui", "jsx-path");
    if (/(?:^|\/)(?:auth|security|crypto|permissions?)(?:\/|\.|$)/.test(lower))
      emitFact("risk.security", "security-path");
    if (deniedPath(fact.path)) emitFact("risk.security", "denied-path");
    if (
      /(?:^|\/)(?:package(?:-lock)?\.json|go\.(?:mod|sum)|cargo\.(?:toml|lock)|requirements[^/]*\.txt|pom\.xml)$/.test(
        lower,
      )
    )
      emitFact("risk.dependencies", "dependency-manifest");
    if (/(?:^|\/)(?:migrations?|schema|database|db)(?:\/|\.|$)|\.sql$/.test(lower))
      emitFact("risk.database", "database-path");
    if (
      /(?:^|\/)(?:infra|terraform|k8s|helm)(?:\/|\.|$)|\.(?:tf|tfvars)$/.test(lower) ||
      /^(?:cdk\.json|samconfig\.toml|serverless\.[^/]+)$/.test(lower)
    )
      emitFact("risk.infrastructure", "infrastructure-path");
    if (/(?:^|\/)(?:openapi|swagger|asyncapi)(?:\.|\/)|\.(?:proto|graphql)$/.test(lower))
      emitFact("risk.api-contract", "api-contract-path");
    if (/(?:^|\/)(?:\.github\/workflows|\.gitlab-ci|azure-pipelines)(?:\/|\.|$)/.test(lower))
      emitFact("risk.ci", "ci-path");
    if (/(?:^|\/)(?:readme|changelog|contributing)(?:\.|$)|\.(?:md|mdx|rst)$/.test(lower))
      emitFact("surface.documentation", "documentation-path");
    if (/(?:^|\/)(?:test|tests|spec|specs)(?:\/|\.|$)|\.(?:test|spec)\.[^.]+$/.test(lower))
      emitFact("surface.tests", "test-path");
    if (/\.(?:json|ya?ml|toml|ini|conf|config)$/.test(lower))
      emitFact("surface.configuration", "configuration-path");
    if (/(?:^|\/)scripts?\//.test(lower) || /\.(?:sh|ps1|bat|cmd)$/.test(lower))
      emitFact("surface.scripts", "script-path");
    if (lower === "cdk.json") emitFact("framework.aws-cdk", "exact-path");
    if (lower === "samconfig.toml") emitFact("framework.aws-sam", "exact-path");
    if (/^serverless\.[^/]+$/.test(lower)) emitFact("framework.serverless", "exact-path");
    for (const [side, raw] of textSides(fact)) {
      if (lower === "package.json") {
        try {
          const names = dependencyNames(JSON.parse(raw));
          if (names === null) {
            emitFact("manifest.malformed", "package-json-invalid", side);
            continue;
          }
          for (const [dependency, id] of [
            ["react", "framework.react"],
            ["vue", "framework.vue"],
            ["@angular/core", "framework.angular"],
            ["next", "framework.nextjs"],
            ["express", "framework.express"],
          ] as const)
            if (names.has(dependency)) emitFact(id, `package:${dependency}`, side);
        } catch {
          emitFact("manifest.malformed", "package-json-invalid", side);
        }
      }
      if (lower === "go.mod") {
        if (!/^\s*module\s+\S+/m.test(raw)) emitFact("manifest.malformed", "go-mod-invalid", side);
        else if (/^\s*(?:require\s+)?github\.com\/gin-gonic\/gin(?:\s|$)/m.test(raw))
          emitFact("framework.gin", "module:gin", side);
      }
    }
    for (const [side, content] of [
      ["before", fact.before],
      ["after", fact.after],
    ] as const) {
      if (content === null || content.kind === "text") continue;
      const id = {
        binary: "content.binary",
        submodule: "content.submodule-unclassified",
        unreadable: "content.unreadable",
        oversized: "content.oversized",
        unknown: "content.unknown",
      }[content.kind];
      emitFact(
        id,
        content.kind === "unreadable"
          ? `unreadable:${content.reason}`
          : content.kind === "unknown"
            ? `unknown:${content.code}`
            : content.kind,
        side,
      );
      if (content.kind === "submodule") emitFact("risk.dependencies", "submodule", side);
    }
    if (!matched && textSides(fact).length > 0)
      emit(acc, "surface.unknown", fact, "inspectable-text");
  }
  const uiFrameworks = new Set([
    "framework.react",
    "framework.vue",
    "framework.angular",
    "framework.nextjs",
  ]);
  if (![...acc.keys()].some((id) => uiFrameworks.has(id))) {
    for (const fact of input.changes.filter((item) => /\.(?:tsx|jsx)$/i.test(item.path)))
      emit(acc, "framework.ui-ambiguous", fact, "jsx-without-framework");
  }
  const risky = [...acc.keys()].some(
    (id) =>
      id.startsWith("risk.") ||
      id.startsWith("content.") ||
      id === "manifest.malformed" ||
      id === "framework.ui-ambiguous",
  );
  if (!risky) emit(acc, "review.architecture", neutral, "low-risk-default-exclusion");

  const categories: Record<ChangeProfileCategory, ChangeProfileItem[]> = {
    baseline: [],
    overlays: [],
    triggers: [],
    exclusions: [],
    escalations: [],
  };
  for (const [id, entry] of acc) {
    const unique = new Map(entry.reasons.map((reason) => [canonicalJson(reason), reason]));
    const reasons = [...unique.values()].sort(
      (a, b) =>
        (ordinal.get(a.ruleId) ?? 0) - (ordinal.get(b.ruleId) ?? 0) ||
        scopeRank[a.scope] - scopeRank[b.scope] ||
        codeUnitCompare(a.path, b.path) ||
        sideRank[a.side] - sideRank[b.side] ||
        codeUnitCompare(a.signal, b.signal),
    );
    const evidence = new Map(
      reasons.map(({ ruleId, path, side, signal }) => {
        const item = { ruleId, path, side, signal };
        return [canonicalJson(item), item];
      }),
    );
    categories[entry.category].push({
      id,
      reasons,
      evidence: [...evidence.values()],
    });
  }
  for (const items of Object.values(categories)) {
    items.sort(
      (a, b) => (ordinal.get(a.id) ?? 0) - (ordinal.get(b.id) ?? 0) || codeUnitCompare(a.id, b.id),
    );
  }
  return {
    schemaVersion: 1,
    classifierVersion: CHANGE_PROFILE_CLASSIFIER_VERSION,
    ruleTableVersion: CHANGE_PROFILE_RULE_TABLE_VERSION,
    inputIdentity: createHash("sha256").update(canonicalInput(input), "utf8").digest("hex"),
    baseline: categories.baseline,
    overlays: categories.overlays,
    triggers: categories.triggers,
    exclusions: categories.exclusions,
    escalations: categories.escalations,
  };
}

export function serializeChangeProfile(profile: ChangeProfile): string {
  return `${JSON.stringify(profile, null, 2)}\n`;
}
export function renderChangeProfile(profile: ChangeProfile): string {
  const line = (label: string, items: ChangeProfileItem[]) =>
    `${label}: ${items.length === 0 ? "none" : items.map((item) => item.id).join(", ")}`;
  return [
    `Change profile ${profile.classifierVersion} (${profile.inputIdentity})`,
    line("Baseline", profile.baseline),
    line("Overlays", profile.overlays),
    line("Triggers", profile.triggers),
    line("Exclusions", profile.exclusions),
    line("Escalations", profile.escalations),
  ].join("\n");
}
