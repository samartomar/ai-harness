import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hashComponentTree, hashSourceTree } from "../../src/baseline-evidence/hash.js";
import { componentIdentityPaths } from "../../src/baseline-evidence/license.js";
import { createCoreBaselineVetRequests } from "../../src/baseline-evidence/scanner-consumer.js";

const scenario = vi.hoisted(() => ({
  catalog: undefined as unknown,
  compiled: undefined as unknown,
  lock: undefined as unknown,
}));

vi.mock("../../src/baseline-evidence/vendor.js", () => ({
  readVendorBaselineLock: () => scenario.lock,
}));
vi.mock("../../src/baseline-evidence/catalog-providers/superpowers.js", () => ({
  superpowersBaselineCatalogV1: () => scenario.catalog,
}));
vi.mock("../../src/org-policy/catalog-providers/superpowers.js", () => ({
  prepareSuperpowersCatalogSourceV1: () => ({ fixture: "framework" }),
}));
vi.mock("../../src/org-policy/workbench/compilers/pinned-baseline.js", () => ({
  compilePinnedBaselineV1: () => scenario.compiled,
}));

import { prepareRegisteredScannerCatalogV1 } from "../../src/baseline-evidence/scanner-provider-catalogs.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("registered baseline coverage identity", () => {
  it("validates the lock with inherited license material but preserves the raw Scanner request tree", () => {
    const root = mkdtempSync(join(tmpdir(), "aih-registered-coverage-"));
    roots.push(root);
    writeFileSync(join(root, "LICENSE"), "legal material");
    writeFileSync(join(root, "component.txt"), "component material");
    const paths = ["component.txt"];
    const raw = hashComponentTree(root, paths);
    const vetted = hashComponentTree(root, componentIdentityPaths(root, paths));
    expect(vetted.treeSha256).not.toBe(raw.treeSha256);
    const catalog = {
      id: "superpowers",
      owner: "obra",
      repo: "Superpowers",
      pinnedSha: "a".repeat(40),
      components: [{ id: "runtime:test", paths }],
    };
    scenario.catalog = catalog;
    scenario.compiled = {
      source: {
        id: "source:superpowers",
        revisionId: catalog.pinnedSha,
        contentDigest: `sha256:${"b".repeat(64)}`,
      },
      declarations: [
        {
          declaration: {
            id: "superpowers/runtime:test",
            sourceId: "source:superpowers",
            sourceRevisionId: catalog.pinnedSha,
            contentDigest: `sha256:${"c".repeat(64)}`,
            derivation: "upstream",
          },
        },
      ],
    };
    scenario.lock = {
      sources: [
        {
          id: "superpowers",
          owner: catalog.owner,
          repo: catalog.repo,
          pinnedSha: catalog.pinnedSha,
          sourceTreeSha256: hashSourceTree(root).treeSha256,
          components: [{ id: "runtime:test", paths, treeSha256: vetted.treeSha256 }],
        },
      ],
    };

    const prepared = prepareRegisteredScannerCatalogV1(root, "superpowers");
    const coverage = prepared.coverage?.components[0];
    if (coverage === undefined) throw new Error("missing registered coverage");
    const request = createCoreBaselineVetRequests(root, prepared.catalog)[0]!;
    expect(coverage.componentTreeSha256).toBe(raw.treeSha256);
    expect(coverage.files.map((file) => file.path)).toEqual(["component.txt"]);
    expect(request.components[0]!.treeSha256).toBe(raw.treeSha256);
  });
});
