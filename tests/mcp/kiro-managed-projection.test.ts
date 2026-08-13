import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executePlan } from "../../src/internals/execute.js";
import { plan, type PlanContext } from "../../src/internals/plan.js";
import {
  KIRO_MCP_SETTINGS_PATH,
  kiroMcpProjectionActions,
  kiroMcpProjectionOnDisk,
} from "../../src/mcp/kiro-managed-projection.js";
import type { McpServer } from "../../src/mcp/servers.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aih-kiro-managed-mcp-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function ctx(apply = true): PlanContext {
  return {
    root,
    contextDir: "ai-coding",
    posture: "enterprise",
    apply,
    verify: false,
    json: false,
    run: async () => ({ code: 0, stdout: "", stderr: "" }),
    env: {},
    options: {},
  } as PlanContext;
}

const graph = {
  type: "stdio",
  command: "uvx",
  args: ["code-review-graph@2.3.6", "serve"],
  description: "Graph analysis",
  classification: "local",
  egress: "none",
  credentials: "none",
  supplyChain: "pinned",
} as const satisfies McpServer;

async function apply(servers: Record<string, McpServer>) {
  return executePlan(plan("kiro managed mcp", ...kiroMcpProjectionActions(ctx(), servers)), ctx());
}

describe("Kiro governed MCP ownership", () => {
  it("projects only the selected Kiro workspace servers and preserves unrelated configuration", async () => {
    const path = join(root, ".kiro", "settings");
    mkdirSync(path, { recursive: true });
    writeFileSync(
      join(path, "mcp.json"),
      JSON.stringify({ topLevel: { operator: true }, mcpServers: { team: { command: "team" } } }),
    );

    await apply({ "code-review-graph": graph });

    expect(JSON.parse(readFileSync(join(root, KIRO_MCP_SETTINGS_PATH), "utf8"))).toMatchObject({
      topLevel: { operator: true },
      mcpServers: {
        team: { command: "team" },
        "code-review-graph": graph,
      },
    });
    expect(kiroMcpProjectionOnDisk(root)?.matches).toBe(true);
  });

  it("refuses an unreceipted desired server collision", () => {
    const path = join(root, ".kiro", "settings");
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "mcp.json"), JSON.stringify({ mcpServers: { "code-review-graph": graph } }));

    expect(() => kiroMcpProjectionActions(ctx(), { "code-review-graph": graph })).toThrow(
      /unreceipted Kiro MCP server/, 
    );
  });

  it("removes only unchanged owned entries when deselected and preserves the workspace file", async () => {
    await apply({ "code-review-graph": graph });
    const path = join(root, KIRO_MCP_SETTINGS_PATH);
    const before = JSON.parse(readFileSync(path, "utf8"));
    before.topLevel = { operator: true };
    before.mcpServers.team = { command: "team" };
    writeFileSync(path, JSON.stringify(before));

    await apply({});

    const after = JSON.parse(readFileSync(path, "utf8"));
    expect(after).toEqual({ topLevel: { operator: true }, mcpServers: { team: { command: "team" } } });
    expect(kiroMcpProjectionOnDisk(root)).toBeUndefined();
    expect(existsSync(join(root, ".aih-config.json"))).toBe(true);
  });
});
