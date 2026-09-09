import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { eccBaselineCatalogV1 } from "../../src/baseline-evidence/catalog-providers/ecc.js";
import { superpowersBaselineCatalogV1 } from "../../src/baseline-evidence/catalog-providers/superpowers.js";
import { readVendorBaselineLock } from "../../src/baseline-evidence/vendor.js";
import { policyAuthoringCatalog } from "../../src/org-policy/catalog.js";
import { policyAuthoringCurationKind } from "../../src/org-policy/catalog-provider-types.js";
import { prepareAihCatalogSourceV1 } from "../../src/org-policy/catalog-providers/aih.js";
import { prepareEccCatalogSourceV1 } from "../../src/org-policy/catalog-providers/ecc.js";
import { prepareSuperpowersCatalogSourceV1 } from "../../src/org-policy/catalog-providers/superpowers.js";
import {
  ECC_MCP_CATALOG_PROVENANCE,
  eccExternalMcpCatalog,
} from "../../src/org-policy/ecc-mcp-catalog.js";

function sourceClosure(entryPath: string, seen = new Set<string>()): Set<string> {
  if (seen.has(entryPath)) return seen;
  seen.add(entryPath);
  const source = readFileSync(entryPath, "utf8");
  for (const match of source.matchAll(/from\s+["']([^"']+)["']/gu)) {
    const specifier = match[1];
    if (!specifier?.startsWith(".")) continue;
    const target = resolve(dirname(entryPath), specifier.replace(/\.js$/u, ".ts"));
    if (existsSync(target)) sourceClosure(target, seen);
  }
  return seen;
}

