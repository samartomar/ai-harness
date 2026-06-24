import { resolveClis } from "../internals/clis.js";
import {
  type Action,
  type CommandSpec,
  doc,
  type Plan,
  type PlanContext,
  plan,
} from "../internals/plan.js";
import { lines } from "../internals/render.js";
import type { RepoStack } from "../profile/scan.js";
import { scanRepo } from "../profile/scan.js";
import { type EccInstallInputs, eccActionsForCli, eccToolsDoc } from "./install.js";
import { eccLanguages } from "./select.js";

/** A short, human-readable stack summary used in the `consult` advisor prompt. */
function stackSummary(stack: RepoStack): string {
  const parts: string[] = [];
  if (stack.languages.length > 0) parts.push(stack.languages.join(" + "));
  if (stack.frameworks.length > 0) parts.push(`using ${stack.frameworks.join(", ")}`);
  if (stack.cloud.length > 0) parts.push(`on ${stack.cloud.join("/")}`);
  return parts.length > 0 ? parts.join(" ") : "a new repository with no detected stack yet";
}

function summaryDoc(clis: string[], inputs: EccInstallInputs): Action {
  const head = inputs.installEverything
    ? "No stack detected (empty/new repo) — ECC installs its FULL profile. Re-run"
    : `Detected ${stackSummaryShort(inputs)} — ECC installs the matching language packs. Re-run`;
  return doc(
    "ECC install summary (affaan-m/ECC)",
    lines(
      `${head} \`aih ecc\` after the stack changes to re-scope the install.`,
      "",
      `Target CLIs: ${clis.join(", ")}.`,
      `Profile: ${inputs.installEverything ? "full" : inputs.profile}.`,
      inputs.installEverything
        ? "Language packs: (full profile installs all)."
        : `Language packs: ${inputs.packs.length > 0 ? inputs.packs.join(", ") : "(baseline only — no language pack matched)"}.`,
      "",
      "ECC = the agent-harness performance system: skills, instincts, persistent",
      "memory, security, and research-first development. Shell-runnable installs",
      "(codex/cursor/zed/opencode) execute under `--apply`; the Claude plugin and",
      "consult-routed targets are emitted as commands for you to run in the tool.",
    ),
  );
}

function stackSummaryShort(inputs: EccInstallInputs): string {
  return inputs.packs.length > 0 ? inputs.packs.join("/") : "the baseline stack";
}

/**
 * Install and configure affaan-m/ECC — the agent-harness optimization system —
 * customized to the repo's detected stack and the user's selected CLIs
 * (`--cli claude,codex` / `--all-tools`, default `claude`).
 *
 * Per CLI, ECC offers a different install path, so the plan mixes `exec` and
 * `doc`: the `ecc-install` CLI runs under `--apply` for the targets it supports
 * (codex/cursor/zed/opencode), while Claude's plugin path and non-target CLIs
 * are emitted as exact commands to run inside the tool. Language packs come from
 * the profiler; an empty repo installs the full profile and self-scopes on a
 * re-run once there is code.
 */
function eccPlan(ctx: PlanContext): Plan {
  const clis = resolveClis(ctx.options);
  const stack = scanRepo(ctx.root, { maxDepth: 8 });
  const { packs, installEverything } = eccLanguages(stack);
  const profile = String(ctx.options.profile ?? "core");
  const inputs: EccInstallInputs = {
    profile,
    packs,
    installEverything,
    stackSummary: stackSummary(stack),
  };

  const actions: Action[] = [];
  for (const cli of clis) actions.push(...eccActionsForCli(cli, inputs));
  actions.push(eccToolsDoc());
  actions.push(summaryDoc(clis, inputs));
  return plan("ecc", ...actions);
}

export const command: CommandSpec = {
  name: "ecc",
  summary:
    "Install affaan-m/ECC (skills, memory, security, research-first) for the selected CLIs, scoped to the detected stack",
  options: [
    {
      flags: "--profile <profile>",
      description: "ECC install profile: minimal|core|full",
      default: "core",
    },
  ],
  plan: eccPlan,
};
