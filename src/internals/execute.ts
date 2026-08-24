import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { applyEdits, type FormattingOptions, modify } from "jsonc-parser";
import { AihError, DirtyWorktreeError, PathContainmentError } from "../errors.js";
import { redactSecrets } from "../guardrails/redact.js";
import {
  MAX_VERIFICATION_STRING_FIELD_LENGTH,
  VERIFICATION_CATEGORIES,
  VERIFICATION_CONFIDENCES,
  VERIFICATION_SEVERITIES,
  VERIFICATION_VERDICTS,
} from "../verification/constants.js";
import { buildEvidenceGraph } from "../verification/graph.js";
import {
  legacyCheckToVerificationResult,
  type StructuredVerificationRunCheckOptions,
  structuredVerificationRunToCheck,
} from "../verification/legacy.js";
import { mergeVerificationResults } from "../verification/merge.js";
import type {
  Evidence,
  VerificationPipelineRun,
  VerificationResult,
} from "../verification/types.js";
import { isWellFormedUtf16 } from "../verification/validation.js";
import { upsertManagedBlock } from "./envfile.js";
import { FsTransaction, readIfExists } from "./fsxn.js";
import { deepMerge, duplicateRootKeys, isPlainObject, parseJsoncText } from "./merge.js";
import type {
  DigestAction,
  EnvBlockAction,
  ExecAction,
  Plan,
  PlanContext,
  ProbeAction,
  StructuredLegacyProbeRun,
  WriteAction,
} from "./plan.js";
import { parseCommitNotAfter } from "./plan.js";
import { ensureTrailingNewline, indent, jsonFile, stripTrailingNewlines } from "./render.js";
import { type Check, VerificationReport } from "./verify.js";
import { dirtyRemoveTargets, dirtyWriteTargets, normalizeRel } from "./worktree-gate.js";

const VERIFICATION_TRUNCATION_SUFFIX = "... [truncated]";
/** Trailing child-output budget surfaced on a failed exec action. */
const MAX_SURFACED_CHILD_OUTPUT_LINES = 20;
const MAX_SURFACED_CHILD_OUTPUT_CHARS = 4_096;
const REDACTED_PATH = "<redacted-path>";

function collectedPath(action: { path: string; sensitive?: { path?: boolean } }): string {
  return action.sensitive?.path ? REDACTED_PATH : action.path;
}

function collectedArgv(action: ExecAction): string[] {
  const indexes = new Set(action.sensitive?.argv ?? []);
  return action.argv.map((value, index) => (indexes.has(index) ? REDACTED_PATH : value));
}

function isSensitiveBackup(path: string, targets: ReadonlySet<string>): boolean {
  const suffix = ".aih.bak";
  return path.endsWith(suffix) && targets.has(path.slice(0, -suffix.length));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function removeJsonKeys(value: unknown, removals: WriteAction["removeJsonKeys"]): unknown {
  if (removals === undefined || !isRecord(value)) return value;
  let next: Record<string, unknown> | undefined;
  for (const [topKey, childKeys] of Object.entries(removals)) {
    const target = (next ?? value)[topKey];
    if (!isRecord(target)) continue;
    const pruned = { ...target };
    let changed = false;
    for (const childKey of new Set(childKeys)) {
      if (Object.hasOwn(pruned, childKey)) {
        delete pruned[childKey];
        changed = true;
      }
    }
    if (!changed) continue;
    next ??= { ...value };
    next[topKey] = pruned;
  }
  return next ?? value;
}

function replaceJsonKeys(
  value: unknown,
  incoming: unknown,
  replacements: WriteAction["replaceJsonKeys"],
): unknown {
  if (replacements === undefined || !isRecord(value) || !isRecord(incoming)) return value;
  let next: Record<string, unknown> | undefined;
  for (const key of new Set(replacements)) {
    if (!Object.hasOwn(incoming, key)) continue;
    next ??= { ...value };
    next[key] = incoming[key];
  }
  return next ?? value;
}

function replaceJsonChildKeys(
  value: unknown,
  incoming: unknown,
  replacements: WriteAction["replaceJsonChildKeys"],
): unknown {
  if (replacements === undefined || !isRecord(value) || !isRecord(incoming)) return value;
  let next: Record<string, unknown> | undefined;
  for (const [topKey, childKeys] of Object.entries(replacements)) {
    const target = (next ?? value)[topKey];
    const incomingTarget = incoming[topKey];
    if (!isRecord(target) || !isRecord(incomingTarget)) continue;
    let replaced: Record<string, unknown> | undefined;
    for (const childKey of new Set(childKeys)) {
      if (!Object.hasOwn(incomingTarget, childKey)) continue;
      replaced ??= { ...target };
      replaced[childKey] = incomingTarget[childKey];
    }
    if (replaced === undefined) continue;
    next ??= { ...value };
    next[topKey] = replaced;
  }
  return next ?? value;
}

function pruneJsonChildKeys(
  value: unknown,
  incoming: unknown,
  prunes: WriteAction["pruneJsonChildKeys"],
): unknown {
  if (prunes === undefined || !isRecord(value)) return value;
  const incomingRecord = isRecord(incoming) ? incoming : {};
  let next: Record<string, unknown> | undefined;
  for (const [topKey, prune] of Object.entries(prunes)) {
    const target = (next ?? value)[topKey];
    if (!isRecord(target)) continue;
    const incomingTarget = isRecord(incomingRecord[topKey]) ? incomingRecord[topKey] : {};
    const exact = new Set(prune.exact ?? []);
    const prefixes = prune.prefixes ?? [];
    let pruned: Record<string, unknown> | undefined;
    for (const childKey of Object.keys(target)) {
      if (Object.hasOwn(incomingTarget, childKey)) continue;
      if (!exact.has(childKey) && !prefixes.some((prefix) => childKey.startsWith(prefix))) {
        continue;
      }
      pruned ??= { ...target };
      delete pruned[childKey];
    }
    if (pruned === undefined) continue;
    next ??= { ...value };
    next[topKey] = pruned;
  }
  return next ?? value;
}

function removeJsonTopLevelKeys(
  value: unknown,
  removals: WriteAction["removeJsonTopLevelKeys"],
): unknown {
  if (removals === undefined || !isRecord(value)) return value;
  let next: Record<string, unknown> | undefined;
  for (const key of new Set(removals)) {
    if (!Object.hasOwn(next ?? value, key)) continue;
    next ??= { ...value };
    delete next[key];
  }
  return next ?? value;
}

function structuredProbeCheckOptions(action: ProbeAction): StructuredVerificationRunCheckOptions {
  const options = action.structured ?? {};
  return { ...options, name: options.name ?? action.describe };
}

function toWellFormedUtf16(value: string): string {
  let text = "";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (Number.isInteger(next) && next >= 0xdc00 && next <= 0xdfff) {
        text += value[index] ?? "";
        text += value[index + 1] ?? "";
        index += 1;
      } else {
        text += "\uFFFD";
      }
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      text += "\uFFFD";
      continue;
    }
    text += value[index] ?? "";
  }
  return text;
}

