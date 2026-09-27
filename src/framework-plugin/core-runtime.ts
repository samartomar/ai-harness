import { resolve } from "node:path";
import { AihError } from "../errors.js";
import { executePlan, type PlanResult } from "../internals/execute.js";
import type { Plan, PlanContext } from "../internals/plan.js";
import type { FrameworkCoreRuntimeV1, FrameworkIdV1 } from "./contract-v1.js";
import type { FrameworkTransactionPinsV1 } from "./host-services.js";

/** ECC guidance commands use Core's bounded plan executor. */
export const FRAMEWORK_CORE_RUNTIME_FRAMEWORKS: ReadonlySet<FrameworkIdV1> = new Set(["ecc"]);

export interface BoundFrameworkCoreRuntimeV1 {
  readonly runtime: FrameworkCoreRuntimeV1;
  /** End the invocation: the executor refuses afterwards. */
  revoke(): void;
}

export interface FrameworkCoreRuntimeInputV1 {
  readonly frameworkId: FrameworkIdV1;
  readonly ctx: PlanContext;
  readonly transactionPins: FrameworkTransactionPinsV1;
  readonly produced: WeakSet<object>;
}

/** Apply the invocation's policy pins to a framework plan. */
function forcePins(
  frameworkId: FrameworkIdV1,
  pins: FrameworkTransactionPinsV1,
  own: FrameworkTransactionPinsV1 | undefined,
): FrameworkTransactionPinsV1 {
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

/** Bind the ECC guidance executor to one root, one policy, and one invocation. */
export function bindFrameworkCoreRuntimeV1(
  input: FrameworkCoreRuntimeInputV1,
): BoundFrameworkCoreRuntimeV1 {
  const { frameworkId, ctx, produced, transactionPins } = input;
  const root = resolve(ctx.root);
  let live = true;
  const runtime: FrameworkCoreRuntimeV1 = Object.freeze({
    planContext: ctx,
    executePlan: async (
      plan: Plan,
      planCtx: PlanContext,
      opts?: { skipWorktreeGate?: boolean },
    ): Promise<PlanResult> => {
      if (!live)
        throw new AihError(
          `the ${frameworkId} framework plugin used Core's executePlan after its invocation ended`,
          "AIH_FRAMEWORK_PLUGIN",
        );
      if (resolve(planCtx.root) !== root)
        throw new AihError(
          `the ${frameworkId} framework plugin asked Core's executePlan to act on another root than its invocation`,
          "AIH_FRAMEWORK_PLUGIN",
        );
      const result = await executePlan(
        { ...plan, ...forcePins(frameworkId, transactionPins, plan) },
        planCtx,
        opts,
      );
      produced.add(result);
      return result;
    },
  });
  return Object.freeze({
    runtime,
    revoke: () => {
      live = false;
    },
  });
}
