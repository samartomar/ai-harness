import { resolve } from "node:path";
import { baselineCatalogById } from "../baseline-evidence/catalogs.js";
import { executeBaselineEvidencePipeline } from "../baseline-evidence/pipeline.js";
import { loadCatalogPackageV1 } from "../catalog-package/load-catalog-package.js";
import { AihError } from "../errors.js";
import { executePlan, type PlanResult } from "../internals/execute.js";
import type { Plan, PlanContext } from "../internals/plan.js";
import { assertPolicyBindingCurrent, policyBindingFileAssertion } from "../org-policy/binding.js";
import { assertOrgPolicyMutationSource } from "../org-policy/drift.js";
import { verifiedOrgPolicyTargets } from "../org-policy/project.js";
import { readOrgPolicy } from "../org-policy/schema.js";
import {
  historicalEccRuntimeDescriptorsFromSourceDataV1,
  workbenchSourceDataRootV1,
} from "../org-policy/workbench/core/source-data.js";
import { consumeWorkbenchPolicy } from "../org-policy/workbench/policy-consumption.js";
import { cleanupQuarantine, resolveTrustSource } from "../trust/fetch.js";
import type { FrameworkCoreRuntimeV1, FrameworkIdV1 } from "./contract-v1.js";
import type { FrameworkTransactionPinsV1 } from "./host-services.js";

/**
 * The frameworks whose command operations get Core's runtime. Superpowers
 * gets none: all of its effects go through the evidence-gated install service.
 * ECC's moved implementation drives Core's executors itself (install,
 * materialization, the governed profile, explicit MCP add/remove), so it runs
 * against this runtime instead.
 */
export const FRAMEWORK_CORE_RUNTIME_FRAMEWORKS: ReadonlySet<FrameworkIdV1> = new Set(["ecc"]);

export interface BoundFrameworkCoreRuntimeV1 {
  readonly runtime: FrameworkCoreRuntimeV1;
  /** End the invocation: every member refuses afterwards. */
  revoke(): void;
}

export interface FrameworkCoreRuntimeInputV1 {
  readonly frameworkId: FrameworkIdV1;
  /** The invocation's plan context, with `targets` resolved. */
  readonly ctx: PlanContext;
  readonly transactionPins: FrameworkTransactionPinsV1;
  /** Every plan result the runtime returns is recorded here. */
  readonly produced: WeakSet<object>;
}

type Pins = FrameworkTransactionPinsV1;

/**
 * Carry the invocation's policy custody pins into a plan the framework built,
 * whatever pins the plan already has: the invocation's file assertions are
 * added, the earlier deadline wins, and a different commit lock is refused.
 */
function forcePins(frameworkId: FrameworkIdV1, pins: Pins, own: Pins | undefined): Pins {
  const lock =
    pins.commitLock === undefined
      ? own?.commitLock
      : own?.commitLock === undefined ||
          JSON.stringify(own.commitLock) === JSON.stringify(pins.commitLock)
        ? pins.commitLock
        : (() => {
            throw new AihError(
              `the ${frameworkId} framework plugin planned under another policy commit lock than its invocation`,
              "AIH_FRAMEWORK_PLUGIN",
            );
          })();
  const deadlines = [pins.commitNotAfter, own?.commitNotAfter].filter(
    (deadline): deadline is string => deadline !== undefined,
  );
  const deadline = deadlines.sort((a, b) => Date.parse(a) - Date.parse(b))[0];
  const assertions = [...(pins.fileAssertions ?? []), ...(own?.fileAssertions ?? [])];
  return {
    ...(assertions.length === 0 ? {} : { fileAssertions: assertions }),
    ...(deadline === undefined ? {} : { commitNotAfter: deadline }),
    ...(lock === undefined ? {} : { commitLock: lock }),
  };
}

/**
 * Bind Core's runtime to one framework command invocation. Each member runs
 * Core's own implementation, and:
 * - refuses once the invocation has ended ({@link BoundFrameworkCoreRuntimeV1.revoke});
 * - refuses a plan context or root other than the invocation's;
 * - executes plans and the evidence pipeline with the invocation's policy
 *   transaction pins forced in, and records every result so the command's
 *   result is accepted only if Core produced it.
 */
