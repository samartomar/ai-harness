import { createHash } from "node:crypto";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { TextDecoder } from "node:util";
import { controlMatrixClaimIds } from "../docs-lint/index.js";
import { AihError } from "../errors.js";
import { readRegularFile } from "../internals/fsxn.js";
import type { Action, CommandSpec, PlanContext } from "../internals/plan.js";
import { digest, plan, probeMany, writeJson, writeText } from "../internals/plan.js";
import { ensureTrailingNewline, jsonFile, lines } from "../internals/render.js";
import type { Check, CheckCode } from "../internals/verify.js";

export const SIDECAR_POINTER_FILE = ".aih-truth.json";
export const TRUTH_STATE_REL = join("truth", "state.json");
export const TRUTH_STAGING_DIR = join("truth", "staging");
export const TRUTH_PACK_JSON_REL = join(TRUTH_STAGING_DIR, "pack.json");
export const TRUTH_PACK_MD_REL = join(TRUTH_STAGING_DIR, "pack.md");
export const TRUTH_PACK_BUNDLE_PATH = ".aih/truth-pack.json";

const MIN_TOKEN_BUDGET = 64;
const DEFAULT_TOKEN_BUDGET = 2400;
const GIT_TIMEOUT_MS = 5_000;
const HEAD_RE = /^[0-9a-f]{40}$/i;
const ZERO_COMMIT = "0".repeat(40);
const DECISION_ID_RE = /^decision\.[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ACCEPTANCE_ID_RE = /^acceptance\.[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const EVIDENCE_ID_RE = /^evidence\.[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]{0,127}$/;
const VENDOR_TOKEN_RE = /^[a-z][a-z0-9-]{0,63}$/;
const REPO_REL_SEGMENT_RE = /^[A-Za-z0-9._-]+$/;
const MAX_EVIDENCE_NEEDLE_CHARS = 256;
const SHA256_RE = /^[0-9a-f]{64}$/;
const EVIDENCE_ALLOWED_ROOTS = new Set(["ai-coding", "docs", "src", "tests"]);
const EVIDENCE_ALLOWED_TOP_FILES = new Set([
  "agents.md",
  "changelog.md",
  "contributing.md",
  "package.json",
  "readme.md",
  "security.md",
  "stability.md",
]);

interface TruthPointer {
  schemaVersion: 1;
  path: string;
  binding: {
    boundToCommit: string;
  };
}

interface TruthDecision {
  id: string;
  supersededBy?: string;
}

type TruthAcceptanceAssertion =
  | {
      id: string;
      kind: "required-env";
      name: string;
    }
  | {
      id: string;
      kind: "vendor-specific";
      vendor: string;
      scope: "vendor-neutral";
    };

type TruthAgentEvidenceAssertion =
  | {
      id: string;
      kind: "file-exists";
      path: string;
    }
  | {
      id: string;
      kind: "file-contains";
      path: string;
      contains: string;
    };

interface TruthState {
  schemaVersion: 1;
  binding: {
    boundToCommit: string;
  };
  assertions: {
    packageVersion?: string;
    claims: string[];
    decisions: TruthDecision[];
    acceptance: TruthAcceptanceAssertion[];
    agentEvidence: TruthAgentEvidenceAssertion[];
  };
  staging: {
    dir: string;
    promotionRequiresApply: true;
  };
}

interface TruthPack {
  schemaVersion: 1;
  kind: "aih.truth.pack";
  tokenBudget: number;
  tokenEstimate: number;
  facts: {
    boundToCommit: string;
    head: string;
    packageVersion?: string;
    controlMatrixClaims: string[];
    decisionIds: string[];
    stagingDir: string;
    assertionFingerprints: {
      acceptance: string;
      agentEvidence: string;
    };
  };
}

function toPosix(path: string): string {
  return path.replace(/\\/g, "/");
}

export function defaultSidecarPath(root: string): string {
  const abs = resolve(root);
  return join(dirname(abs), `${basename(abs)}-ai`);
}

function isRemoteSidecarPath(path: string): boolean {
  return /^[/\\]{2}[^/\\]/.test(path.trim());
}

function assertLocalSidecarPath(path: string): void {
  if (!isRemoteSidecarPath(path)) return;
  throw new AihError(
    "truth sidecar path must be a local filesystem path; UNC/network paths are not supported",
    "AIH_CONFIG",
  );
}

function optionString(ctx: PlanContext, key: string): string | undefined {
  const raw = ctx.options[key];
  return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : undefined;
}

function optionBoolean(ctx: PlanContext, key: string): boolean {
  return ctx.options[key] === true;
}

function configuredSidecarPath(ctx: PlanContext): string {
  const raw = optionString(ctx, "sidecarPath");
  if (raw === undefined) return defaultSidecarPath(ctx.root);
  assertLocalSidecarPath(raw);
  return isAbsolute(raw) ? raw : resolve(ctx.root, raw);
}

function isPathInsideRoot(root: string, path: string): boolean {
  const realRoot = realpathSafe(root);
  const finalReal = finalRealPath(path);
  const rel = relative(realRoot, finalReal);
  return rel === "" || (rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel));
}

function isExternalSidecarPath(root: string, sidecar: string): boolean {
  return !isPathInsideRoot(root, sidecar);
}

function realpathSafe(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function finalRealPath(path: string): string {
  const abs = resolve(path);
  let ancestor = abs;
  while (!existsSync(ancestor) && dirname(ancestor) !== ancestor) ancestor = dirname(ancestor);
  const tail = relative(ancestor, abs);
  return resolve(realpathSafe(ancestor), tail);
}

async function currentHead(ctx: PlanContext): Promise<string | undefined> {
  const result = await ctx.run(["git", "-C", ctx.root, "rev-parse", "HEAD"], {
    cwd: ctx.root,
    timeoutMs: GIT_TIMEOUT_MS,
  });
  if (result.spawnError || result.code !== 0) return undefined;
  const head = result.stdout.trim();
  return HEAD_RE.test(head) ? head.toLowerCase() : undefined;
}

function parseJson(abs: string): unknown | undefined {
  const raw = readRegularFile(abs);
  if (raw === undefined) return undefined;
  try {
    return JSON.parse(raw.toString("utf8"));
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function asCommit(value: unknown): string | undefined {
  const text = asString(value);
  return text !== undefined && HEAD_RE.test(text) ? text.toLowerCase() : undefined;
}

function asDecisionId(value: unknown): string | undefined {
  const text = asString(value);
  return text !== undefined && DECISION_ID_RE.test(text) ? text : undefined;
}

function asAcceptanceId(value: unknown): string | undefined {
  const text = asString(value);
  return text !== undefined && ACCEPTANCE_ID_RE.test(text) ? text : undefined;
}

function asEvidenceId(value: unknown): string | undefined {
  const text = asString(value);
  return text !== undefined && EVIDENCE_ID_RE.test(text) ? text : undefined;
}

function asEnvName(value: unknown): string | undefined {
  const text = asString(value);
  return text !== undefined && ENV_NAME_RE.test(text) ? text : undefined;
}

function asVendorToken(value: unknown): string | undefined {
  const text = asString(value);
  return text !== undefined && VENDOR_TOKEN_RE.test(text) ? text : undefined;
}

function asSha256(value: unknown): string | undefined {
  const text = asString(value);
  return text !== undefined && SHA256_RE.test(text) ? text : undefined;
}

function hasSensitiveEvidenceSegment(path: string): boolean {
  return toPosix(path)
    .split("/")
    .some((segment) => {
      const lower = segment.toLowerCase();
      return lower.startsWith(".") || lower === "secrets" || lower === "admin";
    });
}

function isAllowedEvidencePath(path: string): boolean {
  const segments = toPosix(path).split("/");
  if (segments.length === 1)
    return EVIDENCE_ALLOWED_TOP_FILES.has(segments[0]?.toLowerCase() ?? "");
  return EVIDENCE_ALLOWED_ROOTS.has(segments[0]?.toLowerCase() ?? "");
}

function asRepoRelativePath(value: unknown): string | undefined {
  const text = asString(value);
  if (text === undefined || text.includes("\0")) return undefined;
  const relPath = toPosix(text);
  if (relPath.length > 240 || relPath.startsWith("/") || /^[A-Za-z]:/.test(relPath)) {
    return undefined;
  }
  const segments = relPath.split("/");
  if (
    segments.some(
      (segment) =>
        segment.length === 0 ||
        segment === "." ||
        segment === ".." ||
        !REPO_REL_SEGMENT_RE.test(segment),
    )
  ) {
    return undefined;
  }
  if (hasSensitiveEvidenceSegment(relPath)) return undefined;
  if (!isAllowedEvidencePath(relPath)) return undefined;
  return relPath;
}

function asEvidenceNeedle(value: unknown): string | undefined {
  const text = typeof value === "string" && value.length > 0 ? value : undefined;
  if (text === undefined || text.includes("\0") || text.length > MAX_EVIDENCE_NEEDLE_CHARS) {
    return undefined;
  }
  return text;
}

function strictStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const item of value) {
    const text = asString(item);
    if (text === undefined) return undefined;
    out.push(text);
  }
  return out;
}

function asPositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : undefined;
}

function parsePointer(value: unknown): TruthPointer | undefined {
  if (!isRecord(value) || value.schemaVersion !== 1) return undefined;
  const path = asString(value.path);
  const binding = isRecord(value.binding) ? value.binding : undefined;
  const boundToCommit = asCommit(binding?.boundToCommit);
  if (path === undefined || boundToCommit === undefined) return undefined;
  return { schemaVersion: 1, path, binding: { boundToCommit } };
}

function hasOnlyKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(record).every((key) => allowedSet.has(key));
}

