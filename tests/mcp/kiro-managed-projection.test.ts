import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Cli } from "../../src/internals/clis.js";
import { executePlan } from "../../src/internals/execute.js";
import { type PlanContext, plan } from "../../src/internals/plan.js";
import {
  KIRO_MCP_SETTINGS_PATH,
  kiroMcpProjectionActions,
  kiroMcpProjectionOnDisk,
  kiroMcpProjectionState,
} from "../../src/mcp/kiro-managed-projection.js";
import type { McpServer } from "../../src/mcp/servers.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import { command as pruneCommand } from "../../src/prune/index.js";
import { command as uninstallCommand } from "../../src/uninstall/index.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aih-kiro-managed-mcp-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function ctx(apply = true, targets: Cli[] = ["kiro"]): PlanContext {
  return {
    root,
    contextDir: "ai-coding",
    posture: "enterprise",
    apply,
    verify: false,
    json: false,
    run: async () => ({ code: 0, stdout: "", stderr: "" }),
    host: makeHostAdapter({
      platform: "linux",
      run: async () => ({ code: 0, stdout: "", stderr: "" }),
      env: {},
    }),
    env: {},
    options: {},
    targets,
  };
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
  it("treats a valid marker without Kiro ownership as absent rather than malformed", () => {
    writeFileSync(
      join(root, ".aih-config.json"),
      JSON.stringify({ schemaVersion: 1, contextDir: "ai-coding", targets: ["claude"] }),
    );

    expect(kiroMcpProjectionState(root)).toEqual({
      state: "absent",
      detail: "no Kiro workspace-MCP ownership receipt",
    });
  });

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

  it("keeps nested skills-provider evidence parseable in the ownership receipt", async () => {
    await apply({
      "code-review-graph": {
        ...graph,
        skillsProvider: { provider: "skills", hotReload: true },
      },
    });

    expect(kiroMcpProjectionState(root).state).toBe("clean");
  });

  it("refuses an unreceipted desired server collision", () => {
    const path = join(root, ".kiro", "settings");
    mkdirSync(path, { recursive: true });
    writeFileSync(
      join(path, "mcp.json"),
      JSON.stringify({ mcpServers: { "code-review-graph": graph } }),
    );

    expect(() => kiroMcpProjectionActions(ctx(), { "code-review-graph": graph })).toThrow(
      /unreceipted Kiro MCP server/,
    );
  });

  it("refuses a newly selected server collision while updating an existing receipt", async () => {
    await apply({ "code-review-graph": graph });
    const path = join(root, KIRO_MCP_SETTINGS_PATH);
    const current = JSON.parse(readFileSync(path, "utf8"));
    current.mcpServers["sequential-thinking"] = { command: "operator-owned" };
    writeFileSync(path, JSON.stringify(current));
    const sequential = {
      ...graph,
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-sequential-thinking@2026.7.4"],
      description: "Sequential reasoning",
    } satisfies McpServer;

    expect(() =>
      kiroMcpProjectionActions(ctx(), {
        "code-review-graph": graph,
        "sequential-thinking": sequential,
      }),
    ).toThrow(/unreceipted Kiro MCP server sequential-thinking/);
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
    expect(after).toEqual({
      topLevel: { operator: true },
      mcpServers: { team: { command: "team" } },
    });
    expect(kiroMcpProjectionOnDisk(root)).toBeUndefined();
    expect(existsSync(join(root, ".aih-config.json"))).toBe(true);
  });

  it("revokes ownership without mutating altered or non-file workspace settings", async () => {
    for (const unsafe of ["altered", "directory"] as const) {
      rmSync(root, { recursive: true, force: true });
      mkdirSync(root, { recursive: true });
      await apply({ "code-review-graph": graph });
      const path = join(root, KIRO_MCP_SETTINGS_PATH);
      if (unsafe === "altered") {
        const changed = JSON.parse(readFileSync(path, "utf8"));
        changed.mcpServers["code-review-graph"].command = "operator-owned";
        writeFileSync(path, JSON.stringify(changed));
      } else {
        rmSync(path);
        mkdirSync(path);
      }

      const before = unsafe === "altered" ? readFileSync(path, "utf8") : undefined;
      const actions = kiroMcpProjectionActions(ctx(), {});
      expect(
        actions.some((action) => "path" in action && action.path === KIRO_MCP_SETTINGS_PATH),
      ).toBe(false);
      await executePlan(plan("revoke Kiro MCP", ...actions), ctx());
      expect(kiroMcpProjectionState(root).state).toBe("revoked");
      if (before !== undefined) expect(readFileSync(path, "utf8")).toBe(before);
      else expect(existsSync(path)).toBe(true);
    }
  });

  it("prune and uninstall subtract only unchanged receipt-owned Kiro server names", async () => {
    for (const lifecycle of ["prune", "uninstall"] as const) {
      rmSync(root, { recursive: true, force: true });
      mkdirSync(join(root, ".kiro", "settings"), { recursive: true });
      writeFileSync(
        join(root, KIRO_MCP_SETTINGS_PATH),
        JSON.stringify({ topLevel: { operator: true }, mcpServers: { team: { command: "team" } } }),
      );
      await apply({ "code-review-graph": graph });
      if (lifecycle === "prune") {
        const markerPath = join(root, ".aih-config.json");
        const marker = JSON.parse(readFileSync(markerPath, "utf8"));
        marker.targets = ["claude"];
        writeFileSync(markerPath, JSON.stringify(marker));
        const pruneCtx = ctx(true, ["claude"]);
        await executePlan(await pruneCommand.plan(pruneCtx), pruneCtx);
      } else {
        await executePlan(await uninstallCommand.plan(ctx()), ctx());
      }

      expect(JSON.parse(readFileSync(join(root, KIRO_MCP_SETTINGS_PATH), "utf8"))).toEqual({
        topLevel: { operator: true },
        mcpServers: { team: { command: "team" } },
      });
    }
  });
});
