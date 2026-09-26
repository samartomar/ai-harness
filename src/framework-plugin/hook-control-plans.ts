import type { Cli } from "../internals/clis.js";
import { type Action, doc, type PlanContext } from "../internals/plan.js";
import type { OrgPolicy } from "../org-policy/schema.js";
import {
  FRAMEWORK_IDS_V1,
  FRAMEWORK_PLUGIN_PACKAGE_NAMES,
  type FrameworkHookControlAuthorityV1,
  type FrameworkHookControlDecisionV1,
  type FrameworkHookControlPlanV1,
  type FrameworkHookDisableRequestV1,
  type FrameworkHookEnvironmentPatchV1,
  type FrameworkIdV1,
} from "./contract-v1.js";
import { frameworkHookControlEntriesV1 } from "./hook-controls.js";
import {
  type FrameworkHookEnvironmentPlansV1,
  validateFrameworkHookEnvironmentV1,
} from "./hook-environment.js";
import { FrameworkPluginRefusalError } from "./load-framework-plugin.js";
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
  const packageName = FRAMEWORK_PLUGIN_PACKAGE_NAMES[frameworkId];
  throw new FrameworkPluginRefusalError({
    reason: "framework-plugin-incompatible",
    frameworkId,
    packageName,
    detail: `${packageName} returned an unusable hook-control plan: ${problem}`.slice(0, 2000),
  });
}

function printable(value: unknown, max: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= max &&
    [...value].every((character) => character.charCodeAt(0) >= 0x20)
  );
}

/**
 * One label doc for a framework's decisions; the plan's shape is checked at the
 * boundary. Every requested disable must come back as exactly one disabled
 * decision under its strongest requesting authority, no other hook may come
 * back disabled (whatever authority it claims), and every disabled
 * decision must carry exactly one host decision per targeted host: an
 * omission or a duplicate would otherwise print a control that was never
 * planned (or "No hook is disabled").
 */
function decisionLabel(
  frameworkId: FrameworkIdV1,
  decisions: unknown,
  targets: readonly string[],
  requested: readonly FrameworkHookDisableRequestV1[],
): Action {
  if (!Array.isArray(decisions)) refuse(frameworkId, "decisions is not an array");
  const expected = new Map<string, FrameworkHookControlAuthorityV1>();
  for (const request of requested) {
    if (expected.get(request.hookId) !== "enterprise")
      expected.set(request.hookId, request.authority);
  }
  const hookIds = new Set<string>();
  const lines: string[] = [];
  for (const decision of decisions as FrameworkHookControlDecisionV1[]) {
    if (typeof decision !== "object" || decision === null)
      refuse(frameworkId, "a decision is not an object");
    if (!printable(decision.hookId, 100)) refuse(frameworkId, "a decision names no hook");
    if (hookIds.has(decision.hookId))
      refuse(frameworkId, `${decision.hookId} has more than one decision`);
    hookIds.add(decision.hookId);
    if (decision.state === "enabled") {
      if (expected.has(decision.hookId))
        refuse(frameworkId, `the requested disable of ${decision.hookId} came back enabled`);
      continue;
    }
    if (decision.state !== "disabled")
      refuse(frameworkId, `${decision.hookId} has an unknown state`);
    if (decision.authority !== "enterprise" && decision.authority !== "user") {
      refuse(frameworkId, `${decision.hookId} is disabled without an authority`);
    }
    const authority = expected.get(decision.hookId);
    if (authority === undefined)
      refuse(frameworkId, `${decision.hookId} is disabled, but no authority requested its disable`);
    if (decision.authority !== authority)
      refuse(
        frameworkId,
        `${decision.hookId} is disabled under ${decision.authority}, not ${authority}`,
      );
    if (!Array.isArray(decision.hosts))
      refuse(frameworkId, `${decision.hookId} has no host decisions`);
    lines.push(`${decision.hookId}: disabled (${decision.authority})`);
    const hosts = new Set<string>();
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
      if (hosts.has(host.host))
        refuse(frameworkId, `${decision.hookId} has more than one decision for ${host.host}`);
      hosts.add(host.host);
      lines.push(`  ${host.host}: ${host.enforcement} — ${host.detail}`);
    }
    const missing = targets.filter((target) => !hosts.has(target));
    if (missing.length > 0)
      refuse(frameworkId, `${decision.hookId} has no decision for ${missing.join(", ")}`);
  }
  const omitted = [...expected.keys()].filter((hookId) => !hookIds.has(hookId));
  if (omitted.length > 0)
    refuse(frameworkId, `no decision for the requested disable of ${omitted.join(", ")}`);
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
  const targets: Cli[] = [...new Set<Cli>(ctx.targets ?? ["claude"])];
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
    if (plan.frameworkId !== frameworkId)
      refuse(frameworkId, `it is for ${String(plan.frameworkId).slice(0, 32)}`);
    actions.push(
      decisionLabel(frameworkId, plan.decisions, targets, context.policy.hookControls.disabled),
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
