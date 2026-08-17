import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { hermeticGitEnv } from "../git-fixture-env.js";

const root = resolve(import.meta.dirname, "../..");
const TEST_PROCESS_TIMEOUT_MS = 10_000;

function toolingPlan(): Record<string, unknown> {
  return JSON.parse(
    execFileSync(process.execPath, ["tools/repo-ai-tools.mjs", "plan"], {
      cwd: root,
      encoding: "utf8",
    }),
  ) as Record<string, unknown>;
}

function toolingCommand(...args: string[]): Record<string, unknown> {
  return JSON.parse(
    execFileSync(process.execPath, ["tools/repo-ai-tools.mjs", ...args], {
      cwd: root,
      encoding: "utf8",
    }),
  ) as Record<string, unknown>;
}

/**
 * True when `git ls-files` reports the path as part of the tracked index.
 * `existsSync` cannot stand in for this: an operator's local, gitignored
 * AI-client projections (see ai-coding/rules/repo-ai-tools.md — "optional
 * local projections") legitimately exist on disk without being tracked, so a
 * filesystem-existence assertion fails on any workstation that carries them
 * even though the repository itself is clean. Probe tracking/ignore state
 * with real git, per ai-coding/rules/engine-invariants.md.
 */
function isTrackedByGit(relativePath: string): boolean {
  const out = execFileSync("git", ["ls-files", "--", relativePath], {
    cwd: root,
    encoding: "utf8",
    timeout: TEST_PROCESS_TIMEOUT_MS,
    env: hermeticGitEnv(),
  });
  return out.trim().length > 0;
}

/** `git check-ignore -q <path>` exits 0 iff the path IS ignored, 1 if it is NOT. */
function isIgnoredByGit(relativePath: string): boolean {
  try {
    execFileSync("git", ["check-ignore", "-q", relativePath], {
      cwd: root,
      timeout: TEST_PROCESS_TIMEOUT_MS,
      env: hermeticGitEnv(),
    });
    return true; // exit 0 -> ignored
  } catch {
    return false; // exit 1 -> not ignored
  }
}

/**
 * The repo-hygiene predicate: a path must never enter the Git index, and —
 * so it cannot be staged by accident either — must be ignore-covered
 * whenever it happens to exist on disk (an absent path trivially satisfies
 * the "can't be staged" intent).
 */
function expectUntrackedAndIgnored(relativePath: string): void {
  expect(isTrackedByGit(relativePath), relativePath).toBe(false);
  expect(
    isIgnoredByGit(relativePath) || !existsSync(resolve(root, relativePath)),
    relativePath,
  ).toBe(true);
}

