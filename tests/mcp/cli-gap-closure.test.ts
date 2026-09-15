import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { entry } from "../../src/internals/cli-registry.js";
import { type Cli, SUPPORTED_CLIS } from "../../src/internals/clis.js";
import { executePlan } from "../../src/internals/execute.js";
import { type PlanContext, plan } from "../../src/internals/plan.js";
import { command } from "../../src/mcp/index.js";
import { nativeMcpProjectionActions } from "../../src/mcp/native-managed-projection.js";
import { mcpEntries, mcpTomlBody, nativeMcpEntries } from "../../src/mcp/render.js";
import type { McpServer } from "../../src/mcp/servers.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import { renderCliCoverage, scanCliCoverage } from "../../src/report/cli-coverage.js";

let root: string;
let home: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aih-cli-gap-"));
  home = join(root, "home");
  mkdirSync(home);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
function context(target: Cli): PlanContext {
  const run = async () => ({ code: 1, stdout: "", stderr: "fixture: no subprocess" });
  const env = { HOME: home, USERPROFILE: home };
  return {
    root,
    env,
    run,
    host: makeHostAdapter({ platform: "linux", env, run }),
    contextDir: "ai-coding",
    apply: true,
    verify: false,
    json: false,
    targets: [target],
    options: { cli: target },
  };
}
const server: McpServer = {
  type: "stdio",
  command: "node",
  args: ["fixture.js"],
  description: "fixture",
  classification: "local",
  egress: "none",
  credentials: "none",
  supplyChain: "pinned",
};
const referenced: McpServer = { ...server, env: { FIXTURE_TOKEN: "${FIXTURE_TOKEN}" } };

describe("governed project coverage", () => {
  it("reports feature-specific support and unverified runtime requirements", () => {
    const ctx = context("codex");
    ctx.targets = ["codex", "copilot", "kimi", "kiro"];
    const model = scanCliCoverage(ctx);
    const copilot = model.rows.find((row) => row.cli === "copilot");
    expect(copilot?.capabilities).toMatchObject({
      governedMcp: true,
      governedEcc: false,
      governedUsage: false,
      contextVerification: "manual",
    });
    expect(model.rows.find((row) => row.cli === "kimi")?.capabilities).toMatchObject({
      eccInstall: false,
      governedEcc: true,
    });
    const rendered = renderCliCoverage(model);
    expect(rendered).toContain("Feature support");
    expect(rendered).toContain("runtime version is unverified");
    expect(rendered).toContain("ide1-cli3");
  });

  it.each(["codex", "opencode"] as const)(
    "reports %s project receipts without a global repair",
    async (target) => {
      const ctx = context(target);
      await executePlan(
        plan("fixture", ...nativeMcpProjectionActions(ctx, target, { fixture: server })),
        ctx,
      );
      const cell = scanCliCoverage(ctx).rows.find((row) => row.cli === target)?.mcp;
      expect(cell).toMatchObject({
        state: "wired",
        scope: "repo",
        path: entry(target).mcp.governed?.configPath,
        count: 1,
      });
      expect(cell?.fix).toBeUndefined();
      expect(cell?.detail).toContain("runtime");
      expect(cell?.otherScopes).toEqual([
        expect.objectContaining({ scope: "global", state: "missing" }),
      ]);
    },
  );

  it("keeps drift visible even when a populated global configuration exists", async () => {
    const ctx = context("codex");
    await executePlan(
      plan("fixture", ...nativeMcpProjectionActions(ctx, "codex", { fixture: server })),
      ctx,
    );
    writeFileSync(join(root, ".codex/config.toml"), "# operator changed the file\n");
    mkdirSync(join(home, ".codex"));
    writeFileSync(join(home, ".codex/config.toml"), '[mcp_servers.global]\ncommand = "node"\n');
    const cell = scanCliCoverage(ctx).rows.find((row) => row.cli === "codex")?.mcp;
    expect(cell).toMatchObject({ state: "missing", scope: "repo", path: ".codex/config.toml" });
    expect(cell?.fix).not.toContain("aih mcp");
    expect(cell?.detail).toContain("drift");
    expect(cell?.otherScopes).toEqual([
      expect.objectContaining({ scope: "global", state: "wired", count: 1 }),
    ]);
  });
});

