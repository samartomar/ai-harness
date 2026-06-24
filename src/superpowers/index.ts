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
import { superpowersActionsForCli, superpowersOverviewDoc } from "./install.js";

function summaryDoc(clis: string[]): Action {
  return doc(
    "Superpowers install summary",
    lines(
      `Target CLIs: ${clis.join(", ")}.`,
      "Re-run with `--cli <list>` or `--all-tools` to target a different set.",
      "Superpowers and ECC are complementary — install both (`aih ecc`, `aih superpowers`)",
      "for the full harness: stack-aware rules + the disciplined agent loop that uses them.",
    ),
  );
}

/**
 * Install obra/Superpowers — the agent-behavior layer (brainstorm -> plan -> TDD
 * -> subagent review) — for the user's selected CLIs (`--cli claude,codex` /
 * `--all-tools`, default `claude`). Shell-runnable targets execute under
 * `--apply`; plugin-TUI and not-yet-supported targets are emitted as exact
 * commands / a pointer to the INSTALL guide.
 */
function superpowersPlan(ctx: PlanContext): Plan {
  const clis = resolveClis(ctx.options);
  const actions: Action[] = [];
  for (const cli of clis) actions.push(...superpowersActionsForCli(cli));
  actions.push(superpowersOverviewDoc());
  actions.push(summaryDoc(clis));
  return plan("superpowers", ...actions);
}

export const command: CommandSpec = {
  name: "superpowers",
  summary:
    "Install obra/Superpowers (brainstorm -> plan -> TDD -> review skills) for the selected CLIs",
  options: [],
  plan: superpowersPlan,
};