describe("ai-harness repo AI tooling", () => {
  it("pins the complete repo toolchain and keeps each runtime scope narrow", () => {
    expect(toolingPlan()).toMatchObject({
      pins: {
        serena: {
          package: "serena-agent==1.7.0",
          license: "MIT",
          securityOverrides: ["python-multipart==0.0.32", "starlette==1.3.1"],
        },
        tokenOptimizer: {
          tag: "v5.11.68",
          commit: "ffe3b8007542260b17648a2d9228c3dedda380ad",
          tree: "d044ba6038ac705e8d0da6a4b545cbee00abe7d5",
          license: "PolyForm-Noncommercial-1.0.0",
        },
        tokenSavior: { package: "token-savior-recall[mcp]==4.21.0", license: "MIT" },
        codeReviewGraph: { package: "code-review-graph==2.3.7", license: "MIT" },
        codebaseMemory: { package: "codebase-memory-mcp==0.10.5", license: "MIT" },
      },
      runtime: {
        serena: {
          context: "repo-symbols",
          mode: "no-memories",
          singleProject: true,
          excludedTools: expect.arrayContaining([
            "execute_shell_command",
            "replace_content",
            "replace_in_files",
          ]),
        },
        tokenOptimizer: {
          actions: ["report", "coach"],
          clients: ["claude", "codex"],
          codexClaudeSessionFallback: false,
          profile: "quiet",
          event: "Stop",
        },
        tokenSavior: {
          profile: "optimized",
          memory: false,
          shellHooks: false,
          excludePatterns: [".token-savior-cache.json"],
          enabledTools: [
            "get_entry_points",
            "search_codebase",
            "find_symbol",
            "get_call_chain",
            "get_function_source",
            "get_full_context",
          ],
        },
        codeReviewGraph: { role: "broad-impact-review", advisory: true },
        codebaseMemory: { role: "find-trace-recall", advisory: true },
      },
    });
  });

  it("defines one idempotent Codex bootstrap and one proof-oriented doctor", () => {
    expect(toolingPlan()).toMatchObject({
      bootstrap: {
        codex: {
          setupCommand: "setup-codex",
          doctorCommand: "doctor-codex",
          projection: ".codex/config.toml",
          ecc: {
            marketplace: "affaan-m/ECC",
            plugin: "ecc@ecc",
            lifecycle: "native-plugin",
          },
          tokenOptimizer: {
            integration: "on-demand",
            commands: ["token-optimizer-report", "token-optimizer-coach"],
          },
          mcpServers: {
            serena: { launcher: "serena-mcp" },
            tokenSavior: { launcher: "token-savior-mcp" },
            codeReviewGraph: { launcher: "code-review-graph-mcp" },
            codebaseMemory: { launcher: "codebase-memory-mcp" },
          },
        },
      },
    });

    expect(toolingCommand("setup-codex", "--dry-run")).toMatchObject({
      command: "setup-codex",
      dryRun: true,
      mutations: expect.arrayContaining([
        "install pinned repo AI tools",
        "write ignored Codex project projection",
        "install or refresh ECC through the native Codex plugin lifecycle",
      ]),
    });

    const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts["repo:init"]).toBe("node tools/repo-ai-tools.mjs setup-codex");
    expect(pkg.scripts["repo:doctor"]).toBe("node tools/repo-ai-tools.mjs doctor-codex");
  });

  it("versions the project cache by tool pins so live MCP environments are never replaced", () => {
    expect(toolingPlan()).toMatchObject({
      cache: {
        generation: expect.stringMatching(/^[0-9a-f]{16}$/),
        keyInputs: ["repository-path", "tool-pins"],
      },
      installRoot: "project-and-toolset-keyed user cache",
    });
  });

  it("keeps client-specific MCP and hook launchers out of the repository", () => {
    for (const file of [
      ".mcp.json",
      ".codex/config.toml",
      ".codex/hooks.json",
      ".claude/settings.json",
    ]) {
      expectUntrackedAndIgnored(file);
    }
  });

  it("portable ignore rules protect every generated project-local projection", () => {
    const gitignore = readFileSync(resolve(root, ".gitignore"), "utf8");

    for (const entry of [
      "/.codex/config.toml",
      "/.codex/hooks.json",
      "/.serena/",
      "/.code-review-graph/",
      "/.codebase-memory/",
    ]) {
      expect(gitignore, entry).toContain(entry);
    }
  });

  it("keeps the repository hook path limited to the non-AI pre-commit guardrail", () => {
    const hook = readFileSync(resolve(root, ".githooks/pre-commit"), "utf8");
    const routing = readFileSync(resolve(root, "ai-coding/rules/repo-ai-tools.md"), "utf8");

    expect(hook.startsWith("#!/bin/sh")).toBe(true);
    expect(hook).toContain("pre-commit: policy + lint + test");
    expect(existsSync(resolve(root, ".githooks/post-merge"))).toBe(false);
    expect(routing).not.toContain(".githooks/post-merge");
  });

  it("does not expose the removed automatic graph-refresh path", () => {
    const launcher = readFileSync(resolve(root, "tools/repo-ai-tools.mjs"), "utf8");

    expect(launcher).not.toContain('command === "graph-refresh"');
    expect(launcher).not.toContain("graphRefreshLauncher");
  });

  it("routes overlapping tools in the repo-owned canon", () => {
    const extension = readFileSync(
      resolve(root, "ai-coding/rules/project-canon-extension.md"),
      "utf8",
    );
    const routing = readFileSync(resolve(root, "ai-coding/rules/repo-ai-tools.md"), "utf8");

    expect(extension).toContain("rules/repo-ai-tools.md");
    expect(extension).toContain("Never run AIH against this checkout.");
    expect(routing).toContain("blast-area and reviewer-context aid");
    expect(routing).toContain("Serena");
    expect(routing).toContain("Token Savior");
    expect(routing).toContain("Token Optimizer");
    expect(routing).toContain("Claude and Codex");
    expect(routing).toContain("must not block product work");
    expect(routing).toContain("## Default decision path");
    expect(routing).toContain("`get_entry_points`");
    expect(routing).toContain("`get_symbols_overview`");
    expect(routing).toContain("Do not use `replace_symbol_source`");
    expect(routing).toContain("Do not run the report or coach on every task");
    expect(routing).toContain("codebase-memory-mcp");
    expect(routing).toContain("broad impact");
    expect(routing).toContain("find, trace, and recall");
  });

  it("documents the complete Codex bootstrap and local projection boundary", () => {
    const setup = readFileSync(resolve(root, "ai-coding/setup.md"), "utf8");
    const adapter = readFileSync(resolve(root, "ai-coding/adapters/codex.md"), "utf8");

    expect(setup).toContain("npm run repo:init");
    expect(setup).toContain("npm run repo:doctor");
    expect(setup).toContain("Start a new Codex task");
    expect(adapter).toContain("native Codex plugin lifecycle");
    expect(adapter).toContain("ignored project-local `.codex/config.toml`");
  });

  it("makes graph use advisory and consistent in every session bootloader", () => {
    const canonFiles = [
      "AGENTS.md",
      "CLAUDE.md",
      "ai-coding/RULE_ROUTER.md",
      "ai-coding/rules/agent-behavior-core.md",
      "ai-coding/adapters/_shared-canonical-block.md",
    ];

    for (const file of canonFiles) {
      const content = readFileSync(resolve(root, file), "utf8");
      expect(content, file).not.toContain("code-review-graph is a hard prerequisite");
      expect(content, file).not.toContain("work must stop until");
    }

    for (const file of ["AGENTS.md", "CLAUDE.md"]) {
      const content = readFileSync(resolve(root, file), "utf8");
      expect(content, file).toContain("ai-coding/rules/repo-ai-tools.md");
      expect(content, file).toContain("Never run AIH against this checkout.");
      expect(content, file).toContain("warn once and continue");
    }

    const shared = readFileSync(
      resolve(root, "ai-coding/adapters/_shared-canonical-block.md"),
      "utf8",
    );
    expect(shared).toContain("warn once and continue");
  });

  it("keeps Serena configuration and runtime artifacts out of the product diff", () => {
    for (const file of [".serena/project.yml", ".serena/.gitignore"]) {
      expectUntrackedAndIgnored(file);
    }
    expect(toolingPlan()).toMatchObject({
      installRoot: "project-and-toolset-keyed user cache",
    });
  });

  it("keeps Token Savior from indexing or dirtying the worktree with its own cache", () => {
    const gitignore = readFileSync(resolve(root, ".gitignore"), "utf8");
    const launcher = readFileSync(resolve(root, "tools/repo-ai-tools.mjs"), "utf8");

    expect(gitignore).toContain(".token-savior-cache.json");
    expect(launcher).toContain("TOKEN_SAVIOR_EXCLUDE_PATTERNS:");
    expect(launcher).toContain('plan.runtime.tokenSavior.excludePatterns.join(":")');
  });

  it("keeps this repo's manual canon authoritative without generator self-use", () => {
    const selfHosting = readFileSync(resolve(root, "ai-coding/SELF-HOSTING.md"), "utf8");
    const shared = readFileSync(
      resolve(root, "ai-coding/adapters/_shared-canonical-block.md"),
      "utf8",
    );
    const core = readFileSync(resolve(root, "ai-coding/rules/agent-behavior-core.md"), "utf8");
    const router = readFileSync(resolve(root, "ai-coding/RULE_ROUTER.md"), "utf8");
    const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };

    expect(selfHosting).toContain("AIH_SELF_HOSTING_BOUNDARY_v1");
    for (const content of [shared, core, router]) {
      expect(content).toContain("Never run AIH against this checkout.");
    }
    expect(router).toContain("npm run check:self-hosting-canon");
    expect(pkg.scripts["check:self-hosting-canon"]).toContain(
      "tests/self-hosting/self-hosting.test.ts",
    );
    expect(pkg.scripts["check:canon-drift"]).toBeUndefined();
  });

  it("writes generated projections and index markers without check-then-write races", () => {
    const launcher = readFileSync(resolve(root, "tools/repo-ai-tools.mjs"), "utf8");
    const projectionWriter = launcher.slice(
      launcher.indexOf("function writeCodexProjection"),
      launcher.indexOf("function configureEcc"),
    );
    const memoryInitializer = launcher.slice(
      launcher.indexOf("function initializeCodebaseMemory"),
      launcher.indexOf("function codebaseMemoryStatus"),
    );

    expect(launcher).toContain("function writeFileAtomically");
    expect(launcher).toContain('openSync(path, "wx", 0o600)');
    expect(launcher).toContain("renameSync(temporaryPath, path)");
    expect(projectionWriter).not.toContain("existsSync(codexConfigPath)");
    expect(memoryInitializer).not.toContain("existsSync(codebaseMemoryMarker)");
  });
});
