import { postureGradeCheck } from "../config/governance.js";
import type { Posture } from "../config/posture.js";
import type { Check, CheckCode } from "../internals/verify.js";
import { MCP_SECRET_RULE, SECRET_RULE } from "../secrets/probes.js";
import { gradeTrustCheck } from "./grade.js";

/**
 * Scan's `detector.aih-trust-lint` reports Core's native security findings as
 * SARIF 2.1.0 bytes, one result per finding, in Core's own emission order:
 *
 * - `ruleId`: the Core check code (`trust.prompt-injection`, `secrets.plaintext-detected`, ...);
 * - `message.text`: the finding's detail, before any posture grading;
 * - the first location: the source-relative POSIX path and its 1-based start line;
 * - `fingerprints["aih-trust/v1"]`: Core's content fingerprint for the finding, which
 *   persisted trust acknowledgements are keyed on;
 * - `properties["aih-trust/v1"].mcpDescription` on a finding in an incoming MCP
 *   server description, whose location is `<config>#<map>.<server>.description`.
 *
 * The same run carries the per-file facts Core's third-party SARIF classification
 * reads instead of running any detection itself (`runs[0].properties` and
 * `runs[0].artifacts`, C2a §2.6).
 *
 * Core keeps the policy half: it names each check and grades it by posture exactly
 * as its native scan grades the same finding. The bytes are never trusted: an
 * unknown rule id, a missing field, a malformed fact or a path outside the source
 * root refuses the whole result. Nothing is read partially and nothing is coerced.
 */
export const TRUST_LINT_FINGERPRINT_KEY = "aih-trust/v1";

type TrustLintGrading = "trust" | "secrets" | "none";

interface TrustLintRule {
  readonly name: string;
  readonly grading: TrustLintGrading;
}

const trust = (name: CheckCode): TrustLintRule => ({ name, grading: "trust" });
const ungraded = (name: CheckCode): TrustLintRule => ({ name, grading: "none" });

/**
 * Every code the native scan can emit, with the grading Core's native scan applies
 * to it: lint and unpinned-dependency findings go through `gradeTrustCheck`,
 * manifest, typosquat, dependency-confusion and malicious-code findings are
 * emitted ungraded, and secrets are graded as the `secrets` control.
 */
const TRUST_LINT_RULES: ReadonlyMap<string, TrustLintRule> = new Map<string, TrustLintRule>([
  ["trust.prompt-injection", trust("trust.prompt-injection")],
  ["trust.external-egress", trust("trust.external-egress")],
  ["trust.hidden-unicode", trust("trust.hidden-unicode")],
  ["trust.visible-unicode", trust("trust.visible-unicode")],
  ["trust.unpinned-dependency", trust("trust.unpinned-dependency")],
  ["trust.auto-exec-hook", ungraded("trust.auto-exec-hook")],
  ["trust.permission-risk", ungraded("trust.permission-risk")],
  ["trust.typosquat", ungraded("trust.typosquat")],
  ["trust.dependency-confusion", ungraded("trust.dependency-confusion")],
  ["trust.malicious-code", ungraded("trust.malicious-code")],
  ["secrets.plaintext-detected", { name: SECRET_RULE, grading: "secrets" }],
  ["mcp.hardcoded-secret", { name: MCP_SECRET_RULE, grading: "secrets" }],
  ["mcp.config-invalid", { name: "mcp-config-invalid", grading: "secrets" }],
]);

/** Lint codes an MCP server description can carry (it is linted as a trust document). */
const MCP_DESCRIPTION_CODES: ReadonlySet<string> = new Set([
  "trust.prompt-injection",
  "trust.external-egress",
  "trust.hidden-unicode",
  "trust.visible-unicode",
]);

const MCP_SERVER_MAP_KEYS: ReadonlySet<string> = new Set(["mcpServers", "servers", "mcp"]);

/** The lint codes a file's `lintLines` fact may name (the prompt-injection corroboration). */
export type TrustLintLineCodeV1 = "trust.external-egress" | "trust.prompt-injection";

