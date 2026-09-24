import type {
  FrameworkCapabilityPackageDomainV1,
  FrameworkCapabilityPackagesHookV1,
  FrameworkOperationContextV1,
} from "@aihq/core/framework-host";
import { planEccComponentSubtraction } from "./ecc/materialization-plan.js";
import {
  explicitEccMcpRenderPlan,
  planExplicitEccMcpRemove,
  readExplicitEccMcpReceiptStates,
} from "./ecc/mcp-explicit-add.js";
import { withEccInvocation } from "./invocation.js";

/**
 * ECC's planning for `aih capability package`: receipt-proven subtraction of
 * ECC agent/rule packages and the explicit ECC MCP receipt. Every call runs
 * inside the invocation Core built; Core executes what it returns.
 */
export const capabilityPackages: FrameworkCapabilityPackagesHookV1 = Object.freeze({
  domain: (ctx: FrameworkOperationContextV1): FrameworkCapabilityPackageDomainV1 => {
    const domain: FrameworkCapabilityPackageDomainV1 = {
      planComponentSubtraction: (root, componentIds) =>
        withEccInvocation(ctx, () => {
          const planned = planEccComponentSubtraction(root, componentIds);
          return {
            steps: planned.steps.map((step) => ({
              kind: step.kind,
              path: step.path,
              mode: step.mode,
              expect: step.expect,
              ...(step.contents === undefined ? {} : { contents: step.contents }),
              ...(step.prior === undefined ? {} : { prior: step.prior }),
              ...(step.priorMode === undefined ? {} : { priorMode: step.priorMode }),
            })),
            advisories: planned.advisories,
          };
        }),
      assertExplicitMcpApproved: (policy, id, target) =>
        withEccInvocation(ctx, () => {
          explicitEccMcpRenderPlan(policy, id, target);
        }),
      planExplicitMcpRemove: (input) =>
        withEccInvocation(ctx, () => ({ actions: planExplicitEccMcpRemove(input).actions })),
      explicitMcpReceiptStates: (root) =>
        withEccInvocation(ctx, () =>
          readExplicitEccMcpReceiptStates({ root }).map((state) => ({
            ...(state.id === undefined ? {} : { id: state.id }),
            ...(state.target === undefined ? {} : { target: state.target }),
            state: state.state,
          })),
        ),
    };
    return Object.freeze(domain);
  },
});
