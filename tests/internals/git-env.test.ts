import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  HERMETIC_GIT_ENV_SCRIPT_LINE,
  hermeticGitEnv,
  isGitExecutable,
} from "../../src/internals/git-env.js";
import { defaultRunner } from "../../src/internals/proc.js";
import { usageRecorderScript } from "../../src/usage/capture.js";
import { hermeticGitEnv as fixtureGitEnv } from "../git-fixture-env.js";

// Guards the PRODUCTION arm of the worktree-commit leak: `git commit` exports an
// absolute GIT_DIR/GIT_INDEX_FILE into the whole process tree of any hook it
// runs, and git resolves the repo from those BEFORE `cwd`/`-C` — `-C` is simply
// ignored for repo location. A production git spawn that inherits the live env
// therefore operates on the caller's real repository instead of the directory it
// was pointed at (observed 2026-08-01: a worktree hook run flipped this
// checkout's shared `.git` to core.bare and clobbered the staged blobs).
// tests/git-fixture-env.ts covers the test-fixture arm of the same leak.

describe("hermeticGitEnv (pure)", () => {
  it("strips every inherited repo-location GIT_* variable but keeps the rest", () => {
    const env = hermeticGitEnv({
      PATH: "/usr/bin",
      HOME: "/home/dev",
      GIT_DIR: "/leak/.git",
      GIT_WORK_TREE: "/leak",
      GIT_INDEX_FILE: "/leak/.git/index",
      GIT_OBJECT_DIRECTORY: "/leak/.git/objects",
      GIT_ALTERNATE_OBJECT_DIRECTORIES: "/leak/.git/objects",
      GIT_COMMON_DIR: "/leak/.git",
      GIT_NAMESPACE: "leaked",
      GIT_PREFIX: "sub/",
      GIT_AUTHOR_NAME: "leaked",
      GIT_CONFIG_GLOBAL: "/leak/.gitconfig",
      // core.worktree / core.bare set through env config relocates the repo too.
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.worktree",
      GIT_CONFIG_VALUE_0: "/leak",
    });

    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/dev");
    for (const key of [
      "GIT_DIR",
      "GIT_WORK_TREE",
      "GIT_INDEX_FILE",
      "GIT_OBJECT_DIRECTORY",
      "GIT_ALTERNATE_OBJECT_DIRECTORIES",
      "GIT_COMMON_DIR",
      "GIT_NAMESPACE",
      "GIT_PREFIX",
      "GIT_AUTHOR_NAME",
      "GIT_CONFIG_GLOBAL",
      "GIT_CONFIG_COUNT",
      "GIT_CONFIG_KEY_0",
      "GIT_CONFIG_VALUE_0",
    ]) {
      expect(env[key], key).toBeUndefined();
    }
  });

  it("keeps transport-only variables so corporate-CA git still reaches remotes", () => {
    // `aih certs` tells users to export GIT_SSL_CAINFO, and aih's own
    // clone/ls-remote/fetch run over HTTPS. These configure HOW git reaches a
    // remote, never WHICH repo it opens, so they cannot steer a spawn.
    const transport = {
      GIT_SSL_CAINFO: "/etc/corp/ca.pem",
      GIT_SSL_CAPATH: "/etc/corp/certs",
      GIT_SSL_NO_VERIFY: "false",
      GIT_PROXY_COMMAND: "/usr/local/bin/proxy",
      GIT_ASKPASS: "/usr/bin/askpass",
      GIT_TERMINAL_PROMPT: "0",
    };
    expect(hermeticGitEnv({ ...transport })).toEqual(transport);
  });

  it("adds no GIT_* variables of its own (host config regime is left intact)", () => {
    // It deliberately does NOT redirect GIT_CONFIG_GLOBAL/SYSTEM at an empty
    // file: that would drop host core.autocrlf and desync line endings between
    // hermetic and non-hermetic checkouts.
    expect(Object.keys(hermeticGitEnv({ PATH: "/usr/bin" }))).toEqual(["PATH"]);
  });
});

describe("isGitExecutable", () => {
  it("matches git by bare name and by path, and nothing else", () => {
    for (const command of [
      "git",
      "git.exe",
      "GIT",
      "/usr/bin/git",
      "C:\\Program Files\\Git\\cmd\\git.exe",
    ]) {
      expect(isGitExecutable(command), command).toBe(true);
    }
    for (const command of ["gh", "gitleaks", "digit", "git-lfs", "/usr/bin/gh"]) {
      expect(isGitExecutable(command), command).toBe(false);
    }
  });
});

