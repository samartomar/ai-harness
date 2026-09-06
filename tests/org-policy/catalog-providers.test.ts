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
        sourceSnapshot: eccSnapshot,
      }),
    ).toEqual(frameworks.get("ecc"));
    expect(
      prepareSuperpowersCatalogSourceV1({
        baseline: superpowersBaselineCatalogV1(),
        sourceSnapshot: superpowersSnapshot,
      }),
    ).toEqual(frameworks.get("superpowers"));
  });

  it("rejects a mismatched source identity or pin and preserves vendor vet verdicts", () => {
    expect(() =>
      prepareEccCatalogSourceV1({
        baseline: eccBaselineCatalogV1(),
        sourceSnapshot: { ...eccSnapshot, id: "superpowers" },
      }),
    ).toThrow("does not match");
    expect(() =>
      prepareSuperpowersCatalogSourceV1({
        baseline: superpowersBaselineCatalogV1(),
        sourceSnapshot: { ...superpowersSnapshot, pinnedSha: "0".repeat(40) },
      }),
    ).toThrow("does not match");
    expect(
      prepareEccCatalogSourceV1({
        baseline: eccBaselineCatalogV1(),
        sourceSnapshot: eccSnapshot,
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
