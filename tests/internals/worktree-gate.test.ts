import { describe, expect, it } from "vitest";
import type { PlanContext } from "../../src/internals/plan.js";
import { fakeRunner, type Runner } from "../../src/internals/proc.js";
import { isWorktreeDirty } from "../../src/internals/worktree-gate.js";
import { makeHostAdapter } from "../../src/platform/detect.js";

/** A ctx whose Runner is the given fake — git goes through it (no real spawn). */
function ctx(run: Runner): PlanContext {
  return {
    root: "/repo",
    contextDir: "ai-coding",
    apply: false,
    verify: false,
    json: false,
    run,
    host: makeHostAdapter({ platform: "linux", run, env: {} }),
    env: {},
    options: {},
  };
}

describe("isWorktreeDirty", () => {
  it("is true when `git status --porcelain` lists changes", async () => {
    const run = fakeRunner((argv) =>
      argv.includes("status") ? { stdout: " M src/foo.ts\n?? new.ts\n" } : undefined,
    );
    expect(await isWorktreeDirty(ctx(run))).toBe(true);
  });

  it("is false when porcelain output is empty (clean worktree)", async () => {
    const run = fakeRunner((argv) => (argv.includes("status") ? { stdout: "" } : undefined));
    expect(await isWorktreeDirty(ctx(run))).toBe(false);
  });

  it("is false when git is absent / not a repo (spawnError → undefined)", async () => {
    const run = fakeRunner(() => ({ code: 127, spawnError: true }));
    expect(await isWorktreeDirty(ctx(run))).toBe(false);
  });

  it("routes through the Runner seam scoped to the repo root (no direct spawn)", async () => {
    const calls: string[][] = [];
    const run = fakeRunner((argv) => {
      calls.push(argv);
      return { stdout: "" };
    });
    await isWorktreeDirty(ctx(run));
    expect(calls).toEqual([["git", "-C", "/repo", "status", "--porcelain"]]);
  });
});
