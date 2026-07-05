import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
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
import { deepMerge, parseJsoncText } from "./merge.js";
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
import { ensureTrailingNewline, indent, jsonFile, stripTrailingNewlines } from "./render.js";
import { type Check, VerificationReport } from "./verify.js";
import { dirtyRemoveTargets, dirtyWriteTargets, normalizeRel } from "./worktree-gate.js";

const VERIFICATION_TRUNCATION_SUFFIX = "... [truncated]";

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
  docs: { describe: string; path?: string }[];
  probes: { describe: string }[];
  execs: { describe: string; argv: string[]; ran: boolean; code?: number | null; ok?: boolean }[];
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
        `refusing to remove through a symlinked parent: ${displayPath} (parent ${normalizeRel(
          relative(root, current),
        )})`,
      );
    }
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
  const next = ensureTrailingNewline(contents);
  if (readIfExists(absPath) === next) return [];
  const txn = new FsTransaction();
  txn.stage(absPath, next);
  return txn.commit().backups;
}

/** Compute final file contents for a write action, applying JSON merge if requested. */
export function resolveContents(action: WriteAction, absPath: string): string {
  if (action.json !== undefined) {
    let value: unknown = action.json;
    if (action.merge) {
      const existing = readIfExists(absPath);
      const base = existing !== undefined ? parseJsoncText(existing) : undefined;
      value = base !== undefined ? deepMerge(base, action.json) : action.json;
      value = replaceJsonKeys(value, action.json, action.replaceJsonKeys);
      value = replaceJsonChildKeys(value, action.json, action.replaceJsonChildKeys);
      value = pruneJsonChildKeys(value, action.json, action.pruneJsonChildKeys);
    }
    value = removeJsonKeys(value, action.removeJsonKeys);
    value = removeJsonTopLevelKeys(value, action.removeJsonTopLevelKeys);
    return jsonFile(value);
  }
  return ensureTrailingNewline(action.contents ?? "");
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

  const txn = new FsTransaction();
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
      if (!action.external) assertContained(ctx.root, absPath);
      const existing = readIfExists(absPath);
      if (action.once && existing !== undefined) {
        // Write-once seed file already present — preserve the user's content.
        writes.push({
          path: action.path,
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
        if (ctx.apply && effect !== "unchanged") txn.stage(absPath, contents, action.mode);
        writes.push({
          path: action.path,
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
        const contents = ensureTrailingNewline(action.text);
        // Same idempotency contract as write actions: skip a doc-file write whose
        // rendered content already matches disk, so re-running never rewrites it or
        // churns a `.aih.bak`. (The guardrails taxonomy doc was re-backed-up every run.)
        if (ctx.apply && readIfExists(absPath) !== contents) {
          txn.stage(absPath, contents);
        }
      }
      docs.push({ describe: action.describe, path: action.path });
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
        if (ctx.apply) txn.stageRemoval(absPath, destAbs, { backupSibling: action.hardDelete });
        removes.push({
          path: action.path,
          describe: action.describe,
          effect: action.hardDelete ? "delete" : "remove",
          to: destRel,
        });
      }
    } else {
      probes.push({ describe: action.describe });
    }
  }

  // Fold env-block actions per file so multiple scopes COMPOSE (rather than the
  // last write clobbering earlier ones): start from on-disk content and upsert
  // each scope's managed block in order.
  const envByPath = new Map<string, { display: string; blocks: EnvBlockAction[] }>();
  for (const b of envBlockActions) {
    const abs = resolvePath(ctx, b.path);
    const group = envByPath.get(abs) ?? { display: b.path, blocks: [] };
    group.blocks.push(b);
    envByPath.set(abs, group);
  }
  for (const [absPath, { display, blocks }] of envByPath) {
    const existing = readIfExists(absPath);
    let content = existing ?? "";
    for (const b of blocks) {
      content = upsertManagedBlock(content, b.scope, b.vars, b.shell);
    }
    const effect: WriteSummary["effect"] =
      existing === undefined ? "create" : existing === content ? "unchanged" : "merge";
    if (ctx.apply && effect !== "unchanged") txn.stage(absPath, content);
    writes.push({
      path: display,
      describe: `managed env block(s): ${blocks.map((b) => b.scope).join(", ")}`,
      merged: true,
      effect,
    });
  }

  let backups: string[] = [];
  if (ctx.apply) {
    const committed = txn.commit();
    backups = committed.backups;
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

  // Local mutating commands run only on apply, after files are in place.
  const execs: PlanResult["execs"] = [];
  const execFailureChecks: Check[] = [];
  let skipProbesAfterExecFailure = false;
  for (const a of execActions) {
    if (ctx.apply) {
      if (a.expect !== undefined) {
        // Apply-time content pin: the command must consume the exact bytes the
        // plan preflighted. ONE read (no stat-then-read window), hashed the same
        // way the pin was computed; a missing file and a swapped file both abort
        // the apply BEFORE the command runs — nothing is spawned over content
        // the plan never graded.
        let live: string | undefined;
        try {
          live = createHash("sha256")
            .update(readFileSync(a.expect.path, "utf8"), "utf8")
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
      execs.push({
        describe: a.describe,
        argv: a.argv,
        ran: true,
        code: res.code,
        ok,
      });
      if (!ok && a.failureCheck) {
        execFailureChecks.push(
          typeof a.failureCheck === "function" ? a.failureCheck(res) : a.failureCheck,
        );
        if (a.blockProbesOnFailure) skipProbesAfterExecFailure = true;
      }
    } else {
      execs.push({ describe: a.describe, argv: a.argv, ran: false });
    }
  }

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
export function summarizeResult(result: PlanResult): string {
  // "Applied" must mean a mutation was committed. A plan whose only actions are
  // docs/digests/probes writes nothing even under --apply (e.g. an analytics-only
  // command, or an idempotent re-run with no diff), so claiming "Applied" would be
  // misleading. envblock upserts fold into `writes`, so writes+execs+backups cover
  // every mutating outcome.
  const removedAny = result.removed.some((r) => r.effect !== "absent");
  const mutated =
    result.writes.length > 0 ||
    result.execs.some((e) => e.ran) ||
    result.backups.length > 0 ||
    removedAny;
  const head = result.applied
    ? mutated
      ? `Applied ${result.capability}`
      : `${result.capability}: nothing to apply — the plan produced no writes or execs`
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
  }
  for (const dg of result.digests) {
    out.push(`  [digest] — ${dg.describe}`);
    // Already redacted at the digest-collection chokepoint in executePlan, so the
    // text here (and in `--json`) is consistently masked — no re-redaction needed.
    out.push(indent(stripTrailingNewlines(dg.text), 2));
  }
  for (const e of result.execs) {
    const status = e.ran ? ` (exit ${e.code})` : " (run with --apply)";
    out.push(`  [exec] ${e.argv.join(" ")} — ${e.describe}${status}`);
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
