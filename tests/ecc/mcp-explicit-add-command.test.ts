import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ALL_COMMAND_SPEC_PATHS, ALL_COMMAND_SPECS } from "../../src/commands/index.js";
import { eccMcpAddCommand, eccMcpRemoveCommand } from "../../src/ecc/index.js";
import { executePlan } from "../../src/internals/execute.js";
import type { PlanContext } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { ECC_MCP_CATALOG_PROVENANCE } from "../../src/org-policy/ecc-mcp-catalog.js";
import { makeHostAdapter } from "../../src/platform/detect.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(supportedClis: string[] = ["claude"]): string {
  const root = mkdtempSync(join(tmpdir(), "aih-explicit-mcp-command-"));
  roots.push(root);
  writeFileSync(join(root, ".mcp.json"), '{"mcpServers":{}}\n');
  writeFileSync(
    join(root, "aih-org-policy.json"),
    JSON.stringify({
      schemaVersion: 2,
      minimumPosture: "vibe",
      references: { repoContract: "ai-coding/project.json" },
      governance: {
        policyVersion: "2026.08",
        supportedClis,
        catalog: { reviewed: [], custom: [] },
        activations: [],
        authority: { approvals: [] },
        eccMcpApprovals: [
          {
            id: "memxus",
            sourceContentSha256: ECC_MCP_CATALOG_PROVENANCE.contentSha256,
            state: "approved",
            approvedBy: "security-admin",
            authenticationMode: "api-key",
            allowedDataClasses: ["non-sensitive-context"],
          },
        ],
      },
    }),
  );
  return root;
}

function context(
  root: string,
  apply: boolean,
  options: Record<string, unknown>,
  env: NodeJS.ProcessEnv = {},
): PlanContext {
  const run = fakeRunner(() => undefined);
  return {
    root,
    contextDir: "ai-coding",
    apply,
    verify: false,
    json: false,
    run,
    host: makeHostAdapter({ platform: "linux", run, env }),
    env,
    posture: "vibe",
    options,
  };
}

describe("ecc mcp add/remove command specs", () => {
  it("publishes the nested command specs in the command registry metadata", () => {
    expect(ALL_COMMAND_SPECS).toContain(eccMcpAddCommand);
    expect(ALL_COMMAND_SPECS).toContain(eccMcpRemoveCommand);
    expect(ALL_COMMAND_SPEC_PATHS).toContainEqual(["ecc", "mcp", "add"]);
    expect(ALL_COMMAND_SPEC_PATHS).toContainEqual(["ecc", "mcp", "remove"]);
  });

  it("loads target-root policy and uses normal dry-run then apply execution", async () => {
    const root = fixture();
    const dry = await eccMcpAddCommand.plan(context(root, false, { id: "memxus", cli: "claude" }));
    await executePlan(dry, context(root, false, { id: "memxus", cli: "claude" }));
    expect(readFileSync(join(root, ".mcp.json"), "utf8")).not.toContain("memxus");
    expect(existsSync(join(root, ".aih", "ecc-mcp-explicit-add-v1.json"))).toBe(false);

    const add = await eccMcpAddCommand.plan(context(root, true, { id: "memxus", cli: "claude" }));
    await executePlan(add, context(root, true, { id: "memxus", cli: "claude" }));
    expect(readFileSync(join(root, ".mcp.json"), "utf8")).toContain("memxus");

    const remove = await eccMcpRemoveCommand.plan(
      context(root, true, { id: "memxus", cli: "claude" }),
    );
    await executePlan(remove, context(root, true, { id: "memxus", cli: "claude" }));
    expect(readFileSync(join(root, ".mcp.json"), "utf8")).not.toContain("memxus");
  });

  it("refuses a self-declared ordinary policy override before client or receipt writes", async () => {
    const root = fixture();
    const override = join(root, "ordinary-override.json");
    writeFileSync(override, readFileSync(join(root, "aih-org-policy.json"), "utf8"), "utf8");
    const ctx = context(root, true, { id: "memxus", cli: "claude" }, { AIH_ORG_POLICY: override });

    await expect(eccMcpAddCommand.plan(ctx)).rejects.toThrow(/configuration mutation requires/i);
    expect(readFileSync(join(root, ".mcp.json"), "utf8")).not.toContain("memxus");
    expect(existsSync(join(root, ".aih", "ecc-mcp-explicit-add-v1.json"))).toBe(false);
  });

  it("requires exactly one explicit --cli target", async () => {
    const root = fixture();
    await expect(eccMcpAddCommand.plan(context(root, false, { id: "memxus" }))).rejects.toThrow(
      /exactly one explicit --cli target/i,
    );
    await expect(
      eccMcpAddCommand.plan(context(root, false, { id: "memxus", cli: "claude,cursor" })),
    ).rejects.toThrow(/exactly one explicit --cli target/i);
  });

  it("uses the explicit temporary HOME for Gemini config without touching project MCP settings", async () => {
    const root = fixture(["gemini"]);
    const home = mkdtempSync(join(tmpdir(), "aih-explicit-mcp-command-home-"));
    roots.push(home);
    const env = { HOME: home, USERPROFILE: home };
    const settings = join(home, ".gemini", "settings.json");
    mkdirSync(dirname(settings), { recursive: true });
    writeFileSync(
      settings,
      JSON.stringify({
        unrelated: true,
        mcpServers: { operator: { url: "https://operator.example" } },
      }),
    );

    const add = await eccMcpAddCommand.plan(
      context(root, true, { id: "memxus", cli: "gemini" }, env),
    );
    await executePlan(add, context(root, true, { id: "memxus", cli: "gemini" }, env));
    const afterAdd = JSON.parse(readFileSync(settings, "utf8"));
    expect(afterAdd.unrelated).toBe(true);
    expect(afterAdd.mcpServers.operator).toEqual({ url: "https://operator.example" });
    expect(afterAdd.mcpServers.memxus).toBeDefined();
    expect(readFileSync(join(root, ".mcp.json"), "utf8")).toBe('{"mcpServers":{}}\n');

    const remove = await eccMcpRemoveCommand.plan(
      context(root, true, { id: "memxus", cli: "gemini" }, env),
    );
    await executePlan(remove, context(root, true, { id: "memxus", cli: "gemini" }, env));
    const afterRemove = JSON.parse(readFileSync(settings, "utf8"));
    expect(afterRemove.unrelated).toBe(true);
    expect(afterRemove.mcpServers.operator).toEqual({ url: "https://operator.example" });
    expect(afterRemove.mcpServers.memxus).toBeUndefined();
  });
});
