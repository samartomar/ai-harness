import { join } from "node:path";
import { readIfExists } from "./fsxn.js";
import { type WriteAction, writeText } from "./plan.js";
import { stripTrailingNewlines } from "./render.js";

const MANAGED_HEADER = "# aih-managed (backup, temp, and generated reports)";

/**
 * Patterns for the harness's generated artifacts. `.aih/*` (NOT a bare `.aih/`)
 * ignores the DATA in `.aih/` — usage.jsonl, history.jsonl, `aih report` outputs —
 * while `!.aih/usage-record.mjs` keeps the committed recorder TOOL tracked so a fresh
 * clone still has the script the per-tool hooks invoke. A bare `.aih/` excludes the
 * whole directory and, by git's rule that "a file cannot be re-included if a parent
 * directory is excluded", would neuter the negation — which is exactly why every
 * clone used to hit MODULE_NOT_FOUND when a committed hook fired against the ignored
 * (never-cloned) recorder.
 *
 * The leading `!.aih/` re-includes the DIRECTORY before `.aih/*` re-ignores its
 * contents: this is what lets the negation survive an EARLIER broad rule that excludes
 * the dir itself (e.g. a bare-dotfile-dir glob like ".*" plus a trailing slash — common
 * for hiding dotfiles). Because our block is appended at the END of `.gitignore` and
 * later rules win, `!.aih/` overrides the earlier dir-exclude so `.aih/` is traversable
 * again, `.aih/*` then ignores the data, and `!.aih/usage-record.mjs` re-includes the
 * one committed file. Without the `!.aih/` line, a repo whose `.gitignore` already
 * excludes the `.aih` parent (via a glob it never wrote by hand, so `excludesAihDir`
 * can't strip it) would re-strand the recorder even though our own block looks correct
 * in isolation.
 */
const AIH_PATTERNS = [
  "*.aih.bak",
  "*.aih.tmp",
  "!.aih/",
  ".aih/*",
  "!.aih/usage-record.mjs",
] as const;

/** The exact managed lines (header + current patterns) we always rewrite. */
const OWNED_EXACT = new Set<string>([MANAGED_HEADER, ...AIH_PATTERNS]);

/**
 * Does `line` exclude the `.aih` DIRECTORY itself? Every equivalent form — `.aih`,
 * `.aih/`, `/.aih`, `/.aih/` — makes git skip the directory entirely, and by git's
 * rule that "a file cannot be re-included once its parent directory is excluded" that
 * neuters the `!.aih/usage-record.mjs` negation and re-strands the recorder (the
 * original MODULE_NOT_FOUND-on-every-hook bug). So ALL of them are superseded by
 * `.aih/*` + the negation, not just a bare `.aih/`. Note `.aih/*` / `.aih/**` are NOT
 * matched here — they ignore the CONTENTS, leave the dir traversable, and coexist with
 * the negation.
 */
function excludesAihDir(line: string): boolean {
  return line.replace(/^\//, "").replace(/\/$/, "") === ".aih";
}

/** Lines this block owns and rewrites: the managed set plus any `.aih`-dir exclude. */
function isOwnedLine(line: string): boolean {
  const trimmed = line.trim();
  return OWNED_EXACT.has(trimmed) || excludesAihDir(trimmed);
}

/**
 * A write that ensures `.gitignore` ignores the harness's generated DATA while
 * keeping the committed `.aih/usage-record.mjs` recorder tracked. Strips every line
 * this block owns (the managed patterns AND any pre-existing `.aih`-directory exclude
 * in any form) and re-appends the managed block, so the result is idempotent
 * (byte-identical when already correct → recorded as `unchanged`), migrates an older
 * block or a hand-written `.aih/` without duplication, and — crucially — never leaves
 * a dir-exclude that would neuter the negation. Preserves all other `.gitignore`
 * content, its position, and its EOL style (CRLF vs LF).
 */
export function aihIgnoreWrite(root: string): WriteAction {
  const existing = readIfExists(join(root, ".gitignore"));
  const block = [MANAGED_HEADER, ...AIH_PATTERNS].join("\n");
  let content: string;
  if (existing === undefined) {
    content = `${block}\n`;
  } else {
    const usesCrlf = /\r\n/.test(existing);
    const normalized = existing.replace(/\r\n/g, "\n");
    const kept = normalized.split("\n").filter((l) => !isOwnedLine(l));
    const body = stripTrailingNewlines(kept.join("\n"));
    let rebuilt = body.length > 0 ? `${body}\n\n${block}\n` : `${block}\n`;
    if (usesCrlf) rebuilt = rebuilt.replace(/\n/g, "\r\n");
    // Preserve byte-identity when the file already ends in exactly our block (no churn).
    content = rebuilt === existing ? existing : rebuilt;
  }
  return writeText(
    ".gitignore",
    content,
    "ignore aih data (.aih/*), keep the committed usage-record.mjs tool tracked",
  );
}
