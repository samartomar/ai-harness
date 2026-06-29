import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Heuristic: ~4 chars/token for mostly-ASCII markdown. A rough estimate, not a tokenizer. */
const CHARS_PER_TOKEN = 4;

/** Default context budget (tokens) above which agent prompts start paying long-context cost. */
export const DEFAULT_CONTEXT_BUDGET_TOKENS = 40_000;

/** Root-level agent bootloaders an AI CLI loads as system context. */
const ROOT_CONTEXT_FILES = [
  "CLAUDE.md",
  "AGENTS.md",
  "GEMINI.md",
  ".windsurfrules",
  ".github/copilot-instructions.md",
] as const;

/** Extra subtrees (beyond the canonical context dir) whose files load as agent context. */
const EXTRA_CONTEXT_DIRS = [".cursor/rules"] as const;

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
 * canonical context dir (`contextDir`) tree, and Cursor rule files — and
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
  for (const rel of [...rels].sort()) {
    if (!accept(rel)) continue; // drop ignored / untracked-generated / out-of-diff files
    const f = fileFootprint(root, rel); // missing / non-regular files are skipped
    if (f) files.push(f);
  }

  const totalBytes = files.reduce((n, f) => n + f.bytes, 0);
  const totalTokens = files.reduce((n, f) => n + f.tokens, 0);
  return { files, totalBytes, totalTokens, budgetTokens, overBudget: totalTokens > budgetTokens };
}
