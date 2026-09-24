import type {
  FileAssertion,
  FrameworkPolicyDeliveryCommitV1,
  FrameworkPolicyDeliveryHookV1,
  FrameworkPreparedPolicyDeliveryV1,
  PlanResult,
} from "@aihq/core/framework-host";
import {
  applyPreparedGovernedEccDelivery,
  type PreparedGovernedEccDelivery,
} from "./ecc/governed-lifecycle.js";
import { type EccCommandDeps, executeEccCommand } from "./ecc/pipeline.js";
import { currentCoreRuntime, withEccInvocation } from "./invocation.js";

function samePath(a: string, b: string): boolean {
  const normal = (path: string) => path.replace(/\\/g, "/").replace(/^\.\//, "");
  return normal(a) === normal(b);
}

/** The prepared delivery with Core's re-read binding assertion in place of the prepared one. */
function withPolicyBinding(
  prepared: PreparedGovernedEccDelivery,
  policyBinding: FileAssertion | undefined,
): PreparedGovernedEccDelivery {
  if (policyBinding === undefined) return prepared;
  const guard = prepared.transactionGuard;
  return {
    ...prepared,
    transactionGuard: {
      ...guard,
      fileAssertions: [
        ...(guard?.fileAssertions ?? []).filter(
          (assertion) => !samePath(assertion.path, policyBinding.path),
        ),
        policyBinding,
      ],
    },
  };
}

/**
 * Governed ECC delivery around Core's policy projection: prepare verifies the
 * policy's ECC selection through the evidence gate and holds the exact bytes
 * and ownership plan in memory; commit writes exactly that preparation, after
 * Core projected its own policy settings. `deps` is this package's test seam.
 */
export function eccPolicyDelivery(deps: EccCommandDeps = {}): FrameworkPolicyDeliveryHookV1 {
  const hook: FrameworkPolicyDeliveryHookV1 = {
    prepare: (ctx) =>
      withEccInvocation(ctx, async (): Promise<FrameworkPreparedPolicyDeliveryV1> => {
        const planContext = currentCoreRuntime().planContext;
        let prepared: PreparedGovernedEccDelivery | undefined;
        const result = await executeEccCommand(planContext, {
          ...deps,
          prepareOnly: true,
          onGovernedPrepared: (delivery) => {
            prepared = delivery;
          },
        });
        const retained = prepared;
        if (!planContext.apply || retained === undefined) return Object.freeze({ result });
        return Object.freeze({
          result,
          commit: (update: FrameworkPolicyDeliveryCommitV1): Promise<PlanResult> =>
            withEccInvocation(ctx, () =>
              applyPreparedGovernedEccDelivery(
                planContext,
                withPolicyBinding(retained, update.policyBinding),
                result,
                deps,
              ),
            ),
        });
      }),
  };
  return Object.freeze(hook);
}