const LINT_LINE_CODES: readonly TrustLintLineCodeV1[] = [
  "trust.external-egress",
  "trust.prompt-injection",
];

const UNICODE_CATEGORIES: ReadonlySet<string> = new Set([
  "bidi-control",
  "homoglyph-confusable",
  "tag-character",
  "visible-typography",
  "zero-width",
]);

const REPOSITORY_LICENSE_FILES: ReadonlySet<string> = new Set([
  "LICENSE",
  "LICENSE.md",
  "LICENSE.txt",
  "COPYING",
]);

export interface UnicodeRiskV1 {
  readonly category:
    | "bidi-control"
    | "detector-reported-hidden-unicode"
    | "homoglyph-confusable"
    | "tag-character"
    | "visible-typography"
    | "zero-width";
  readonly code: Extract<CheckCode, "trust.hidden-unicode" | "trust.visible-unicode">;
  readonly reason: string;
}

/** What a third-party hidden-Unicode report means when Core has no reviewable evidence for it. */
export const DETECTOR_REPORTED_HIDDEN_UNICODE_RISK: UnicodeRiskV1 = Object.freeze({
  category: "detector-reported-hidden-unicode",
  code: "trust.hidden-unicode",
  reason: "detector reported hidden Unicode without reviewable visible-typography evidence",
});

/** One sealed file's classification facts, as Scan's trust lint states them. */
export type TrustLintArtifactFactsV1 =
  | { readonly unreadable: true }
  | {
      readonly unreadable: false;
      readonly strictUnicodeSurface: boolean;
      readonly legalText: boolean;
      readonly unicodeRisk: UnicodeRiskV1 | null;
      /** Line → the lint codes the whole-file lint reports on it. */
      readonly lintLines: ReadonlyMap<number, readonly TrustLintLineCodeV1[]>;
      readonly yr4CorepackIntegrityOnly: boolean;
    };

/** The facts Core's third-party classification reads, from one trust-lint run. */
export interface TrustLintFactsV1 {
  readonly trustDocumentCount: number;
  /** The first root-level license file Scan found, else null. */
  readonly repositoryLicenseFile: string | null;
  /** Every regular file in the sealed tree, skip directories included, by source-relative path. */
  readonly artifacts: ReadonlyMap<string, TrustLintArtifactFactsV1>;
}

/** The server an MCP-description finding was linted from; `server` is the raw map key. */
export interface TrustLintMcpDescriptionV1 {
  readonly configPath: string;
  readonly mapKey: "mcpServers" | "servers" | "mcp";
  readonly server: string;
}

export interface TrustLintCheckV1 {
  readonly check: Check;
  readonly mcpDescription?: TrustLintMcpDescriptionV1;
}

