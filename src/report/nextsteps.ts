import { lines } from "../internals/render.js";
import type { AdoptionSnapshot } from "./advisories.js";
import type { ContextBloat } from "./bloat.js";
import type { LoadGroupModel } from "./loadgroups.js";
import { thousands } from "./render.js";

/**
 * The "Next steps" panel — the report's SELF-GUIDING layer. The other panels
 * surface symptoms (a 67/100 score, a missing artifact, an "OVER budget" number);
 * this one translates them into the exact, copy-runnable `aih` commands so a reader
 * doesn't have to know which command fixes which gap. It also reconciles the
 * scary-looking full-corpus footprint with the per-turn cost that actually matters.
 *
 * Pure: no I/O, derived entirely from snapshots the panels already computed.
 */

export interface NextStepsInput {
  /** Managed-artifact presence (Configuration panel). Drives the per-gap commands. */
  adoption?: AdoptionSnapshot;
  /** Full-corpus footprint (the union of all context files). */
  bloat?: ContextBloat;
  /** Per-turn load-group model (what one tool actually loads). */
  perTurn?: LoadGroupModel;
  /** Captured usage events; 0 = telemetry not wired yet. `undefined` = unknown. */
  usageEvents?: number;
  /** Agent shell tools (rg/fd/jq/…) not on PATH — surfaces the `aih tools` install step. */
  toolsMissing?: number;
  /** Repo opted into the harness (committed marker) — only an opted-in repo is nagged. */
  initialized: boolean;
}

/** Map a missing managed artifact to the exact command that creates it. */
export function commandForArtifact(name: string): string {
  const n = name.toLowerCase();
  if (n.includes("gitleaks") || n.includes("pre-commit") || n.includes("guardrail"))
    return "aih guardrails --apply";
  if (n.includes("devcontainer") || n.includes("sandbox")) return "aih sandbox --apply";
  if (n.includes("mcp")) return "aih mcp --apply";
  if (n.includes("secret")) return "aih secrets --apply";
  if (n.includes("context") || n.includes("scaffold")) return "aih scaffold --apply";
  return "aih init --apply";
}

/**
 * The ordered list of concrete next-step lines (each names a command). Empty when
 * the repo is fully set up. Adoption gaps first, then telemetry wiring.
 */
export function nextSteps(input: NextStepsInput): string[] {
  if (!input.initialized) return [];
  const steps: string[] = [];

  // A — adoption gaps → commands, grouped so one command isn't listed twice
  // (gitleaks + pre-commit both map to `aih guardrails --apply`).
  const absent = input.adoption?.absent ?? [];
  if (absent.length > 0) {
    const byCmd = new Map<string, string[]>();
    for (const a of absent) {
      const cmd = commandForArtifact(a);
      const arr = byCmd.get(cmd) ?? [];
      arr.push(a);
      byCmd.set(cmd, arr);
    }
    for (const [cmd, arts] of byCmd) steps.push(`Add ${arts.join(", ")} → \`${cmd}\``);
  }

  // C — telemetry: one line wires both Usage and Trends.
  if (input.usageEvents === 0) {
    steps.push(
      "Wire telemetry → `aih usage --apply` + `aih track --apply` (commit/stop hook) to populate Usage + Trends",
    );
  }

  // Machine shell tools the agent guidance leans on — surface the install command.
  if (input.toolsMissing && input.toolsMissing > 0) {
    steps.push(
      `Install ${input.toolsMissing} missing shell tool(s) → \`aih tools\` (preview) · \`aih tools --apply\` (install)`,
    );
  }

  return steps;
}

/**
 * B — reconcile the full-corpus footprint with the per-turn cost. Returns a
 * one-line clarification, or `undefined` when there's nothing to clarify.
 */
export function budgetClarification(
  bloat: ContextBloat | undefined,
  perTurn: LoadGroupModel | undefined,
): string | undefined {
  if (!bloat || !perTurn) return undefined;
  if (bloat.overBudget && !perTurn.overBudget) {
    return lines(
      `Context: the ~${thousands(bloat.totalTokens)}-token figure is the FULL corpus (informational).`,
      `What an agent pays PER TURN is only ~${thousands(perTurn.worstTokens)} tok — within budget. The rich`,
      "canon loads on-demand via the router, so there is nothing to fix here.",
    );
  }
  if (perTurn.overBudget) {
    return lines(
      `Context: per-turn load ~${thousands(perTurn.worstTokens)} tok is OVER the ${thousands(perTurn.budgetTokens)} budget —`,
      "trim the always-loaded bootloaders or raise `--token-budget`.",
    );
  }
  return undefined;
}

/** Headline for the Next steps digest. */
export function nextStepsHeadline(input: NextStepsInput): string {
  const n = nextSteps(input).length;
  return n === 0 ? "Next steps — all clear" : `Next steps — ${n} action${n === 1 ? "" : "s"}`;
}

/** The Next steps panel body (the prominent, self-guiding action list). */
export function nextStepsDigest(input: NextStepsInput): string {
  const steps = nextSteps(input);
  const budget = budgetClarification(input.bloat, input.perTurn);
  const body: string[] = [];

  if (steps.length === 0) {
    body.push("✓ Nothing to do — managed artifacts present and telemetry wired.");
  } else {
    body.push(
      "Run these to finish setup — each is additive and non-destructive (drop `--apply` to preview):",
      "",
      ...steps.map((s, i) => `  ${i + 1}. ${s}`),
    );
  }
  if (budget) body.push("", budget);
  return lines(...body);
}
