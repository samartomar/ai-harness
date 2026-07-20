import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import { AihError } from "../../../errors.js";
import { readIfExists, retryTransient } from "../../../internals/fsxn.js";
import { isPlainObject, parseJsoncText } from "../../../internals/merge.js";
import type {
  ClaudeContaminationReport,
  ContaminationEntry,
  ContaminationSurface,
  FrameworkAttribution,
} from "./contamination.js";
import { assertSafeKey, isSafeRelPosixPath } from "./surfaces.js";

/**
 * Opt-in, PREVIEWED cleanup remediation for USER-scope Claude contamination — the
 * machinery the physical-laptop sign-off depends on (its real polluted state is the
 * first target). Three phases, explicitly separated (D14 plan/apply):
 *
 *   1. {@link planClaudeCleanup} — a pure, JSON-serializable PREVIEW derived from a
 *      contamination report. It plans the migration/disable of FRAMEWORK-ATTRIBUTED
 *      surfaces only (unknown surfaces are opt-in via `includeUnknown`). It NEVER
 *      deletes a whole shared JSON file — only targeted key/hook removals mirroring
 *      D18 field-level discipline — and never touches anything outside `~/.claude/**`
 *      or `~/.mcp.json`.
 *   2. {@link applyClaudeCleanup} — executes BACKUP-FIRST: every affected file (and
 *      full dirs for removed trees) is copied into a timestamped backup root under
 *      `<home>/.aih/cleanup-backup/<runId>/` with a schema-validated `manifest.json`
 *      recording every step + original paths + digests. Only AFTER the manifest is
 *      durably written do removals/edits run; a mid-apply error stops, preserves the
 *      backup, and reports completed vs pending (fail closed).
 *   3. {@link rollbackClaudeCleanup} — restores from the manifest, validating each
 *      backup file against its recorded digest and refusing a manifest that fails
 *      schema or digest checks (a drifted entry is skipped + reported, never
 *      overwritten).
 *
 * WRITE MECHANISM. The shared `executePlan` engine is root-contained against the
 * PROJECT root; cleanup targets the HOME scope, so routing through it adds no safety.
 * Direct, well-tested `node:fs` code with the manifest-first ordering as the safety
 * net is used instead — every destructive step stays behind the durable manifest.
 */

/** A cleanup-remediation error. Fails closed on any write-path ambiguity. */
export class ClaudeCleanupError extends AihError {
  constructor(message: string) {
    super(message, "AIH_BINDING_CLAUDE_CLEANUP");
  }
}

/** `backup-then-remove` = copy tree then delete it; `backup-then-disable` = backup JSON then targeted key/hook removal. */
export type ClaudeCleanupAction = "backup-then-remove" | "backup-then-disable";

/** How a `backup-then-disable` step edits its JSON file (targeted, never whole-file). */
export type ClaudeCleanupEdit =
  | { kind: "json-key"; container: string; key: string }
  | { kind: "hook"; event: string; command: string };

/** One preview/apply step. JSON-serializable. */
export interface ClaudeCleanupStep {
  action: ClaudeCleanupAction;
  surface: ContaminationSurface;
  attribution: FrameworkAttribution;
  /** Home-relative POSIX path: the tree to remove, or the JSON file to edit. */
  path: string;
  /** Present only for `backup-then-disable`. */
  edit?: ClaudeCleanupEdit;
}

export interface ClaudeCleanupPlan {
  schemaVersion: 1;
  /** Whether unknown-attribution surfaces were folded into `steps`. */
  includeUnknown: boolean;
  /** The steps to apply (the PREVIEW shown to the user). */
  steps: ClaudeCleanupStep[];
  /** Surfaces present in the report but left alone (unknown attribution, when not opted in). */
  skipped: ClaudeCleanupStep[];
}

export interface ClaudeCleanupPlanOptions {
  /** Opt in to remediating `unknown`-attribution surfaces too (default false). */
  includeUnknown?: boolean;
}

// -- Target allowlists (defense in depth; enforced at plan AND apply) ---------

