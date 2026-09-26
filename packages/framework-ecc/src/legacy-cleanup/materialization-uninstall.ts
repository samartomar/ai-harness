import {
  commitMaterializationSteps,
  ECC_MATERIALIZATION_RECEIPT_PATH,
  readEccMaterializationReceipt,
} from "@aihq/core/framework-host";
import type {
  EccMaterializationDeps,
  EccMaterializationResult,
} from "../ecc/materialization-types.js";
import { planEccUninstall } from "./materialization-plan.js";

/** Remove only destinations whose live bytes still match an aih ownership receipt. */
export function uninstallEccMaterialization(
  root: string,
  deps: EccMaterializationDeps = {},
): EccMaterializationResult {
  const state = readEccMaterializationReceipt(root);
  if (state.state === "malformed") {
    return {
      root,
      written: [],
      removed: [],
      unchanged: [],
      advisories: [
        {
          path: ECC_MATERIALIZATION_RECEIPT_PATH,
          reason: "malformed-receipt",
          detail: `${state.detail}; refusing every ownership claim, nothing removed`,
        },
      ],
      receipt: undefined,
    };
  }
  const operation = planEccUninstall(root);
  commitMaterializationSteps(
    operation.root,
    operation.steps.map((step) => ({
      path: step.path,
      mode: step.mode,
      expect: step.expect,
      ...(step.contents === undefined ? {} : { contents: step.contents }),
      ...(step.prior === undefined ? {} : { prior: step.prior }),
      ...(step.priorMode === undefined ? {} : { priorMode: step.priorMode }),
      announce: () =>
        deps.onStep?.({
          phase: step.phase,
          kind: step.kind,
          path: step.path,
          ...(step.plan === undefined ? {} : { componentId: step.plan.componentId }),
        }),
    })),
    deps.rename === undefined ? {} : { rename: deps.rename },
  );
  deps.onLedgerUpdate?.({
    root: operation.root,
    components: operation.components.map((component) => ({
      id: component.id as `${string}:${string}`,
      authorization: component.authorization,
    })),
  });
  return {
    root: operation.root,
    written: operation.write,
    removed: operation.subtract,
    unchanged: operation.unchanged,
    advisories: operation.advisories,
    receipt: operation.receipt,
  };
}