function truncateVerificationPrefix(value: string, maxLength: number): string {
  return toWellFormedUtf16(value.slice(0, maxLength));
}

function verificationText(value: string | undefined, fallback: string): string {
  let text = value ?? fallback;
  if (!isWellFormedUtf16(text)) text = toWellFormedUtf16(text);
  text = redactSecrets(text);
  if (text.length === 0) text = fallback;
  if (text.length <= MAX_VERIFICATION_STRING_FIELD_LENGTH) return text;
  return `${truncateVerificationPrefix(
    text,
    MAX_VERIFICATION_STRING_FIELD_LENGTH - VERIFICATION_TRUNCATION_SUFFIX.length,
  )}${VERIFICATION_TRUNCATION_SUFFIX}`;
}

/**
 * Project a failed child's captured output onto the plan result.
 *
 * This is the single source-side chokepoint for child output, mirroring the
 * digest chokepoint in executePlan: redact HERE, upstream of every renderer, so
 * the human summary and the `--json` envelope carry the same masked body. Child
 * stderr routinely carries credentials (tokens in registry URLs, proxy auth),
 * and it is unbounded — a chatty installer can emit megabytes — so the tail is
 * kept and the head dropped with an explicit count rather than silently.
 */
function surfacedChildOutput(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const redacted = redactSecrets(raw).replace(/\s+$/, "");
  if (redacted.length === 0) return undefined;
  const lines = redacted.split("\n");
  const omitted = Math.max(0, lines.length - MAX_SURFACED_CHILD_OUTPUT_LINES);
  let text = lines.slice(-MAX_SURFACED_CHILD_OUTPUT_LINES).join("\n");
  // Second bound: twenty copies of one pathological line is still unbounded.
  if (text.length > MAX_SURFACED_CHILD_OUTPUT_CHARS) {
    text = text.slice(-MAX_SURFACED_CHILD_OUTPUT_CHARS);
  }
  return omitted > 0 ? `… ${omitted} earlier line(s) omitted\n${text}` : text;
}

function optionalVerificationText(value: string | undefined): string | undefined {
  return value === undefined ? undefined : verificationText(value, "");
}

function sanitizedEvidence(evidence: Evidence, passName: string, index: number): Evidence {
  const snippet = optionalVerificationText(evidence.snippet);
  return {
    id: verificationText(evidence.id, `${passName}:evidence:${index}`),
    type: verificationText(evidence.type, "evidence"),
    source: verificationText(evidence.source, "unknown"),
    ...(snippet === undefined ? {} : { snippet }),
  };
}

function verificationEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
  index: number,
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new AihError(
      `structured verification result at index ${index} has invalid ${field}`,
      "AIH_CONFIG",
    );
  }
  return value as T;
}

function sanitizedVerificationResult(
  result: VerificationResult,
  index: number,
): VerificationResult {
  const passName = verificationText(result.passName, "structured verification");
  return {
    passName,
    verdict: verificationEnum(result.verdict, VERIFICATION_VERDICTS, "verdict", index),
    severity: verificationEnum(result.severity, VERIFICATION_SEVERITIES, "severity", index),
    confidence: verificationEnum(result.confidence, VERIFICATION_CONFIDENCES, "confidence", index),
    evidence: result.evidence.map((evidence, index) =>
      sanitizedEvidence(evidence, passName, index),
    ),
    message: verificationText(result.message, passName),
    category: verificationEnum(result.category, VERIFICATION_CATEGORIES, "category", index),
  };
}

function suffixedPassName(passName: string, suffix: number): string {
  const suffixText = `#${suffix}`;
  if (passName.length + suffixText.length <= MAX_VERIFICATION_STRING_FIELD_LENGTH) {
    return `${passName}${suffixText}`;
  }
  return `${truncateVerificationPrefix(
    passName,
    MAX_VERIFICATION_STRING_FIELD_LENGTH - suffixText.length,
  )}${suffixText}`;
}

function uniqueVerificationResults(results: readonly VerificationResult[]): VerificationResult[] {
  const used = new Set<string>();
  const nextSuffix = new Map<string, number>();
  return results.map((result) => {
    if (!used.has(result.passName)) {
      used.add(result.passName);
      return result;
    }
    let suffix = nextSuffix.get(result.passName) ?? 2;
    let passName = suffixedPassName(result.passName, suffix);
    while (used.has(passName)) {
      suffix += 1;
      passName = suffixedPassName(result.passName, suffix);
    }
    nextSuffix.set(result.passName, suffix + 1);
    used.add(passName);
    return { ...result, passName };
  });
}

function maxEvidencePerResult(results: readonly VerificationResult[]): number {
  return Math.max(1, ...results.map((result) => result.evidence.length));
}

function verificationRunFromResults(
  results: readonly VerificationResult[],
): VerificationPipelineRun | undefined {
  if (results.length === 0) return undefined;
  const uniqueResults = uniqueVerificationResults(
    results.map((result, index) => sanitizedVerificationResult(result, index)),
  );
  return {
    results: uniqueResults,
    summary: mergeVerificationResults(uniqueResults),
    evidenceGraph: buildEvidenceGraph(uniqueResults, {
      maxResults: uniqueResults.length,
      maxEvidencePerResult: maxEvidencePerResult(uniqueResults),
    }),
  };
}

interface VerificationEntry {
  result?: VerificationResult;
  reportCheck?: Check;
}

function legacyVerificationEntry(check: Check): VerificationEntry {
  return {
    result: legacyCheckToVerificationResult(check),
    reportCheck: check,
  };
}

function structuredVerificationEntries(
  action: ProbeAction,
  run: VerificationPipelineRun,
): VerificationEntry[] {
  const entries: VerificationEntry[] = run.results.map((result) => ({ result }));
  const reportCheck = structuredVerificationRunToCheck(run, structuredProbeCheckOptions(action));
  if (entries[0] !== undefined) entries[0].reportCheck = reportCheck;
  else entries.push({ reportCheck });
  return entries;
}

function structuredLegacyVerificationEntries(run: StructuredLegacyProbeRun): VerificationEntry[] {
  const results = run.verification?.results ?? [];
  if (results.length !== run.reportChecks.length) {
    throw new AihError(
      `structured legacy probe returned mismatched result/check counts: ${results.length}/${run.reportChecks.length}`,
      "AIH_CONFIG",
    );
  }
  const entries: VerificationEntry[] = [];
  for (let index = 0; index < run.reportChecks.length; index += 1) {
    const result = results[index];
    const reportCheck = run.reportChecks[index];
    if (result === undefined || reportCheck === undefined) {
      throw new AihError("structured legacy probe returned sparse results", "AIH_CONFIG");
    }
    entries.push({ result, reportCheck });
  }
  return entries;
}