function parseDecisions(value: unknown): TruthDecision[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: TruthDecision[] = [];
  for (const item of value) {
    if (!isRecord(item)) return undefined;
    const id = asDecisionId(item.id);
    if (id === undefined) return undefined;
    const supersededBy =
      item.supersededBy === undefined ? undefined : asDecisionId(item.supersededBy);
    if (item.supersededBy !== undefined && supersededBy === undefined) return undefined;
    out.push({ id, ...(supersededBy === undefined ? {} : { supersededBy }) });
  }
  return out;
}

function parseAcceptanceAssertions(value: unknown): TruthAcceptanceAssertion[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return undefined;
  const out: TruthAcceptanceAssertion[] = [];
  for (const item of value) {
    if (!isRecord(item)) return undefined;
    const id = asAcceptanceId(item.id);
    if (id === undefined) return undefined;
    if (item.kind === "required-env") {
      if (!hasOnlyKeys(item, ["id", "kind", "name"])) return undefined;
      const name = asEnvName(item.name);
      if (name === undefined) return undefined;
      out.push({ id, kind: "required-env", name });
      continue;
    }
    if (item.kind === "vendor-specific") {
      if (!hasOnlyKeys(item, ["id", "kind", "vendor", "scope"])) return undefined;
      const vendor = asVendorToken(item.vendor);
      if (vendor === undefined || item.scope !== "vendor-neutral") return undefined;
      out.push({ id, kind: "vendor-specific", vendor, scope: "vendor-neutral" });
      continue;
    }
    return undefined;
  }
  return out;
}

