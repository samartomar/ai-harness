import { type EngineOutcome, errorMessage } from "../shared.js";
import type { AdminEngineContext } from "./context.js";

/** `policy-session.ts` lines 167-170, verbatim: the session's own sentence. */
const POLICY_CLEARED_MESSAGE =
  "Policy cleared. All selections, requests and curation records were removed from this draft. You can start again with any source.";

/** The Clear policy feature: reset the draft to the policy the page opened with. */
export interface ClearPolicyFeature {
  /**
   * Reset the draft through the session's own `clear()`
   * (`ui/shell/policy-session.ts` lines 164-173). The hand-built file menu
   * runs it with no confirmation step (`ui/shell/file-transfer.ts` 398-402).
   */
  clearPolicy(): EngineOutcome;
}

export function clearPolicyFeature(ctx: AdminEngineContext): ClearPolicyFeature {
  return {
    clearPolicy() {
      try {
        ctx.resetOutcome();
        ctx.active.clear();
        return ctx.outcome(POLICY_CLEARED_MESSAGE);
      } catch (error) {
        return { ok: false, message: errorMessage(error, "The policy was not cleared.") };
      }
    },
  };
}