export function bindFrameworkCoreRuntimeV1(
  input: FrameworkCoreRuntimeInputV1,
): BoundFrameworkCoreRuntimeV1 {
  const { frameworkId, ctx, transactionPins, produced } = input;
  const root = resolve(ctx.root);
  let live = true;
  const check = (member: string, candidateRoot?: string): void => {
    if (!live) {
      throw new AihError(
        `the ${frameworkId} framework plugin used Core's ${member} after its invocation ended`,
        "AIH_FRAMEWORK_PLUGIN",
      );
    }
    if (candidateRoot !== undefined && resolve(candidateRoot) !== root) {
      throw new AihError(
        `the ${frameworkId} framework plugin asked Core's ${member} to act on another root than its invocation`,
        "AIH_FRAMEWORK_PLUGIN",
      );
    }
  };
  const record = (result: PlanResult): PlanResult => {
    produced.add(result);
    return result;
  };
  const runtime: FrameworkCoreRuntimeV1 = Object.freeze({
    planContext: ctx,
    executePlan: async (
      plan: Plan,
      planCtx: PlanContext,
      opts?: { skipWorktreeGate?: boolean },
    ) => {
      check("executePlan", planCtx.root);
      return record(
        await executePlan(
          { ...plan, ...forcePins(frameworkId, transactionPins, plan) },
          planCtx,
          opts,
        ),
      );
    },
    executeBaselineEvidencePipeline: async (planCtx, request, deps) => {
      check("evidence pipeline", planCtx.root);
      return record(
        await executeBaselineEvidencePipeline(
          planCtx,
          {
            ...request,
            transactionPins: forcePins(frameworkId, transactionPins, request.transactionPins),
          },
          deps,
        ),
      );
    },
    resolveTrustSource: (...args) => {
      check("source resolution", args[1]?.root);
      return resolveTrustSource(...args);
    },
    cleanupQuarantine: (...args) => {
      check("quarantine cleanup");
      return cleanupQuarantine(...args);
    },
    verifiedOrgPolicyTargets: (planCtx, ...rest) => {
      check("policy targets", planCtx.root);
      return verifiedOrgPolicyTargets(planCtx, ...rest);
    },
    assertPolicyBindingCurrent: (bindingRoot, ...rest) => {
      check("policy binding", bindingRoot);
      return assertPolicyBindingCurrent(bindingRoot, ...rest);
    },
    policyBindingFileAssertion: (bindingRoot, ...rest) => {
      check("policy binding", bindingRoot);
      return policyBindingFileAssertion(bindingRoot, ...rest);
    },
    assertOrgPolicyMutationSource: (planCtx, ...rest) => {
      check("policy mutation gate", planCtx.root);
      return assertOrgPolicyMutationSource(planCtx, ...rest);
    },
    readOrgPolicy: (policyRoot, ...rest) => {
      check("policy reader", policyRoot);
      return readOrgPolicy(policyRoot, ...rest);
    },
    baselineCatalogById: (...args) => {
      check("evidence catalog");
      return baselineCatalogById(...args);
    },
    loadCatalogPackageV1: (...args) => {
      check("Catalog loader");
      return loadCatalogPackageV1(...args);
    },
    historicalEccRuntimeDescriptorsFromSourceDataV1: (...args) => {
      check("runtime descriptors");
      return historicalEccRuntimeDescriptorsFromSourceDataV1(...args);
    },
    workbenchSourceDataRootV1: (...args) => {
      check("Workbench source data");
      return workbenchSourceDataRootV1(...args);
    },
    consumeWorkbenchPolicy: (...args) => {
      check("Workbench policy consumption");
      return consumeWorkbenchPolicy(...args);
    },
  } satisfies FrameworkCoreRuntimeV1);
  return Object.freeze({
    runtime,
    revoke: () => {
      live = false;
    },
  });
}
