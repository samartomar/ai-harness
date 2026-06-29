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
  /** Captured usage events; 0 = none captured yet. `undefined` = unknown. */
  usageEvents?: number;
  /** Telemetry capture is wired (the usage recorder + hook exist) — even with 0 events yet. */
  telemetryWired?: boolean;
  /** Agent shell tools (rg/fd/jq/…) not on PATH — surfaces the `aih tools` install step. */
  toolsMissing?: number;
  /** Large repo without a graph path — broad reads would burn the agent budget. */
  scaleGraphMissing?: boolean;
  /** AI CLIs RUNNABLE on this machine (binary on PATH) but NOT wired in this repo. */
  installedUntargeted?: string[];
  /** This repo's current target set — used to build the "wire them" command. */
  targets?: string[];
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

/** Indent for a step's command line(s) — aligns under the `  N. ` number prefix. */
const STEP_INDENT = "     ";

/**
 * One next-step: a description line, then each command on its OWN bare, indented line
 * so the reader can copy a command verbatim and run it (the old `desc → \`cmd\`` form
 * wasn't pasteable — the backticks + prose broke the line). A trailing `# note` is a
 * shell comment both PowerShell and bash ignore.
 */
function step(desc: string, ...cmds: string[]): string {
  return [`${desc}:`, ...cmds.map((c) => `${STEP_INDENT}${c}`)].join("\n");
}

/**
 * The ordered list of concrete next-steps (each names its command(s) on their own
 * copy-pasteable line). Empty when the repo is fully set up. Adoption gaps first,
 * then telemetry, tools, and untargeted-tool wiring.
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
    for (const [cmd, arts] of byCmd) steps.push(step(`Add ${arts.join(", ")}`, cmd));
  }

  // C — telemetry: prompt to WIRE it only when it isn't wired yet. Once the recorder
  // + hook exist, events accrue as you work — so a "wire telemetry" step after you've
  // wired it would be misleading; drop it (don't nag about data that's now just a
  // matter of time).
  if (input.usageEvents === 0 && !input.telemetryWired) {
    steps.push(
      step(
        "Wire telemetry to populate Usage + Trends",
        "aih usage --apply",
        "aih track --apply   # commit/stop hook",
      ),
    );
  }

  // Machine shell tools the agent guidance leans on — surface the install command.
  if (input.toolsMissing && input.toolsMissing > 0) {
    steps.push(
      step(
        `Install ${input.toolsMissing} missing shell tool(s)`,
        "aih tools           # preview",
        "aih tools --apply   # install",
      ),
    );
  }

  if (input.scaleGraphMissing) {
    steps.push(
      step(
        "Enable code-review-graph before large-repo analysis",
        "aih mcp --apply",
        "aih tools --apply   # installs code-review-graph when uv/pip is available",
      ),
    );
  }

  // AI CLIs installed on this machine but not wired in this repo — adoption targets
  // the repo's EXISTING bootloaders, so a tool you installed later (e.g. kiro) stays
  // unwired and silent. Surface it with the exact command to add it (the user opts in).
  const untargeted = input.installedUntargeted ?? [];
  if (untargeted.length > 0) {
    const full = [...(input.targets ?? []), ...untargeted].join(",");
    steps.push(
      step(
        `Wire ${untargeted.length} installed tool(s) not yet in this repo (${untargeted.join(", ")})`,
        `aih init --cli ${full} --apply`,
      ),
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