/** A `backup-then-remove` target must be a safe path under one of these owned-file roots. */
const CLEANUP_REMOVE_ROOTS: readonly string[] = [
  ".claude/skills/",
  ".claude/agents/",
  ".claude/rules/",
];
/** A `backup-then-disable` step may only edit one of these shared JSON files. */
const CLEANUP_DISABLE_FILES: readonly string[] = [".claude/settings.json", ".mcp.json"];
/** The only top-level JSON containers a targeted key-removal may touch. */
const DISABLE_CONTAINERS: ReadonlySet<string> = new Set(["enabledPlugins", "mcpServers"]);

function assertRemovableTarget(rel: string): void {
  if (!isSafeRelPosixPath(rel) || !CLEANUP_REMOVE_ROOTS.some((root) => rel.startsWith(root))) {
    throw new ClaudeCleanupError(
      `refusing cleanup remove target ${JSON.stringify(rel)} — must be a safe path under ${CLEANUP_REMOVE_ROOTS.join(", ")}`,
    );
  }
}

function assertDisableFile(rel: string): void {
  if (!CLEANUP_DISABLE_FILES.includes(rel)) {
    throw new ClaudeCleanupError(
      `refusing cleanup disable target ${JSON.stringify(rel)} — only ${CLEANUP_DISABLE_FILES.join(", ")} may be edited`,
    );
  }
}

// -- Phase 1: plan ------------------------------------------------------------

/**
 * Build the cleanup PREVIEW from a contamination report. Framework-attributed
 * surfaces are planned; `unknown`-attribution surfaces are set aside in `skipped`
 * unless `includeUnknown` is set. Every step's target is validated here (and again
 * at apply) so a malformed report can never produce an out-of-scope write.
 */
export function planClaudeCleanup(
  report: ClaudeContaminationReport,
  opts: ClaudeCleanupPlanOptions = {},
): ClaudeCleanupPlan {
  const includeUnknown = opts.includeUnknown ?? false;
  const steps: ClaudeCleanupStep[] = [];
  const skipped: ClaudeCleanupStep[] = [];
  for (const entry of report.entries) {
    const step = stepForEntry(entry);
    if (entry.attribution === "unknown" && !includeUnknown) skipped.push(step);
    else steps.push(step);
  }
  return { schemaVersion: 1, includeUnknown, steps, skipped };
}

function stepForEntry(entry: ContaminationEntry): ClaudeCleanupStep {
  const common = { surface: entry.surface, attribution: entry.attribution } as const;
  switch (entry.surface) {
    case "skill":
    case "agent":
    case "rule":
      assertRemovableTarget(entry.path);
      return { action: "backup-then-remove", ...common, path: entry.path };
    case "plugin":
      assertDisableFile(entry.path);
      assertSafeKey(entry.name);
      return {
        action: "backup-then-disable",
        ...common,
        path: entry.path,
        edit: { kind: "json-key", container: "enabledPlugins", key: entry.name },
      };
    case "mcpServer":
      assertDisableFile(entry.path);
      assertSafeKey(entry.name);
      return {
        action: "backup-then-disable",
        ...common,
        path: entry.path,
        edit: { kind: "json-key", container: "mcpServers", key: entry.name },
      };
    case "hook":
      assertDisableFile(entry.path);
      return {
        action: "backup-then-disable",
        ...common,
        path: entry.path,
        edit: { kind: "hook", event: entry.name, command: entry.command ?? "" },
      };
  }
}

// -- Manifest schema (zod) ----------------------------------------------------

const SHA256_HEX = /^[0-9a-f]{64}$/;

const CleanupEditSchema = z.union([
  z.object({ kind: z.literal("json-key"), container: z.string(), key: z.string() }).strict(),
  z.object({ kind: z.literal("hook"), event: z.string(), command: z.string() }).strict(),
]);

const CleanupBackupFileSchema = z
  .object({
    /** Home-relative POSIX path of the ORIGINAL file (its restore destination). */
    path: z.string().min(1),
    /** sha256 hex of the backed-up bytes (the rollback integrity check). */
    digest: z.string().regex(SHA256_HEX),
  })
  .strict();

const CleanupManifestEntrySchema = z
  .object({
    action: z.enum(["backup-then-remove", "backup-then-disable"]),
    surface: z.enum(["skill", "agent", "hook", "rule", "plugin", "mcpServer"]),
    attribution: z.enum(["ecc", "superpowers", "gstack", "gsd", "unknown"]),
    path: z.string().min(1),
    edit: CleanupEditSchema.optional(),
    /** Whether the target existed at apply time (absent -> nothing backed up/removed). */
    present: z.boolean(),
    backup: z.array(CleanupBackupFileSchema),
  })
  .strict();

const CleanupManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    runId: z.string().min(1),
    createdAt: z.string().min(1),
    /** Absolute home the run targeted (informational/audit). */
    home: z.string().min(1),
    /** Subdirectory holding the mirrored backup files. */
    backupDir: z.literal("files"),
    entries: z.array(CleanupManifestEntrySchema),
  })
  .strict();

export type ClaudeCleanupManifest = z.infer<typeof CleanupManifestSchema>;
type CleanupManifestEntry = z.infer<typeof CleanupManifestEntrySchema>;

// -- Phase 2: apply -----------------------------------------------------------

export interface ClaudeCleanupApplyDeps {
  /** The user's home root (tests inject a mkdtemp home; NEVER the real `~`). */
  home: string;
  /** Clock seam for a deterministic runId/timestamp. Defaults to `new Date()`. */
  now?: () => Date;
  /** Explicit backup run id (deterministic tests). Defaults to a timestamp of `now`. */
  runId?: string;
  /**
   * TEST-ONLY fault-injection seam: invoked immediately before each destructive step
   * (after the manifest is durably written). Throwing simulates a mid-apply failure to
   * prove the manifest-first ordering. No production caller sets this.
   */
  beforeStep?: (step: ClaudeCleanupStep, index: number) => void;
}

export interface ClaudeCleanupApplyResult {
  runId: string;
  /** Absolute backup root — pass this to {@link rollbackClaudeCleanup}. */
  backupRoot: string;
  status: "applied" | "failed";
  completed: ClaudeCleanupStep[];
  /** On failure: the failing step and everything after it (never executed). */
  pending: ClaudeCleanupStep[];
  /** Steps whose target was already absent (idempotent no-op). */
  skippedAbsent: ClaudeCleanupStep[];
  error?: string;
}

export function applyClaudeCleanup(
  plan: ClaudeCleanupPlan,
  deps: ClaudeCleanupApplyDeps,
): ClaudeCleanupApplyResult {
  const { home } = deps;
  const now = (deps.now ?? (() => new Date()))();
  const runId = deps.runId ?? defaultRunId(now);
  const backupRoot = join(home, ".aih", "cleanup-backup", runId);
  const filesDir = join(backupRoot, "files");

  // Never mix two runs' backups under one runId.
  if (existsSync(join(backupRoot, "manifest.json"))) {
    throw new ClaudeCleanupError(
      `cleanup backup already exists for runId ${JSON.stringify(runId)} at ${backupRoot}`,
    );
  }

  // 1. Resolve each step's backup set (re-validating every target defensively).
  const entries: CleanupManifestEntry[] = [];
  const uniqueBackups = new Map<string, string>(); // home-rel path -> digest
  for (const step of plan.steps) {
    if (step.action === "backup-then-remove") {
      assertRemovableTarget(step.path);
      const abs = resolveUnder(home, step.path);
      if (!existsSync(abs)) {
        entries.push(manifestEntry(step, false, []));
        continue;
      }
      const backup = listTreeFiles(abs, step.path).map((file) => {
        const digest = digestBytes(readFileSync(file.abs));
        uniqueBackups.set(file.rel, digest);
        return { path: file.rel, digest };
      });
      entries.push(manifestEntry(step, true, backup));
    } else {
      assertDisableFile(step.path);
      const abs = resolveUnder(home, step.path);
      if (!existsSync(abs)) {
        entries.push(manifestEntry(step, false, []));
        continue;
      }
      let digest = uniqueBackups.get(step.path);
      if (digest === undefined) {
        digest = digestBytes(readFileSync(abs));
        uniqueBackups.set(step.path, digest);
      }
      entries.push(manifestEntry(step, true, [{ path: step.path, digest }]));
    }
  }

  // 2. Copy every unique backup file into files/ (BEFORE the manifest, BEFORE any edit).
  mkdirSync(filesDir, { recursive: true });
  for (const rel of uniqueBackups.keys()) {
    copyInto(resolveUnder(home, rel), resolveUnder(filesDir, rel));
  }

  // 3. Write the schema-validated manifest — the durability point for rollback.
  const manifest: ClaudeCleanupManifest = {
    schemaVersion: 1,
    runId,
    createdAt: now.toISOString(),
    home,
    backupDir: "files",
    entries,
  };
  CleanupManifestSchema.parse(manifest);
  writeFileAtomic(join(backupRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  // 4. Execute destructive steps only AFTER the manifest is durable. Fail closed
  //    mid-apply: stop, preserve the backup, report completed vs pending.
  const completed: ClaudeCleanupStep[] = [];
  const skippedAbsent: ClaudeCleanupStep[] = [];
  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i];
    const entry = entries[i];
    if (step === undefined || entry === undefined) continue;
    if (!entry.present) {
      skippedAbsent.push(step);
      continue;
    }
    try {
      deps.beforeStep?.(step, i);
      if (step.action === "backup-then-remove") {
        retryTransient(() =>
          rmSync(resolveUnder(home, step.path), { recursive: true, force: true }),
        );
      } else if (step.edit !== undefined) {
        applyJsonEdit(resolveUnder(home, step.path), step.edit);
      }
      completed.push(step);
    } catch (err) {
      return {
        runId,
        backupRoot,
        status: "failed",
        completed,
        pending: plan.steps.slice(i),
        skippedAbsent,
        error: (err as Error).message,
      };
    }
  }
  return { runId, backupRoot, status: "applied", completed, pending: [], skippedAbsent };
}