function parseAgentEvidenceAssertions(value: unknown): TruthAgentEvidenceAssertion[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return undefined;
  const out: TruthAgentEvidenceAssertion[] = [];
  for (const item of value) {
    if (!isRecord(item)) return undefined;
    const id = asEvidenceId(item.id);
    const path = asRepoRelativePath(item.path);
    if (id === undefined || path === undefined) return undefined;
    if (item.kind === "file-exists") {
      if (!hasOnlyKeys(item, ["id", "kind", "path"])) return undefined;
      out.push({ id, kind: "file-exists", path });
      continue;
    }
    if (item.kind === "file-contains") {
      if (!hasOnlyKeys(item, ["id", "kind", "path", "contains"])) return undefined;
      const contains = asEvidenceNeedle(item.contains);
      if (contains === undefined) return undefined;
      out.push({ id, kind: "file-contains", path, contains });
      continue;
    }
    return undefined;
  }
  return out;
}

function parseState(value: unknown): TruthState | undefined {
  if (!isRecord(value) || value.schemaVersion !== 1) return undefined;
  const binding = isRecord(value.binding) ? value.binding : undefined;
  const assertions = isRecord(value.assertions) ? value.assertions : undefined;
  const staging = isRecord(value.staging) ? value.staging : undefined;
  const boundToCommit = asCommit(binding?.boundToCommit);
  const stagingDir = asString(staging?.dir);
  if (boundToCommit === undefined || assertions === undefined || stagingDir === undefined) {
    return undefined;
  }
  if (toPosix(stagingDir) !== toPosix(TRUTH_STAGING_DIR)) return undefined;
  if (staging?.promotionRequiresApply !== true) return undefined;
  const packageVersion =
    assertions.packageVersion === undefined ? undefined : asString(assertions.packageVersion);
  if (assertions.packageVersion !== undefined && packageVersion === undefined) return undefined;
  const claims = strictStringArray(assertions.claims);
  const decisions = parseDecisions(assertions.decisions);
  const acceptance = parseAcceptanceAssertions(assertions.acceptance);
  const agentEvidence = parseAgentEvidenceAssertions(assertions.agentEvidence);
  if (
    claims === undefined ||
    decisions === undefined ||
    acceptance === undefined ||
    agentEvidence === undefined
  ) {
    return undefined;
  }
  return {
    schemaVersion: 1,
    binding: { boundToCommit },
    assertions: {
      packageVersion,
      claims,
      decisions,
      acceptance,
      agentEvidence,
    },
    staging: { dir: stagingDir, promotionRequiresApply: true },
  };
}

