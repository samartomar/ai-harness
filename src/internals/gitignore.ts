import { join } from "node:path";
import { readIfExists } from "./fsxn.js";
import { type WriteAction, writeText } from "./plan.js";
import { stripTrailingNewlines } from "./render.js";

/** Patterns the harness's own generated files match — never meant to be committed. */
const AIH_PATTERNS = ["*.aih.bak", "*.aih.tmp", ".aih/"] as const;

/**
 * A write that ensures `.gitignore` ignores the harness's generated artifacts:
 * `*.aih.bak` backups, `*.aih.tmp` staging files, and the `.aih/` output dir that
 * holds `aih report` artifacts. Appends a small managed block only when the
 * patterns are absent; if they're already present the returned content equals
 * what's on disk, so the executor records it as `unchanged` (no rewrite, no
 * churn). Preserves all existing `.gitignore` content.
 */
export function aihIgnoreWrite(root: string): WriteAction {
  const existing = readIfExists(join(root, ".gitignore"));
  const block = ["# aih-managed (backup, temp, and generated reports)", ...AIH_PATTERNS].join("\n");
  let content: string;
  if (existing === undefined) {
    content = `${block}\n`;
  } else {
    const lines = existing.split(/\r?\n/);
    const haveAll = AIH_PATTERNS.every((p) => lines.includes(p));
    content = haveAll ? existing : `${stripTrailingNewlines(existing)}\n\n${block}\n`;
  }
  return writeText(
    ".gitignore",
    content,
    "ignore aih-generated files (*.aih.bak, *.aih.tmp, .aih/)",
  );
}
