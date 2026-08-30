import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AIH_OWNED_ECC_MCP_EXCLUSIONS,
  ECC_MCP_CATALOG_CANONICAL_SHA256,
  ECC_MCP_CATALOG_IDS,
  ECC_MCP_CATALOG_PROVENANCE,
  eccExternalMcpCatalog,
  validateEccMcpCatalogInventory,
} from "../../src/org-policy/ecc-mcp-catalog.js";
import snapshot from "../../src/org-policy/ecc-mcp-catalog.snapshot.json";

const PINNED_IDS = [
  "nexus",
  "ito-compute",
  "jira",
  "github",
  "firecrawl",
  "supabase",
  "ecc-memory-vault",
  "memory",
  "omega-memory",
  "longhand",
  "sequential-thinking",
  "vercel",
  "railway",
  "cloudflare-docs",
  "cloudflare-workers-builds",
  "cloudflare-workers-bindings",
  "cloudflare-observability",
  "clickhouse",
  "exa-web-search",
  "parallel-search",
  "context7",
  "codescene",
  "magic",
  "memxus",
  "filesystem",
  "playwright",
  "fal-ai",
  "browserbase",
  "browser-use",
  "devfleet",
  "token-optimizer",
  "laraplugins",
  "confluence",
  "evalview",
  "squish",
] as const;

describe("source-locked ECC MCP catalog inventory", () => {
  it("preserves the exact ordered upstream catalog and provenance", () => {
    expect(ECC_MCP_CATALOG_PROVENANCE).toEqual({
      repository: "affaan-m/ECC",
      commit: "19e2f2b46d1f7a6c2422ee5e299adcfa052a99e5",
      path: "mcp-configs/mcp-servers.json",
      contentSha256: "a4426254c55a5352db2672bc86a87f10b0029f5e4ae1b74817841e87d9ab1e57",
    });
    expect(ECC_MCP_CATALOG_IDS).toEqual(PINNED_IDS);
    expect(Object.keys(snapshot.mcpServers)).toEqual(PINNED_IDS);
    expect(createHash("sha256").update(JSON.stringify(snapshot), "utf8").digest("hex")).toBe(
      ECC_MCP_CATALOG_CANONICAL_SHA256,
    );
    expect(
      createHash("sha256")
        .update(
          readFileSync(
            new URL("../../src/org-policy/ecc-mcp-catalog.snapshot.json", import.meta.url),
          ),
        )
        .digest("hex"),
    ).toBe(ECC_MCP_CATALOG_PROVENANCE.contentSha256);
  });

  it("subtracts AIH-owned servers without presenting the rest as AIH controls", () => {
    expect(AIH_OWNED_ECC_MCP_EXCLUSIONS).toEqual([
      "github",
      "sequential-thinking",
      "context7",
      "playwright",
    ]);
    expect(eccExternalMcpCatalog).toHaveLength(31);
    const aihOwned = new Set<string>(AIH_OWNED_ECC_MCP_EXCLUSIONS);
    expect(eccExternalMcpCatalog.map((entry) => entry.id)).toEqual(
      PINNED_IDS.filter((id) => !aihOwned.has(id)),
    );
    expect(eccExternalMcpCatalog.every((entry) => entry.owner === "ecc")).toBe(true);
  });

  it("classifies transport and explicit-add boundaries without launching anything", () => {
    const all = validateEccMcpCatalogInventory(snapshot);
    expect(all.filter((entry) => entry.transport === "stdio")).toHaveLength(24);
    expect(all.filter((entry) => entry.transport === "http")).toHaveLength(11);

    const https = eccExternalMcpCatalog.filter(
      (entry) => entry.addability === "https-configurable",
    );
    expect(https).toHaveLength(10);
    expect(https.every((entry) => entry.url?.startsWith("https://") === true)).toBe(true);
    expect(eccExternalMcpCatalog.find((entry) => entry.id === "devfleet")).toMatchObject({
      transport: "http",
      addability: "manual-localhost",
      url: "http://localhost:18801/mcp",
    });
    expect(
      eccExternalMcpCatalog.filter((entry) => entry.addability === "manual-stdio"),
    ).toHaveLength(20);
  });

  it("keeps placeholder requirements declarative and fails closed on inventory drift", () => {
    expect(
      eccExternalMcpCatalog.find((entry) => entry.id === "jira")?.credentialRequirement,
    ).toEqual({
      kind: "operator-supplied",
      variables: ["JIRA_API_TOKEN"],
    });
    expect(
      eccExternalMcpCatalog.find((entry) => entry.id === "supabase")?.credentialRequirement,
    ).toEqual({
      kind: "none",
      variables: [],
    });
    expect(
      eccExternalMcpCatalog.find((entry) => entry.id === "filesystem")?.configurationPlaceholders,
    ).toEqual(["path"]);
    const digest = (value: unknown) =>
      createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
    const unexpected = {
      ...snapshot,
      mcpServers: { ...snapshot.mcpServers, unexpected: { command: "nope" } },
    };
    expect(() => validateEccMcpCatalogInventory(unexpected, digest(unexpected))).toThrow(
      /snapshot count mismatch/,
    );
    const changedTransport = {
      ...snapshot,
      mcpServers: {
        ...snapshot.mcpServers,
        nexus: { ...snapshot.mcpServers.nexus, type: "http", url: "https://example.com" },
      },
    };
    expect(() =>
      validateEccMcpCatalogInventory(changedTransport, digest(changedTransport)),
    ).toThrow(/transport/);
    const changedPlaceholder = structuredClone(snapshot) as unknown as {
      mcpServers: Record<string, Record<string, unknown>>;
    };
    const jira = changedPlaceholder.mcpServers.jira;
    if (jira === undefined) throw new Error("expected pinned Jira entry");
    changedPlaceholder.mcpServers.jira = {
      ...jira,
      env: { ...(jira.env as Record<string, unknown>), NEW_KEY: "YOUR_UNKNOWN_KEY_HERE" },
    };
    expect(() =>
      validateEccMcpCatalogInventory(changedPlaceholder, digest(changedPlaceholder)),
    ).toThrow(/unknown or stale placeholder classification/);
  });
});