export type TrustLintSarifMappingV1 =
  | { readonly checks: TrustLintCheckV1[]; readonly facts: TrustLintFactsV1 }
  | { readonly refusal: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Refusal text reaches a report, so bound it and keep control characters out. */
function shown(value: unknown): string {
  const text = typeof value === "string" ? value : (JSON.stringify(value) ?? String(value));
  const visible = text.replace(/[\p{C}]/gu, " ");
  return visible.length > 120 ? `${visible.slice(0, 117)}...` : visible;
}

/**
 * A SARIF artifact URI that names a path under the declared source root, in POSIX
 * form, as C2 requires of every URI Scan returns.
 */
export function isSourceRelativeSarifUriV1(uri: string): boolean {
  if (uri.length === 0 || uri.includes("\\") || uri.startsWith("/")) return false;
  // A drive letter, a URL (file:///..., https://...) or a file: URI never names a source path.
  if (/^[A-Za-z]:/.test(uri) || /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(uri) || /^file:/i.test(uri))
    return false;
  return !uri.split("/").some((part) => part === ".." || part === "." || part.length === 0);
}

/** An MCP server name as it appears in a description's pseudo path. */
export function safeMcpName(name: string): string {
  const safe = name.replace(/[^A-Za-z0-9._-]/g, "_");
  return safe.length > 0 ? safe : "server";
}

function gradeTrustLintCheck(check: Check, grading: TrustLintGrading, posture: Posture): Check {
  if (grading === "trust") return gradeTrustCheck(check, posture);
  if (grading === "secrets") return postureGradeCheck(check, "secrets", posture);
  return check;
}

type Mapped<T> = { readonly value: T } | { readonly refusal: string };

function mcpDescriptionOf(
  result: Record<string, unknown>,
  ruleId: string,
  uri: string,
  mcpConfigPaths: ReadonlySet<string>,
): Mapped<TrustLintMcpDescriptionV1 | undefined> {
  const properties = isRecord(result.properties)
    ? result.properties[TRUST_LINT_FINGERPRINT_KEY]
    : undefined;
  const description = isRecord(properties) ? properties.mcpDescription : undefined;
  if (description === undefined) {
    // A declared config's "#" pseudo path names a server description and nothing else.
    const pseudo = [...mcpConfigPaths].some((path) => uri.startsWith(`${path}#`));
    return pseudo || !isSourceRelativeSarifUriV1(uri)
      ? { refusal: `has no source-relative location: ${shown(uri)}` }
      : { value: undefined };
  }
  if (!isRecord(description)) return { refusal: "has a malformed mcpDescription property" };
  const { configPath, mapKey, server } = description;
  if (
    typeof configPath !== "string" ||
    !mcpConfigPaths.has(configPath) ||
    typeof mapKey !== "string" ||
    !MCP_SERVER_MAP_KEYS.has(mapKey) ||
    typeof server !== "string"
  )
    return { refusal: `names an undeclared MCP server description: ${shown(description)}` };
  if (!MCP_DESCRIPTION_CODES.has(ruleId))
    return { refusal: `reports ${shown(ruleId)} on an MCP server description` };
  if (uri !== `${configPath}#${mapKey}.${safeMcpName(server)}.description`)
    return {
      refusal: `has an MCP description location that does not name its server: ${shown(uri)}`,
    };
  return {
    value: { configPath, mapKey: mapKey as TrustLintMcpDescriptionV1["mapKey"], server },
  };
}

function mapResult(
  result: unknown,
  index: number,
  posture: Posture,
  mcpConfigPaths: ReadonlySet<string>,
): Mapped<TrustLintCheckV1> {
  const at = `result ${index}`;
  if (!isRecord(result)) return { refusal: `${at} is not an object` };
  const ruleId = result.ruleId;
  if (typeof ruleId !== "string") return { refusal: `${at} has no rule id` };
  const rule = TRUST_LINT_RULES.get(ruleId);
  if (rule === undefined) return { refusal: `${at} has unknown rule id ${shown(ruleId)}` };
  const message = isRecord(result.message) ? result.message.text : undefined;
  if (typeof message !== "string" || message.length === 0)
    return { refusal: `${at} (${ruleId}) has no message text` };
  const locations = result.locations;
  const physical =
    Array.isArray(locations) && isRecord(locations[0]) && isRecord(locations[0].physicalLocation)
      ? locations[0].physicalLocation
      : undefined;
  const uri = isRecord(physical?.artifactLocation) ? physical.artifactLocation.uri : undefined;
  if (typeof uri !== "string")
    return { refusal: `${at} (${ruleId}) has no source-relative location: ${shown(uri)}` };
  const mcpDescription = mcpDescriptionOf(result, ruleId, uri, mcpConfigPaths);
  if ("refusal" in mcpDescription)
    return { refusal: `${at} (${ruleId}) ${mcpDescription.refusal}` };
  const startLine = isRecord(physical?.region) ? physical.region.startLine : undefined;
  if (typeof startLine !== "number" || !Number.isSafeInteger(startLine) || startLine < 1)
    return { refusal: `${at} (${ruleId}) has no 1-based start line` };
  const fingerprint = isRecord(result.fingerprints)
    ? result.fingerprints[TRUST_LINT_FINGERPRINT_KEY]
    : undefined;
  if (typeof fingerprint !== "string" || fingerprint.length === 0)
    return { refusal: `${at} (${ruleId}) has no ${TRUST_LINT_FINGERPRINT_KEY} fingerprint` };
  const check: Check = {
    name: rule.name,
    verdict: "fail",
    detail: message,
    code: ruleId as CheckCode,
    location: { uri, startLine },
    fingerprint,
  };
  const graded = gradeTrustLintCheck(check, rule.grading, posture);
  return {
    value:
      mcpDescription.value === undefined
        ? { check: graded }
        : { check: graded, mcpDescription: mcpDescription.value },
  };
}

function runFacts(run: Record<string, unknown>): Mapped<Omit<TrustLintFactsV1, "artifacts">> {
  const properties = isRecord(run.properties)
    ? run.properties[TRUST_LINT_FINGERPRINT_KEY]
    : undefined;
  if (
    !isRecord(properties) ||
    properties.format !== "aih-trust-lint-facts" ||
    properties.version !== 1
  )
    return { refusal: "run carries no aih-trust-lint-facts version 1" };
  const { trustDocumentCount, repositoryLicenseFile } = properties;
  if (
    typeof trustDocumentCount !== "number" ||
    !Number.isSafeInteger(trustDocumentCount) ||
    trustDocumentCount < 0
  )
    return { refusal: "run facts have no trust document count" };
  if (
    repositoryLicenseFile !== null &&
    (typeof repositoryLicenseFile !== "string" ||
      !REPOSITORY_LICENSE_FILES.has(repositoryLicenseFile))
  )
    return { refusal: `run facts name license file ${shown(repositoryLicenseFile)}` };
  return { value: { trustDocumentCount, repositoryLicenseFile } };
}

function unicodeRiskFact(value: unknown): Mapped<UnicodeRiskV1 | null> {
  if (value === null) return { value: null };
  if (
    !isRecord(value) ||
    typeof value.category !== "string" ||
    !UNICODE_CATEGORIES.has(value.category) ||
    (value.code !== "trust.hidden-unicode" && value.code !== "trust.visible-unicode") ||
    typeof value.reason !== "string" ||
    value.reason.length === 0
  )
    return { refusal: `malformed unicodeRisk ${shown(value)}` };
  return {
    value: {
      category: value.category as UnicodeRiskV1["category"],
      code: value.code,
      reason: value.reason,
    },
  };
}

function lintLinesFact(value: unknown): Mapped<Map<number, readonly TrustLintLineCodeV1[]>> {
  if (!Array.isArray(value)) return { refusal: "lintLines is not a list" };
  const lines = new Map<number, readonly TrustLintLineCodeV1[]>();
  for (const entry of value) {
    const line = isRecord(entry) ? entry.line : undefined;
    const codes = isRecord(entry) ? entry.codes : undefined;
    if (typeof line !== "number" || !Number.isSafeInteger(line) || line < 1 || lines.has(line))
      return { refusal: `lintLines has a malformed or repeated line ${shown(line)}` };
    if (
      !Array.isArray(codes) ||
      codes.length === 0 ||
      new Set(codes).size !== codes.length ||
      codes.some((code) => !LINT_LINE_CODES.includes(code as TrustLintLineCodeV1))
    )
      return { refusal: `lintLines line ${line} has malformed codes ${shown(codes)}` };
    lines.set(line, codes as TrustLintLineCodeV1[]);
  }
  return { value: lines };
}

function artifactFacts(value: unknown): Mapped<TrustLintArtifactFactsV1> {
  if (!isRecord(value)) return { refusal: "has no aih-trust/v1 facts" };
  if (value.unreadable === true) {
    return Object.keys(value).length === 1
      ? { value: { unreadable: true } }
      : { refusal: "is unreadable yet carries facts" };
  }
  const { strictUnicodeSurface, legalText, yr4CorepackIntegrityOnly } = value;
  if (typeof strictUnicodeSurface !== "boolean" || typeof legalText !== "boolean")
    return { refusal: "has malformed surface facts" };
  if (yr4CorepackIntegrityOnly !== undefined && yr4CorepackIntegrityOnly !== true)
    return { refusal: "has a malformed yr4CorepackIntegrityOnly fact" };
  const unicodeRisk = unicodeRiskFact(value.unicodeRisk);
  if ("refusal" in unicodeRisk) return unicodeRisk;
  const lintLines = lintLinesFact(value.lintLines);
  if ("refusal" in lintLines) return lintLines;
  return {
    value: {
      unreadable: false,
      strictUnicodeSurface,
      legalText,
      unicodeRisk: unicodeRisk.value,
      lintLines: lintLines.value,
      yr4CorepackIntegrityOnly: yr4CorepackIntegrityOnly === true,
    },
  };
}

function artifactsOf(run: Record<string, unknown>): Mapped<Map<string, TrustLintArtifactFactsV1>> {
  const artifacts = run.artifacts ?? [];
  if (!Array.isArray(artifacts)) return { refusal: "run artifacts are not a list" };
  const byUri = new Map<string, TrustLintArtifactFactsV1>();
  for (const [index, artifact] of artifacts.entries()) {
    const uri =
      isRecord(artifact) && isRecord(artifact.location) ? artifact.location.uri : undefined;
    if (typeof uri !== "string" || !isSourceRelativeSarifUriV1(uri) || byUri.has(uri))
      return { refusal: `artifact ${index} has no unique source-relative uri: ${shown(uri)}` };
    const properties =
      isRecord(artifact) && isRecord(artifact.properties) ? artifact.properties : {};
    const facts = artifactFacts(properties[TRUST_LINT_FINGERPRINT_KEY]);
    if ("refusal" in facts) return { refusal: `artifact ${shown(uri)} ${facts.refusal}` };
    byUri.set(uri, facts.value);
  }
  return { value: byUri };
}

/**
 * Scan's native-finding SARIF as Core's graded native checks plus the facts
 * Core's third-party classification reads, or why it was refused.
 * `mcpConfigPaths` are the incoming MCP configs Core declared in the request; a
 * description finding may name only those.
 */
export function trustLintChecksFromSarifV1(
  sarif: string,
  posture: Posture,
  mcpConfigPaths: readonly string[] = [],
): TrustLintSarifMappingV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(sarif);
  } catch {
    return { refusal: "detector.aih-trust-lint returned bytes that are not JSON" };
  }
  if (!isRecord(parsed) || parsed.version !== "2.1.0" || !Array.isArray(parsed.runs))
    return { refusal: "detector.aih-trust-lint returned JSON that is not a SARIF 2.1.0 log" };
  const [run] = parsed.runs;
  if (parsed.runs.length !== 1 || !isRecord(run))
    return { refusal: "detector.aih-trust-lint returned other than exactly one run" };
  const facts = runFacts(run);
  if ("refusal" in facts) return { refusal: `detector.aih-trust-lint ${facts.refusal}` };
  const artifacts = artifactsOf(run);
  if ("refusal" in artifacts) return { refusal: `detector.aih-trust-lint ${artifacts.refusal}` };
  const results = run.results ?? [];
  if (!Array.isArray(results))
    return { refusal: "detector.aih-trust-lint returned a run whose results are not a list" };
  const declared = new Set(mcpConfigPaths);
  const checks: TrustLintCheckV1[] = [];
  for (const [index, result] of results.entries()) {
    const mapped = mapResult(result, index, posture, declared);
    if ("refusal" in mapped) return { refusal: `detector.aih-trust-lint SARIF ${mapped.refusal}` };
    checks.push(mapped.value);
  }
  return { checks, facts: { ...facts.value, artifacts: artifacts.value } };
}
