import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  agentBehaviorCoreDoc,
  ruleRouterDoc,
  sharedCanonicalBlockBody,
} from "../../src/bootstrap-ai/canon.js";
import type { RepoStack } from "../../src/profile/scan.js";

const root = resolve(import.meta.dirname, "../..");

function toolingPlan(): Record<string, unknown> {
  return JSON.parse(
    execFileSync(process.execPath, ["tools/repo-ai-tools.mjs", "plan"], {
      cwd: root,
      encoding: "utf8",
    }),
  ) as Record<string, unknown>;
}

describe("ai-harness repo AI tooling", () => {
  it("pins the three requested tools and keeps their runtime scope narrow", () => {
    expect(toolingPlan()).toMatchObject({
      pins: {
        serena: {
          package: "serena-agent==1.6.1",
          license: "MIT",
          securityOverrides: [
            "cryptography==49.0.0",
            "python-multipart==0.0.32",
            "starlette==1.3.1",
          ],
        },
        tokenOptimizer: {
          tag: "v5.11.68",
          commit: "0968d8e0a4afe07d3de37ac6a720e5fcc02e4987",
          license: "PolyForm-Noncommercial-1.0.0",
        },
        tokenSavior: { package: "token-savior-recall[mcp]==4.21.0", license: "MIT" },
      },
      runtime: {
        serena: { context: "ide", mode: "no-memories" },
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
        },
      },
    });
  });

  it("wires only repo-local MCP and hook launchers", () => {
    const mcp = JSON.parse(readFileSync(resolve(root, ".mcp.json"), "utf8")) as {
      mcpServers: Record<string, { command?: string; args?: string[] }>;
    };
    const hooks = JSON.parse(readFileSync(resolve(root, ".codex/hooks.json"), "utf8")) as {
      hooks: Record<string, Array<{ hooks?: Array<{ command?: string }> }>>;
    };
    const codexConfig = readFileSync(resolve(root, ".codex/config.toml"), "utf8");
    const claudeSettings = JSON.parse(
      readFileSync(resolve(root, ".claude/settings.json"), "utf8"),
    ) as {
      hooks: Record<string, Array<{ hooks?: Array<{ command?: string }> }>>;
    };

    expect(mcp.mcpServers.serena).toMatchObject({
      command: "node",
      args: ["tools/repo-ai-tools.mjs", "serena-mcp"],
    });
    expect(mcp.mcpServers["token-savior"]).toMatchObject({
      command: "node",
      args: ["tools/repo-ai-tools.mjs", "token-savior-mcp"],
    });
    expect(codexConfig).toContain('[mcp_servers."serena"]');
    expect(codexConfig).toContain('[mcp_servers."token-savior"]');
    expect(codexConfig).toContain('[mcp_servers."code-review-graph"]');
    expect(codexConfig).toContain('args = ["tools/repo-ai-tools.mjs", "serena-mcp"]');
    expect(codexConfig).toContain('args = ["tools/repo-ai-tools.mjs", "token-savior-mcp"]');
    expect(codexConfig).toContain(
      'args = ["--offline", "--no-python-downloads", "--no-env-file", "code-review-graph@2.3.7", "serve"]',
    );

    const stopCommands = (hooks.hooks.Stop ?? [])
      .flatMap((group) => group.hooks ?? [])
      .map((hook) => hook.command ?? "");
    expect(stopCommands).toContain("node tools/repo-ai-tools.mjs token-optimizer-stop");

    const claudeStopCommands = (claudeSettings.hooks.Stop ?? [])
      .flatMap((group) => group.hooks ?? [])
      .map((hook) => hook.command ?? "");
    expect(claudeStopCommands).toContain("node tools/repo-ai-tools.mjs token-optimizer-stop");
  });

  it("wires a fail-open post-merge hook that refreshes the advisory review graph", () => {
    const hook = readFileSync(resolve(root, ".githooks/post-merge"), "utf8");
    const routing = readFileSync(resolve(root, "ai-coding/rules/repo-ai-tools.md"), "utf8");

    expect(hook.startsWith("#!/bin/sh")).toBe(true);
    expect(hook).toContain("node tools/repo-ai-tools.mjs graph-refresh");
    expect(hook).toContain("|| true");
    expect(routing).toContain(".githooks/post-merge");
  });

  it("derives the graph-refresh launcher from the pinned .mcp.json serve entry", () => {
    const printed = JSON.parse(
      execFileSync(process.execPath, ["tools/repo-ai-tools.mjs", "graph-refresh", "--print"], {
        cwd: root,
        encoding: "utf8",
      }),
    ) as { command: string; args: string[] };
    const mcp = JSON.parse(readFileSync(resolve(root, ".mcp.json"), "utf8")) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    const serve = mcp.mcpServers["code-review-graph"];
    if (!serve) throw new Error(".mcp.json is missing the code-review-graph server");

    expect(printed.command).toBe(serve.command);
    expect(printed.args.slice(0, serve.args.length - 1)).toEqual(serve.args.slice(0, -1));
    expect(printed.args).toContain("update");
    expect(printed.args).not.toContain("serve");
  });

  it("routes overlapping tools in the repo-owned canon", () => {
    const extension = readFileSync(
      resolve(root, "ai-coding/rules/project-canon-extension.md"),
      "utf8",
    );
    const routing = readFileSync(resolve(root, "ai-coding/rules/repo-ai-tools.md"), "utf8");

    expect(extension).toContain("rules/repo-ai-tools.md");
    expect(extension).toContain("Never use AIH project-truth or project-governance surfaces");
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
      expect(content, file).toContain("Never use AIH project-truth or project-governance commands");
      expect(content, file).toContain("warn once and continue");
    }

    const shared = readFileSync(
      resolve(root, "ai-coding/adapters/_shared-canonical-block.md"),
      "utf8",
    );
    expect(shared).toContain("warn once and continue");
  });

  it("keeps Serena runtime artifacts out of the product diff", () => {
    const serenaIgnore = readFileSync(resolve(root, ".serena/.gitignore"), "utf8");

    expect(serenaIgnore).toContain("/cache");
    expect(serenaIgnore).toContain("/logs");
  });

  it("keeps Token Savior from indexing or dirtying the worktree with its own cache", () => {
    const gitignore = readFileSync(resolve(root, ".gitignore"), "utf8");
    const launcher = readFileSync(resolve(root, "tools/repo-ai-tools.mjs"), "utf8");

    expect(gitignore).toContain(".token-savior-cache.json");
    expect(launcher).toContain("TOKEN_SAVIOR_EXCLUDE_PATTERNS:");
    expect(launcher).toContain('plan.runtime.tokenSavior.excludePatterns.join(":")');
  });

  it("keeps this repo's generated canon in source sync without project-governance self-use", () => {
    const project = JSON.parse(readFileSync(resolve(root, "ai-coding/project.json"), "utf8")) as {
      description: string;
      languages: string[];
      frameworks: string[];
      cloud: string[];
      databases: string[];
      deployment: string[];
      packageManager: string;
      entrypoints: string[];
      commands: Record<string, { value: string }>;
      scale: { isMonorepo: boolean };
    };
    const stack: RepoStack = {
      languages: project.languages,
      frameworks: project.frameworks,
      cloud: project.cloud,
      databases: project.databases,
      deployment: project.deployment,
      packageManager: project.packageManager,
      hasTypeScript: project.languages.includes("TypeScript/Node.js"),
      scripts: {},
      description: project.description,
      entryPoints: project.entrypoints,
      testRunner: project.commands.test?.value,
      buildCommand: project.commands.build?.value,
      lintCommand: project.commands.lint?.value,
      verifyCommand: project.commands.verify?.value,
      typecheckCommand: project.commands.typecheck?.value,
      browserTest: false,
      isMonorepo: project.scale.isMonorepo,
    };

    expect(
      readFileSync(resolve(root, "ai-coding/adapters/_shared-canonical-block.md"), "utf8"),
    ).toBe(sharedCanonicalBlockBody("ai-coding"));
    expect(readFileSync(resolve(root, "ai-coding/rules/agent-behavior-core.md"), "utf8")).toBe(
      agentBehaviorCoreDoc("ai-coding"),
    );
    expect(readFileSync(resolve(root, "ai-coding/RULE_ROUTER.md"), "utf8")).toBe(
      ruleRouterDoc("ai-coding", "ai-harness", stack, ["CLAUDE.md", "AGENTS.md"], {
        projectExtension: true,
        canon: "compact",
      }),
    );
  });
});
