import {
  CatalogPackageRefusalError,
  catalogPackageRefusalMessage,
} from "../catalog-package/load-catalog-package.js";
import { AihError } from "../errors.js";
import { executePlan, type PlanResult } from "../internals/execute.js";
import {
  type CommandSpec,
  doc,
  type PlanContext,
  plan,
  structuredChecksProbe,
} from "../internals/plan.js";
import type { Check } from "../internals/verify.js";
import { assertOrgPolicyMutationSource } from "../org-policy/drift.js";
import { verifiedOrgPolicyTargets } from "../org-policy/project.js";
import { FRAMEWORK_PLUGIN_PACKAGE_NAMES } from "./contract-v1.js";
import {
  FrameworkPluginRefusalError,
  frameworkPluginRefusalMessage,
} from "./load-framework-plugin.js";
import {
  executeFrameworkCommandV1,
  type FrameworkCommandDepsV1,
  requireFrameworkPluginV1,
} from "./run-framework-command.js";

/**
 * `aih superpowers` — Core keeps the command surface (name, summary, options)
 * and the decisions: policy targets, the policy mutation-source gate, the
 * Catalog descriptor and the evidence gate. Everything Superpowers-specific
 * runs in `@aihq/framework-superpowers`; without it the command refuses.
 */

const PACKAGE = FRAMEWORK_PLUGIN_PACKAGE_NAMES.superpowers;

export async function executeSuperpowersCommand(
  ctx: PlanContext,
  deps: FrameworkCommandDepsV1 = {},
): Promise<PlanResult> {
  const loaded = await requireFrameworkPluginV1("superpowers", deps);
  const policyTargets = await verifiedOrgPolicyTargets(ctx);
  const targetCtx: PlanContext = { ...ctx, targets: policyTargets.resolution.clis };
  assertOrgPolicyMutationSource(targetCtx, policyTargets.source?.verification.authority);
  return executeFrameworkCommandV1(
    loaded,
    "superpowers",
    {
      ctx: targetCtx,
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
      options: {},
    },
    deps,
  );
}

function refusedPhase(ctx: PlanContext, reason: string, message: string, check: Check) {
  return executePlan(
    plan(
      "init: superpowers",
      doc(`init: superpowers — refused (${reason})`, message),
      structuredChecksProbe("init superpowers phase", () => [check]),
    ),
    ctx,
  );
}

/**
 * The `aih init` Superpowers phase: the same evidence-gated plugin path as
 * `aih superpowers`, with init's resolved targets. It always verifies, like the
 * command. A missing plugin (or Catalog descriptor) is reported as a refused
 * phase with its reason — a coded skip; an installed-but-unusable one fails.
 */
export async function executeSuperpowersInitPhase(
  ctx: PlanContext,
  deps: FrameworkCommandDepsV1 = {},
): Promise<PlanResult> {
  const phaseCtx: PlanContext = { ...ctx, verify: true };
  try {
    return await executeSuperpowersCommand(phaseCtx, deps);
  } catch (error) {
    if (error instanceof FrameworkPluginRefusalError) {
      const unavailable = error.refusal.reason === "framework-plugin-unavailable";
      return refusedPhase(
        phaseCtx,
        error.refusal.reason,
        frameworkPluginRefusalMessage(error.refusal),
        {
          name: "init superpowers phase",
          verdict: unavailable ? "skip" : "fail",
          code: unavailable ? "framework-plugin.unavailable" : "framework-plugin.incompatible",
          detail: `refused: ${frameworkPluginRefusalMessage(error.refusal)}`,
        },
      );
    }
    if (error instanceof CatalogPackageRefusalError) {
      const unavailable = error.refusal.reason === "catalog-package-unavailable";
      return refusedPhase(
        phaseCtx,
        error.refusal.reason,
        catalogPackageRefusalMessage(error.refusal),
        {
          name: "init superpowers phase",
          verdict: unavailable ? "skip" : "fail",
          detail: `refused: ${catalogPackageRefusalMessage(error.refusal)}`,
        },
      );
    }
    throw error;
  }
}

export const command: CommandSpec = {
  name: "superpowers",
  summary:
    "Verify exact-pinned obra/Superpowers components and emit evidence-bound target guidance",
  options: [],
  plan: () => {
    throw new AihError(
      `aih superpowers runs through ${PACKAGE} and its evidence-gated executor; it has no standalone plan`,
      "AIH_FRAMEWORK_PLUGIN",
    );
  },
  alwaysVerify: true,
};
