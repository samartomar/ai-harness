import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { loadCatalogAuthoringBundleV1 } from "../../src/catalog-package/authoring-bundle.js";
import type { CatalogPackageAccessV1 } from "../../src/catalog-package/load-catalog-package.js";
import { canonicalStrictJsonBytesV1 } from "../../src/contract/strict-json-v1.js";

const requireFromTest = createRequire(import.meta.url);
const installedDocument = JSON.parse(
  readFileSync(requireFromTest.resolve("@aihq/catalog/catalog-authoring-bundle.json"), "utf8"),
) as Record<string, unknown>;

function fixture(document: unknown): CatalogPackageAccessV1 {
  const bytes = Buffer.concat([canonicalStrictJsonBytesV1(document), Buffer.from("\n")]);
  return {
    importPackage: () => Promise.resolve({}),
    resolve: (specifier) =>
      specifier.endsWith("package.json")
        ? "C:/fixture/package.json"
        : "C:/fixture/catalog-authoring-bundle-v1.json",
    readFile: (path) =>
      path.endsWith("package.json") ? Buffer.from('{"version":"0.3.0"}') : bytes,
  };
}

describe("loadCatalogAuthoringBundleV1", () => {
  it("admits the exact Catalog authority into a detached prepared snapshot", () => {
    const result = loadCatalogAuthoringBundleV1(fixture(installedDocument));
    expect(result.catalogVersion).toBe("0.3.0");
    expect(result.prepared.bundle).toEqual(
      (installedDocument.prepared as Record<string, unknown>).bundle,
    );
    expect(result.prepared).not.toBe(installedDocument.prepared);
  });

  it("ignores Catalog-supplied bindings and derives them from admitted declarations", () => {
    const changed = structuredClone(installedDocument) as {
      prepared: {
        bindings: Record<string, { external?: { item?: { source?: { path?: string } } } }>;
      };
    };
    const admitted = loadCatalogAuthoringBundleV1(fixture(changed));
    const binding = structuredClone(admitted.prepared.bindings["ecc/mcp:supabase"]);
    if (binding?.external?.item?.source === undefined)
      throw new Error("missing derived test binding");
    binding.external.item.source.path = "mcp-configs/changed.json";
    changed.prepared.bindings["ecc/mcp:supabase"] = binding;
    const result = loadCatalogAuthoringBundleV1(fixture(changed));
    expect(result.prepared.bindings["ecc/mcp:supabase"]?.external?.item.source.path).not.toBe(
      "mcp-configs/changed.json",
    );
  });

  it("refuses changed authority even when the carrier remains canonical", () => {
    const changed = structuredClone(installedDocument) as {
      prepared: {
        catalog: { frameworks: Array<{ assets: Array<{ source: { path: string } }> }> };
      };
    };
    const framework = changed.prepared.catalog.frameworks[0];
    const asset = framework?.assets[0];
    if (asset === undefined) throw new Error("missing Catalog authority fixture asset");
    asset.source.path = "changed";
    expect(() => loadCatalogAuthoringBundleV1(fixture(changed))).toThrow(
      /unaccepted authority sha256/,
    );
  });

  it("refuses malformed carrier bytes as incompatible", () => {
    expect(() =>
      loadCatalogAuthoringBundleV1(
        fixture({ format: "wrong", version: 1, prepared: {}, sourceRecords: [], production: {} }),
      ),
    ).toThrow(/catalog-package-incompatible/);
  });
});
