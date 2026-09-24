import { AihError } from "../errors.js";
import { type Action, doc, type PlanContext } from "../internals/plan.js";
import type { OrgPolicy } from "../org-policy/schema.js";
import {
  FRAMEWORK_IDS_V1,
  type FrameworkHookControlDecisionV1,
  type FrameworkHookControlPlanV1,
  type FrameworkHookEnvironmentPatchV1,
  type FrameworkIdV1,
} from "./contract-v1.js";
import { frameworkHookControlEntriesV1 } from "./hook-controls.js";
import {
  type FrameworkHookEnvironmentPlansV1,
  validateFrameworkHookEnvironmentV1,
} from "./hook-environment.js";
import {
  type FrameworkCommandDepsV1,
  frameworkOperationContextV1,
  requireFrameworkPluginV1,
  selfContainedFrameworkHostV1,
} from "./run-framework-command.js";

export type { FrameworkHookEnvironmentPlansV1 } from "./hook-environment.js";

/** Every framework's hook-control plan, as Core carries it into a projection. */
export interface FrameworkHookControlPlansV1 {
  /** Per framework, the Claude settings environment its plan owns. */
  readonly environments: FrameworkHookEnvironmentPlansV1;
  /**
   * Labels, one doc per planned framework: each disabled hook's per-host
   * enforcement (`upstream-switch`, `not-applicable`, or `unenforced` with its
   * next route), then the plugin's own label docs.
   */
  readonly actions: readonly Action[];
}

const MAX_DETAIL = 600;

function refuse(frameworkId: FrameworkIdV1, problem: string): never {
  throw new AihError(
    `the ${frameworkId} framework plugin returned an unusable hook-control plan: ${problem}`,
    "AIH_FRAMEWORK_PLUGIN",
  );
}

function printable(value: unknown, max: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= max &&
    [...value].every((character) => character.charCodeAt(0) >= 0x20)
  );
}

/** One label doc for a framework's decisions; the plan's shape is checked at the boundary. */
function decisionLabel(
  frameworkId: FrameworkIdV1,
  decisions: unknown,
  targets: readonly string[],
): Action {
  if (!Array.isArray(decisions)) refuse(frameworkId, "decisions is not an array");
  const lines: string[] = [];
  for (const decision of decisions as FrameworkHookControlDecisionV1[]) {
    if (typeof decision !== "object" || decision === null)
      refuse(frameworkId, "a decision is not an object");
    if (!printable(decision.hookId, 100)) refuse(frameworkId, "a decision names no hook");
    if (decision.state === "enabled") continue;
    if (decision.state !== "disabled")
      refuse(frameworkId, `${decision.hookId} has an unknown state`);
    if (decision.authority !== "enterprise" && decision.authority !== "user") {
      refuse(frameworkId, `${decision.hookId} is disabled without an authority`);
    }
    if (!Array.isArray(decision.hosts))
      refuse(frameworkId, `${decision.hookId} has no host decisions`);
    lines.push(`${decision.hookId}: disabled (${decision.authority})`);
    for (const host of decision.hosts) {
      if (
        typeof host !== "object" ||
        host === null ||
        !targets.includes(host.host) ||
        !["not-applicable", "upstream-switch", "unenforced"].includes(host.enforcement) ||
        !printable(host.detail, MAX_DETAIL)
      ) {
        refuse(frameworkId, `${decision.hookId} has a malformed host decision`);
      }
      lines.push(`  ${host.host}: ${host.enforcement} — ${host.detail}`);
    }
  }
  return doc(
    `${frameworkId} hook controls`,
    lines.length === 0 ? "No hook is disabled." : lines.join("\n"),
  );
}

function labelActions(frameworkId: FrameworkIdV1, actions: unknown): Action[] {
  if (!Array.isArray(actions)) refuse(frameworkId, "actions is not an array");
  // A hook-control plan only labels: any effect goes through `environment`.
  for (const action of actions as Action[]) {
    if (
      typeof action !== "object" ||
      action === null ||
      action.kind !== "doc" ||
      !printable(action.describe, 200) ||
      typeof action.text !== "string"
    ) {
      refuse(frameworkId, "actions may only be label docs");
    }
  }
  return (actions as Action[]).map((action) =>
    action.kind === "doc" ? doc(action.describe, action.text.slice(0, 16_384)) : action,
  );
}

/**
 * Ask each framework's plugin for the hook-control plan the two authorities
 * request (enterprise `governance.frameworkHookControls`, the user list in
 * `.aih-config.json`) for EVERY targeted host, and carry the plan's decisions
 * as labels plus the settings environment it owns. A framework with no request
 * is not loaded. A requested framework whose plugin is missing or broken
 * refuses (`framework-plugin-unavailable` names the install command); the
 * plugin refuses ids and profiles its inventory lacks. Whether the environment
 * is written is the caller's decision (only a Claude target owns it).
 */
export async function frameworkHookControlPlansV1(
  ctx: PlanContext,
  policy: OrgPolicy | undefined,
  deps: Pick<FrameworkCommandDepsV1, "loadPlugin" | "loadDescriptor"> = {},
): Promise<FrameworkHookControlPlansV1> {
  const environments = new Map<FrameworkIdV1, FrameworkHookEnvironmentPatchV1>();
  const actions: Action[] = [];
  const targets = ctx.targets ?? ["claude"];
  for (const frameworkId of FRAMEWORK_IDS_V1) {
    const { enterprise, user } = frameworkHookControlEntriesV1(frameworkId, policy, ctx.root);
    if (enterprise === undefined && user === undefined) continue;
    const loaded = await requireFrameworkPluginV1(frameworkId, deps);
    // Hook planning is read-only: the operation gets no executor and no runtime.
    const context = await frameworkOperationContextV1(
      loaded,
      { ...ctx, targets },
      { policy, options: {}, host: selfContainedFrameworkHostV1(ctx, "planning hook controls") },
      deps,
    );
    const plan: FrameworkHookControlPlanV1 = loaded.plugin.planHookControls(
      context,
      context.policy.hookControls,
    );
    if (plan.frameworkId !== frameworkId) {
      throw new AihError(
        `the ${frameworkId} framework plugin returned a hook-control plan for ${String(plan.frameworkId).slice(0, 32)}`,
        "AIH_FRAMEWORK_PLUGIN",
      );
    }
    actions.push(
      decisionLabel(frameworkId, plan.decisions, targets),
      ...labelActions(frameworkId, plan.actions),
    );
    if (plan.environment !== undefined) {
      environments.set(
        frameworkId,
        validateFrameworkHookEnvironmentV1(frameworkId, plan.environment),
      );
    }
  }
  return { environments, actions };
}
