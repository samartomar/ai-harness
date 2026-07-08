import { describe, expect, it } from "vitest";
import type { PlanContext } from "../../src/internals/plan.js";
import { fakeRunner, type RunResult } from "../../src/internals/proc.js";
import {
  acceptChanged,
  acceptIn,
  changedSince,
  gitTrackedSet,
} from "../../src/internals/scan-allowlist.js";
import { makeHostAdapter } from "../../src/platform/detect.js";

/** A ctx whose Runner answers git argv via `reply` (matched on the args after `-C <root>`). */
function ctx(reply: (gitArgs: string[]) => Partial<RunResult>): PlanContext {
  const run = fakeRunner((argv) => {
    if (argv[0] !== "git") return { code: 1, spawnError: true };
    // argv = ["git", "-C", root, ...gitArgs]
    return reply(argv.slice(3));
  });
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

describe("gitTrackedSet", () => {
  it("parses a NUL-delimited ls-files list into a path set", async () => {
    const c = ctx((args) =>
      args[0] === "ls-files"
        ? { code: 0, stdout: "a.md\0gen/a.md\0my file.md\0" }
        : { code: 1, spawnError: true },
    );
    const allow = await gitTrackedSet(c);
    expect(allow?.files.size).toBe(3);
    expect(allow?.files.has("a.md")).toBe(true);
    expect(allow?.files.has("gen/a.md")).toBe(true);
    // A path with spaces survives the -z split.
    expect(allow?.files.has("my file.md")).toBe(true);
  });

  it("returns undefined when git is absent (caller falls back to a full scan)", async () => {
    const allow = await gitTrackedSet(ctx(() => ({ code: 1, spawnError: true })));
    expect(allow).toBeUndefined();
  });
});

describe("acceptIn / acceptChanged predicates", () => {
  it("acceptIn(undefined) keeps everything; with an allowlist it drops non-members", () => {
    expect(acceptIn(undefined)("anything.md")).toBe(true);
    const allow = { files: new Set(["a.md"]) };
    expect(acceptIn(allow)("a.md")).toBe(true);
    expect(acceptIn(allow)("gen/a.md")).toBe(false);
  });

  it("acceptChanged intersects the allowlist with the changed-set", () => {
    const allow = { files: new Set(["a.md", "b.md"]) };
    const changed = new Set(["a.md"]);
    const accept = acceptChanged(allow, changed);
    expect(accept("a.md")).toBe(true); // tracked AND changed
    expect(accept("b.md")).toBe(false); // tracked but NOT changed
    expect(accept("c.md")).toBe(false); // not tracked
  });

  it("acceptChanged with no changed-set is just the allowlist", () => {
    const allow = { files: new Set(["a.md"]) };
    expect(acceptChanged(allow, undefined)("a.md")).toBe(true);
    expect(acceptChanged(allow, undefined)("z.md")).toBe(false);
  });

  it("acceptChanged treats a directory as changed when one of its children changed", () => {
    const changed = new Set(["secrets/token.txt"]);
    const accept = acceptChanged(undefined, changed);
    expect(accept("secrets")).toBe(true);
    expect(accept("src/secrets")).toBe(false);
  });
});

describe("changedSince", () => {
  it("unions committed, working-tree, and untracked changes", async () => {
    const c = ctx((args) => {
      if (args[0] === "rev-parse") return { code: 0, stdout: "/repo" };
      if (args.includes("main...HEAD")) return { code: 0, stdout: "x.md\n" };
      if (args[0] === "diff") return { code: 0, stdout: "y.md\n" }; // working tree
      if (args[0] === "ls-files") return { code: 0, stdout: "z.md\n" }; // untracked
      return { code: 1, spawnError: true };
    });
    const changed = await changedSince(c, "main");
    expect([...(changed ?? [])].sort()).toEqual(["x.md", "y.md", "z.md"]);
  });

  it("returns undefined when not in a git repo (→ full scan upstream)", async () => {
    const changed = await changedSince(
      ctx((args) =>
        args[0] === "rev-parse" ? { code: 1, spawnError: true } : { code: 0, stdout: "" },
      ),
      "main",
    );
    expect(changed).toBeUndefined();
  });
});
