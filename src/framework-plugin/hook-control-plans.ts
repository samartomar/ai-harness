import { AihError } from "../errors.js";
import type { PlanContext } from "../internals/plan.js";
import type { OrgPolicy } from "../org-policy/schema.js";
import {
  FRAMEWORK_IDS_V1,
  type FrameworkHookEnvironmentPatchV1,
  type FrameworkHostServicesV1,
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
} from "./run-framework-command.js";

export type { FrameworkHookEnvironmentPlansV1 } from "./hook-environment.js";

/** Hook planning is read-only: the operation gets no executor and no runtime. */
function planningHost(ctx: PlanContext): FrameworkHostServicesV1 {
  const refuseEffect = async (): Promise<never> => {
    throw new AihError(
      "a framework plugin requested an effect while planning hook controls",
      "AIH_FRAMEWORK_PLUGIN",
    );
  };
  return Object.freeze({
    runEvidenceGatedInstall: refuseEffect,
    executePlan: refuseEffect,
    progress: (message: string) => ctx.progress?.(message),
  });
}

/**
 * Ask each framework's plugin for the hook-control plan the two authorities
 * request (enterprise `governance.frameworkHookControls`, the user list in
 * `.aih-config.json`) and return the settings environment each plan owns. A
 * framework with no request is not loaded. A requested framework whose plugin
 * is missing or broken refuses (`framework-plugin-unavailable` names the
 * install command); the plugin refuses ids and profiles its inventory lacks.
 */
export async function frameworkHookEnvironmentPlansV1(
  ctx: PlanContext,
  policy: OrgPolicy | undefined,
  deps: Pick<FrameworkCommandDepsV1, "loadPlugin" | "loadDescriptor"> = {},
): Promise<FrameworkHookEnvironmentPlansV1> {
  const plans = new Map<FrameworkIdV1, FrameworkHookEnvironmentPatchV1>();
  for (const frameworkId of FRAMEWORK_IDS_V1) {
    const { enterprise, user } = frameworkHookControlEntriesV1(frameworkId, policy, ctx.root);
    if (enterprise === undefined && user === undefined) continue;
    const loaded = await requireFrameworkPluginV1(frameworkId, deps);
    const context = await frameworkOperationContextV1(
      loaded,
      { ...ctx, targets: ctx.targets ?? ["claude"] },
      { policy, options: {}, host: planningHost(ctx) },
      deps,
    );
    const plan = loaded.plugin.planHookControls(context, context.policy.hookControls);
    if (plan.frameworkId !== frameworkId) {
      throw new AihError(
        `the ${frameworkId} framework plugin returned a hook-control plan for ${String(plan.frameworkId).slice(0, 32)}`,
        "AIH_FRAMEWORK_PLUGIN",
      );
    }
    if (plan.environment !== undefined) {
      plans.set(frameworkId, validateFrameworkHookEnvironmentV1(frameworkId, plan.environment));
    }
  }
  return plans;
}
