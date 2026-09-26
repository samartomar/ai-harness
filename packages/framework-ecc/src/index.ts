import type {
  CommandSpec,
  FrameworkCommandV1,
  FrameworkOperationContextV1,
  FrameworkPluginDescriptionV1,
  FrameworkPluginV1,
  PlanResult,
} from "@aihq/core/framework-host";
import { AihError, doc, FRAMEWORK_PLUGIN_CLEANUP_VERSION, plan } from "@aihq/core/framework-host";
import { capabilityPackages } from "./capability-packages.js";
import { executePlan } from "./core-runtime.js";
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
import { legacyMcpRemovePlan } from "./legacy-cleanup/mcp-command.js";
import { prune, uninstall } from "./lifecycle-hooks.js";
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
          const lifecycle = context.options.lifecycle;
          if (lifecycle === "uninstall") {
            if (!context.apply)
              return runtime.executePlan(
                plan(
                  "ecc: legacy uninstall preview",
                  doc(
                    "ECC cleanup",
                    "Pass --apply to remove unchanged receipt-owned ECC content. Modified and ambiguous items are preserved and reported.",
                  ),
                ),
                context,
              );
            const outcome = await uninstall.remove(ctx);
            return runtime.executePlan(
              plan(
                "ecc: legacy uninstall",
                doc(
                  "ECC cleanup",
                  [
                    ...outcome.removed.map((path) => `Removed: ${path}`),
                    ...outcome.advisories.map((entry) => `Manual: ${entry.path}: ${entry.detail}`),
                  ].join("\n") || "No receipt-owned ECC content remained.",
                ),
              ),
              context,
            );
          }
          const retired =
            context.apply && context.options.allTools === true
              ? "--all-tools --apply"
              : context.apply
                ? "--apply"
                : lifecycle !== undefined
                  ? `--lifecycle ${String(lifecycle)}`
                  : context.options.profile !== undefined
                    ? "--profile"
                    : Array.isArray(context.options.with) && context.options.with.length > 0
                      ? "--with"
                      : context.options.eccPath !== undefined
                        ? "--ecc-path"
                        : undefined;
          if (retired !== undefined)
            throw new AihError(
              `aih ecc ${retired} was retired: aih no longer installs ECC. Run aih ecc for the exact ECC commands.`,
              "AIH_CONFIG",
            );
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
    "ecc mcp remove": commandOf({
      name: "remove",
      summary: "Remove receipt-owned ECC MCP",
      plan: legacyMcpRemovePlan,
    }),
  }),
  policyDelivery: eccPolicyDelivery(),
  capabilityPackages,
  uninstall,
  prune,
  doctor,
});