function readPointer(root: string): TruthPointer | undefined {
  return parsePointer(parseJson(join(root, SIDECAR_POINTER_FILE)));
}

function commandPointer(ctx: PlanContext): TruthPointer | undefined {
  const pointer = readPointer(ctx.root);
  if (optionString(ctx, "sidecarPath") === undefined) return pointer;
  const sidecar = configuredSidecarPath(ctx);
  if (!isExternalSidecarPath(ctx.root, sidecar)) {
    return {
      schemaVersion: 1,
      path: sidecar,
      binding: { boundToCommit: ZERO_COMMIT },
    };
  }
  const state = readState(sidecar);
  if (state === undefined) return undefined;
  return {
    schemaVersion: 1,
    path: sidecar,
    binding: { boundToCommit: state.binding.boundToCommit },
  };
}

function pointerSidecarPath(root: string, pointer: TruthPointer): string | undefined {
  if (isRemoteSidecarPath(pointer.path)) return undefined;
  return isAbsolute(pointer.path) ? pointer.path : resolve(root, pointer.path);
}

function pointerPathFor(root: string, sidecar: string): string {
  const rel = relative(root, sidecar);
  if (rel.length > 0 && !isAbsolute(rel) && !isRemoteSidecarPath(rel)) return toPosix(rel);
  throw new AihError(
    "truth sidecar path must be representable as a local relative pointer from the repository root",
    "AIH_CONFIG",
  );
}

function readState(sidecar: string): TruthState | undefined {
  return parseState(parseJson(join(sidecar, TRUTH_STATE_REL)));
}

function packageVersion(root: string): string | undefined {
  const parsed = parseJson(join(root, "package.json"));
  return isRecord(parsed) ? asString(parsed.version) : undefined;
}

function tokenBudget(ctx: PlanContext): number {
  const raw = ctx.options.tokenBudget;
  let parsed: number | undefined;
  if (raw === undefined) {
    parsed = undefined;
  } else if (typeof raw === "number" && Number.isInteger(raw) && raw >= 1) {
    parsed = raw;
  } else if (typeof raw === "string" && /^[1-9][0-9]*$/.test(raw.trim())) {
    parsed = Number(raw.trim());
  } else {
    throw new AihError("--token-budget must be a positive integer", "AIH_CONFIG");
  }
  if (parsed === undefined) return DEFAULT_TOKEN_BUDGET;
  if (!Number.isSafeInteger(parsed)) {
    throw new AihError("--token-budget must be a positive safe integer", "AIH_CONFIG");
  }
  return Math.max(MIN_TOKEN_BUDGET, Math.floor(parsed));
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(Buffer.byteLength(text, "utf8") / 4));
}

function sha256Json(value: unknown): string {
  return createHash("sha256").update(jsonFile(value), "utf8").digest("hex");
}

function assertionFingerprintsFor(
  acceptance: readonly TruthAcceptanceAssertion[],
  agentEvidence: readonly TruthAgentEvidenceAssertion[],
): TruthPack["facts"]["assertionFingerprints"] {
  return {
    acceptance: sha256Json(acceptance),
    agentEvidence: sha256Json(agentEvidence),
  };
}

function assertionFingerprints(state: TruthState): TruthPack["facts"]["assertionFingerprints"] {
  return assertionFingerprintsFor(state.assertions.acceptance, state.assertions.agentEvidence);
}