function verificationRunFromEntries(
  entries: readonly VerificationEntry[],
): VerificationPipelineRun | undefined {
  return verificationRunFromResults(
    entries.flatMap((entry) => (entry.result === undefined ? [] : [entry.result])),
  );
}

function reportFromVerificationEntries(entries: readonly VerificationEntry[]): VerificationReport {
  const report = new VerificationReport();
  for (const entry of entries) {
    if (entry.reportCheck !== undefined) report.add(entry.reportCheck);
  }
  return report;
}

export interface WriteSummary {
  path: string;
  describe: string;
  merged: boolean;
  /**
   * Effect relative to current disk state. `unchanged` writes are skipped (no
   * backup); `kept` is a write-once file that already exists (left untouched).
   */
  effect: "create" | "overwrite" | "merge" | "unchanged" | "kept";
}

export interface RemoveSummary {
  path: string;
  describe: string;
  /** `remove` = move to `.aih/legacy/`; `delete` = hard-delete (single-slot `.aih.bak`
   * backup); `absent` = nothing on disk. */
  effect: "remove" | "delete" | "absent";
  /** Repo-relative destination (`.aih/legacy/…` or `<path>.aih.bak`), when present. */
  to?: string;
}

export interface PlanResult {
  capability: string;
  applied: boolean;
  writes: WriteSummary[];
  docs: {
    describe: string;
    text: string;
    path?: string;
    effect?: "create" | "overwrite" | "unchanged";
  }[];
  probes: { describe: string }[];
  execs: {
    describe: string;
    argv: string[];
    ran: boolean;
    code?: number | null;
    ok?: boolean;
    /** Redacted, tail-bounded child stderr. Present only when the action failed. */
    stderr?: string;
    /** Redacted, tail-bounded child stdout, for children that diagnose there. */
    stdout?: string;
  }[];
  /** Read-only computed reports surfaced verbatim (text) + machine-readable (`data`). */
  digests: { describe: string; text: string; data?: unknown }[];
  backups: string[];
  /** Files aih removed (moved to `.aih/legacy/`) or would remove (dry-run). */
  removed: RemoveSummary[];
  report?: VerificationReport;
  /** Structured verification sidecar; legacy `report` remains the CLI compatibility surface. */
  verification?: VerificationPipelineRun;
}

/** Resolve an action path against the context root (absolute paths pass through). */
function resolvePath(ctx: PlanContext, p: string): string {
  return resolve(ctx.root, p);
}

function localTransactionRoot(ctx: PlanContext, absPath: string): string | undefined {
  const rel = relative(ctx.root, absPath);
  return !rel.startsWith("..") && !isAbsolute(rel) ? ctx.root : undefined;
}

function invalidPlanCommitLock(): never {
  throw new AihError("invalid plan commit lock", "AIH_CONFIG");
}

function externalCommitLockFields(lock: object): { path: string; trustedBase: string } {
  try {
    const keys = Reflect.ownKeys(lock);
    const descriptors = Object.getOwnPropertyDescriptors(lock);
    if (
      Object.getPrototypeOf(lock) !== Object.prototype ||
      keys.length !== 3 ||
      !keys.every((key) => key === "external" || key === "path" || key === "trustedBase")
    )
      invalidPlanCommitLock();
    const external = descriptors.external;
    const path = descriptors.path;
    const trustedBase = descriptors.trustedBase;
    if (
      external === undefined ||
      path === undefined ||
      trustedBase === undefined ||
      !external.enumerable ||
      !path.enumerable ||
      !trustedBase.enumerable ||
      !("value" in external) ||
      !("value" in path) ||
      !("value" in trustedBase) ||
      external.value !== true ||
      typeof path.value !== "string" ||
      typeof trustedBase.value !== "string"
    )
      invalidPlanCommitLock();
    return { path: path.value, trustedBase: trustedBase.value };
  } catch {
    invalidPlanCommitLock();
  }
}

function resolveCommitLock(
  plan: Plan,
  ctx: PlanContext,
): { path: string; root: string } | undefined {
  const lock = plan.commitLock;
  if (lock === undefined) return undefined;
  if (typeof lock === "object") {
    const external = externalCommitLockFields(lock);
    try {
      if (
        !isAbsolute(external.path) ||
        !isAbsolute(external.trustedBase) ||
        !existsSync(external.trustedBase)
      )
        invalidPlanCommitLock();
      const baseInfo = lstatSync(external.trustedBase);
      if (baseInfo.isSymbolicLink() || !baseInfo.isDirectory()) invalidPlanCommitLock();
      const base = realpathSync(external.trustedBase);
      const path = resolve(external.path);
      const rel = relative(base, path);
      if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) invalidPlanCommitLock();
      assertNoSymlinkParents(base, path, external.path);
      return { path, root: base };
    } catch {
      invalidPlanCommitLock();
    }
  }
  if (
    typeof lock !== "string" ||
    !/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(lock) ||
    lock.split("/").some((part) => part === "." || part === "..")
  ) {
    throw new AihError("invalid plan commit lock", "AIH_CONFIG");
  }
  const absPath = resolvePath(ctx, lock);
  assertContained(ctx.root, absPath);
  assertNoSymlinkParents(ctx.root, absPath, lock);
  return { path: absPath, root: ctx.root };
}

/** lstat kind (does not follow links) or `undefined` when the path is absent. */
function lstatKind(p: string): { isSymlink: boolean } | undefined {
  try {
    return { isSymlink: lstatSync(p).isSymbolicLink() };
  } catch {
    return undefined;
  }
}

function assertNoSymlinkParents(root: string, absPath: string, displayPath: string): void {
  const rel = relative(root, absPath);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return;
  const parts = rel.split(/[\\/]+/).filter((part) => part.length > 0);
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = resolve(current, part);
    const info = lstatKind(current);
    if (info === undefined) return;
    if (info.isSymlink) {
      throw new PathContainmentError(
        `refusing to write or remove through a symlinked parent: ${displayPath} (parent ${normalizeRel(
          relative(root, current),
        )})`,
      );
    }
  }
}

/**
 * External writes normally have no containment boundary. A caller that knows a
 * specific trusted base (for example an explicitly supplied HOME) can opt into
 * the same no-follow rule the repo executor uses, without changing legacy host
 * file behavior.
 */
