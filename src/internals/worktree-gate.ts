import { gitRead } from "./git.js";
import type { PlanContext } from "./plan.js";

/**
 * True when the git worktree has uncommitted changes (`git status --porcelain`
 * yields a non-empty listing). Routed through the read-only {@link gitRead} Runner
 * seam — no direct spawn — so it stays hermetic in tests and cross-platform.
 *
 * Returns `false` when git is absent or this is not a repo (`gitRead` → undefined):
 * with no git history there is no uncommitted work to clobber, so the `--apply`
 * preflight has nothing to guard.
 */
export async function isWorktreeDirty(ctx: PlanContext): Promise<boolean> {
  const out = await gitRead(ctx, ["status", "--porcelain"]);
  return typeof out === "string" && out.trim().length > 0;
}