function boundedMarkdown(linesIn: readonly string[], budget: number): string {
  const maxBytes = budget * 4;
  const text = ensureTrailingNewline(lines(...linesIn));
  if (estimateTokens(text) <= budget) return text;
  const suffix = "\n- truncated: token budget reached\n";
  const allowed = Math.max(0, maxBytes - Buffer.byteLength(suffix, "utf8"));
  const raw = Buffer.from(text, "utf8");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let end = allowed; end > 0; end -= 1) {
    let prefix: string;
    try {
      prefix = decoder.decode(raw.subarray(0, end));
    } catch {
      continue;
    }
    const candidate = ensureTrailingNewline(`${prefix}${suffix}`);
    if (estimateTokens(candidate) <= budget) return candidate;
  }
  return ensureTrailingNewline(suffix);
}

function packFromState(
  ctx: PlanContext,
  sidecar: string,
  state: TruthState,
  head: string,
  budget: number,
): { pack: TruthPack; markdown: string } {
  const matrixClaims = controlMatrixClaimIds(ctx.root);
  const decisions = state.assertions.decisions;
  const fingerprints = assertionFingerprints(state);
  const markdown = boundedMarkdown(
    [
      "# AIH Truth Pack",
      "",
      `- boundCommit: ${state.binding.boundToCommit}`,
      `- head: ${head}`,
      `- packageVersion: ${packageVersion(ctx.root) ?? "unknown"}`,
      `- controlMatrixClaims: ${matrixClaims.length}`,
      `- decisions: ${decisions.length}`,
      `- acceptanceAssertions: ${state.assertions.acceptance.length}`,
      `- agentEvidenceAssertions: ${state.assertions.agentEvidence.length}`,
      `- sidecar: ${toPosix(sidecar)}`,
      `- staging: ${toPosix(state.staging.dir)}`,
    ],
    budget,
  );
  return {
    markdown,
    pack: {
      schemaVersion: 1,
      kind: "aih.truth.pack",
      tokenBudget: budget,
      tokenEstimate: estimateTokens(markdown),
      facts: {
        boundToCommit: state.binding.boundToCommit,
        head,
        packageVersion: packageVersion(ctx.root),
        controlMatrixClaims: matrixClaims,
        decisionIds: decisions.map((decision) => decision.id),
        stagingDir: state.staging.dir,
        assertionFingerprints: fingerprints,
      },
    },
  };
}

function parsePack(value: unknown): TruthPack | undefined {
  if (!isRecord(value) || value.schemaVersion !== 1 || value.kind !== "aih.truth.pack") {
    return undefined;
  }
  const tokenBudget = asPositiveInteger(value.tokenBudget);
  const tokenEstimate = asPositiveInteger(value.tokenEstimate);
  const facts = isRecord(value.facts) ? value.facts : undefined;
  const boundToCommit = asCommit(facts?.boundToCommit);
  const head = asCommit(facts?.head);
  const packageVersion =
    facts?.packageVersion === undefined ? undefined : asString(facts.packageVersion);
  const controlMatrixClaims = strictStringArray(facts?.controlMatrixClaims);
  const decisionIds = strictStringArray(facts?.decisionIds);
  const stagingDir = asString(facts?.stagingDir);
  const hasAssertionFingerprints =
    facts !== undefined && Object.hasOwn(facts, "assertionFingerprints");
  const assertionFingerprints =
    hasAssertionFingerprints && isRecord(facts.assertionFingerprints)
      ? facts.assertionFingerprints
      : undefined;
  const defaultFingerprints =
    hasAssertionFingerprints === false ? assertionFingerprintsFor([], []) : undefined;
  const acceptanceFingerprint =
    hasAssertionFingerprints === false
      ? defaultFingerprints?.acceptance
      : asSha256(assertionFingerprints?.acceptance);
  const agentEvidenceFingerprint =
    hasAssertionFingerprints === false
      ? defaultFingerprints?.agentEvidence
      : asSha256(assertionFingerprints?.agentEvidence);
  if (
    tokenBudget === undefined ||
    tokenEstimate === undefined ||
    tokenBudget < MIN_TOKEN_BUDGET ||
    tokenEstimate > tokenBudget ||
    boundToCommit === undefined ||
    head === undefined ||
    (facts?.packageVersion !== undefined && packageVersion === undefined) ||
    controlMatrixClaims === undefined ||
    decisionIds === undefined ||
    stagingDir === undefined ||
    acceptanceFingerprint === undefined ||
    agentEvidenceFingerprint === undefined
  ) {
    return undefined;
  }
  return {
    schemaVersion: 1,
    kind: "aih.truth.pack",
    tokenBudget,
    tokenEstimate,
    facts: {
      boundToCommit,
      head,
      packageVersion,
      controlMatrixClaims,
      decisionIds,
      stagingDir,
      assertionFingerprints: {
        acceptance: acceptanceFingerprint,
        agentEvidence: agentEvidenceFingerprint,
      },
    },
  };
}

function sameArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function fail(code: CheckCode, detail: string): Check {
  return { name: "truth verify", verdict: "fail", code, detail };
}

function pass(name: string, detail: string): Check {
  return { name, verdict: "pass", detail };
}

function repoFileContents(ctx: PlanContext, relPath: string): Buffer | undefined {
  const abs = resolve(ctx.root, relPath);
  if (!isPathInsideRoot(ctx.root, abs)) return undefined;
  try {
    if (lstatSync(abs).isSymbolicLink()) return undefined;
  } catch {
    return undefined;
  }
  const realRoot = realpathSafe(ctx.root);
  const finalReal = finalRealPath(abs);
  const finalRel = toPosix(relative(realRoot, finalReal));
  if (
    finalRel === "" ||
    finalRel.startsWith("..") ||
    isAbsolute(finalRel) ||
    !isAllowedEvidencePath(finalRel) ||
    hasSensitiveEvidenceSegment(finalRel)
  ) {
    return undefined;
  }
  return readRegularFile(abs);
}

function acceptanceChecks(ctx: PlanContext, state: TruthState): Check[] {
  const checks: Check[] = [];
  for (const assertion of state.assertions.acceptance) {
    if (assertion.kind === "required-env") {
      const value = ctx.env[assertion.name];
      if (typeof value !== "string" || value.trim().length === 0) {
        checks.push(
          fail(
            "truth.acceptance-blocked-environment",
            "blocked:environment acceptance preflight requirement is unsatisfied",
          ),
        );
      } else {
        checks.push(pass("truth acceptance preflight", "environment requirement is satisfiable"));
      }
      continue;
    }

    checks.push(
      fail(
        "truth.acceptance-blocked-vendor-specific",
        "blocked:vendor-specific acceptance preflight found vendor-specific work in vendor-neutral scope",
      ),
    );
  }
  return checks;
}

function agentEvidenceChecks(ctx: PlanContext, state: TruthState): Check[] {
  const checks: Check[] = [];
  for (const assertion of state.assertions.agentEvidence) {
    const contents = repoFileContents(ctx, assertion.path);
    const ok =
      assertion.kind === "file-exists"
        ? contents !== undefined
        : contents?.toString("utf8").includes(assertion.contains) === true;
    if (ok) {
      checks.push(
        pass("truth agent evidence", "agent evidence claim re-run by harness and recorded"),
      );
    } else {
      checks.push(
        fail(
          "truth.agent-evidence-mismatch",
          "agent evidence claim did not match the re-run harness result",
        ),
      );
    }
  }
  return checks;
}

function truthPackIntegrityCheck(
  ctx: PlanContext,
  pack: TruthPack,
  state: TruthState,
  head: string,
): Check | undefined {
  const actualVersion = packageVersion(ctx.root);
  const matrixClaims = controlMatrixClaimIds(ctx.root);
  const decisionIds = state.assertions.decisions.map((decision) => decision.id);
  const fingerprints = assertionFingerprints(state);
  const versionMatches = (pack.facts.packageVersion ?? undefined) === actualVersion;
  if (
    pack.facts.boundToCommit !== state.binding.boundToCommit ||
    pack.facts.head !== head ||
    !versionMatches ||
    !sameArray(pack.facts.controlMatrixClaims, matrixClaims) ||
    !sameArray(pack.facts.decisionIds, decisionIds) ||
    pack.facts.stagingDir !== state.staging.dir ||
    pack.facts.assertionFingerprints.acceptance !== fingerprints.acceptance ||
    pack.facts.assertionFingerprints.agentEvidence !== fingerprints.agentEvidence
  ) {
    return fail(
      "truth.pack-invalid",
      "truth pack facts do not match the verified sidecar state and repository metadata",
    );
  }
  return undefined;
}

