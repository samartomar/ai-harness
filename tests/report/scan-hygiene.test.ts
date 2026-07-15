import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DigestAction, PlanContext } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import type { ContextBloat } from "../../src/report/bloat.js";
import { command } from "../../src/report/index.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aih-scan-hygiene-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function put(rel: string, bytes: number): void {
  const full = join(dir, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, "x".repeat(bytes), "utf8");
}

/** A report ctx whose Runner answers git argv via `git`. */
function ctx(
  options: Record<string, unknown>,
  git: (args: string[]) => string | null,
): PlanContext {
  const run = fakeRunner((argv) => {
    if (argv[0] !== "git") return { code: 1, spawnError: true };
    const out = git(argv.slice(3));
    return out === null ? { code: 1, spawnError: true } : { code: 0, stdout: out };
  });
  return {
    root: dir,
    contextDir: "ai-coding",
    apply: false,
    verify: true,
    json: false,
    run,
    host: makeHostAdapter({ platform: "linux", run, env: {} }),
    env: { HOME: dir, USERPROFILE: dir },
    options,
  };
}

/** The ContextBloat data from the lead "Context footprint" digest. */
async function bloatOf(c: PlanContext): Promise<ContextBloat> {
  const actions = (await command.plan(c)).actions;
  const d = actions.find(
    (a): a is DigestAction => a.kind === "digest" && a.describe.startsWith("Context footprint"),
  );
  return d?.data as ContextBloat;
}

describe("report — gitignore-honoring footprint", () => {
  it("excludes a file the git allowlist omits (the generated-copy double-count fix)", async () => {
    put("ai-coding/RULE_ROUTER.md", 400); // tracked source
    put("ai-coding/generated.md", 4000); // generated copy, NOT in the allowlist
    const tracked = (args: string[]) =>
      args[0] === "ls-files" ? "ai-coding/RULE_ROUTER.md\0" : "";
    const paths = (await bloatOf(ctx({}, tracked))).files.map((f) => f.path);
    expect(paths).toContain("ai-coding/RULE_ROUTER.md");
    expect(paths).not.toContain("ai-coding/generated.md");
  });

  it("--all-files skips the allowlist and counts everything on disk", async () => {
    put("ai-coding/RULE_ROUTER.md", 400);
    put("ai-coding/generated.md", 4000);
    const tracked = (args: string[]) =>
      args[0] === "ls-files" ? "ai-coding/RULE_ROUTER.md\0" : "";
    const paths = (await bloatOf(ctx({ allFiles: true }, tracked))).files.map((f) => f.path);
    expect(paths).toContain("ai-coding/generated.md");
  });

  it("not a git repo → full scan (allowlist unavailable, keep all)", async () => {
    put("ai-coding/RULE_ROUTER.md", 400);
    put("ai-coding/generated.md", 4000);
    const noGit = () => null; // every git call fails → gitTrackedSet undefined
    const paths = (await bloatOf(ctx({}, noGit))).files.map((f) => f.path);
    expect(paths).toContain("ai-coding/generated.md"); // not filtered
  });

  it("--since narrows to files changed vs the ref", async () => {
    put("ai-coding/RULE_ROUTER.md", 400); // changed
    put("ai-coding/conventions.md", 800); // tracked but unchanged
    const git = (args: string[]) => {
      if (args[0] === "ls-files" && args.includes("--cached"))
        return "ai-coding/RULE_ROUTER.md\0ai-coding/conventions.md\0"; // both tracked
      if (args[0] === "ls-files" && args.includes("--others")) return "";
      if (args[0] === "rev-parse") return dir;
      if (args.includes("main...HEAD")) return "ai-coding/RULE_ROUTER.md\0"; // only this changed
      return "";
    };
    const paths = (await bloatOf(ctx({ since: "main" }, git))).files.map((f) => f.path);
    expect(paths).toContain("ai-coding/RULE_ROUTER.md");
    expect(paths).not.toContain("ai-coding/conventions.md");
  });
});