describe("shared host environment contracts", () => {
  it.each(["cursor", "opencode", "codex"] as const)(
    "rejects malformed %s environment references without disclosing their values",
    (target) => {
      for (const value of [
        "fixture-secret",
        "$FIXTURE_TOKEN",
        "%FIXTURE_TOKEN%",
        "${INVALID-NAME}",
      ]) {
        const servers = { fixture: { ...server, env: { FIXTURE_TOKEN: value } } };
        const render = () =>
          target === "codex" ? mcpTomlBody(servers) : mcpEntries(target, servers);
        expect(render).toThrow(/canonical environment references/);
        try {
          render();
        } catch (error) {
          expect(String(error)).not.toContain(value);
        }
      }
    },
  );
  it("refuses renamed Codex references consistently", () => {
    const servers = { fixture: { ...server, env: { ALIAS: "${FIXTURE_TOKEN}" } } };
    expect(() => mcpTomlBody(servers)).toThrow(/renamed references/);
    expect(() => nativeMcpEntries("codex", servers)).toThrow(/renamed references/);
  });
  it("refuses unsupported mappings before a multi-host plan can write configuration", async () => {
    const ctx = context("copilot");
    ctx.options = { cli: "cursor,copilot", selfHost: true };
    ctx.targets = ["cursor", "copilot"];
    await expect(command.plan(ctx)).rejects.toThrow(
      /copilot MCP environment references are unsupported/,
    );
    expect(existsSync(join(root, ".cursor/mcp.json"))).toBe(false);
    expect(existsSync(join(root, ".github/mcp.json"))).toBe(false);
  });
  it.each(["cursor", "opencode"] as const)(
    "renders the same %s references from both entry points",
    (target) => {
      const generic = mcpEntries(target, { fixture: referenced }).fixture;
      const governed = nativeMcpEntries(target, { fixture: referenced }).fixture;
      const key = target === "opencode" ? "environment" : "env";
      expect(generic?.[key]).toEqual(governed?.[key]);
      expect(JSON.stringify(generic)).not.toContain('"${FIXTURE_TOKEN}"');
    },
  );
  it("forwards Codex variables without writing literal placeholder values", () => {
    const parsed = parseToml(mcpTomlBody({ fixture: referenced }));
    expect(parsed.mcp_servers).toEqual(nativeMcpEntries("codex", { fixture: referenced }));
  });
  it.each(["copilot", "kimi"] as const)(
    "refuses unsupported %s references in both renderers",
    (target) => {
      expect(() => mcpEntries(target, { fixture: referenced })).toThrow(
        /environment references.*unsupported/,
      );
      expect(() => nativeMcpEntries(target, { fixture: referenced })).toThrow(
        /environment references.*unsupported/,
      );
    },
  );
});

describe("offline target routing", () => {
  it.each(SUPPORTED_CLIS)(
    "writes native %s configuration, preserves operator content, and is idempotent",
    async (target) => {
      const ctx = context(target);
      ctx.options.mode = "offline";
      const relative = entry(target).mcp.configPath ?? "";
      const path = relative.startsWith("~/") ? join(home, relative.slice(2)) : join(root, relative);
      mkdirSync(dirname(path), { recursive: true });
      const isToml = target === "codex";
      const key = entry(target).mcp.configKey ?? "";
      writeFileSync(
        path,
        isToml ? 'model = "operator"\n' : JSON.stringify({ operator: true, [key]: {} }),
      );
      const planned = await command.plan(ctx);
      expect(
        planned.actions.some((action) => action.kind === "write" && action.path === ".mcp.json"),
      ).toBe(target === "claude");
      expect(
        planned.actions.some(
          (action) => action.kind === "write" && action.path === "managed-mcp.json.example",
        ),
      ).toBe(target === "claude");
      await executePlan(planned, ctx);
      const first = readFileSync(path, "utf8");
      const parsed = isToml ? parseToml(first) : JSON.parse(first);
      expect(isToml ? parsed.model : parsed.operator).toBe(isToml ? "operator" : true);
      expect(Object.keys(parsed[key]).length).toBeGreaterThan(0);
      for (const config of Object.values(parsed[key]) as Record<string, unknown>[]) {
        expect(config.url).toBeUndefined();
        expect(config.command).toBeDefined();
      }
      await executePlan(await command.plan(ctx), ctx);
      expect(readFileSync(path, "utf8")).toBe(first);
      expect(existsSync(join(root, ".mcp.json"))).toBe(target === "claude");
    },
  );
  it("none mode provides guidance without claiming to disable a non-Claude host", async () => {
    const ctx = context("cursor");
    ctx.options.mode = "none";
    mkdirSync(join(root, ".cursor"));
    const existing = '{"mcpServers":{"operator":{"command":"node"}}}';
    writeFileSync(join(root, ".cursor/mcp.json"), existing);
    const planned = await command.plan(ctx);
    expect(
      planned.actions.some(
        (action) => action.kind === "write" && action.path === "managed-mcp.json.example",
      ),
    ).toBe(false);
    expect(
      planned.actions.some((action) =>
        action.describe.includes("existing host configuration is unchanged"),
      ),
    ).toBe(true);
    await executePlan(planned, ctx);
    expect(readFileSync(join(root, ".cursor/mcp.json"), "utf8")).toBe(existing);
  });
});
