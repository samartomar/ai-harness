import { lines } from "../internals/render.js";
import type { ContextBloat } from "./bloat.js";

/** Group an integer with commas, locale-independently (byte-stable digests). */
export function thousands(n: number): string {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Up to this many "largest contributor" rows in the footprint digest. */
const TOP_FILES = 10;

/**
 * Render the local context-footprint digest as plain text for a `doc` action.
 * Deterministic: files are re-sorted by token weight (path tie-break), numbers
 * are locale-independent, no dates — so the output is stable across runs.
 */
export function contextBloatDigest(bloat: ContextBloat): string {
  const { files, totalBytes, totalTokens, budgetTokens, overBudget } = bloat;

  const status = overBudget
    ? `OVER budget by ${thousands(totalTokens - budgetTokens)} tokens`
    : `within budget (${thousands(budgetTokens - totalTokens)} tokens to spare)`;

  const top = [...files]
    .sort((a, b) => b.tokens - a.tokens || a.path.localeCompare(b.path))
    .slice(0, TOP_FILES);

  return lines(
    "Agent context loaded from this repo (bootloaders · context dir · Cursor rules):",
    "",
    `  Files:  ${files.length}`,
    `  Bytes:  ${thousands(totalBytes)}`,
    `  Tokens: ~${thousands(totalTokens)} (estimate, bytes/4) · budget ${thousands(budgetTokens)}`,
    `  Status: ${overBudget ? "⚠ " : ""}${status}`,
    "",
    ...(files.length === 0
      ? ["  (no agent context files found — run `aih scaffold` / `aih bootstrap-ai`)"]
      : [
          "  Largest contributors:",
          ...top.map((f) => `    ~${thousands(f.tokens)} tok  ${f.path}`),
        ]),
  );
}
