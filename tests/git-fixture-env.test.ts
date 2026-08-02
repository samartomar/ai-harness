import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hermeticGitEnv } from "./git-fixture-env.js";

// Guards the fix for the worktree-commit leak: `git commit` from a linked
// worktree exports an absolute GIT_DIR/GIT_INDEX_FILE, and any fixture git
// spawn in the same process tree that forgets to scrub them escapes its temp
// dir and mutates the outer repo. hermeticGitEnv() is what strips them.

describe("suite-wide GIT_* scrub (vitest setupFiles)", () => {
  it("no inherited GIT_* variable survives into test code", () => {
    // tests/setup-git-env.ts runs per worker before this file loads. Under a
    // normal run this holds trivially; under the pre-commit hook it is the
    // guard that keeps production-code-under-test git spawns (which use the
    // live process env) inside their own fixture directories. If the
    // setupFiles wiring is ever dropped, the hook's own suite run fails here.
    expect(Object.keys(process.env).filter((key) => /^GIT_/i.test(key))).toEqual([]);
  });
});

describe("hermeticGitEnv (pure)", () => {
  it("strips every inherited GIT_* variable but keeps the rest", () => {
    const env = hermeticGitEnv({
      PATH: "/usr/bin",
      HOME: "/home/dev",
      GIT_DIR: "/leak/.git",
      GIT_WORK_TREE: "/leak",
      GIT_INDEX_FILE: "/leak/.git/index",
      GIT_OBJECT_DIRECTORY: "/leak/.git/objects",
      GIT_COMMON_DIR: "/leak/.git",
      GIT_AUTHOR_NAME: "leaked",
      GIT_CONFIG_GLOBAL: "/leak/.gitconfig",
    });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/dev");
    for (const key of [
      "GIT_DIR",
      "GIT_WORK_TREE",
      "GIT_INDEX_FILE",
      "GIT_OBJECT_DIRECTORY",
      "GIT_COMMON_DIR",
      "GIT_AUTHOR_NAME",
      "GIT_CONFIG_GLOBAL",
    ]) {
      expect(env[key]).toBeUndefined();
    }
  });

  it("adds no GIT_* variables of its own (host config regime is left intact)", () => {
    // It deliberately does NOT set GIT_CONFIG_GLOBAL/SYSTEM/NOSYSTEM: doing so
    // would drop host core.autocrlf and desync line endings from the
    // non-hermetic production code that some fixtures interoperate with.
    const env = hermeticGitEnv({ PATH: "/usr/bin" });
    expect(Object.keys(env).filter((key) => /^GIT_/i.test(key))).toEqual([]);
  });
});

/** True iff the repo at `cwd` has at least one commit (HEAD resolves). */
function hasCommits(cwd: string): boolean {
  try {
    execFileSync("git", ["rev-parse", "--verify", "HEAD"], {
      cwd,
      stdio: "pipe",
      env: hermeticGitEnv(),
    });
    return true;
  } catch {
    return false;
  }
}

describe("hermeticGitEnv (end-to-end leak neutralization)", () => {
  let scratch: string;
  let decoyDir: string;
  let decoyGitDir: string;
  let fixtureDir: string;
  const savedGitDir = process.env.GIT_DIR;
  const savedIndex = process.env.GIT_INDEX_FILE;

  function initDecoyRepo(dir: string): void {
    // The decoy stands in for the shared .git a worktree `git commit` would
    // leak. It is created with a hermetic env so its setup is itself immune to
    // any GIT_DIR already present in the ambient env (e.g. under the hook).
    mkdirSync(dir, { recursive: true });
    const git = (args: string[]) =>
      execFileSync("git", args, { cwd: dir, stdio: "pipe", env: hermeticGitEnv() });
    git(["init", "-q"]);
    git(["config", "user.email", "decoy@example.invalid"]);
    git(["config", "user.name", "Decoy"]);
  }

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), "aih-git-hermetic-guard-"));
    decoyDir = join(scratch, "decoy");
    fixtureDir = join(scratch, "fixture");
    mkdirSync(fixtureDir, { recursive: true });
    initDecoyRepo(decoyDir);
    decoyGitDir = join(decoyDir, ".git");
  });

  afterEach(() => {
    // Restore the two vars the leak tests set, whatever they were before.
    for (const [key, value] of [
      ["GIT_DIR", savedGitDir],
      ["GIT_INDEX_FILE", savedIndex],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(scratch, { recursive: true, force: true });
  });

  it("keeps a fixture git spawn from escaping into an inherited GIT_DIR (decoy untouched)", () => {
    const configBefore = readFileSync(join(decoyGitDir, "config"), "utf8");

    // Simulate the exact leak: an absolute GIT_DIR/GIT_INDEX_FILE inherited
    // from an outer `git commit`, live in process.env when the fixture runs.
    process.env.GIT_DIR = decoyGitDir;
    process.env.GIT_INDEX_FILE = join(decoyGitDir, "index");

    const git = (args: string[]) =>
      execFileSync("git", args, { cwd: fixtureDir, stdio: "pipe", env: hermeticGitEnv() });
    git(["init", "-q", "-b", "main"]);
    git(["config", "user.email", "fixture@example.invalid"]);
    git(["config", "user.name", "Fixture"]);
    git(["config", "commit.gpgsign", "false"]);
    writeFileSync(join(fixtureDir, "file.txt"), "hello\n");
    git(["add", "-A"]);
    git(["commit", "-q", "-m", "init"]);

    // The commit landed in the fixture's OWN repo.
    expect(existsSync(join(fixtureDir, ".git"))).toBe(true);
    expect(hasCommits(fixtureDir)).toBe(true);
    const fixtureHead = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: fixtureDir,
      env: hermeticGitEnv(),
    })
      .toString()
      .trim();
    expect(fixtureHead).toMatch(/^[0-9a-f]{40}$/);

    // The decoy is byte-identical and still has no commits — nothing escaped.
    expect(readFileSync(join(decoyGitDir, "config"), "utf8")).toBe(configBefore);
    expect(hasCommits(decoyDir)).toBe(false);
  });

  it("documents the mechanism: WITHOUT scrubbing, the inherited GIT_DIR hijacks the spawn", () => {
    // Same leak, but the fixture spawn inherits the raw env (no hermeticGitEnv).
    // This proves the escape is real, so the guard above is a meaningful test.
    process.env.GIT_DIR = decoyGitDir;
    process.env.GIT_INDEX_FILE = join(decoyGitDir, "index");

    execFileSync("git", ["config", "user.name", "escapee-marker"], {
      cwd: fixtureDir,
      stdio: "pipe",
      env: process.env,
    });

    // The write escaped into the decoy's config, and the fixture never got a repo.
    expect(readFileSync(join(decoyGitDir, "config"), "utf8")).toContain("escapee-marker");
    expect(existsSync(join(fixtureDir, ".git"))).toBe(false);
  });
});
