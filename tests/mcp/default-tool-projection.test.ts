import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PlanContext } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { policyAwareMcpCatalog } from "../../src/mcp/catalog.js";
import { projectDefaultDeveloperMcpSelection } from "../../src/mcp/default-tool-projection.js";
import { parseOrgPolicy } from "../../src/org-policy/schema.js";
import { makeHostAdapter } from "../../src/platform/detect.js";

const roots: string[] = [];

function context(): PlanContext {
  const root = mkdtempSync(join(tmpdir(), "aih-default-mcp-"));
  roots.push(root);
  const run = fakeRunner(() => undefined);
  const env = {};
  return {
    root,
    contextDir: "ai-coding",
    apply: false,
    verify: false,
    json: false,
    run,
    env,
    host: makeHostAdapter({ platform: "linux", run, env }),
    options: {},
  };
}

function v3(developerTools?: Record<string, unknown>) {
  return parseOrgPolicy({
    schemaVersion: 3,
    minimumCoreVersion: "0.6.0",
    minimumPosture: "vibe",
    references: { repoContract: "ai-coding/project.json" },
    authoringSelections: {
      selectionVersion: "workbench-selection/v1",
      roots: [],
      exclusions: [],
      requests: [],
      drafts: [],
    },
    ...(developerTools === undefined ? {} : { developerTools }),
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("default developer-tool MCP projection", () => {
  it("keeps GitHub and MarkItDown MCP opt-in independently of the default MarkItDown CLI", () => {
    const ctx = context();
    const defaults = policyAwareMcpCatalog(ctx, { scope: "project" });
    expect(defaults.servers?.github).toBeUndefined();
    expect(defaults.servers?.["markitdown-mcp"]).toBeUndefined();
    const inventory = policyAwareMcpCatalog(ctx, {
      scope: "project",
      includeOptionalServers: true,
    });
    expect(inventory.servers?.github).toBeDefined();
    expect(inventory.servers?.["markitdown-mcp"]).toMatchObject({ egress: "third-party" });
    expect(policyAwareMcpCatalog(ctx, { scope: "project" }).servers?.github).toBeUndefined();
    const policy = v3({ excluded: ["markitdown"] });
    policy.mcp = {
      allowedServers: ["github", "markitdown-mcp"],
      approvals: [],
      disabledServers: [],
      allowManagedOnly: false,
      incumbentHosts: [],
    };
    const selected = policyAwareMcpCatalog(ctx, { scope: "project", verifiedPolicy: { policy } });
    expect(selected.servers?.github).toBeDefined();
    expect(selected.servers?.["markitdown-mcp"]).toMatchObject({
      type: "stdio",
      supplyChain: "pinned",
    });
    expect(selected.developerTools?.selected).not.toContain("markitdown");
    policy.mcp.disabledServers = ["github", "markitdown-mcp"];
    const excluded = policyAwareMcpCatalog(ctx, { scope: "project", verifiedPolicy: { policy } });
    expect(excluded.servers?.github).toBeUndefined();
    expect(excluded.servers?.["markitdown-mcp"]).toBeUndefined();
  });

  it("projects all four MCP-backed defaults when no policy is supplied", () => {
    const result = policyAwareMcpCatalog(context(), { scope: "project" });
    expect(result.error).toBeUndefined();
    expect(Object.keys(result.servers ?? {})).toEqual(
      expect.arrayContaining(["code-review-graph", "codebase-memory-mcp", "serena", "context7"]),
    );
    expect(result.servers?.["token-optimizer"]).toBeUndefined();
    expect(result.servers?.markitdown).toBeUndefined();
    expect(result.servers?.["markitdown-mcp"]).toBeUndefined();
  });

  it("keeps unrelated defaults while honoring explicit subsets, exclusions, and empty", () => {
    const ctx = context();
    const base = policyAwareMcpCatalog(ctx, { scope: "project" }).servers ?? {};

    const subset = projectDefaultDeveloperMcpSelection(base, v3({ selected: ["context7"] }));
    expect(Object.keys(subset.servers)).toEqual(["sequential-thinking", "context7"]);
    expect(subset.selection.source).toBe("explicit");

    const excluded = projectDefaultDeveloperMcpSelection(base, v3({ excluded: ["serena"] }));
    expect(excluded.servers.serena).toBeUndefined();
    expect(excluded.servers["code-review-graph"]).toBeDefined();

    const empty = projectDefaultDeveloperMcpSelection(base, v3({ selected: [] }));
    expect(Object.keys(empty.servers)).toEqual(["sequential-thinking"]);
  });

  it("fails closed for malformed supplied selection and retains legacy MCP restrictions", () => {
    const ctx = context();
    const base = policyAwareMcpCatalog(ctx, { scope: "project" }).servers ?? {};
    const malformed = projectDefaultDeveloperMcpSelection(base, {
      schemaVersion: 3,
      developerTools: { selected: ["unknown"] },
    } as never);
    expect(malformed.selection).toMatchObject({ accepted: false, selected: [] });
    expect(malformed.servers["code-review-graph"]).toBeUndefined();
    expect(malformed.servers["codebase-memory-mcp"]).toBeUndefined();
    expect(malformed.servers.serena).toBeUndefined();
    expect(malformed.servers.context7).toBeUndefined();

    const legacyRestricted = v3();
    legacyRestricted.mcp = {
      allowedServers: [],
      approvals: [],
      disabledServers: ["code-review-graph"],
      allowManagedOnly: false,
      incumbentHosts: [],
    };
    const catalog = policyAwareMcpCatalog(ctx, {
      scope: "project",
      verifiedPolicy: { policy: legacyRestricted },
    });
    expect(catalog.servers?.["code-review-graph"]).toBeUndefined();
    expect(catalog.servers?.["codebase-memory-mcp"]).toBeDefined();
    expect(catalog.servers?.serena).toBeDefined();
    expect(catalog.servers?.context7).toBeDefined();
  });
});
