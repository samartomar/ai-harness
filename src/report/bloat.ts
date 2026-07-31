import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { bootloadersFor, loadedDirsFor, REGISTRY_IDS } from "../internals/cli-registry.js";

/** Heuristic: ~4 chars/token for mostly-ASCII markdown. A rough estimate, not a tokenizer. */
const CHARS_PER_TOKEN = 4;

/** Default context budget (tokens) above which agent prompts start paying long-context cost. */
export const DEFAULT_CONTEXT_BUDGET_TOKENS = 40_000;

/**
 * Agent bootloaders an AI CLI loads as system context, derived from the CLI registry
 * so a newly registered target is measured without editing this file. A hand-kept list
 * here silently under-reported every target it forgot (issue #553).
 */
const ROOT_CONTEXT_FILES: readonly string[] = bootloadersFor(REGISTRY_IDS);

/**
 * Extra subtrees (beyond the canonical context dir) whose files load as agent context —
 * the directory-load semantic, where a tool reads every rule in the tree rather than only
 * the bootloader aih writes. Derived from the registry, so a target that declares a rule
 * tree is measured without editing this file. The former hardcoded `.cursor/rules` list
 * walked Cursor's tree but never Kiro's, under-reporting every steering file aih did not
 * itself write — the same failure as the hand-kept bootloader list in issue #553.
 */
const EXTRA_CONTEXT_DIRS: readonly string[] = loadedDirsFor(REGISTRY_IDS);

/** Basenames that are OS/file-manager metadata, never agent context (issue #553). */
const OS_METADATA_NAMES = new Set([".ds_store", "thumbs.db", "desktop.ini"]);

/**
 * True when `rel` is OS metadata — a Finder/Explorer sidecar carrying no AI instruction
 * or project canon. Tracked copies count too: being committed does not make Finder
 * metadata part of the agent's context corpus.
 */
function isOsMetadata(rel: string): boolean {
  const base = rel.slice(rel.lastIndexOf("/") + 1);
  return OS_METADATA_NAMES.has(base.toLowerCase()) || base.startsWith("._");
}

/** Compact contract files that v1 made the steady-state context target. */
const CONTRACT_CONTEXT_FILES = ["RULE_ROUTER.md", "project.json", "project.md"] as const;

/** Legacy canon family measured against the compact contract target when present. */
const LEGACY_CONTEXT_FILES = [
  "RULE_ROUTER.md",
  "INDEX.md",
  "architecture.md",
  "conventions.md",
  "tasks.md",
  "SETUP-TASKS.md",
  "VALIDATION.md",
  "project-guardrails.md",
  "REGENERATION.md",
  "harness-update.md",
  "adapters/other-tools.md",
  "project.json",
  "project.md",
  "setup.md",
] as const;

/** One context file's footprint. `tokens` is an estimate (bytes / 4). */
export interface ContextFile {
  /** Repo-relative path, POSIX separators. */
  path: string;
  bytes: number;
  tokens: number;
}

/** Options for {@link scanContextBloat} — keep the scan sync + pure (no async git). */
export interface ScanOptions {
  /**
   * Keep only paths this predicate accepts (repo-relative POSIX). Default: keep
   * all. Callers pass a gitignore-honoring allowlist (computed async via the
   * Runner) so the footprint doesn't double-count generated copies or ignored files.
   */
  accept?: (rel: string) => boolean;
  /**
   * Count OS metadata (`.DS_Store` and peers) as context. Default false — it is never
   * agent instruction. `--all-files` sets this true to keep its documented
   * "every file on disk" contract literal (issue #553).
   */
  includeOsMetadata?: boolean;
}

/** The agent context an AI CLI loads from this repo, with an estimated token footprint. */
export interface ContextBloat {
  /** Every context file found, sorted by path for deterministic digests. */
  files: ContextFile[];
  totalBytes: number;
  totalTokens: number;
  budgetTokens: number;
  overBudget: boolean;
}

export interface TokenOptimizationSlice {
  paths: string[];
  files: number;
  bytes: number;
  tokens: number;
}

export interface TokenOptimizationIndex {
  legacy: TokenOptimizationSlice;
  contract: TokenOptimizationSlice;
  savedTokens: number;
  reductionPct: number;
}

