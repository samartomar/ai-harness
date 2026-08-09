import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  explicitEccMcpReceiptRecord,
  explicitEccMcpRenderPlan,
  planExplicitEccMcpAdd,
  planExplicitEccMcpRemove,
  readExplicitEccMcpReceiptStates,
} from "../../src/ecc/mcp-explicit-add.js";
import {
  emptyExplicitAddReceipt,
  parseExplicitAddReceipt,
} from "../../src/ecc/mcp-explicit-add-receipt.js";
import { REGISTRY_IDS } from "../../src/internals/cli-registry.js";
import { executePlan } from "../../src/internals/execute.js";
import type { PlanContext } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { ECC_MCP_CATALOG_PROVENANCE } from "../../src/org-policy/ecc-mcp-catalog.js";
import { makeHostAdapter } from "../../src/platform/detect.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const HTTPS_IDS = [
  "vercel",
  "cloudflare-docs",
  "cloudflare-workers-builds",
  "cloudflare-workers-bindings",
  "cloudflare-observability",
  "clickhouse",
  "parallel-search",
  "memxus",
  "browser-use",
  "laraplugins",
] as const;

function policy(
  id: (typeof HTTPS_IDS)[number] = "memxus",
  state: "approved" | "revoked" = "approved",
  supportedClis: readonly string[] = ["claude"],
): Record<string, unknown> {
  const governance: Record<string, unknown> = {
    policyVersion: "2026.08",
    catalog: { reviewed: [], custom: [] },
    activations: [],
    authority: { approvals: [] },
    eccMcpApprovals: [
      {
        id,
        sourceContentSha256: ECC_MCP_CATALOG_PROVENANCE.contentSha256,
        state,
        approvedBy: "security-admin",
        authenticationMode: "api-key",
        allowedDataClasses: ["non-sensitive-context"],
      },
    ],
  };
  governance.supportedClis = supportedClis;
  return {
    schemaVersion: 2,
    minimumPosture: "vibe",
    references: { repoContract: "ai-coding/project.json" },
    governance,
  };
}

describe("explicit ECC HTTPS MCP render plan", () => {
  it("renders the policy-approved pinned HTTPS entry through every registered MCP renderer", () => {
    for (const target of REGISTRY_IDS) {
      const plan = explicitEccMcpRenderPlan(
        policy("memxus", "approved", REGISTRY_IDS),
        "memxus",
        target,
      );
      expect(plan.target).toBe(target);
      expect(plan.catalog).toEqual(ECC_MCP_CATALOG_PROVENANCE);
      expect(plan.renderedDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(JSON.stringify(plan.rendered)).toContain("MEMXUS_API_KEY");
      expect(JSON.stringify(plan.rendered)).not.toContain("YOUR_MEMXUS");
    }
  });

  it("renders every source-approved HTTPS entry and no manual entry", () => {
    for (const id of HTTPS_IDS) {
      expect(explicitEccMcpRenderPlan(policy(id), id, "claude").id).toBe(id);
    }
    expect(() => explicitEccMcpRenderPlan(policy(), "devfleet", "claude")).toThrow();
  });

  it("refuses manual, unapproved, revoked, and source-mismatched selections before rendering", () => {
    expect(() => explicitEccMcpRenderPlan(policy(), "jira", "claude")).toThrow(/unapproved/);
    expect(() => explicitEccMcpRenderPlan(policy("memxus", "revoked"), "memxus", "claude")).toThrow(
      /revoked/,
    );
    expect(() => explicitEccMcpRenderPlan(policy(), "vercel", "claude")).toThrow(/unapproved/);
    expect(() => explicitEccMcpRenderPlan(policy(), "memxus", "cursor")).toThrow(/not sanctioned/);
    const withoutSupportedClis = policy();
    delete (withoutSupportedClis.governance as Record<string, unknown>).supportedClis;
    expect(explicitEccMcpRenderPlan(withoutSupportedClis, "memxus", "claude").id).toBe("memxus");
  });

  it("records only configuration ownership facts in a strict receipt", () => {
    const plan = explicitEccMcpRenderPlan(policy(), "memxus", "claude");
    const record = explicitEccMcpReceiptRecord(plan);
    expect(parseExplicitAddReceipt({ ...emptyExplicitAddReceipt(), records: [record] })).toEqual({
      ...emptyExplicitAddReceipt(),
      records: [record],
    });
    expect(() =>
      parseExplicitAddReceipt({
        ...emptyExplicitAddReceipt(),
        records: [{ ...record, extra: true }],
      }),
    ).toThrow(/invalid explicit ECC MCP receipt records/);
    expect(() =>
      parseExplicitAddReceipt({ ...emptyExplicitAddReceipt(), records: [record], extra: true }),
    ).toThrow(/format/);
    expect(() =>
      parseExplicitAddReceipt({
        ...emptyExplicitAddReceipt(),
        records: [{ ...record, target: "unknown-cli" }],
      }),
    ).toThrow(/records/);
    expect(() =>
      parseExplicitAddReceipt({
        ...emptyExplicitAddReceipt(),
        records: [{ ...record, config: { ...record.config, path: "operator/path" } }],
      }),
    ).toThrow(/records/);
  });
});

function fixture(): { root: string; home: string } {
  const root = mkdtempSync(join(tmpdir(), "aih-explicit-mcp-root-"));
  const home = mkdtempSync(join(tmpdir(), "aih-explicit-mcp-home-"));
  roots.push(root, home);
  return { root, home };
}

function context(root: string, home: string, apply: boolean): PlanContext {
  const run = fakeRunner(() => undefined);
  const env = { HOME: home, USERPROFILE: home };
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
    options: { force: true },
  };
}

