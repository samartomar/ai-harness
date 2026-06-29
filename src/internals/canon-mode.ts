import type { CommandOption, PlanContext } from "./plan.js";

/**
 * Which context canon a run emits.
 *  - `compact` (default) — the repo CONTRACT: `project.json` + `project.md` +
 *    `setup.md` (from `aih contract`) behind a thin RULE_ROUTER. The lean,
 *    evidence-first surface that reads as one contract, not a doc family.
 *  - `legacy` — the full pre-contract doc family (INDEX/architecture/conventions/
 *    tasks/SETUP-TASKS/VALIDATION/project-guardrails/example-skill +
 *    REGENERATION/harness-update/other-tools). Byte-identical to the old output, for
 *    a team mid-migration; the compiler NEVER deletes, so this is the non-destructive
 *    escape hatch, opt-in only.
 */
export type CanonMode = "compact" | "legacy";

/** Resolve the canon mode from the parsed flags — compact unless `--canon legacy`. */
export function canonMode(ctx: PlanContext): CanonMode {
  return ctx.options.canon === "legacy" ? "legacy" : "compact";
}

/** The shared `--canon` flag, placed on `init`, `scaffold`, and `bootstrap-ai`. */
export const CANON_OPTION: CommandOption = {
  flags: "--canon <mode>",
  description:
    "context canon: compact (default — the repo contract) | legacy (the full doc family)",
  default: "compact",
};
