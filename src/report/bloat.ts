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

/** One context file's footprint. `tokens` is an estimate (bytes / 4). */
export interface ContextFile {
  /** Repo-relative path, POSIX separators. */
  path: string;
  bytes: number;
  tokens: number;
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

function estimateTokens(bytes: number): number {
  return Math.ceil(bytes / CHARS_PER_TOKEN);
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
): ContextBloat {
  const rels = new Set<string>(ROOT_CONTEXT_FILES);
  for (const dir of [contextDir, ...EXTRA_CONTEXT_DIRS]) {
    if (!isDir(join(root, dir))) continue;
    const found: string[] = [];
    walk(root, dir, found);
    for (const rel of found) rels.add(rel);
  }

  const files: ContextFile[] = [];
  for (const rel of [...rels].sort()) {
    const bytes = fileSize(join(root, rel));
    if (bytes === undefined) continue; // missing or not a regular file → skip
    files.push({ path: rel, bytes, tokens: estimateTokens(bytes) });
  }

  const totalBytes = files.reduce((n, f) => n + f.bytes, 0);
  const totalTokens = files.reduce((n, f) => n + f.tokens, 0);
  return { files, totalBytes, totalTokens, budgetTokens, overBudget: totalTokens > budgetTokens };
}
