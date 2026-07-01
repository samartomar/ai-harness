import { describe, expect, it } from "vitest";
import { type PlanContext, plan, remove, writeText } from "../../src/internals/plan.js";
import { fakeRunner, type Runner } from "../../src/internals/proc.js";
import {
  dirtyPaths,
  dirtyRemoveTargets,
  dirtyWriteTargets,
  isWorktreeDirty,
} from "../../src/internals/worktree-gate.js";
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
    expect(calls).toEqual([["git", "-C", "/repo", "status", "--porcelain", "-uall"]]);
  });
});

const dirtyRun = (stdout: string): Runner =>
  fakeRunner((argv) => (argv.includes("status") ? { stdout } : undefined));

describe("dirtyPaths", () => {
  it("parses porcelain into a path set (modified, untracked, staged)", async () => {
    const set = await dirtyPaths(ctx(dirtyRun(" M src/a.ts\n?? b.txt\nA  c.ts\n")));
    expect(set).toEqual(new Set(["src/a.ts", "b.txt", "c.ts"]));
  });

  it("maps a rename to its destination path", async () => {
    expect(await dirtyPaths(ctx(dirtyRun("R  old.ts -> new.ts\n")))).toEqual(new Set(["new.ts"]));
  });

  it("is empty when git is absent / not a repo", async () => {
    expect((await dirtyPaths(ctx(fakeRunner(() => ({ code: 127, spawnError: true }))))).size).toBe(
      0,
    );
  });
});

describe("dirtyWriteTargets — the precise clobber set", () => {
  it("flags a repo-local write target that ITSELF has uncommitted changes", async () => {
    const p = plan("t", writeText("opencode.json", "{}", "x"));
    expect(await dirtyWriteTargets(p, ctx(dirtyRun(" M opencode.json\n")))).toEqual([
      "opencode.json",
    ]);
  });

  it("is empty when the written file is NEW/clean and only UNRELATED files are dirty", async () => {
    const p = plan("t", writeText("opencode.json", "{}", "x"));
    expect(await dirtyWriteTargets(p, ctx(dirtyRun("?? codex/\n M other.ts\n")))).toEqual([]);
  });

  it("ignores external writes — a ~/home config is never a repo worktree target", async () => {
    const p = plan("t", writeText("/home/u/.codex/config.toml", "x", "x", { external: true }));
    expect(await dirtyWriteTargets(p, ctx(dirtyRun(" M whatever\n")))).toEqual([]);
  });
});

describe("dirtyRemoveTargets — removals gate on membership (incl. untracked dirs)", () => {
  it("flags a removal target that is itself dirty", async () => {
    const p = plan("prune", remove("ai-coding/adapters/codex.md", "stale"));
    expect(await dirtyRemoveTargets(p, ctx(dirtyRun(" M ai-coding/adapters/codex.md\n")))).toEqual([
      "ai-coding/adapters/codex.md",
    ]);
  });

  it("flags an untracked FILE inside an untracked directory (-uall closes the ?? dir/ blind spot)", async () => {
    // With -uall git lists every untracked file individually — the gate must see it.
    const p = plan("prune", remove("ai-coding/adapters/codex.md", "stale"));
    expect(await dirtyRemoveTargets(p, ctx(dirtyRun("?? ai-coding/adapters/codex.md\n")))).toEqual([
      "ai-coding/adapters/codex.md",
    ]);
  });

  it("passes a clean removal target even when unrelated files are dirty", async () => {
    const p = plan("prune", remove("ai-coding/adapters/codex.md", "stale"));
    expect(await dirtyRemoveTargets(p, ctx(dirtyRun(" M other.ts\n")))).toEqual([]);
  });
});
