import { AihError } from "../errors.js";
import type { PlanResult } from "../internals/execute.js";
import type { CommandSpec, PlanContext } from "../internals/plan.js";
import { verifiedOrgPolicyTargets } from "../org-policy/project.js";
import { FRAMEWORK_PLUGIN_PACKAGE_NAMES, type FrameworkCommandPathV1 } from "./contract-v1.js";
import {
  executeFrameworkCommandV1,
  type FrameworkCommandDepsV1,
  type FrameworkInvocationV1,
  requireFrameworkPluginV1,
} from "./run-framework-command.js";

/**
 * `aih ecc` — Core keeps the command surface
 * (names, summaries, options) and the invocation's decisions: the policy
 * targets and the policy custody pins its runtime forces into every
 * transaction. Everything ECC-specific runs in `@aihq/framework-ecc`, against
 * the Core runtime bound to the invocation; without the plugin these commands
 * refuse with `framework-plugin-unavailable` and name the install command.
 */

const PACKAGE = FRAMEWORK_PLUGIN_PACKAGE_NAMES.ecc;

function runsThroughPlugin(path: FrameworkCommandPathV1<"ecc">): CommandSpec["plan"] {
  return () => {
    throw new AihError(
      `aih ${path} runs through ${PACKAGE} and Core's runtime; it has no standalone plan`,
      "AIH_FRAMEWORK_PLUGIN",
    );
  };
}

/** Core's decisions for one ECC invocation: the policy targets and custody pins. */
async function eccInvocation(ctx: PlanContext): Promise<FrameworkInvocationV1> {
  const policyTargets = await verifiedOrgPolicyTargets(ctx);
  return {
    ctx: { ...ctx, targets: policyTargets.resolution.clis },
    policy: policyTargets.policy,
    transactionPins: {
      ...(policyTargets.fileAssertions === undefined
        ? {}
        : { fileAssertions: policyTargets.fileAssertions }),
      ...(policyTargets.commitNotAfter === undefined
        ? {}
        : { commitNotAfter: policyTargets.commitNotAfter }),
      ...(policyTargets.commitLock === undefined ? {} : { commitLock: policyTargets.commitLock }),
    },
    options: ctx.options,
  };
}

async function executeEccPath(
  path: FrameworkCommandPathV1<"ecc">,
  ctx: PlanContext,
  deps: FrameworkCommandDepsV1,
): Promise<PlanResult> {
  const loaded = await requireFrameworkPluginV1("ecc", deps);
  return executeFrameworkCommandV1(loaded, path, await eccInvocation(ctx), deps);
}

export function executeEccCommand(
  ctx: PlanContext,
  deps: FrameworkCommandDepsV1 = {},
): Promise<PlanResult> {
  return executeEccPath("ecc", ctx, deps);
}

export const command: CommandSpec = {
  name: "ecc",
  summary: "Show developer-managed ECC installation guidance or read-only status",
  options: [
    {
      flags: "--status",
      description: "report ECC install-state file presence",
    },
    { flags: "--cli <list>", description: "CLI targets for developer guidance" },
  ],
  plan: runsThroughPlugin("ecc"),
  zeroWrite: true,
  readOnly: true,
};
