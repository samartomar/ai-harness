import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PlanContext } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { policyAwareMcpCatalog } from "../../src/mcp/catalog.js";
import { projectDefaultDeveloperMcpSelection } from "../../src/mcp/default-tool-projection.js";
import { parseOrgPolicy } from "../../src/org-policy/schema.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import { headroomLayout, headroomMcpServer, headroomPlatform } from "../../src/tools/headroom.js";
import { headroomReceiptFor, writeHeadroomReceipt } from "../../src/tools/headroom-receipt.js";

const roots: string[] = [];

function activate(ctx: PlanContext) {
  const layout = headroomLayout(ctx);
  mkdirSync(layout.stateRoot, { recursive: true });
  const receipt = headroomReceiptFor({
    layout,
    platform: headroomPlatform(process.platform, process.arch) ?? "linux-x64",
    acceptedAt: "2026-09-23T12:00:00.000Z",
    hosts: ["claude"],
    server: headroomMcpServer(ctx),
  });
  writeHeadroomReceipt(layout, receipt, undefined);
  return { layout, receipt };
}

function context(): PlanContext {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "aih-default-mcp-")));
  const state = realpathSync(mkdtempSync(join(tmpdir(), "aih-default-mcp-state-")));
  roots.push(root, state);
  const run = fakeRunner(() => undefined);
  const env = { XDG_STATE_HOME: state, HOME: state, LOCALAPPDATA: state };
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

function v3(developerTools?: Record<string, unknown>, minimumCoreVersion = "0.6.0") {
  return parseOrgPolicy({
    schemaVersion: 3,
    minimumCoreVersion,
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

  it("projects all five MCP-backed defaults when no policy is supplied", () => {
    const result = policyAwareMcpCatalog(context(), { scope: "project" });
    expect(result.error).toBeUndefined();
    expect(Object.keys(result.servers ?? {})).toEqual(
      expect.arrayContaining([
        "code-review-graph",
        "codebase-memory-mcp",
        "serena",
        "context7",
        "playwright",
      ]),
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

    const playwrightOnly = projectDefaultDeveloperMcpSelection(
      base,
      v3({ selected: ["playwright"] }),
    );
    expect(Object.keys(playwrightOnly.servers)).toEqual(["sequential-thinking", "playwright"]);

    const excluded = projectDefaultDeveloperMcpSelection(base, v3({ excluded: ["serena"] }));
    expect(excluded.servers.serena).toBeUndefined();
    expect(excluded.servers["code-review-graph"]).toBeDefined();

    const empty = projectDefaultDeveloperMcpSelection(base, v3({ selected: [] }));
    expect(Object.keys(empty.servers)).toEqual(["sequential-thinking"]);
  });

  it("never projects selected Headroom before an explicit activation receipt exists", () => {
    const ctx = context();
    const catalog = policyAwareMcpCatalog(ctx, { scope: "project" });
    expect(catalog.developerTools?.selected).toContain("headroom");
    expect(catalog.servers?.headroom).toBeUndefined();
    // The generated shape is still offered for byte-identical removal only.
    expect(catalog.excludedDeveloperToolServers?.headroom).toEqual(headroomMcpServer(ctx));
  });

  it("projects the generated Headroom launcher only for a current activation", () => {
    const ctx = context();
    const { layout, receipt } = activate(ctx);
    expect(policyAwareMcpCatalog(ctx, { scope: "project" }).servers?.headroom).toEqual(
      headroomMcpServer(ctx),
    );

    const deactivating = { ...ctx, options: { deactivateHeadroom: true } };
    const removal = policyAwareMcpCatalog(deactivating, { scope: "project" });
    expect(removal.servers?.headroom).toBeUndefined();
    expect(removal.excludedDeveloperToolServers?.headroom).toEqual(receipt.launcher.server);

    const excludedPolicy = v3({ excluded: ["headroom"] }, "0.7.0");
    const excluded = policyAwareMcpCatalog(ctx, {
      scope: "project",
      verifiedPolicy: { policy: excludedPolicy },
    });
    expect(excluded.servers?.headroom).toBeUndefined();
    expect(excluded.excludedDeveloperToolServers?.headroom).toEqual(receipt.launcher.server);

    const disabled = v3();
    disabled.mcp = {
      allowedServers: [],
      approvals: [],
      disabledServers: ["headroom"],
      allowManagedOnly: false,
      incumbentHosts: [],
    };
    expect(
      policyAwareMcpCatalog(ctx, { scope: "project", verifiedPolicy: { policy: disabled } }).servers
        ?.headroom,
    ).toBeUndefined();

    writeFileSync(
      layout.receiptPath,
      `${JSON.stringify({ ...receipt, pin: { ...receipt.pin, package: "headroom-ai[mcp]==0.37.0" } }, null, 2)}\n`,
    );
    const stale = policyAwareMcpCatalog(ctx, { scope: "project" });
    expect(stale.servers?.headroom).toBeUndefined();
    expect(stale.excludedDeveloperToolServers?.headroom).toEqual(receipt.launcher.server);
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
    expect(malformed.servers.playwright).toBeUndefined();

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
    expect(catalog.servers?.playwright).toBeDefined();
  });
});