function assertTrustedExternalPath(base: string, absPath: string, displayPath: string): void {
  let baseInfo: ReturnType<typeof lstatSync>;
  try {
    baseInfo = lstatSync(base);
  } catch {
    throw new PathContainmentError(`trusted external base is missing: ${base}`);
  }
  if (!baseInfo.isDirectory() || baseInfo.isSymbolicLink()) {
    throw new PathContainmentError(`trusted external base is not a real directory: ${base}`);
  }
  const rel = relative(base, absPath);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    throw new PathContainmentError(
      `refusing to write outside trusted external base\n  base:   ${base}\n  target: ${absPath}`,
    );
  }
  assertNoSymlinkParents(base, absPath, displayPath);
  if (lstatKind(absPath)?.isSymlink) {
    throw new PathContainmentError(`refusing to write through a symlink: ${displayPath}`);
  }
}

/** realpath, or a plain resolve if the path does not exist yet. */
function realpathSafe(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

function dedupeCommandArrayByNeedle(
  items: readonly unknown[],
  needles: readonly string[],
): unknown[] {
  const seen = new Set<string>();
  const kept: unknown[] = [];
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i];
    const command = isPlainObject(item) && typeof item.command === "string" ? item.command : "";
    const needle = needles.find((n) => command.includes(n));
    if (needle !== undefined) {
      if (seen.has(needle)) continue;
      seen.add(needle);
    }
    kept.push(item);
  }
  return kept.reverse();
}

function updateJsonPath(
  value: unknown,
  path: readonly string[],
  update: (items: readonly unknown[]) => unknown[],
): unknown {
  if (path.length === 0) return Array.isArray(value) ? update(value) : value;
  if (!isPlainObject(value)) return value;
  const [head, ...rest] = path;
  if (head === undefined || !(head in value)) return value;
  const next = updateJsonPath(value[head], rest, update);
  return next === value[head] ? value : { ...value, [head]: next };
}

function dedupeJsonArrayCommands(
  value: unknown,
  specs: Record<string, readonly string[]> | undefined,
): unknown {
  if (specs === undefined) return value;
  let out = value;
  for (const [path, needles] of Object.entries(specs)) {
    out = updateJsonPath(out, path.split("."), (items) =>
      dedupeCommandArrayByNeedle(items, needles),
    );
  }
  return out;
}

/**
 * Fail closed if a repo-scoped action path escapes the target root. Resolves the
 * deepest EXISTING ancestor through realpath first, so a symlinked/junctioned
 * parent that redirects outside the repo is caught (the not-yet-existing suffix
 * cannot contain links). Host/system writes opt out with `external: true`.
 */
function assertContained(root: string, absPath: string): void {
  const realRoot = realpathSafe(root);
  let ancestor = absPath;
  while (!existsSync(ancestor) && dirname(ancestor) !== ancestor) ancestor = dirname(ancestor);
  const tail = relative(ancestor, absPath);
  const finalReal = resolve(realpathSafe(ancestor), tail);
  const rel = relative(realRoot, finalReal);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return;
  throw new PathContainmentError(
    `refusing to write outside the target root\n  root:   ${realRoot}\n  target: ${absPath}\n` +
      "(an absolute path, a `..` escape, or a symlinked parent — pass an in-repo relative path)",
  );
}

/**
 * Write a single, explicitly-requested analysis artifact (e.g. a `--sarif` report)
 * to a repo-contained path, transactionally. Returns the backups created (0 or 1).
 *
 * DESIGN — why this is NOT gated on `--apply`: the harness invariant "no writes
 * without --apply" protects the user's MANAGED project surface (bootloaders,
 * configs, the context dir) from being mutated without consent. A `--sarif` file
 * is not part of that surface — it is a report OUTPUT the operator requested by
 * naming its path on the command line, exactly like `report --out` or a test
 * runner writing `junit.xml`. Naming the path IS the consent. Crucially, the
 * primary use case — `aih bootstrap-ai --verify --sarif results.sarif` feeding
 * GitHub code-scanning — runs the drift gate WITHOUT `--apply` (CI must not
 * regenerate the repo it is gating); apply-gating the artifact would make the flag
 * a no-op in exactly the scenario it exists for, or force `--apply` to also rewrite
 * every bootloader. So the artifact is decoupled from the plan's apply gate — but
 * NOT from its safety machinery: the path is still contained to `root`
 * ({@link assertContained}) and an overwrite is still backed up to `*.aih.bak` via
 * {@link FsTransaction}. Re-writing identical bytes is a no-op (no rewrite, no
 * backup churn), matching {@link executePlan}'s idempotency contract.
 */
export function writeArtifact(ctx: PlanContext, relPath: string, contents: string): string[] {
  const absPath = resolvePath(ctx, relPath);
  assertContained(ctx.root, absPath);
  assertNoSymlinkParents(ctx.root, absPath, relPath);
  const next = ensureTrailingNewline(contents);
  if (readIfExists(absPath) === next) return [];
  const txn = new FsTransaction();
  txn.stage(absPath, next, undefined, undefined, { root: ctx.root });
  return txn.commit().backups;
}

/**
 * Key-order-insensitive rendering, used only to answer "did this key's value
 * change?". `JSON.stringify` cannot answer it: a merge that preserves a value
 * while reordering its members would read as a change, and the key would lose
 * its formatting for nothing.
 */
function structuralJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(structuralJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${structuralJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * The destination's own indentation and line ending, so a key written into it is
 * written in the style the rest of the file already uses. A file with no
 * indented line has no style to honour and takes the same 2-space default
 * {@link jsonFile} renders.
 */
function destinationFormatting(text: string): FormattingOptions {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const indent = /\n([ \t]+)\S/.exec(text)?.[1];
  if (indent === undefined) return { insertSpaces: true, tabSize: 2, eol };
  if (indent.startsWith("\t")) return { insertSpaces: false, tabSize: 1, eol };
  return { insertSpaces: true, tabSize: indent.length, eol };
}

/**
 * Render `value` onto the destination's OWN text, editing only the top-level
 * keys whose value changed. Every other key is never re-emitted, so its
 * comments, indentation and ordering survive byte-for-byte — which is what lets
 * a subtraction claim it left operator content alone (A2). Returns undefined
 * when this is not an object-onto-object edit, and the caller renders the whole
 * file as before.
 *
 * A key that IS edited is re-serialized whole, so a comment inside one does not
 * survive. Callers owning such a key refuse that case themselves rather than
 * strip it silently.
 */
function editedJsonText(source: string, base: unknown, value: unknown): string | undefined {
  if (!isPlainObject(base) || !isPlainObject(value)) return undefined;
  // A duplicated top-level name makes `modify` and every reader of the file
  // disagree about which property they mean, so an in-place edit would land
  // under a shadow and change nothing the client can see. Render the whole file
  // instead: it collapses the duplicates to the value the readers already agree
  // on, in one apply.
  if (duplicateRootKeys(source).length > 0) return undefined;
  const formattingOptions = destinationFormatting(source);
  let text = source;
  // Each `modify` reparses `text`, so this is O(changed keys²) in the file's
  // size. The bound is over CHANGED keys, not all of them, and a client settings
  // file measures sub-millisecond; it is not worth a batched-edit rewrite.
  for (const key of Object.keys(base)) {
    if (Object.hasOwn(value, key)) continue;
    text = applyEdits(text, modify(text, [key], undefined, { formattingOptions }));
  }
  for (const key of Object.keys(value)) {
    if (Object.hasOwn(base, key) && structuralJson(base[key]) === structuralJson(value[key])) {
      continue;
    }
    text = applyEdits(text, modify(text, [key], value[key], { formattingOptions }));
  }
  return text;
}

/** Compute final file contents for a write action, applying JSON merge if requested. */
export function resolveContents(action: WriteAction, absPath: string): string {
  if (action.json !== undefined) {
    let value: unknown = action.json;
    // Only a merge has a destination to preserve: every other JSON write is a
    // whole-file render aih owns outright.
    let source: string | undefined;
    let base: unknown;
    if (action.merge) {
      source = readIfExists(absPath);
      base = source !== undefined ? parseJsoncText(source) : undefined;
      value = base !== undefined ? deepMerge(base, action.json) : action.json;
      value = replaceJsonKeys(value, action.json, action.replaceJsonKeys);
      value = replaceJsonChildKeys(value, action.json, action.replaceJsonChildKeys);
      value = pruneJsonChildKeys(value, action.json, action.pruneJsonChildKeys);
      value = dedupeJsonArrayCommands(value, action.dedupeJsonArrayCommands);
    }
    value = removeJsonKeys(value, action.removeJsonKeys);
    value = removeJsonTopLevelKeys(value, action.removeJsonTopLevelKeys);
    const edited = source === undefined ? undefined : editedJsonText(source, base, value);
    return edited ?? jsonFile(value);
  }
  return action.exactContents === true
    ? (action.contents ?? "")
    : ensureTrailingNewline(action.contents ?? "");
}

/**
 * Of the plan's repo-local targets that are `dirty`, the ones this apply would
 * actually CHANGE (rendered content ≠ disk) — the true clobber set. A `write`/`doc`
 * whose bytes already match disk is a no-op (the main loop records it `unchanged` and
 * writes nothing), so an idempotent re-apply over an uncommitted-but-unchanged file is
 * NOT a clobber and must not gate. A brand-new file (no existing content) and a
 * `write`-once seed can never clobber. `envblock` targets that are dirty are treated
 * conservatively as changes (they recompose a managed block; repo-local ones are rare).
 */
function changedDirtyTargets(plan: Plan, ctx: PlanContext, dirty: Set<string>): string[] {
  const out: string[] = [];
  for (const a of plan.actions) {
    const p =
      a.kind === "write" && a.external !== true
        ? a.path
        : a.kind === "doc" && typeof a.path === "string"
          ? a.path
          : a.kind === "envblock"
            ? a.path
            : undefined;
    if (p === undefined) continue;
    const abs = resolvePath(ctx, p);
    if (!dirty.has(normalizeRel(relative(ctx.root, abs)))) continue;
    if (a.kind === "write" && a.external !== true) {
      assertContained(ctx.root, abs);
      assertNoSymlinkParents(ctx.root, abs, a.path);
    }
    if (a.kind === "doc" && typeof a.path === "string") {
      assertContained(ctx.root, abs);
      assertNoSymlinkParents(ctx.root, abs, a.path);
    }
    const existing = readIfExists(abs);
    if (
      a.kind === "write" &&
      (existing === undefined || a.once || resolveContents(a, abs) === existing)
    ) {
      continue;
    }
    if (a.kind === "doc" && existing === ensureTrailingNewline(a.text)) continue;
    out.push(normalizeRel(relative(ctx.root, abs)));
  }
  return out;
}

/**
 * Execute a plan. In dry-run (`ctx.apply === false`) nothing is written — the
 * result still reports exactly what would change. With `ctx.apply` writes are
 * committed transactionally; with `ctx.verify` probe actions run and populate a
 * {@link VerificationReport}.
 */
export async function executePlan(
  plan: Plan,
  ctx: PlanContext,
  opts: { skipWorktreeGate?: boolean } = {},
): Promise<PlanResult> {
  const commitNotAfter = parseCommitNotAfter(plan.commitNotAfter);
  const commitLock = resolveCommitLock(plan, ctx);
  // Dirty-worktree --apply preflight: refuse only when this apply would write over a
  // file that ITSELF has uncommitted changes — the precise "clobber your work" case —
  // not merely because some unrelated file in the repo is dirty. So creating a new
  // `opencode.json` is allowed on a repo that just has an untracked `codex/` dir
  // elsewhere, while regenerating a `CLAUDE.md` you have uncommitted edits to still
  // gates. `external` writes (global ~/home configs) and write-free runs are never
  // gated; `skipWorktreeGate` exempts pure-analytics commands (`aih report`, whose only
  // writes are gitignored OUTPUT artifacts). The check runs BEFORE anything is staged,
  // so a refusal leaves the worktree byte-for-byte unchanged; git goes through the
  // read-only Runner seam (git-absent / not-a-repo → nothing dirty → not gated).
  if (ctx.apply && opts.skipWorktreeGate !== true && ctx.options.force !== true) {
    const dirtyTargets = new Set(await dirtyWriteTargets(plan, ctx));
    // Effect-aware: a dirty target is only a real clobber if THIS write would change
    // its content. A write whose rendered bytes already match disk is a no-op (the loop
    // below records it `unchanged` and writes nothing), so re-running `aih mcp --apply`
    // over a still-uncommitted but unchanged config must not be blocked.
    const clobbered = dirtyTargets.size === 0 ? [] : changedDirtyTargets(plan, ctx, dirtyTargets);
    // Removals gate on dirty-set MEMBERSHIP directly (no content-equality filter — a
    // removal always destroys the file, so a dirty/untracked removal target is always a
    // clobber). This is the case the write-only gate would silently miss.
    const removedDirty = await dirtyRemoveTargets(plan, ctx);
    const blocked = [...clobbered, ...removedDirty];
    if (blocked.length > 0) {
      const list = blocked.join(", ");
      // Say what would actually happen: dirty REMOVAL targets get removed, not
      // overwritten — "overwrite" alone under-states the risk of reaching for --force.
      const verb = removedDirty.length > 0 ? "overwrite or remove" : "overwrite";
      throw new DirtyWorktreeError(
        `Refusing to ${verb} uncommitted changes in: ${list}. Commit or stash ${
          blocked.length > 1 ? "them" : "it"
        } first, or pass --force.`,
      );
    }
  }

  const transactionOptions = {
    commitNotAfter,
    ...(commitLock === undefined ? {} : { commitLock }),
  };
  const txn = new FsTransaction(transactionOptions);
  const deferredTxn = new FsTransaction(transactionOptions);
  for (const assertion of plan.fileAssertions ?? []) {
    if (
      !/^[a-f0-9]{64}$/.test(assertion.sha256) ||
      !Number.isSafeInteger(assertion.maxBytes) ||
      assertion.maxBytes < 0
    )
      throw new AihError("invalid transaction file assertion", "AIH_CONFIG");
    const absPath = resolvePath(ctx, assertion.path);
    assertContained(ctx.root, absPath);
    assertNoSymlinkParents(ctx.root, absPath, assertion.path);
    if (ctx.apply) {
      txn.stageAssertion(
        absPath,
        assertion.sha256,
        assertion.describe,
        ctx.root,
        assertion.maxBytes,
      );
      deferredTxn.stageAssertion(
        absPath,
        assertion.sha256,
        assertion.describe,
        ctx.root,
        assertion.maxBytes,
      );
    }
  }
  const sensitiveBackupTargets = new Set<string>();
  const writes: WriteSummary[] = [];
  const docs: PlanResult["docs"] = [];
  const probes: PlanResult["probes"] = [];
  const digests: PlanResult["digests"] = [];
  const removes: RemoveSummary[] = [];
  const digestActions: DigestAction[] = [];
  const execActions: ExecAction[] = [];
  const envBlockActions: EnvBlockAction[] = [];

  for (const action of plan.actions) {
    if (action.kind === "write") {
      const absPath = resolvePath(ctx, action.path);
      if (!action.external) {
        assertContained(ctx.root, absPath);
        assertNoSymlinkParents(ctx.root, absPath, action.path);
      } else if (action.trustedBase !== undefined) {
        assertTrustedExternalPath(action.trustedBase, absPath, action.path);
      }
      const existing = readIfExists(absPath);
      if (ctx.apply && action.expect !== undefined) {
        const live =
          existing === undefined
            ? undefined
            : createHash("sha256").update(existing, "utf8").digest("hex");
        const unchanged =
          "absent" in action.expect ? existing === undefined : live === action.expect.sha256;
        if (!unchanged) {
          throw new AihError(
            `refusing to write ${action.path} — it changed after the plan was computed; re-run the command`,
            "AIH_TRUST",
          );
        }
      }
      if (action.once && existing !== undefined) {
        // Write-once seed file already present — preserve the user's content.
        writes.push({
          path: collectedPath(action),
          describe: action.describe,
          merged: false,
          effect: "kept",
        });
      } else {
        const contents = resolveContents(action, absPath);
        // Skip a write whose rendered content already matches disk — true idempotency:
        // no rewrite, no `.aih.bak`, surfaced as `unchanged` in the plan.
        const effect: WriteSummary["effect"] =
          existing === undefined
            ? "create"
            : existing === contents
              ? "unchanged"
              : action.merge
                ? "merge"
                : "overwrite";
        if (action.assertUnchanged) {
          if (action.expect === undefined || "absent" in action.expect || effect !== "unchanged") {
            throw new AihError(`invalid unchanged-file assertion for ${action.path}`, "AIH_CONFIG");
          }
          if (ctx.apply) {
            const targetTxn = action.requiresPriorExecSuccess ? deferredTxn : txn;
            targetTxn.stageAssertion(
              absPath,
              action.expect.sha256,
              action.describe,
              action.external ? action.trustedBase : ctx.root,
            );
          }
        } else if (ctx.apply && effect !== "unchanged") {
          const targetTxn = action.requiresPriorExecSuccess ? deferredTxn : txn;
          targetTxn.stage(absPath, contents, action.mode, action.expect, {
            root: action.external ? action.trustedBase : ctx.root,
            durable: action.durable,
            expectScratch: action.expectScratch,
          });
          if (action.sensitive?.path) sensitiveBackupTargets.add(absPath);
        }
        writes.push({
          path: collectedPath(action),
          describe: action.describe,
          merged: Boolean(action.merge),
          effect,
        });
      }
    } else if (action.kind === "doc") {
      if (action.path) {
        const absPath = resolvePath(ctx, action.path);
        // Contain doc-file writes too (they are repo-scoped guidance, never external),
        // BEFORE the readIfExists below follows the path — so a symlinked/escaping doc
        // path can neither leak an out-of-repo read nor redirect the write.
        assertContained(ctx.root, absPath);
        assertNoSymlinkParents(ctx.root, absPath, action.path);
        const existing = readIfExists(absPath);
        const contents = ensureTrailingNewline(action.text);
        // Same idempotency contract as write actions: skip a doc-file write whose
        // rendered content already matches disk, so re-running never rewrites it or
        // churns a `.aih.bak`. (The guardrails taxonomy doc was re-backed-up every run.)
        const effect: NonNullable<PlanResult["docs"][number]["effect"]> =
          existing === undefined ? "create" : existing === contents ? "unchanged" : "overwrite";
        if (ctx.apply && effect !== "unchanged") {
          txn.stage(absPath, contents, undefined, undefined, { root: ctx.root });
        }
        docs.push({ describe: action.describe, text: action.text, path: action.path, effect });
      } else {
        docs.push({ describe: action.describe, text: action.text });
      }
    } else if (action.kind === "exec") {
      execActions.push(action);
    } else if (action.kind === "envblock") {
      envBlockActions.push(action);
    } else if (action.kind === "digest") {
      digestActions.push(action);
    } else if (action.kind === "remove") {
      const absPath = resolvePath(ctx, action.path);
      // Fail closed BEFORE touching disk: contain the raw path (a symlinked or `..`
      // escaping target realpaths outside the root → throws), then refuse a symlink
      // outright, including symlinked parents. aih only removes plain files it wrote,
      // and moving/restoring a link would silently recreate a regular file (or
      // re-establish an escape / dirty-gate bypass through an alternate path).
      assertContained(ctx.root, absPath);
      assertNoSymlinkParents(ctx.root, absPath, action.path);
      const info = lstatKind(absPath);
      if (info?.isSymlink) {
        throw new PathContainmentError(
          `refusing to remove a symlink: ${action.path} (aih only removes files it wrote)`,
        );
      }
      if (info === undefined) {
        removes.push({ path: action.path, describe: action.describe, effect: "absent" });
      } else {
        // Default = reversible archive move (to `archiveRoot`, a closed union that
        // defaults to `.aih/legacy`); `hardDelete` = the explicit opt-out, a
        // single-slot rename to the sibling `<path>.aih.bak` (the same latest-wins
        // convention every write backup uses; `*.aih.bak` is gitignored).
        const destRel = action.hardDelete
          ? `${normalizeRel(action.path)}.aih.bak`
          : `${action.archiveRoot ?? ".aih/legacy"}/${normalizeRel(action.path)}`;
        const destAbs = resolvePath(ctx, destRel);
        // Contain the DESTINATION too, not just the source: if `.aih/` (or any parent
        // of the destination path) is a symlink escaping the repo, the move would rename
        // the file OUTSIDE the root. assertContained realpaths the deepest existing
        // ancestor, so a symlinked parent — or a `..` surviving in the path — trips it.
        assertContained(ctx.root, destAbs);
        assertNoSymlinkParents(ctx.root, destAbs, destRel);
        if (ctx.apply)
          txn.stageRemoval(absPath, destAbs, {
            backupSibling: action.hardDelete,
            expect: action.expect,
            root: ctx.root,
          });
        removes.push({
          path: action.path,
          describe: action.describe,
          effect: action.hardDelete ? "delete" : "remove",
          to: destRel,
        });
      }
    } else if (action.kind === "probe") {
      probes.push({ describe: action.describe });
    } else {
      const unknown = action as { kind?: unknown; describe?: unknown };
      throw new AihError(
        `unknown plan action kind: ${String(unknown.kind)} (${String(unknown.describe ?? "")})`,
        "AIH_CONFIG",
      );
    }
  }

  // Fold env-block actions per file so multiple scopes COMPOSE (rather than the
  // last write clobbering earlier ones): start from on-disk content and upsert
  // each scope's managed block in order.
  const envByPath = new Map<
    string,
    {
      display: string;
      blocks: EnvBlockAction[];
      sensitive: boolean;
      requiresPriorExecSuccess: boolean;
    }
  >();
  for (const b of envBlockActions) {
    const abs = resolvePath(ctx, b.path);
    const group = envByPath.get(abs) ?? {
      display: b.path,
      blocks: [],
      sensitive: false,
      requiresPriorExecSuccess: false,
    };
    group.blocks.push(b);
    group.sensitive ||= b.sensitive?.path === true;
    group.requiresPriorExecSuccess ||= b.requiresPriorExecSuccess === true;
    envByPath.set(abs, group);
  }
  for (const [absPath, { display, blocks, sensitive, requiresPriorExecSuccess }] of envByPath) {
    const existing = readIfExists(absPath);
    let content = existing ?? "";
    for (const b of blocks) {
      content = upsertManagedBlock(content, b.scope, b.vars, b.shell, b.unsetKeys);
    }
    const effect: WriteSummary["effect"] =
      existing === undefined ? "create" : existing === content ? "unchanged" : "merge";
    if (ctx.apply && effect !== "unchanged") {
      const targetTxn = requiresPriorExecSuccess ? deferredTxn : txn;
      targetTxn.stage(absPath, content, undefined, undefined, {
        root: localTransactionRoot(ctx, absPath),
      });
      if (sensitive) sensitiveBackupTargets.add(absPath);
    }
    writes.push({
      path: sensitive ? REDACTED_PATH : display,
      describe: `managed env block(s): ${blocks.map((b) => b.scope).join(", ")}`,
      merged: true,
      effect,
    });
  }

  let backups: string[] = [];
  if (ctx.apply) {
    const committed = txn.commit();
    backups = committed.backups.map((backup) =>
      isSensitiveBackup(backup, sensitiveBackupTargets) ? REDACTED_PATH : backup,
    );
    // Reconcile each removal summary's `to` with the destination commit ACTUALLY
    // chose. A hard-delete whose `<path>.aih.bak` slot is occupied never overwrites
    // it — it lands at `<path>.1.aih.bak` — so the planned `to` would misdirect the
    // user's restore. `committed.removed[].path` is the absolute source we staged.
    const actualDest = new Map(
      committed.removed.map((r) => [r.path, normalizeRel(relative(ctx.root, r.legacyPath))]),
    );
    for (const summary of removes) {
      const dest = actualDest.get(resolvePath(ctx, summary.path));
      if (dest !== undefined) summary.to = dest;
    }
  }

  let deferredCommitted = false;
  const commitDeferredWrites = (): void => {
    if (!ctx.apply || deferredCommitted) return;
    const committed = deferredTxn.commit();
    deferredCommitted = true;
    backups.push(
      ...committed.backups.map((backup) =>
        isSensitiveBackup(backup, sensitiveBackupTargets) ? REDACTED_PATH : backup,
      ),
    );
  };

  // Local mutating commands run only on apply, after files are in place.
  const execs: PlanResult["execs"] = [];
  const execFailureChecks: Check[] = [];
  let skipProbesAfterExecFailure = false;
  let priorExecFailed = false;
  for (const a of execActions) {
    if (ctx.apply) {
      if (priorExecFailed && a.requiresPriorExecSuccess) {
        execs.push({ describe: a.describe, argv: collectedArgv(a), ran: false });
        continue;
      }
      if (a.expect !== undefined) {
        // Apply-time content pin: the command must consume the exact bytes the
        // plan preflighted. ONE read (no stat-then-read window), hashed the same
        // way the pin was computed; a missing file and a swapped file both abort
        // the apply BEFORE the command runs — nothing is spawned over content
        // the plan never graded.
        let live: string | undefined;
        const expectPath = isAbsolute(a.expect.path)
          ? a.expect.path
          : resolvePath(ctx, a.expect.path);
        try {
          live = createHash("sha256")
            .update(readFileSync(expectPath, "utf8"), "utf8")
            .digest("hex");
        } catch {
          live = undefined;
        }
        if (live !== a.expect.sha256) {
          throw new AihError(
            `refusing to run "${a.describe}" — ${a.expect.path} changed after the plan was ` +
              `computed (expected ${a.expect.sha256.slice(0, 12)}…, found ${
                live !== undefined ? `${live.slice(0, 12)}…` : "missing"
              }); re-run the command`,
            "AIH_TRUST",
          );
        }
      }
      const res = await ctx.run(a.argv, { cwd: a.cwd, env: a.env, timeoutMs: a.timeoutMs });
      const ok = res.code === 0 || Boolean(a.allowFailure);
      // A failing child already wrote a good diagnostic; carry it so the exit
      // code is not the only evidence the operator gets. Successful runs stay
      // out of the envelope — that output is noise, and children can be chatty.
      const stderr = ok ? undefined : surfacedChildOutput(res.stderr);
      const stdout = ok ? undefined : surfacedChildOutput(res.stdout);
      execs.push({
        describe: a.describe,
        argv: collectedArgv(a),
        ran: true,
        code: res.code,
        ok,
        ...(stderr === undefined ? {} : { stderr }),
        ...(stdout === undefined ? {} : { stdout }),
      });
      if (!ok) {
        priorExecFailed = true;
        if (a.failureCheck) {
          execFailureChecks.push(
            typeof a.failureCheck === "function" ? a.failureCheck(res) : a.failureCheck,
          );
        }
        if (a.blockProbesOnFailure) skipProbesAfterExecFailure = true;
      }
    } else {
      execs.push({ describe: a.describe, argv: collectedArgv(a), ran: false });
    }
  }
  if (!priorExecFailed) commitDeferredWrites();

  let report: VerificationReport | undefined;
  let verification: VerificationPipelineRun | undefined;
  if (ctx.verify) {
    const verificationEntries: VerificationEntry[] = [];
    for (const check of execFailureChecks) {
      verificationEntries.push(legacyVerificationEntry(check));
    }
    if (!skipProbesAfterExecFailure) {
      for (const action of plan.actions) {
        if (action.kind === "probe") {
          if (action.runStructuredLegacy) {
            const structuredLegacyRun = await action.runStructuredLegacy(ctx);
            verificationEntries.push(...structuredLegacyVerificationEntries(structuredLegacyRun));
          } else if (action.runStructured) {
            const structuredRun = await action.runStructured(ctx);
            verificationEntries.push(...structuredVerificationEntries(action, structuredRun));
          } else if (action.runMany) {
            for (const check of await action.runMany(ctx)) {
              verificationEntries.push(legacyVerificationEntry(check));
            }
          } else if (action.run) {
            const check = await action.run(ctx);
            verificationEntries.push(legacyVerificationEntry(check));
          } else {
            throw new AihError(`probe action has no runner: ${action.describe}`, "AIH_CONFIG");
          }
        }
      }
    }
    verification = verificationRunFromEntries(verificationEntries);
    report = reportFromVerificationEntries(verificationEntries);
  }

  for (const action of digestActions) {
    const evaluated =
      action.run !== undefined
        ? await action.run(ctx)
        : { text: action.text ?? "", data: action.data };
    const text = typeof evaluated === "string" ? evaluated : evaluated.text;
    const data = typeof evaluated === "string" ? action.data : evaluated.data;
    // The single source-side redaction chokepoint: mask secrets in the digest
    // body HERE, upstream of every renderer, so BOTH the human summary and the
    // `--json` output carry the redacted text — automation reading `--json` is
    // the case that matters most. `data` is the raw structured payload; callers
    // must not embed secrets there (recursively redacting arbitrary JSON would
    // risk corrupting legitimate values).
    digests.push({
      describe: action.describe,
      text: redactSecrets(text),
      data,
    });
  }

  return {
    capability: plan.capability,
    applied: ctx.apply,
    writes,
    docs,
    probes,
    execs,
    digests,
    backups,
    removed: removes,
    report,
    verification,
  };
}

/** Human-readable summary of a plan result (used when --json is off). */
export function summarizeResult(
  result: PlanResult,
  options: { readonly readOnly?: boolean } = {},
): string {
  // "Applied" must mean a mutation was committed. A plan whose only actions are
  // docs/digests/probes writes nothing even under --apply (e.g. an analytics-only
  // command, or an idempotent re-run with no diff), so claiming "Applied" would be
  // misleading. envblock upserts fold into `writes`, so writes+execs+backups cover
  // every mutating outcome.
  const removedAny = result.removed.some((r) => r.effect !== "absent");
  const mutated =
    result.writes.some((w) => w.effect !== "unchanged" && w.effect !== "kept") ||
    result.docs.some((d) => d.effect !== undefined && d.effect !== "unchanged") ||
    result.execs.some((e) => e.ran) ||
    result.backups.length > 0 ||
    removedAny;
  const head = result.applied
    ? mutated
      ? `Applied ${result.capability}`
      : `${result.capability}: nothing to apply — the plan produced no writes or execs`
    : options.readOnly === true
      ? `Plan for ${result.capability} (read-only — nothing written)`
      : `Plan for ${result.capability} (dry-run — nothing written; pass --apply to execute)`;
  const out: string[] = [head];
  for (const w of result.writes) {
    out.push(`  [${w.effect}] ${w.path} — ${w.describe}`);
  }
  for (const r of result.removed) {
    out.push(
      r.effect === "remove"
        ? `  [remove] ${r.path} — ${r.describe} (→ ${r.to})`
        : r.effect === "delete"
          ? `  [delete] ${r.path} — ${r.describe} (backup: ${r.to})`
          : `  [absent] ${r.path} — ${r.describe}`,
    );
  }
  for (const d of result.docs) {
    out.push(`  [doc]${d.path ? ` ${d.path}` : ""} — ${d.describe}`);
    out.push(indent(stripTrailingNewlines(d.text), 2));
  }
  for (const dg of result.digests) {
    out.push(`  [digest] — ${dg.describe}`);
    // Already redacted at the digest-collection chokepoint in executePlan, so the
    // text here (and in `--json`) is consistently masked — no re-redaction needed.
    out.push(indent(stripTrailingNewlines(dg.text), 2));
  }
  for (const e of result.execs) {
    const status = e.ran ? ` (exit ${e.code})` : " (run with --apply)";
    out.push(`  [exec] ${formatArgv(e.argv)} — ${e.describe}${status}`);
    // Already redacted and bounded at the collection chokepoint in executePlan,
    // so this text and the `--json` envelope carry the same masked body.
    if (e.stderr) {
      out.push("    stderr:");
      out.push(indent(stripTrailingNewlines(e.stderr), 6));
    }
    if (e.stdout) {
      out.push("    stdout:");
      out.push(indent(stripTrailingNewlines(e.stdout), 6));
    }
  }
  // Only list probes when there's no report to supersede them; otherwise the
  // Verification section below already shows each check with its verdict + detail
  // (listing both just duplicates every line).
  if (!result.report) {
    for (const p of result.probes) {
      out.push(`  [probe] ${p.describe} (run with --verify)`);
    }
  }
  // Only show the verification section when a probe actually ran. A command that
  // always-verifies but has no probes this run (e.g. a bare `aih report` without
  // `--gate`) produces an empty report — printing "0 passed" would be noise.
  if (result.report && result.report.checks.length > 0) {
    out.push("Verification:");
    out.push(result.report.summary());
  }
  if (result.backups.length > 0) {
    out.push(`  backups: ${result.backups.length} file(s) saved as *.aih.bak`);
  }
  return out.join("\n");
}

function formatArgv(argv: readonly string[]): string {
  return argv.map(formatArg).join(" ");
}

function formatArg(arg: string): string {
  return /^[A-Za-z0-9_./:=@%+-]+$/.test(arg) ? arg : JSON.stringify(arg);
}