export async function truthVerifyChecks(ctx: PlanContext): Promise<Check[]> {
  const pointer = commandPointer(ctx);
  if (pointer === undefined) {
    return [fail("truth.sidecar-missing", `${SIDECAR_POINTER_FILE} is missing or invalid`)];
  }
  const sidecar = pointerSidecarPath(ctx.root, pointer);
  if (sidecar === undefined) {
    return [fail("truth.sidecar-missing", "truth sidecar path must be a local filesystem path")];
  }
  if (!isExternalSidecarPath(ctx.root, sidecar)) {
    return [
      fail("truth.sidecar-missing", "truth sidecar path must resolve outside repository root"),
    ];
  }
  const state = readState(sidecar);
  if (state === undefined) {
    return [
      fail(
        "truth.sidecar-missing",
        "truth sidecar state is missing, malformed, or not apply-gated",
      ),
    ];
  }

  const checks: Check[] = [];
  const head = await currentHead(ctx);
  if (head === undefined) {
    checks.push(
      fail("truth.bound-commit-drift", "could not determine git HEAD; truth verify failed closed"),
    );
  } else if (
    pointer.binding.boundToCommit.toLowerCase() !== head ||
    state.binding.boundToCommit.toLowerCase() !== head
  ) {
    checks.push(
      fail("truth.bound-commit-drift", "sidecar code-commit binding does not match HEAD"),
    );
  }

  const actualVersion = packageVersion(ctx.root);
  if (actualVersion !== undefined && state.assertions.packageVersion === undefined) {
    checks.push(fail("truth.version-drift", "sidecar package version assertion is missing"));
  } else if (
    state.assertions.packageVersion !== undefined &&
    state.assertions.packageVersion !== actualVersion
  ) {
    checks.push(
      fail("truth.version-drift", "sidecar package version assertion does not match package.json"),
    );
  }

  const matrixRows = new Set(controlMatrixClaimIds(ctx.root));
  for (const claim of state.assertions.claims) {
    if (!matrixRows.has(claim.toUpperCase())) {
      checks.push(
        fail("truth.claim-matrix-row-missing", "a sidecar claim has no control-matrix row"),
      );
    }
  }

  const decisions = state.assertions.decisions;
  const ids = new Set(decisions.map((decision) => decision.id));
  for (const decision of decisions) {
    if (decision.supersededBy !== undefined && !ids.has(decision.supersededBy)) {
      checks.push(
        fail(
          "truth.decision-supersession-missing",
          "a sidecar decision supersession target is missing",
        ),
      );
    }
  }

  if (checks.length > 0) return checks;

  checks.push(...acceptanceChecks(ctx, state), ...agentEvidenceChecks(ctx, state));

  if (checks.some((check) => check.verdict === "fail")) return checks;
  return [
    ...checks,
    {
      name: "truth verify",
      verdict: "pass",
      detail:
        "sidecar matches HEAD, package version, claims, decisions, preflight, and agent evidence",
    },
  ];
}

export async function sidecarInitActions(ctx: PlanContext): Promise<Action[]> {
  if (!optionBoolean(ctx, "sidecar")) return [];
  const head = await currentHead(ctx);
  if (head === undefined) {
    throw new AihError(
      "truth sidecar requires a valid git HEAD to record a code-commit binding",
      "AIH_CONFIG",
    );
  }
  const boundToCommit = head;
  const sidecar = configuredSidecarPath(ctx);
  if (!isExternalSidecarPath(ctx.root, sidecar)) {
    throw new AihError("truth sidecar path must resolve outside the repository root", "AIH_CONFIG");
  }
  const state: TruthState = {
    schemaVersion: 1,
    binding: { boundToCommit },
    assertions: {
      packageVersion: packageVersion(ctx.root),
      claims: controlMatrixClaimIds(ctx.root),
      decisions: [],
      acceptance: [],
      agentEvidence: [],
    },
    staging: { dir: toPosix(TRUTH_STAGING_DIR), promotionRequiresApply: true },
  };
  const pointer: TruthPointer = {
    schemaVersion: 1,
    path: pointerPathFor(ctx.root, sidecar),
    binding: { boundToCommit },
  };
  return [
    writeJson(SIDECAR_POINTER_FILE, pointer, "truth sidecar pointer and code-commit binding", {
      merge: true,
    }),
    writeJson(join(sidecar, TRUTH_STATE_REL), state, "truth sidecar state", { external: true }),
    writeText(join(sidecar, TRUTH_STAGING_DIR, ".gitkeep"), "", "truth staging directory", {
      external: true,
    }),
    writeText(
      "AGENTS.md",
      lines(
        "# Agent Instructions",
        "",
        "- AI-managed: write proposed truth updates to the external sidecar staging area first.",
        "- Human-authored: source code, public docs, and release notes stay in this repository.",
        "- Approval-gated: promotion from sidecar staging requires an explicit `--apply` run.",
      ),
      "root instruction file declaring AI-managed, human-authored, and approval-gated content",
      { once: true },
    ),
  ];
}