describe("catalog source providers", () => {
  const snapshots = new Map(readVendorBaselineLock().sources.map((source) => [source.id, source]));
  const eccSnapshot = snapshots.get("ecc")!;
  const superpowersSnapshot = snapshots.get("superpowers")!;
  const canonicalEccSnapshot = { ...eccSnapshot, owner: "affaan-m", repo: "ECC" };

  it("prepares first-party content from an explicit package identity", () => {
    const catalog = policyAuthoringCatalog();
    expect(
      prepareAihCatalogSourceV1({
        capabilityCatalog: catalog.aihCapabilityCatalog,
        capabilityPackage: catalog.aihCapabilityPackage,
      }),
    ).toEqual({
      aihCapabilityCatalog: catalog.aihCapabilityCatalog,
      aihCapabilityPackage: catalog.aihCapabilityPackage,
      aihSkills: catalog.aihSkills,
      aihAgents: catalog.aihAgents,
    });
  });
  it("keeps direct source contributions equal to the compatibility facade", () => {
    const frameworks = new Map(
      policyAuthoringCatalog().frameworks.map((framework) => [framework.id, framework]),
    );
    expect(
      prepareEccCatalogSourceV1({
        baseline: eccBaselineCatalogV1(),
        sourceSnapshot: canonicalEccSnapshot,
      }),
    ).toEqual(frameworks.get("ecc"));
    expect(
      prepareSuperpowersCatalogSourceV1({
        baseline: superpowersBaselineCatalogV1(),
        sourceSnapshot: superpowersSnapshot,
      }),
    ).toEqual(frameworks.get("superpowers"));
  });

  it("adds all source-locked ECC MCP options as unvetted authorable declarations", () => {
    const baseline = eccBaselineCatalogV1();
    const framework = prepareEccCatalogSourceV1({ baseline, sourceSnapshot: canonicalEccSnapshot });
    const baselineIds = baseline.components.map((component) => component.id);
    const baselineAssets = framework.assets.filter((asset) => baselineIds.includes(asset.id));
    const externalAssets = framework.assets.filter(
      (asset) =>
        asset.id.startsWith("mcp:") && asset.source.path === ECC_MCP_CATALOG_PROVENANCE.path,
    );

    expect(ECC_MCP_CATALOG_PROVENANCE).toMatchObject({
      repository: "affaan-m/ECC",
      commit: baseline.pinnedSha,
      path: "mcp-configs/mcp-servers.json",
      contentSha256: "a4426254c55a5352db2672bc86a87f10b0029f5e4ae1b74817841e87d9ab1e57",
    });
    expect(baselineAssets.map((asset) => asset.id)).toEqual(baselineIds);
    expect(externalAssets.map((asset) => asset.id)).toEqual(
      eccExternalMcpCatalog.map((entry) => `mcp:${entry.id}`),
    );
    for (const asset of externalAssets) {
      const entry = eccExternalMcpCatalog.find((candidate) => `mcp:${candidate.id}` === asset.id);
      if (entry === undefined) throw new Error(`missing ECC MCP inventory entry for ${asset.id}`);
      expect(asset).toMatchObject({
        kind: "mcp",
        source: {
          repository: ECC_MCP_CATALOG_PROVENANCE.repository,
          commit: ECC_MCP_CATALOG_PROVENANCE.commit,
          path: ECC_MCP_CATALOG_PROVENANCE.path,
        },
        sourcePaths: [ECC_MCP_CATALOG_PROVENANCE.path],
        metadata: {
          title: entry.id,
          summary: entry.description,
          sourcePath: ECC_MCP_CATALOG_PROVENANCE.path,
          sourceSha256: ECC_MCP_CATALOG_PROVENANCE.contentSha256,
          allowedTools: [],
        },
      });
      expect(asset.vet).toBeUndefined();
    }
  });

  it("provides pinned Superpowers skill descriptions without inventing tool permissions", () => {
    const baseline = superpowersBaselineCatalogV1();
    const framework = prepareSuperpowersCatalogSourceV1({
      baseline,
      sourceSnapshot: superpowersSnapshot,
    });
    const skills = framework.assets.filter((asset) => asset.kind === "skill");
    expect(skills.length).toBeGreaterThan(0);
    for (const skill of skills) {
      expect(skill.metadata?.summary.length).toBeGreaterThan(0);
      expect(skill.metadata?.sourcePath).toBe(`skills/${skill.id.slice("skill:".length)}/SKILL.md`);
      expect(skill.metadata?.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(skill.metadata?.allowedTools).toEqual([]);
    }
    expect(() =>
      prepareSuperpowersCatalogSourceV1({
        baseline: { ...baseline, pinnedSha: "f".repeat(40) },
        sourceSnapshot: { ...superpowersSnapshot, pinnedSha: "f".repeat(40) },
      }),
    ).toThrow("content metadata does not match");
  });

  it("rejects a mismatched source identity or pin and preserves vendor vet verdicts", () => {
    expect(() =>
      prepareEccCatalogSourceV1({
        baseline: eccBaselineCatalogV1(),
        sourceSnapshot: { ...eccSnapshot, id: "superpowers" },
      }),
    ).toThrow("does not match");
    expect(() =>
      prepareEccCatalogSourceV1({
        baseline: eccBaselineCatalogV1(),
        sourceSnapshot: { ...canonicalEccSnapshot, owner: "samartomar" },
      }),
    ).toThrow("does not match");
    expect(() =>
      prepareSuperpowersCatalogSourceV1({
        baseline: superpowersBaselineCatalogV1(),
        sourceSnapshot: { ...superpowersSnapshot, pinnedSha: "0".repeat(40) },
      }),
    ).toThrow("does not match");
    expect(() =>
      prepareSuperpowersCatalogSourceV1({
        baseline: superpowersBaselineCatalogV1(),
        sourceSnapshot: { ...superpowersSnapshot, owner: "different-owner" },
      }),
    ).toThrow("does not match");
    expect(
      prepareEccCatalogSourceV1({
        baseline: eccBaselineCatalogV1(),
        sourceSnapshot: canonicalEccSnapshot,
      }).assets.find((asset) => asset.vet?.verdict === "blocked")?.vet?.verdict,
    ).toBe("blocked");
    expect(policyAuthoringCurationKind("baseline:rules")).toBeUndefined();
    expect(policyAuthoringCurationKind("baseline:commands")).toBe("command");
    expect(policyAuthoringCurationKind("module:commands-core")).toBe("command");
  });

  it("keeps the Superpowers public entry transitively free of ECC implementation", () => {
    const sources = [
      ...sourceClosure(resolve("src/org-policy/catalog-providers/superpowers.ts")),
    ].map((path) => path.replaceAll("\\", "/"));
    expect(sources).not.toContainEqual(expect.stringMatching(/(?:^|\/)ecc(?:\/|\.ts$)/u));
    expect(sources).not.toContainEqual(expect.stringMatching(/baseline-evidence\/catalogs\.ts$/u));
  });
});
