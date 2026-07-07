import { existsSync, realpathSync } from "node:fs";
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

interface TruthState {
  schemaVersion: 1;
  binding: {
    boundToCommit: string;
  };
  assertions: {
    packageVersion?: string;
    claims: string[];
    decisions: TruthDecision[];
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
  };
}

function toPosix(path: string): string {
  return path.replace(/\\/g, "/");
}

export function defaultSidecarPath(root: string): string {
  const abs = resolve(root);
  return join(dirname(abs), `${basename(abs)}-ai`);
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
  if (claims === undefined || decisions === undefined) return undefined;
  return {
    schemaVersion: 1,
    binding: { boundToCommit },
    assertions: {
      packageVersion,
      claims,
      decisions,
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

function pointerSidecarPath(root: string, pointer: TruthPointer): string {
  return isAbsolute(pointer.path) ? pointer.path : resolve(root, pointer.path);
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
  const parsed =
    typeof raw === "number" ? raw : typeof raw === "string" ? Number.parseInt(raw, 10) : undefined;
  if (parsed === undefined || !Number.isFinite(parsed)) return DEFAULT_TOKEN_BUDGET;
  return Math.max(MIN_TOKEN_BUDGET, Math.floor(parsed));
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(Buffer.byteLength(text, "utf8") / 4));
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
): { pack: TruthPack; markdown: string } {
  const budget = tokenBudget(ctx);
  const matrixClaims = controlMatrixClaimIds(ctx.root);
  const decisions = state.assertions.decisions;
  const markdown = boundedMarkdown(
    [
      "# AIH Truth Pack",
      "",
      `- boundCommit: ${state.binding.boundToCommit}`,
      `- head: ${head}`,
      `- packageVersion: ${packageVersion(ctx.root) ?? "unknown"}`,
      `- controlMatrixClaims: ${matrixClaims.length}`,
      `- decisions: ${decisions.length}`,
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
    stagingDir === undefined
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
    },
  };
}

function sameArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function fail(code: CheckCode, detail: string): Check {
  return { name: "truth verify", verdict: "fail", code, detail };
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
  const versionMatches = (pack.facts.packageVersion ?? undefined) === actualVersion;
  if (
    pack.facts.boundToCommit !== state.binding.boundToCommit ||
    pack.facts.head !== head ||
    !versionMatches ||
    !sameArray(pack.facts.controlMatrixClaims, matrixClaims) ||
    !sameArray(pack.facts.decisionIds, decisionIds) ||
    pack.facts.stagingDir !== state.staging.dir
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
  return [
    {
      name: "truth verify",
      verdict: "pass",
      detail: "sidecar matches HEAD, package version, claims, and decisions",
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
    },
    staging: { dir: toPosix(TRUTH_STAGING_DIR), promotionRequiresApply: true },
  };
  const pointer: TruthPointer = {
    schemaVersion: 1,
    path: sidecar,
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
  const checks = await truthVerifyChecks(ctx);
  const verifyProbe = probeMany("truth verify", () => checks);
  if (checks.some((check) => check.verdict === "fail")) return plan("truth pack", verifyProbe);

  const pointer = commandPointer(ctx);
  if (pointer === undefined) return plan("truth pack", verifyProbe);
  const sidecar = pointerSidecarPath(ctx.root, pointer);
  const state = readState(sidecar);
  const head = await currentHead(ctx);
  if (state === undefined || head === undefined) {
    return plan("truth pack", verifyProbe);
  }
  const { pack, markdown } = packFromState(ctx, sidecar, state, head);
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
  summary: "Verify the sidecar binding, version, claim rows, and decision supersessions",
  options: [
    {
      flags: "--sidecar-path <dir>",
      description: "external sidecar directory (defaults to pointer or sibling <repo>-ai)",
    },
  ],
  alwaysVerify: true,
  plan: truthVerifyPlan,
};
