import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

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
        serena: { package: "serena-agent==1.5.3", license: "MIT" },
        tokenOptimizer: {
          tag: "v5.11.44",
          commit: "bbe6c9a4bc2694be5c718b4ef77a729f3a8646dc",
          license: "PolyForm-Noncommercial-1.0.0",
        },
        tokenSavior: { package: "token-savior-recall[mcp]==4.4.1", license: "MIT" },
      },
      runtime: {
        serena: { context: "ide", mode: "no-memories" },
        tokenOptimizer: { profile: "quiet", event: "Stop" },
        tokenSavior: { profile: "optimized", memory: false, shellHooks: false },
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

    expect(mcp.mcpServers.serena).toMatchObject({
      command: "node",
      args: ["tools/repo-ai-tools.mjs", "serena-mcp"],
    });
    expect(mcp.mcpServers["token-savior"]).toMatchObject({
      command: "node",
      args: ["tools/repo-ai-tools.mjs", "token-savior-mcp"],
    });

    const stopCommands = (hooks.hooks.Stop ?? [])
      .flatMap((group) => group.hooks ?? [])
      .map((hook) => hook.command ?? "");
    expect(stopCommands).toContain("node tools/repo-ai-tools.mjs token-optimizer-stop");
  });

  it("routes overlapping tools in the repo-owned canon", () => {
    const extension = readFileSync(
      resolve(root, "ai-coding/rules/project-canon-extension.md"),
      "utf8",
    );
    const routing = readFileSync(resolve(root, "ai-coding/rules/repo-ai-tools.md"), "utf8");

    expect(extension).toContain("rules/repo-ai-tools.md");
    expect(routing).toContain("blast-area and reviewer-context aid");
    expect(routing).toContain("Serena");
    expect(routing).toContain("Token Savior");
    expect(routing).toContain("Token Optimizer");
    expect(routing).toContain("must not block product work");
  });
});