function manifestEntry(
  step: ClaudeCleanupStep,
  present: boolean,
  backup: { path: string; digest: string }[],
): CleanupManifestEntry {
  const base = {
    action: step.action,
    surface: step.surface,
    attribution: step.attribution,
    path: step.path,
    present,
    backup,
  };
  return step.edit !== undefined ? { ...base, edit: step.edit } : base;
}

/**
 * Apply ONE targeted JSON edit: parse, delete the named container key or matching
 * hook command, rewrite. Preserves every unrelated key (parse -> mutate -> restringify
 * keeps insertion order); a missing key/file is an idempotent no-op. Never replaces a
 * shared file with a template.
 */
function applyJsonEdit(absFile: string, edit: ClaudeCleanupEdit): void {
  const raw = readIfExists(absFile);
  if (raw === undefined) return;
  const parsed = parseJsoncText(raw);
  if (!isPlainObject(parsed)) {
    // A shared JSON file whose root is not an object is malformed state; failing
    // the step (backup intact) is honest — silently "completing" a no-op is not.
    throw new ClaudeCleanupError(
      `refusing targeted edit — ${absFile} does not have a JSON object root`,
    );
  }
  if (edit.kind === "json-key") {
    if (!DISABLE_CONTAINERS.has(edit.container)) {
      throw new ClaudeCleanupError(
        `refusing to edit unsupported JSON container ${JSON.stringify(edit.container)}`,
      );
    }
    assertSafeKey(edit.key);
    const container = parsed[edit.container];
    if (isPlainObject(container) && Object.hasOwn(container, edit.key)) {
      delete container[edit.key];
    }
  } else {
    removeHookCommand(parsed.hooks, edit.event, edit.command);
  }
  writeFileAtomic(absFile, `${JSON.stringify(parsed, null, 2)}\n`);
}

/**
 * Remove every hook whose command equals `command` under `event`, structurally
 * (not by index): drops matching commands from nested matcher groups, prunes an
 * emptied group, and deletes the event key when nothing remains. Unrelated events
 * and commands are untouched.
 */
function removeHookCommand(hooks: unknown, event: string, command: string): void {
  if (!isPlainObject(hooks)) return;
  const groups = hooks[event];
  if (!Array.isArray(groups)) return;
  const kept: unknown[] = [];
  for (const group of groups) {
    if (typeof group === "string") {
      if (group !== command) kept.push(group);
    } else if (isPlainObject(group) && Array.isArray(group.hooks)) {
      const innerKept = group.hooks.filter(
        (inner) =>
          !(typeof inner === "string" && inner === command) &&
          !(isPlainObject(inner) && inner.command === command),
      );
      if (innerKept.length > 0) kept.push({ ...group, hooks: innerKept });
    } else if (isPlainObject(group) && group.command === command) {
      // dropped
    } else {
      kept.push(group);
    }
  }
  if (kept.length > 0) hooks[event] = kept;
  else delete hooks[event];
}

// -- Phase 3: rollback --------------------------------------------------------

