import * as fs from "node:fs";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { inventoryMcpReadiness } from "../../src/heal/mcp-inventory.js";
import type { PlanContext } from "../../src/internals/plan.js";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, lstatSync: vi.fn(actual.lstatSync) };
});

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true });
});

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "aih-mcp-inventory-"));
  roots.push(value);
  return value;
}

function ctx(rootPath: string, targets: PlanContext["targets"] = ["claude"]): PlanContext {
  return {
    root: rootPath,
    contextDir: ".ai-context",
    apply: false,
    verify: false,
    json: false,
    env: { HOME: join(rootPath, "home") },
    host: {} as PlanContext["host"],
    run: async () => ({ code: 0, stdout: "", stderr: "" }),
    options: {},
    targets,
  };
}

describe("MCP readiness inventory", () => {
  it("includes Claude's ordinary project path and Codex's governed project path", () => {
    const project = root();
    writeFileSync(join(project, ".mcp.json"), '{"mcpServers":{"claude":{"command":"npx"}}}');
    mkdirSync(join(project, ".codex"));
    writeFileSync(join(project, ".codex", "config.toml"), '[mcp_servers.codex]\ncommand="npx"\n');

    const result = inventoryMcpReadiness(ctx(project, ["claude", "codex"]));
    expect(
      result.servers.map((server) => `${server.targetCli}:${server.configPath}:${server.name}`),
    ).toEqual(["claude:.mcp.json:claude", "codex:.codex/config.toml:codex"]);
    expect(result.servers.every((server) => server.state === "unverified")).toBe(true);
  });

  it("does not serialize configured commands and reports missing Codex auth env names only", () => {
    const project = root();
    mkdirSync(join(project, ".codex"));
    writeFileSync(
      join(project, ".codex", "config.toml"),
      '[mcp_servers.secure]\ncommand="secret-command"\nbearer_token_env_var="TOKEN_NAME"\n',
    );

    const result = inventoryMcpReadiness(ctx(project, ["codex"]));
    expect(result.servers[0]).toMatchObject({ state: "unavailable", reason: "missing-auth-env" });
    expect(JSON.stringify(result.servers)).not.toContain("secret-command");
    expect(result.servers[0]?.detail).toContain("TOKEN_NAME");
  });

  it("sanitizes malformed configuration errors", () => {
    const project = root();
    writeFileSync(join(project, ".mcp.json"), "{ bad secret value }");

    const result = inventoryMcpReadiness(ctx(project));
    expect(result.issues[0]?.check).toMatchObject({
      code: "mcp.config-invalid",
      detail: "registered MCP configuration is malformed or unsupported",
    });
  });

  it.each([
    'required = "yes"',
    'enabled = "false"',
    'bearer_token_env_var = "Bearer private-value"',
  ])("rejects malformed native fields without echoing their value: %s", (field) => {
    const project = root();
    mkdirSync(join(project, ".codex"));
    writeFileSync(join(project, ".codex", "config.toml"), `[mcp_servers.fixture]\n${field}\n`);
    const result = inventoryMcpReadiness(ctx(project, ["codex"]));
    expect(result.servers).toEqual([]);
    expect(result.issues[0]?.check.code).toBe("mcp.config-invalid");
    expect(JSON.stringify(result)).not.toContain("private-value");
  });

  it("keeps nonregular and inaccessible registered paths visible", () => {
    const project = root();
    mkdirSync(join(project, ".mcp.json"));
    expect(inventoryMcpReadiness(ctx(project)).issues[0]?.check.code).toBe("mcp.config-invalid");
    vi.mocked(fs.lstatSync).mockImplementationOnce(() => {
      throw Object.assign(new Error("denied private path"), { code: "EACCES" });
    });
    const result = inventoryMcpReadiness(ctx(project));
    expect(result.issues[0]?.check.code).toBe("mcp.config-invalid");
    expect(JSON.stringify(result)).not.toContain("denied private path");
  });

  it("does not infer successful authentication from a populated environment reference", () => {
    const project = root();
    mkdirSync(join(project, ".codex"));
    writeFileSync(
      join(project, ".codex", "config.toml"),
      '[mcp_servers.fixture]\nurl="https://fixture.invalid"\nenv_http_headers={ Authorization="FIXTURE_TOKEN" }\n',
    );
    const context = ctx(project, ["codex"]);
    expect(inventoryMcpReadiness(context).servers[0]?.reason).toBe("missing-auth-env");
    context.env.FIXTURE_TOKEN = "private-fixture-value";
    const result = inventoryMcpReadiness(context);
    expect(result.servers[0]?.state).toBe("unverified");
    expect(JSON.stringify(result)).not.toContain("private-fixture-value");
  });

  it("preserves duplicate-key and unsupported native configurations as issues", () => {
    const project = root();
    writeFileSync(join(project, ".mcp.json"), '{"mcpServers":{},"mcpServers":{"hidden":{}}}');
    writeFileSync(join(project, "opencode.json"), '{"mcp":{"servers":{}}}');
    const result = inventoryMcpReadiness(ctx(project, ["claude", "opencode"]));
    expect(result.issues.map((issue) => issue.targetCli)).toEqual(["claude", "opencode"]);
    expect(result.servers).toEqual([]);
  });

  it("inventories selected global and both OpenCode project paths without executing declarations", () => {
    const project = root();
    mkdirSync(join(project, "home", ".codex"), { recursive: true });
    writeFileSync(
      join(project, "home", ".codex", "config.toml"),
      '[mcp_servers.global]\ncommand="custom-private-launcher"\n',
    );
    writeFileSync(
      join(project, "opencode.json"),
      '{"mcp":{"active":{"type":"local","command":["uvx","--offline","fixture"]}}}',
    );
    writeFileSync(
      join(project, "opencode.jsonc"),
      '{"mcp":{"inactive":{"type":"local","command":["npx","fixture"],"enabled":false}}}',
    );
    const result = inventoryMcpReadiness(ctx(project, ["codex", "opencode"]));
    expect(result.servers.map((server) => server.name)).toEqual(["global", "active", "inactive"]);
    expect(result.servers[2]?.state).toBe("disabled");
    expect(JSON.stringify(result.servers)).not.toContain("custom-private-launcher");
  });
});
