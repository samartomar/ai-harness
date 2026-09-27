import type {
  FrameworkOperationContextV1,
  FrameworkPluginDescriptionV1,
  FrameworkPluginV1,
  PlanResult,
} from "@aihq/core/framework-host";
import { doc, FRAMEWORK_PLUGIN_CLEANUP_VERSION, plan } from "@aihq/core/framework-host";
import { ECC_DESCRIPTOR_SECTIONS } from "./descriptor.js";
import { doctor } from "./doctor.js";
import { eccGuidance, eccStatus } from "./guidance.js";
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
import { prune, uninstall } from "./lifecycle-hooks.js";
import { policyDelivery } from "./policy-inspection.js";

function describe(): FrameworkPluginDescriptionV1 {
  return {
    frameworkId: "ecc",
    displayName: "ECC",
    upstream: { ...UPSTREAM },
    supportedHosts: [...SUPPORTED_HOSTS],
    catalogSubpath: "./catalog-framework-ecc.json",
    descriptorSections: [...ECC_DESCRIPTOR_SECTIONS],
    environment: [...ENVIRONMENT_VARIABLES],
    // ECC files are managed by the developer and its own installer.
    ownedArtifacts: [],
  };
}

/** The framework plugin export `@aihq/core` loads (contract 1, C3). */
export const aihFrameworkPluginV1: FrameworkPluginV1 = Object.freeze({
  contractVersion: CONTRACT_VERSION,
  cleanupVersion: FRAMEWORK_PLUGIN_CLEANUP_VERSION,
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
        withEccInvocation(ctx, async () => {
          const runtime = currentCoreRuntime();
          const context = runtime.planContext;
          const home = context.env.HOME ?? context.env.USERPROFILE ?? context.root;
          const text =
            context.options.status === true
              ? eccStatus(context.root, home)
              : eccGuidance(ctx.targets, context.host.platform);
          return runtime.executePlan(
            plan(
              context.options.status === true ? "ecc: status" : "ecc: guidance",
              doc("ECC", text),
            ),
            context,
          );
        }),
    }),
  }),
  policyDelivery,
  uninstall,
  prune,
  doctor,
});
