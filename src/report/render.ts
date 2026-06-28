import { lines } from "../internals/render.js";
import type { ContextBloat } from "./bloat.js";
import type { LoadGroupModel } from "./loadgroups.js";

/** Group an integer with commas, locale-independently (byte-stable digests). */
export function thousands(n: number): string {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** Up to this many "largest contributor" rows in the terminal digest (the HTML
 * dashboard shows the full, scrollable list). */
const TOP_FILES = 15;

/**
 * Render the local context-footprint digest as plain text for a `doc` action.
 * Deterministic: files are re-sorted by token weight (path tie-break), numbers
 * are locale-independent, no dates — so the output is stable across runs.
 */
export function contextBloatDigest(bloat: ContextBloat, perTurn?: LoadGroupModel): string {
  const { files, totalBytes, totalTokens, budgetTokens, overBudget } = bloat;

  const status = overBudget
    ? `OVER budget by ${thousands(totalTokens - budgetTokens)} tokens`
    : `within budget (${thousands(budgetTokens - totalTokens)} tokens to spare)`;

  // Reconcile the alarming corpus total with the cost that actually matters: when
  // the FULL corpus is over budget but a single tool's PER-TURN load is within it,
  // say so — the rich canon loads on-demand, so the ⚠ isn't an action item.
  const perTurnNote =
    overBudget && perTurn && !perTurn.overBudget
      ? [
          `  Note: this is the FULL corpus. Per turn an agent loads only ~${thousands(perTurn.worstTokens)} tok`,
          "  (within budget) — the rest is on-demand canon. The per-turn panel below is what `--gate` checks.",
        ]
      : [];

  const top = [...files]
    .sort((a, b) => b.tokens - a.tokens || a.path.localeCompare(b.path))
    .slice(0, TOP_FILES);

  return lines(
    "All agent-context files on disk (union of every tool's bootloaders + context",
    "dir + Cursor rules — see the per-turn panel for what one tool actually loads):",
    "",
    `  Files:  ${files.length}`,
    `  Bytes:  ${thousands(totalBytes)}`,
    `  Tokens: ~${thousands(totalTokens)} (estimate, bytes/4) · budget ${thousands(budgetTokens)}`,
    `  Status: ${overBudget ? "⚠ " : ""}${status}`,
    ...perTurnNote,
    "",
    ...(files.length === 0
      ? ["  (no agent context files found — run `aih scaffold` / `aih bootstrap-ai`)"]
      : [
          `  Largest contributors${files.length > TOP_FILES ? ` (top ${TOP_FILES} of ${files.length} — \`aih report --open\` for all)` : ""}:`,
          ...top.map((f) => {
            const share = totalTokens > 0 ? Math.round((f.tokens / totalTokens) * 100) : 0;
            return `    ~${thousands(f.tokens)} tok  (${share}%)  ${f.path}`;
          }),
        ]),
  );
}

/**
 * Render the per-tool load-group digest: the heaviest single tool's always-loaded
 * bootloader bundle (the real per-turn cost) plus a per-group breakdown and the
 * on-demand canon bucket. Deterministic — comma-grouped numbers, no dates, stable
 * sort from {@link scanLoadGroups}.
 */
export function loadGroupDigest(model: LoadGroupModel): string {
  const { groups, worst, worstTokens, budgetTokens, overBudget, onDemandFiles, onDemandTokens } =
    model;
  const present = groups.filter((g) => g.present);

  const status = overBudget
    ? `OVER per-turn budget by ${thousands(worstTokens - budgetTokens)} tokens`
    : `within budget (${thousands(budgetTokens - worstTokens)} tokens to spare)`;

  return lines(
    "Per-turn agent context — the heaviest single tool's always-loaded bootloaders.",
    "You pay ONE tool's bundle per turn, not the sum of every tool's files:",
    "",
    `  Worst tool: ~${thousands(worstTokens)} tok  ${worst ? `(${worst.label})` : "(no bootloaders on disk)"}`,
    `  Budget:     ${thousands(budgetTokens)} tok · ${overBudget ? "⚠ " : ""}${status}`,
    "",
    ...(present.length === 0
      ? ["  (no bootloaders on disk — run `aih bootstrap-ai --apply`)"]
      : [
          "  Always-loaded per tool group:",
          ...present.map((g) => `    ~${thousands(g.tokens)} tok  ${g.label}`),
        ]),
    "",
    `  On-demand canon (loaded via pointer, not every turn): ~${thousands(onDemandTokens)} tok across ${onDemandFiles.length} files`,
    "  Note: Cursor/Kiro files with `inclusion: always` frontmatter are also always-loaded;",
    "  frontmatter-aware counting is not yet implemented, so only the canon bootloader is",
    "  attributed to each tool here.",
  );
}
