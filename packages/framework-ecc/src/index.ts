import type {
  CommandSpec,
  FrameworkCommandV1,
  FrameworkOperationContextV1,
  FrameworkPluginDescriptionV1,
  FrameworkPluginV1,
  PlanResult,
} from "@aihq/core/framework-host";
import { executePlan } from "./core-runtime.js";
import { ECC_DESCRIPTOR_SECTIONS } from "./descriptor.js";
import { eccMcpAddCommand, eccMcpRemoveCommand } from "./ecc/index.js";
import { executeEccCommand } from "./ecc/pipeline.js";
import { hookInventory, planHookControls } from "./hooks.js";
import { identifyComponents } from "./identify.js";
import {
  CONTRACT_VERSION,
  ENVIRONMENT_VARIABLES,
  HOST_API_VERSION,
  PACKAGE_NAME,
  PACKAGE_VERSION,
  SUPPORTED_HOSTS,
  UPSTREAM,
} from "./identity.js";
import { currentCoreRuntime, withEccInvocation } from "./invocation.js";
import { eccPolicyDelivery } from "./policy-delivery.js";

function describe(): FrameworkPluginDescriptionV1 {
  return {
    frameworkId: "ecc",
    displayName: "ECC",
    upstream: { ...UPSTREAM },
    supportedHosts: [...SUPPORTED_HOSTS],
    catalogSubpath: "./catalog-framework-ecc.json",
    descriptorSections: [...ECC_DESCRIPTOR_SECTIONS],
    environment: [...ENVIRONMENT_VARIABLES],
    // ECC materializes per-component files; its receipts record each one, so no
    // fixed per-host artifact list describes them.
    ownedArtifacts: [],
  };
}

/**
 * One ECC command: plan it against the plan context Core bound to the
 * invocation and execute the plan through Core's runtime, which carries the
 * invocation's policy pins and is the only producer of a result Core accepts.
 */
function commandOf(spec: CommandSpec): FrameworkCommandV1 {
  return Object.freeze({
    execute: (ctx: FrameworkOperationContextV1): Promise<PlanResult> =>
      withEccInvocation(ctx, async () => {
        const planContext = currentCoreRuntime().planContext;
        return executePlan(await spec.plan(planContext), planContext);
      }),
  });
}

/** The framework plugin export `@aihq/core` loads (contract 1, C3). */
export const aihFrameworkPluginV1: FrameworkPluginV1 = Object.freeze({
  contractVersion: CONTRACT_VERSION,
  hostApiVersion: HOST_API_VERSION,
  frameworkId: "ecc",
  packageName: PACKAGE_NAME,
  packageVersion: PACKAGE_VERSION,
  describe,
  identifyComponents,
  hookInventory,
  planHookControls,
  commands: Object.freeze({
    ecc: Object.freeze({
      execute: (ctx: FrameworkOperationContextV1): Promise<PlanResult> =>
        withEccInvocation(ctx, async () => executeEccCommand(currentCoreRuntime().planContext)),
    }),
    "ecc mcp add": commandOf(eccMcpAddCommand),
    "ecc mcp remove": commandOf(eccMcpRemoveCommand),
  }),
  policyDelivery: eccPolicyDelivery(),
});
