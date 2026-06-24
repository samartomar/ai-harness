import type { Action, CommandSpec, PlanContext } from "../internals/plan.js";
import { doc, plan } from "../internals/plan.js";
import { INIT_PHASES } from "./phases.js";

/**
 * Orchestrate a full repo bootstrap by COMPOSING the repo-scoped capabilities —
 * profile, scaffold, secrets, guardrails, mcp, sandbox — in that order. Each
 * phase's actions come straight from `command.plan(ctx)` (never re-implemented),
 * preceded by a `doc` headline so a dry-run reads as labelled sections. Because
 * every sub-capability is invoked with the same `ctx`, a custom `--context-dir`,
 * `--apply`, or `--verify` flows through to all of them, and
 * `aih init . --apply` lays the entire repo bootstrap down in one pass.
 *
 * The composition introduces no remote mutation of its own: it only adds `doc`
 * headers and forwards whatever write/doc/probe actions the leaves already
 * produce, so the harness's "no faked provisioning" guarantee is preserved.
 */
async function initPlan(ctx: PlanContext): Promise<ReturnType<typeof plan>> {
  const actions: Action[] = [];

  for (const phase of INIT_PHASES) {
    const sub = await phase.command.plan(ctx);
    actions.push(doc(`init: ${phase.command.name}`, phase.headline));
    actions.push(...sub.actions);
  }

  return plan("init", ...actions);
}

export const command: CommandSpec = {
  name: "init",
  summary: "Initialize a target repo: profile, scaffold, guardrails, secrets, mcp, sandbox",
  options: [],
  plan: initPlan,
};
