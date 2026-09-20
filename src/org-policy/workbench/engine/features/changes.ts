import {
  changeHunks,
  type DiffHunkGap,
  type DiffLine,
  policyLineDiff,
} from "../../ui/shell/policy-diff.js";
import type { AdminEngineContext } from "./context.js";

/** The Changes view's feature: the draft's diff against the starting policy. */
export interface ChangesFeature {
  /**
   * The draft's line changes against the STARTING policy, as hunks with
   * context and folded gaps (`changes-screen.ts` lines 289-302, whose baseline
   * is `serializePolicy(model.initialPolicy)`, fixed at mount:
   * `ui/shell/new-workbench.ts` line 84). An empty array means no changes. It
   * is a method, not part of `state()`, so the diff is computed only when the
   * view asks for it.
   */
  changes(): readonly (DiffLine | DiffHunkGap)[];
}

export function changesFeature(ctx: AdminEngineContext): ChangesFeature {
  return {
    // Both functions are total over strings: there is no failure to report,
    // and a swallowed one would read as "no changes".
    changes() {
      return changeHunks(policyLineDiff(ctx.baseline, ctx.active.serialize()));
    },
  };
}
