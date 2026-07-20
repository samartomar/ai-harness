import { readFileSync } from "node:fs";
import { join } from "node:path";
import { executePlan, type PlanResult } from "../../../../src/internals/execute.js";
import { type Action, type PlanContext, plan } from "../../../../src/internals/plan.js";
import { fakeRunner } from "../../../../src/internals/proc.js";
import { makeHostAdapter } from "../../../../src/platform/detect.js";

/**
 * A hermetic apply-mode {@link PlanContext} rooted at `root`. Windows host so the
 * suite exercises the platform this repo actually ships on; the runner is a no-op
 * fake (nothing here shells out). `skipWorktreeGate` is passed at execute time, so
 * the temp dir need not be a git repo.
 */
export function makeCtx(root: string, over: Partial<PlanContext> = {}): PlanContext {
  const run = over.run ?? fakeRunner(() => undefined);
  return {
    root,
    contextDir: "ai-coding",
    apply: true,
    verify: false,
    json: false,
    run,
    host: makeHostAdapter({ platform: "windows", run, env: over.env ?? {} }),
    env: over.env ?? {},
    options: {},
    ...over,
  };
}

/** Execute binding actions against `root` under --apply (worktree gate skipped). */
export async function applyActions(root: string, actions: Action[]): Promise<PlanResult> {
  return executePlan(plan("claude-binding", ...actions), makeCtx(root), { skipWorktreeGate: true });
}

/** Read + JSON.parse a repo-relative file. */
export function readJson(root: string, rel: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, rel), "utf8")) as Record<string, unknown>;
}

/** Read a repo-relative file's raw bytes as a string. */
export function readText(root: string, rel: string): string {
  return readFileSync(join(root, rel), "utf8");
}
