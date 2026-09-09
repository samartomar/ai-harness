import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  prepared: vi.fn(),
}));

vi.mock("../../src/org-policy/workbench/prepared-catalog.js", () => ({
  packagedPreparedWorkbenchCatalogV1: mocks.prepared,
  prepareWorkbenchCatalog: mocks.prepared,
}));
vi.mock("../../src/org-policy/workbench/default-catalog-preassembly.js", async (original) => ({
  ...(await original<
    typeof import("../../src/org-policy/workbench/default-catalog-preassembly.js")
  >()),
  // This test exercises the tiny compiler fallback; package admission has its
  // own contract and installed-tarball tests.
  packagedDefaultCatalogPreassemblyCompanionV1: () => undefined,
}));

import * as adoptionRecipe from "../../src/org-policy/adoption-recipe.js";
import { policyStudioModel } from "../../src/org-policy/studio-model.js";
import { tinyStudioModel } from "./studio-test-fixture.js";

describe("policy workbench detached default model", () => {
  beforeEach(() => {
    mocks.prepared.mockClear();
    mocks.prepared.mockImplementation(() => {
      const fixture = tinyStudioModel();
      return {
        catalog: fixture.catalog,
        bundle: fixture.workbenchBundle,
        bindings: fixture.workbenchBindings,
        sourceInputs: fixture.workbenchSourceInputs,
      };
    });
  });

  it("rejects malformed baseline provenance before preparing the catalog", () => {
    expect(() => policyStudioModel(undefined, { schemaVersion: 1 } as never)).toThrow(
      /baseline evidence provenance/,
    );
    expect(mocks.prepared).not.toHaveBeenCalled();
  });

  it("returns a detached default model without rebuilding its prepared catalog", () => {
    const recipe = vi.spyOn(adoptionRecipe, "buildAdoptionRecipe");
    try {
      const first = policyStudioModel();
      const assetId = Object.keys(first.workbenchBundle.assets)[0];
      if (assetId === undefined) throw new Error("expected workbench asset");
      const asset = first.workbenchBundle.assets[assetId];
      if (asset === undefined) throw new Error("expected workbench asset");
      asset.label = "caller mutation";

      expect(policyStudioModel().workbenchBundle.assets[assetId]?.label).not.toBe(
        "caller mutation",
      );
      expect(mocks.prepared).toHaveBeenCalledTimes(1);
      expect(recipe).toHaveBeenCalledTimes(1);
    } finally {
      recipe.mockRestore();
    }
  });
});
