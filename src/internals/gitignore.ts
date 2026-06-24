import { join } from "node:path";
import { readIfExists } from "./fsxn.js";
import { type WriteAction, writeText } from "./plan.js";

/** Patterns the harness's own backup/temp files match — never meant to be committed. */
const AIH_PATTERNS = ["*.aih.bak", "*.aih.tmp"] as const;

/**
 * A write that ensures `.gitignore` ignores the harness's transactional artifacts
 * (`*.aih.bak` backups, `*.aih.tmp` staging files). Appends a small managed block
 * only when the patterns are absent; if they're already present the returned
 * content equals what's on disk, so the executor records it as `unchanged` (no
 * rewrite, no churn). Preserves all existing `.gitignore` content.
 */
export function aihIgnoreWrite(root: string): WriteAction {
  const existing = readIfExists(join(root, ".gitignore"));
  const block = ["# aih-managed (transactional backup + temp files)", ...AIH_PATTERNS].join("\n");
  let content: string;
  if (existing === undefined) {
    content = `${block}\n`;
  } else {
    const lines = existing.split(/\r?\n/);
    const haveAll = AIH_PATTERNS.every((p) => lines.includes(p));
    content = haveAll ? existing : `${existing.replace(/\n*$/, "")}\n\n${block}\n`;
  }
  return writeText(".gitignore", content, "ignore aih backup/temp files (*.aih.bak, *.aih.tmp)");
}
