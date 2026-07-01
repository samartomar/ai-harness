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

/** Build NUL-delimited porcelain (`-z`) stdout: each record is NUL-terminated, and
 * paths are raw/unquoted (exactly what `git status --porcelain -z` emits). */
const z = (...records: string[]): string => records.map((r) => `${r}\0`).join("");

describe("isWorktreeDirty", () => {
  it("is true when `git status --porcelain` lists changes", async () => {
    const run = fakeRunner((argv) =>
      argv.includes("status") ? { stdout: z(" M src/foo.ts", "?? new.ts") } : undefined,
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
    expect(calls).toEqual([["git", "-C", "/repo", "status", "--porcelain", "-z", "-uall"]]);
  });
});

const dirtyRun = (stdout: string): Runner =>
  fakeRunner((argv) => (argv.includes("status") ? { stdout } : undefined));

describe("dirtyPaths", () => {
  it("parses porcelain into a path set (modified, untracked, staged)", async () => {
    const set = await dirtyPaths(ctx(dirtyRun(z(" M src/a.ts", "?? b.txt", "A  c.ts"))));
    expect(set).toEqual(new Set(["src/a.ts", "b.txt", "c.ts"]));
  });

  it("maps a rename to its destination and consumes the source token", async () => {
    // In `-z` a rename is `R  <dest>\0<src>\0` (fields reversed, no ` -> ` arrow).
    const set = await dirtyPaths(ctx(dirtyRun(z("R  new.ts", "old.ts"))));
    expect(set).toEqual(new Set(["new.ts"])); // old.ts (the source) must NOT appear
  });

  it("keeps a path with an embedded newline intact (the -z gate-bypass regression)", async () => {
    // Human-format porcelain would C-quote this as `"weird\nname.txt"` and the old
    // newline-splitting parser mangled it — so a dirty removal target with such a name
    // slipped the gate. `-z` emits the raw path; splitting on NUL preserves it exactly.
    const set = await dirtyPaths(ctx(dirtyRun(z("?? weird\nname.txt"))));
    expect(set).toEqual(new Set(["weird\nname.txt"]));
  });

  it("keeps a literal ' -> ' in a filename instead of treating it as a rename arrow", async () => {
    const set = await dirtyPaths(ctx(dirtyRun(z("?? a -> b.txt"))));
    expect(set).toEqual(new Set(["a -> b.txt"]));
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
    expect(await dirtyWriteTargets(p, ctx(dirtyRun(z(" M opencode.json"))))).toEqual([
      "opencode.json",
    ]);
  });

  it("is empty when the written file is NEW/clean and only UNRELATED files are dirty", async () => {
    const p = plan("t", writeText("opencode.json", "{}", "x"));
    expect(await dirtyWriteTargets(p, ctx(dirtyRun(z("?? codex/", " M other.ts"))))).toEqual([]);
  });

  it("ignores external writes — a ~/home config is never a repo worktree target", async () => {
    const p = plan("t", writeText("/home/u/.codex/config.toml", "x", "x", { external: true }));
    expect(await dirtyWriteTargets(p, ctx(dirtyRun(z(" M whatever"))))).toEqual([]);
  });
});

describe("dirtyRemoveTargets — removals gate on membership (incl. untracked dirs)", () => {
  it("flags a removal target that is itself dirty", async () => {
    const p = plan("prune", remove("ai-coding/adapters/codex.md", "stale"));
    expect(await dirtyRemoveTargets(p, ctx(dirtyRun(z(" M ai-coding/adapters/codex.md"))))).toEqual(
      ["ai-coding/adapters/codex.md"],
    );
  });

  it("flags an untracked FILE inside an untracked directory (-uall closes the ?? dir/ blind spot)", async () => {
    // With -uall git lists every untracked file individually — the gate must see it.
    const p = plan("prune", remove("ai-coding/adapters/codex.md", "stale"));
    expect(await dirtyRemoveTargets(p, ctx(dirtyRun(z("?? ai-coding/adapters/codex.md"))))).toEqual(
      ["ai-coding/adapters/codex.md"],
    );
  });

  it("flags a dirty removal target whose name needs porcelain quoting (-z closes the bypass)", async () => {
    // The kiro-hook artifact glob (`aih-*.kiro.hook`) can match a file whose name has an
    // embedded newline; under the old parser its dirty entry never matched the remove
    // target, so `--delete` could move it without `--force`. `-z` makes them match.
    const weird = ".kiro/hooks/aih-x\n.kiro.hook";
    const p = plan("prune", remove(weird, "stale"));
    expect(await dirtyRemoveTargets(p, ctx(dirtyRun(z(`?? ${weird}`))))).toEqual([weird]);
  });

  it("passes a clean removal target even when unrelated files are dirty", async () => {
    const p = plan("prune", remove("ai-coding/adapters/codex.md", "stale"));
    expect(await dirtyRemoveTargets(p, ctx(dirtyRun(z(" M other.ts"))))).toEqual([]);
  });
});
