import {
  type Action,
  type Cli,
  doc,
  type FrameworkOperationContextV1,
  type FrameworkPruneHookV1,
  type FrameworkPrunePlanV1,
  type FrameworkUninstallHookV1,
  type FrameworkUninstallOutcomeV1,
  lines,
  plan,
} from "@aihq/core/framework-host";
import {
  eccPruneReconciliationActions,
  hasEccRegisteredTarget,
  hasEccRegistrationLedger,
} from "./ecc/prune-reconcile.js";
import { currentCoreRuntime, currentEccInvocation, withEccInvocation } from "./invocation.js";
import { isAihDirectEccInstallTarget } from "./legacy-cleanup/direct-targets.js";
import { legacyCleanupActions } from "./legacy-cleanup/index.js";
import { uninstallEccMaterialization } from "./legacy-cleanup/materialization-uninstall.js";

/**
 * `aih uninstall --apply`: subtract every byte the governed materialization
 * receipt proves aih wrote. The engine keeps the per-file digest match, the
 * operator-content guarantee and the rollback; a destination it cannot prove
 * is kept and reported.
 */
export const uninstall: FrameworkUninstallHookV1 = Object.freeze({
  remove: (ctx: FrameworkOperationContextV1) =>
    withEccInvocation(ctx, async (): Promise<FrameworkUninstallOutcomeV1> => {
      const result = uninstallEccMaterialization(ctx.root);
      const runtime = currentEccInvocation().runtime;
      const legacy =
        runtime === undefined
          ? { removed: [], digests: [] }
          : await runtime.executePlan(
              plan(
                "legacy ECC receipt cleanup",
                ...legacyCleanupActions(runtime.planContext, "uninstall"),
              ),
              runtime.planContext,
              { skipWorktreeGate: true },
            );
      return {
        removed: [
          ...result.removed.map((file) => file.path),
          ...legacy.removed.map((file) => file.path),
        ],
        advisories: [
          ...result.advisories.map((advisory) => ({
            path: advisory.path,
            reason: advisory.reason,
            detail: advisory.detail,
          })),
          ...legacy.digests.map((entry) => ({
            path: "legacy ECC cleanup",
            reason: "manual-review",
            detail: entry.text,
          })),
        ],
      };
    }),
});

function unreceiptedEccPreservationDoc(cli: Cli): Action {
  return doc(
    `Preserve unreceipted ECC ${cli} footprint`,
    lines(
      `No AIH ECC registration ledger target receipt authenticates the ${cli} install state.`,
      "Prune preserves the target's client files and skips upstream uninstall execution.",
      "AIH-owned repository adapters and managed bootloader blocks remain eligible for cleanup.",
    ),
  );
}

/**
 * `aih prune`: ECC's share of reconciling the dropped targets, planned
 * against the prune invocation's plan context (Core's runtime). A target the
 * registration ledger does not authenticate is preserved (a doc, no effect);
 * the Codex footprint is subtracted when no ledger coordinates Codex; the
 * ledger-coordinated reconciliation covers the rest.
 */
export const prune: FrameworkPruneHookV1 = Object.freeze({
  plan: (ctx: FrameworkOperationContextV1, dropped: readonly Cli[], kept?: readonly Cli[]) =>
    withEccInvocation(ctx, async (): Promise<FrameworkPrunePlanV1> => {
      const planContext = currentCoreRuntime().planContext;
      const actions: Action[] = [];
      const subtracted = 0;
      const coordinated = hasEccRegistrationLedger(planContext);
      for (const cli of dropped) {
        if (
          isAihDirectEccInstallTarget(cli) &&
          (!coordinated || !hasEccRegisteredTarget(planContext, cli))
        ) {
          actions.push(unreceiptedEccPreservationDoc(cli));
        }
      }
      actions.push(...eccPruneReconciliationActions(planContext, dropped));
      actions.push(...legacyCleanupActions(planContext, "prune", dropped, kept));
      return { actions, subtracted };
    }),
});