describe("project-local explicit ECC MCP lifecycle", () => {
  it.each([
    ["claude", ".mcp.json", "mcpServers"],
    ["cursor", ".cursor/mcp.json", "mcpServers"],
    ["copilot", ".vscode/mcp.json", "servers"],
    ["kimi", ".mcp.json", "mcpServers"],
    ["kiro", ".kiro/settings/mcp.json", "mcpServers"],
  ])(
    "adds and removes one receipt-owned entry from %s without deleting or clobbering",
    async (target, configPath, configKey) => {
      const { root, home } = fixture();
      const path = join(root, configPath);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(
        path,
        JSON.stringify({ unrelated: true, [configKey]: { operator: { url: "x" } } }),
      );
      const add = planExplicitEccMcpAdd({
        root,
        policy: policy("memxus", "approved", [target]),
        id: "memxus",
        target,
      });
      expect(existsSync(join(root, ".aih", "ecc-mcp-explicit-add-v1.json"))).toBe(false);
      await executePlan(add, context(root, home, true));
      const afterAdd = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      expect(afterAdd.unrelated).toBe(true);
      expect((afterAdd[configKey] as Record<string, unknown>).operator).toEqual({ url: "x" });
      expect((afterAdd[configKey] as Record<string, unknown>).memxus).toBeDefined();

      const remove = planExplicitEccMcpRemove({ root, id: "memxus", target });
      await executePlan(remove, context(root, home, true));
      const afterRemove = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      expect(afterRemove.unrelated).toBe(true);
      expect((afterRemove[configKey] as Record<string, unknown>).operator).toEqual({ url: "x" });
      expect((afterRemove[configKey] as Record<string, unknown>).memxus).toBeUndefined();
      expect(existsSync(path)).toBe(true);
    },
  );

  it.each([
    ["antigravity", ".antigravity/mcp.json", "mcpServers"],
    ["gemini", ".gemini/settings.json", "mcpServers"],
    ["windsurf", ".codeium/windsurf/mcp_config.json", "mcpServers"],
    ["opencode", ".config/opencode/opencode.json", "mcp"],
    ["zed", ".config/zed/settings.json", "context_servers"],
  ])(
    "adds and removes %s under an explicit guarded HOME",
    async (target, configPath, configKey) => {
      const { root, home } = fixture();
      const path = join(home, configPath);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(
        path,
        JSON.stringify({ unrelated: true, [configKey]: { operator: { url: "x" } } }),
      );
      await executePlan(
        planExplicitEccMcpAdd({
          root,
          home,
          policy: policy("memxus", "approved", [target]),
          id: "memxus",
          target,
        }),
        context(root, home, true),
      );
      expect(JSON.parse(readFileSync(path, "utf8"))[configKey].memxus).toBeDefined();
      await executePlan(
        planExplicitEccMcpRemove({ root, home, id: "memxus", target }),
        context(root, home, true),
      );
      const after = JSON.parse(readFileSync(path, "utf8"));
      expect(after.unrelated).toBe(true);
      expect(after[configKey].operator).toEqual({ url: "x" });
      expect(after[configKey].memxus).toBeUndefined();
      expect(existsSync(path)).toBe(true);
    },
  );

  it("adds and removes only an exact receipt-owned Codex table", async () => {
    const { root, home } = fixture();
    const path = join(home, ".codex/config.toml");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '[mcp_servers."operator"]\nurl = "https://operator.example"\n');
    await executePlan(
      planExplicitEccMcpAdd({
        root,
        home,
        policy: policy("memxus", "approved", ["codex"]),
        id: "memxus",
        target: "codex",
      }),
      context(root, home, true),
    );
    expect(readFileSync(path, "utf8")).toContain('[mcp_servers."memxus"]');
    await executePlan(
      planExplicitEccMcpRemove({ root, home, id: "memxus", target: "codex" }),
      context(root, home, true),
    );
    const after = readFileSync(path, "utf8");
    expect(after).toContain('[mcp_servers."operator"]');
    expect(after).not.toContain('[mcp_servers."memxus"]');
    expect(existsSync(path)).toBe(true);
  });

  it("keeps a selected Codex table exact among direct siblings and nested subtables", async () => {
    const { root, home } = fixture();
    const path = join(home, ".codex/config.toml");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      '# operator comment\n[mcp_servers."operator"]\nurl = "https://operator.example"\n\n[other]\nkeep = true\n',
    );
    for (const id of ["memxus", "browser-use"] as const) {
      await executePlan(
        planExplicitEccMcpAdd({
          root,
          home,
          policy: policy(id, "approved", ["codex"]),
          id,
          target: "codex",
        }),
        context(root, home, true),
      );
    }
    expect(
      planExplicitEccMcpAdd({
        root,
        home,
        policy: policy("memxus", "approved", ["codex"]),
        id: "memxus",
        target: "codex",
      }).actions,
    ).toHaveLength(0);
    const withBoth = readFileSync(path, "utf8");
    expect(withBoth.indexOf('[mcp_servers."operator"]')).toBeLessThan(
      withBoth.indexOf('[mcp_servers."memxus"]'),
    );
    expect(withBoth.indexOf('[mcp_servers."memxus"]')).toBeLessThan(
      withBoth.indexOf('[mcp_servers."browser-use"]'),
    );
    expect(withBoth).toContain('[mcp_servers."browser-use".env_http_headers]');
    await executePlan(
      planExplicitEccMcpRemove({ root, home, id: "memxus", target: "codex" }),
      context(root, home, true),
    );
    const after = readFileSync(path, "utf8");
    expect(after).toContain("# operator comment");
    expect(after).toContain('[mcp_servers."operator"]');
    expect(after).toContain('[mcp_servers."browser-use"]');
    expect(after).toContain('[mcp_servers."browser-use".env_http_headers]');
    expect(after).toContain("[other]");
    expect(after).not.toContain('[mcp_servers."memxus"]');
  });

  it("refuses orphaned or child-before-direct Codex MCP tables without deleting them", () => {
    const { root, home } = fixture();
    const path = join(home, ".codex/config.toml");
    mkdirSync(dirname(path), { recursive: true });
    const orphan = '[mcp_servers."memxus".http_headers]\nAuthorization = "operator"\n';
    writeFileSync(path, orphan);
    expect(() =>
      planExplicitEccMcpAdd({
        root,
        home,
        policy: policy("memxus", "approved", ["codex"]),
        id: "memxus",
        target: "codex",
      }),
    ).toThrow(/operator-owned/);
    writeFileSync(path, `${orphan}\n[mcp_servers."memxus"]\nurl = "https://operator.example"\n`);
    expect(() =>
      planExplicitEccMcpAdd({
        root,
        home,
        policy: policy("memxus", "approved", ["codex"]),
        id: "memxus",
        target: "codex",
      }),
    ).toThrow(/operator-owned/);
    expect(
      planExplicitEccMcpRemove({ root, home, id: "memxus", target: "codex" }).actions.map(
        (action) => action.kind,
      ),
    ).toEqual(["digest"]);
    expect(readFileSync(path, "utf8")).toContain('Authorization = "operator"');
  });

  it.each([
    '[mcp_servers."memxus".http_headers]\nAuthorization = "operator"\n',
    "[mcp_servers.'memxus'.http_headers]\nAuthorization = \"operator\"\n",
    '[mcp_servers.memxus.http_headers]\nAuthorization = "operator"\n',
  ])("treats an orphaned Codex nested table as operator-owned: %s", (orphan) => {
    const { root, home } = fixture();
    const path = join(home, ".codex/config.toml");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, orphan);

    expect(() =>
      planExplicitEccMcpAdd({
        root,
        home,
        policy: policy("memxus", "approved", ["codex"]),
        id: "memxus",
        target: "codex",
      }),
    ).toThrow(/operator-owned/);
    expect(
      planExplicitEccMcpRemove({ root, home, id: "memxus", target: "codex" }).actions.map(
        (action) => action.kind,
      ),
    ).toEqual(["digest"]);
    expect(readFileSync(path, "utf8")).toBe(orphan);
  });

  it.each([
    '[mcp_servers."memxus".http_headers]\nAuthorization = "operator"\n',
    '[mcp_servers."memxus"]\nurl = "https://operator.example"\n',
  ])("refuses a later same-id Codex %s table after the receipt-owned tree", async (laterTable) => {
    const { root, home } = fixture();
    const path = join(home, ".codex/config.toml");
    mkdirSync(dirname(path), { recursive: true });
    await executePlan(
      planExplicitEccMcpAdd({
        root,
        home,
        policy: policy("memxus", "approved", ["codex"]),
        id: "memxus",
        target: "codex",
      }),
      context(root, home, true),
    );
    const hostile = `${readFileSync(path, "utf8")}\n[other]\nkeep = true\n\n${laterTable}`;
    writeFileSync(path, hostile);

    expect(() =>
      planExplicitEccMcpAdd({
        root,
        home,
        policy: policy("memxus", "approved", ["codex"]),
        id: "memxus",
        target: "codex",
      }),
    ).toThrow(/Add is refused/);
    expect(readExplicitEccMcpReceiptStates({ root, home })[0]?.state).not.toBe("clean");
    expect(
      planExplicitEccMcpRemove({ root, home, id: "memxus", target: "codex" }).actions.map(
        (action) => action.kind,
      ),
    ).toEqual(["digest"]);
    expect(readFileSync(path, "utf8")).toBe(hostile);
  });

  it.each(["gemini", "codex"])(
    "refuses global %s target and parent symlink swaps at apply",
    async (target) => {
      const { root, home } = fixture();
      const planned = planExplicitEccMcpAdd({
        root,
        home,
        policy: policy("memxus", "approved", [target]),
        id: "memxus",
        target,
      });
      const configDir = target === "codex" ? join(home, ".codex") : join(home, ".gemini");
      const outside = mkdtempSync(join(tmpdir(), "aih-explicit-mcp-outside-"));
      roots.push(outside);
      mkdirSync(configDir, { recursive: true });
      const targetPath =
        target === "codex" ? join(configDir, "config.toml") : join(configDir, "settings.json");
      try {
        symlinkSync(join(outside, "target"), targetPath, "file");
      } catch {
        return;
      }
      await expect(executePlan(planned, context(root, home, true))).rejects.toThrow(/symlink/);
      rmSync(targetPath);
      rmSync(configDir, { recursive: true, force: true });
      try {
        symlinkSync(outside, configDir, "dir");
      } catch {
        return;
      }
      await expect(executePlan(planned, context(root, home, true))).rejects.toThrow(/symlink/);
    },
  );

  it("reports every explicit receipt state without contacting a server", async () => {
    const { root, home } = fixture();
    expect(readExplicitEccMcpReceiptStates({ root, home })[0]?.state).toBe("absent");
    const config = join(root, ".mcp.json");
    await executePlan(
      planExplicitEccMcpAdd({ root, policy: policy(), id: "memxus", target: "claude" }),
      context(root, home, true),
    );
    expect(readExplicitEccMcpReceiptStates({ root, home })[0]?.state).toBe("clean");
    writeFileSync(config, '{"mcpServers":{"memxus":{"url":"changed"}}}\n');
    expect(readExplicitEccMcpReceiptStates({ root, home })[0]?.state).toBe("altered");
    rmSync(config);
    expect(readExplicitEccMcpReceiptStates({ root, home })[0]?.state).toBe("absent");
    writeFileSync(join(root, ".aih", "ecc-mcp-explicit-add-v1.json"), "{}\n");
    expect(readExplicitEccMcpReceiptStates({ root, home })[0]?.state).toBe("malformed");
    const record = explicitEccMcpReceiptRecord(
      explicitEccMcpRenderPlan(policy(), "memxus", "claude"),
    );
    writeFileSync(
      join(root, ".aih", "ecc-mcp-explicit-add-v1.json"),
      JSON.stringify({
        format: "aih-ecc-mcp-explicit-add",
        version: 1,
        records: [
          { ...record, config: { ...record.config, renderedSha256: `sha256:${"0".repeat(64)}` } },
        ],
      }),
    );
    expect(readExplicitEccMcpReceiptStates({ root, home })[0]?.state).toBe("revoked");
    writeFileSync(
      join(root, ".aih", "ecc-mcp-explicit-add-v1.json"),
      JSON.stringify({ format: "aih-ecc-mcp-explicit-add", version: 1, records: [record] }),
    );
    symlinkSync(join(root, "outside"), config);
    expect(readExplicitEccMcpReceiptStates({ root, home })[0]?.state).toBe("unsafe-path");
  });

  it("pins add against a plan-to-apply config race and writes no receipt", async () => {
    const { root, home } = fixture();
    const config = join(root, ".mcp.json");
    writeFileSync(config, '{"mcpServers":{}}\n');
    const planned = planExplicitEccMcpAdd({
      root,
      policy: policy(),
      id: "memxus",
      target: "claude",
    });
    writeFileSync(config, '{"mcpServers":{"operator":{"url":"x"}}}\n');
    await expect(executePlan(planned, context(root, home, true))).rejects.toThrow(
      /changed after the plan/,
    );
    expect(existsSync(join(root, ".aih", "ecc-mcp-explicit-add-v1.json"))).toBe(false);
  });

  it("pins add against a plan-to-apply receipt race and writes no config", async () => {
    const { root, home } = fixture();
    const config = join(root, ".mcp.json");
    writeFileSync(config, '{"mcpServers":{}}\n');
    const planned = planExplicitEccMcpAdd({
      root,
      policy: policy(),
      id: "memxus",
      target: "claude",
    });
    mkdirSync(join(root, ".aih"), { recursive: true });
    writeFileSync(join(root, ".aih", "ecc-mcp-explicit-add-v1.json"), "{}\n");
    await expect(executePlan(planned, context(root, home, true))).rejects.toThrow(
      /changed after the plan/,
    );
    expect(readFileSync(config, "utf8")).not.toContain("memxus");
  });

  it("rejects operator collisions and accepts only exact receipt-owned idempotence", async () => {
    const { root, home } = fixture();
    const config = join(root, ".mcp.json");
    writeFileSync(config, '{"mcpServers":{"memxus":{"url":"operator"}}}\n');
    expect(() =>
      planExplicitEccMcpAdd({ root, policy: policy(), id: "memxus", target: "claude" }),
    ).toThrow(/operator-owned/);
    writeFileSync(config, '{"mcpServers":{}}\n');
    await executePlan(
      planExplicitEccMcpAdd({ root, policy: policy(), id: "memxus", target: "claude" }),
      context(root, home, true),
    );
    expect(
      planExplicitEccMcpAdd({ root, policy: policy(), id: "memxus", target: "claude" }).actions,
    ).toHaveLength(0);
  });

  it("refuses an oversized client config before parsing or planning a write", () => {
    const { root } = fixture();
    writeFileSync(join(root, ".mcp.json"), `{"mcpServers":{}}${" ".repeat(4 * 1024 * 1024)}`);
    expect(() =>
      planExplicitEccMcpAdd({ root, policy: policy(), id: "memxus", target: "claude" }),
    ).toThrow(/unsafe/);
  });

  it("reports remove drift and refuses symlinked project paths without mutation", async () => {
    const { root, home } = fixture();
    const config = join(root, ".mcp.json");
    writeFileSync(config, '{"mcpServers":{}}\n');
    await executePlan(
      planExplicitEccMcpAdd({ root, policy: policy(), id: "memxus", target: "claude" }),
      context(root, home, true),
    );
    writeFileSync(config, '{"mcpServers":{"memxus":{"url":"operator-change"}}}\n');
    const drift = planExplicitEccMcpRemove({ root, id: "memxus", target: "claude" });
    expect(drift.actions.map((action) => action.kind)).toEqual(["digest"]);
    await executePlan(drift, context(root, home, true));
    expect(readFileSync(config, "utf8")).toContain("operator-change");

    writeFileSync(join(root, ".aih", "ecc-mcp-explicit-add-v1.json"), "{}\n");
    const malformedReceipt = planExplicitEccMcpRemove({
      root,
      id: "memxus",
      target: "claude",
    });
    expect(malformedReceipt.actions.map((action) => action.kind)).toEqual(["digest"]);
    await executePlan(malformedReceipt, context(root, home, true));
    expect(readFileSync(config, "utf8")).toContain("operator-change");

    rmSync(config);
    writeFileSync(join(root, "outside.json"), "{}");
    symlinkSync(join(root, "outside.json"), config);
    expect(() =>
      planExplicitEccMcpAdd({ root, policy: policy(), id: "memxus", target: "claude" }),
    ).toThrow(/unsafe/);
  });
});