describe("production git spawns under a hostile inherited GIT_DIR", () => {
  let scratch: string;
  let decoyDir: string;
  let decoyGitDir: string;
  let targetDir: string;
  const savedGitDir = process.env.GIT_DIR;
  const savedIndex = process.env.GIT_INDEX_FILE;

  /** Build a repo with one commit, immune to any GIT_* already in the ambient env. */
  function initRepo(dir: string): string {
    mkdirSync(dir, { recursive: true });
    const git = (args: string[]) =>
      execFileSync("git", args, { cwd: dir, stdio: "pipe", env: fixtureGitEnv() })
        .toString()
        .trim();
    git(["init", "-q", "-b", "main"]);
    git(["config", "user.email", "fixture@example.invalid"]);
    git(["config", "user.name", "Fixture"]);
    git(["config", "commit.gpgsign", "false"]);
    git(["commit", "-q", "--allow-empty", "-m", `seed ${dir}`]);
    return git(["rev-parse", "HEAD"]);
  }

  /** Publish the exact leak an outer `git commit` creates for its hook subtree. */
  function leakDecoyIntoEnv(): void {
    process.env.GIT_DIR = decoyGitDir;
    process.env.GIT_INDEX_FILE = join(decoyGitDir, "index");
  }

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), "aih-git-env-guard-"));
    decoyDir = join(scratch, "decoy");
    decoyGitDir = join(decoyDir, ".git");
    targetDir = join(scratch, "target");
  });

  afterEach(() => {
    for (const [key, value] of [
      ["GIT_DIR", savedGitDir],
      ["GIT_INDEX_FILE", savedIndex],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(scratch, { recursive: true, force: true });
  });

  it("a mutating spawn lands in its own -C directory, leaving the decoy untouched", async () => {
    initRepo(decoyDir);
    mkdirSync(targetDir, { recursive: true });
    const decoyConfigBefore = readFileSync(join(decoyGitDir, "config"), "utf8");
    leakDecoyIntoEnv();

    // `aih workspace --git` plans exactly this argv (src/workspace/git.ts).
    const res = await defaultRunner(["git", "-C", targetDir, "init", "-q", "-b", "main"]);

    expect(res.spawnError).toBeUndefined();
    expect(res.code).toBe(0);
    // Unscrubbed, git ignores -C, REINITIALIZES the decoy, and never creates a
    // repo in the target at all.
    expect(existsSync(join(targetDir, ".git"))).toBe(true);
    expect(readFileSync(join(decoyGitDir, "config"), "utf8")).toBe(decoyConfigBefore);
  }, 20000);

  it("a read spawn reports the -C repo's HEAD, not the inherited GIT_DIR's", async () => {
    const decoyHead = initRepo(decoyDir);
    const targetHead = initRepo(targetDir);
    expect(targetHead).not.toBe(decoyHead);
    leakDecoyIntoEnv();

    // The shape gitRead / resolveGitSource / the baseline pin check all use.
    const res = await defaultRunner(["git", "-C", targetDir, "rev-parse", "HEAD"]);

    expect(res.code).toBe(0);
    expect(res.stdout.trim()).toBe(targetHead);
  }, 20000);

  it("documents the mechanism: an unscrubbed spawn IS hijacked by the decoy", () => {
    // Proves the two guards above are meaningful rather than vacuously green.
    initRepo(decoyDir);
    mkdirSync(targetDir, { recursive: true });
    leakDecoyIntoEnv();

    execFileSync("git", ["-C", targetDir, "init", "-q", "-b", "main"], {
      stdio: "pipe",
      env: process.env,
    });

    expect(existsSync(join(targetDir, ".git"))).toBe(false);
  }, 20000);
});

// --- Structural audit: every literal git spawn under src/ carries the guard ---
//
// Encodes the spawn-site audit as a permanent check, so a NEW unguarded git
// spawn fails here instead of silently reintroducing the leak. Two shapes count
// as guarded: an in-process spawn passing `hermeticGitEnv(...)`, and a spawn
// inside a GENERATED script (which runs in its own node process and cannot
// import the helper) passing the inlined `env: gitEnv`.

const SRC_DIR = join(import.meta.dirname, "..", "..", "src");
const GIT_SPAWN = /(?:execFile|execFileSync|spawn|spawnSync)\(\s*"git"/;
/** Options may trail the argv array by a few lines — scan a window, not one line. */
const OPTIONS_WINDOW = 6;

function typescriptSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return typescriptSources(full);
    return entry.isFile() && entry.name.endsWith(".ts") ? [full] : [];
  });
}

describe("git spawn-site audit (src/**)", () => {
  it("every literal `git` spawn passes a scrubbed env", () => {
    const unguarded: string[] = [];
    for (const file of typescriptSources(SRC_DIR)) {
      const lines = readFileSync(file, "utf8").split(/\r?\n/);
      lines.forEach((line, index) => {
        if (!GIT_SPAWN.test(line)) return;
        const window = lines.slice(index, index + OPTIONS_WINDOW).join("\n");
        if (window.includes("hermeticGitEnv(") || window.includes("env: gitEnv")) return;
        unguarded.push(`${file.slice(SRC_DIR.length + 1)}:${index + 1}: ${line.trim()}`);
      });
    }
    expect(unguarded).toEqual([]);
  });

  it("the generic spawn seams route git through the helper", () => {
    // proc.ts's defaultRunner and release-preflight's sh() take the executable as
    // a variable, so the literal-argv scan above cannot see them.
    for (const relative of ["internals/proc.ts", "internals/release-preflight.ts"]) {
      const source = readFileSync(join(SRC_DIR, relative), "utf8");
      expect(source, relative).toContain("isGitExecutable");
      expect(source, relative).toContain("hermeticGitEnv");
    }
  });

  it("the usage recorder carries the scrub inline for its own node process", () => {
    const script = usageRecorderScript();
    expect(script).toContain(HERMETIC_GIT_ENV_SCRIPT_LINE);
    for (const spawn of script.match(/execFileSync\("git",[^\n]*/g) ?? []) {
      expect(spawn).toContain("env: gitEnv");
    }
  });
});