/** List directory entries, tolerating an unreadable/missing dir as "empty". */
function safeReadDir(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

/** Byte size of a regular file, or `undefined` if missing / not a regular file. */
function fileSize(path: string): number | undefined {
  try {
    const s = statSync(path);
    return s.isFile() ? s.size : undefined;
  } catch {
    return undefined;
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Recursively collect repo-relative file paths (POSIX) under `relDir`. */
function walk(root: string, relDir: string, out: string[]): void {
  const absDir = join(root, relDir);
  for (const entry of safeReadDir(absDir)) {
    const rel = `${relDir}/${entry}`;
    if (isDir(join(absDir, entry))) walk(root, rel, out);
    else out.push(rel);
  }
}

/** Rough token estimate for a byte count (~4 chars/token). Shared with the load-group model. */
export function estimateTokens(bytes: number): number {
  return Math.ceil(bytes / CHARS_PER_TOKEN);
}

/**
 * One file's footprint, or `undefined` if it is missing / not a regular file.
 * The single per-file primitive both `scanContextBloat` (full inventory) and the
 * load-group model build on, so they share one tokenizer.
 */
export function fileFootprint(root: string, rel: string): ContextFile | undefined {
  const bytes = fileSize(join(root, rel));
  return bytes === undefined ? undefined : { path: rel, bytes, tokens: estimateTokens(bytes) };
}

function contextPath(contextDir: string, rel: string): string {
  return `${contextDir.replace(/\\/g, "/").replace(/\/+$/, "")}/${rel}`;
}

function pathCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sumFiles(
  files: readonly ContextFile[],
  wanted: ReadonlySet<string>,
): TokenOptimizationSlice {
  const picked = files
    .filter((f) => wanted.has(f.path))
    .sort((a, b) => pathCompare(a.path, b.path));
  const bytes = picked.reduce((n, f) => n + f.bytes, 0);
  const tokens = picked.reduce((n, f) => n + f.tokens, 0);
  return { paths: picked.map((f) => f.path), files: picked.length, bytes, tokens };
}

/**
 * Token-Optimization Index (TOI): compare the legacy always-loaded family against
 * the compact v1 contract target using the SAME `scanContextBloat().files`
 * inventory. Missing files count in neither side; no contents are read here.
 */
export function tokenOptimizationIndex(
  files: readonly ContextFile[],
  contextDir: string,
): TokenOptimizationIndex {
  const legacyPaths = new Set<string>([
    ...ROOT_CONTEXT_FILES,
    ...LEGACY_CONTEXT_FILES.map((rel) => contextPath(contextDir, rel)),
  ]);
  const contractPaths = new Set<string>(
    CONTRACT_CONTEXT_FILES.map((rel) => contextPath(contextDir, rel)),
  );
  const legacy = sumFiles(files, legacyPaths);
  const contract = sumFiles(files, contractPaths);
  const savedTokens = Math.max(0, legacy.tokens - contract.tokens);
  const reductionPct = legacy.tokens > 0 ? Math.round((savedTokens / legacy.tokens) * 100) : 0;
  return { legacy, contract, savedTokens, reductionPct };
}

/**
 * Scan `root` for the agent context an AI CLI loads — root bootloaders, the
 * canonical context dir (`contextDir`) tree, and every registry-declared rule tree — and
 * estimate its token footprint (bytes / 4). Pure: reads file *sizes* only (never
 * contents), touches no network, mutates nothing; returns repo-relative POSIX
 * paths sorted by path so the rendered digest is byte-stable across runs.
 */
export function scanContextBloat(
  root: string,
  contextDir: string,
  budgetTokens: number = DEFAULT_CONTEXT_BUDGET_TOKENS,
  opts: ScanOptions = {},
): ContextBloat {
  const accept = opts.accept ?? (() => true);
  const rels = new Set<string>(ROOT_CONTEXT_FILES);
  for (const dir of [contextDir, ...EXTRA_CONTEXT_DIRS]) {
    if (!isDir(join(root, dir))) continue;
    const found: string[] = [];
    walk(root, dir, found);
    for (const rel of found) rels.add(rel);
  }

  const files: ContextFile[] = [];
  const keepOsMetadata = opts.includeOsMetadata === true;
  for (const rel of [...rels].sort()) {
    if (!keepOsMetadata && isOsMetadata(rel)) continue; // Finder/Explorer sidecars
    if (!accept(rel)) continue; // drop ignored / untracked-generated / out-of-diff files
    const f = fileFootprint(root, rel); // missing / non-regular files are skipped
    if (f) files.push(f);
  }

  const totalBytes = files.reduce((n, f) => n + f.bytes, 0);
  const totalTokens = files.reduce((n, f) => n + f.tokens, 0);
  return { files, totalBytes, totalTokens, budgetTokens, overBudget: totalTokens > budgetTokens };
}