async function truthPackPlan(ctx: PlanContext) {
  const budget = tokenBudget(ctx);
  const checks = await truthVerifyChecks(ctx);
  const verifyProbe = probeMany("truth verify", () => checks);
  if (checks.some((check) => check.verdict === "fail")) return plan("truth pack", verifyProbe);

  const pointer = commandPointer(ctx);
  if (pointer === undefined) return plan("truth pack", verifyProbe);
  const sidecar = pointerSidecarPath(ctx.root, pointer);
  if (sidecar === undefined) return plan("truth pack", verifyProbe);
  const state = readState(sidecar);
  const head = await currentHead(ctx);
  if (state === undefined || head === undefined) {
    return plan("truth pack", verifyProbe);
  }
  const { pack, markdown } = packFromState(ctx, sidecar, state, head, budget);
  return plan(
    "truth pack",
    verifyProbe,
    writeText(join(sidecar, TRUTH_PACK_MD_REL), markdown, "truth pack Markdown", {
      external: true,
    }),
    writeJson(join(sidecar, TRUTH_PACK_JSON_REL), pack, "truth pack JSON", { external: true }),
    digest("truth pack", `truth pack staged in ${toPosix(join(sidecar, TRUTH_STAGING_DIR))}`, {
      sidecar,
      tokenBudget: pack.tokenBudget,
      tokenEstimate: pack.tokenEstimate,
    }),
  );
}

function truthVerifyPlan() {
  return plan("truth verify", probeMany("truth verify", truthVerifyChecks));
}

export async function truthPackEvidenceSource(ctx: PlanContext): Promise<{
  source?: { contents: string; rel: typeof TRUTH_PACK_BUNDLE_PATH };
  checks: Check[];
}> {
  const pointer = readPointer(ctx.root);
  if (pointer === undefined) return { checks: [] };
  const sidecar = pointerSidecarPath(ctx.root, pointer);
  if (sidecar === undefined) {
    return {
      checks: [fail("truth.sidecar-missing", "truth sidecar path must be a local filesystem path")],
    };
  }
  if (!isExternalSidecarPath(ctx.root, sidecar)) {
    return {
      checks: [
        fail("truth.sidecar-missing", "truth sidecar path must resolve outside repository root"),
      ],
    };
  }
  const abs = join(sidecar, TRUTH_PACK_JSON_REL);
  if (!existsSync(abs)) return { checks: [] };

  const checks = await truthVerifyChecks(ctx);
  if (checks.some((check) => check.verdict === "fail")) return { checks };

  const state = readState(sidecar);
  const head = await currentHead(ctx);
  const pack = parsePack(parseJson(abs));
  if (state === undefined || head === undefined || pack === undefined) {
    return { checks: [fail("truth.pack-invalid", "truth pack is missing or malformed")] };
  }
  const integrity = truthPackIntegrityCheck(ctx, pack, state, head);
  if (integrity !== undefined) return { checks: [integrity] };
  return { source: { contents: jsonFile(pack), rel: TRUTH_PACK_BUNDLE_PATH }, checks };
}

export const truthPackCommand: CommandSpec = {
  name: "pack",
  summary: "Assemble a token-bounded project truth pack from the external sidecar",
  options: [
    {
      flags: "--token-budget <tokens>",
      description: "maximum approximate tokens for the emitted Markdown pack",
      default: String(DEFAULT_TOKEN_BUDGET),
    },
    {
      flags: "--sidecar-path <dir>",
      description: "external sidecar directory (defaults to sibling <repo>-ai)",
    },
  ],
  alwaysVerify: true,
  plan: truthPackPlan,
};

export const truthVerifyCommand: CommandSpec = {
  name: "verify",
  summary: "Verify sidecar binding, drift checks, preflight assertions, and agent evidence",
  options: [
    {
      flags: "--sidecar-path <dir>",
      description: "external sidecar directory (defaults to pointer or sibling <repo>-ai)",
    },
  ],
  alwaysVerify: true,
  plan: truthVerifyPlan,
};