export interface ClaudeCleanupRollbackDeps {
  /** The home root to restore into (the backup's recorded home when unmoved). */
  home: string;
}

export interface ClaudeCleanupRollbackResult {
  runId: string;
  /** Home-relative paths restored byte-for-byte from the backup. */
  restored: string[];
  /** Entries skipped because the backup file drifted from its recorded digest (never overwritten). */
  skippedDrifted: { path: string; reason: string }[];
}

/**
 * Restore a run's backup. The manifest is schema-validated (a schema break is
 * REFUSED outright); each backup file is re-digested and only restored when it
 * still matches its recorded digest — a drifted backup is skipped + reported
 * rather than laundered over the live file.
 */
export function rollbackClaudeCleanup(
  backupRoot: string,
  deps: ClaudeCleanupRollbackDeps,
): ClaudeCleanupRollbackResult {
  const manifestPath = join(backupRoot, "manifest.json");
  const raw = readIfExists(manifestPath);
  if (raw === undefined) {
    throw new ClaudeCleanupError(`no cleanup manifest at ${manifestPath}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ClaudeCleanupError(`cleanup manifest is not valid JSON: ${manifestPath}`);
  }
  const result = CleanupManifestSchema.safeParse(parsed);
  if (!result.success) {
    throw new ClaudeCleanupError(
      `refusing tampered cleanup manifest (schema invalid): ${manifestPath}`,
    );
  }
  const manifest = result.data;
  const filesDir = join(backupRoot, manifest.backupDir);
  const restored: string[] = [];
  const skippedDrifted: { path: string; reason: string }[] = [];
  const seen = new Set<string>();
  for (const entry of manifest.entries) {
    for (const file of entry.backup) {
      if (seen.has(file.path)) continue;
      seen.add(file.path);
      const backupAbs = resolveUnder(filesDir, file.path);
      if (!existsSync(backupAbs)) {
        skippedDrifted.push({ path: file.path, reason: "backup file missing" });
        continue;
      }
      if (digestBytes(readFileSync(backupAbs)) !== file.digest) {
        skippedDrifted.push({
          path: file.path,
          reason: "backup digest mismatch — refusing to restore drifted content",
        });
        continue;
      }
      copyInto(backupAbs, resolveUnder(deps.home, file.path));
      restored.push(file.path);
    }
  }
  return { runId: manifest.runId, restored, skippedDrifted };
}

// -- Shared fs helpers --------------------------------------------------------

/** A deterministic, Windows-safe backup run id from a clock (`:`/`.` are illegal in paths). */
function defaultRunId(now: Date): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

function digestBytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Join `rel` (a validated safe POSIX path) under `base`; fail closed on anything unsafe. */
function resolveUnder(base: string, rel: string): string {
  if (!isSafeRelPosixPath(rel)) {
    throw new ClaudeCleanupError(`refusing unsafe home-relative path ${JSON.stringify(rel)}`);
  }
  return join(base, ...rel.split("/"));
}

/**
 * List every regular FILE under `absRoot` with its home-relative POSIX path. A
 * single file returns itself; symlinks are never followed (they could escape the
 * home scope) — empty directories carry no files and are not preserved.
 */
function listTreeFiles(absRoot: string, relRoot: string): { abs: string; rel: string }[] {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(absRoot);
  } catch {
    return [];
  }
  if (stat.isSymbolicLink()) return [];
  if (stat.isFile()) return [{ abs: absRoot, rel: relRoot }];
  if (stat.isDirectory()) {
    const out: { abs: string; rel: string }[] = [];
    for (const name of readdirSync(absRoot).sort((a, b) => a.localeCompare(b))) {
      out.push(...listTreeFiles(join(absRoot, name), `${relRoot}/${name}`));
    }
    return out;
  }
  return [];
}

function copyInto(srcAbs: string, destAbs: string): void {
  mkdirSync(dirname(destAbs), { recursive: true });
  retryTransient(() => copyFileSync(srcAbs, destAbs));
}

function writeFileAtomic(absFile: string, contents: string): void {
  mkdirSync(dirname(absFile), { recursive: true });
  const tmp = `${absFile}.aih-cleanup.tmp`;
  rmSync(tmp, { force: true });
  writeFileSync(tmp, contents, { encoding: "utf8", flag: "w" });
  retryTransient(() => renameSync(tmp, absFile));
}
