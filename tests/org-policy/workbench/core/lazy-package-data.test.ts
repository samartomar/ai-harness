import { expect, it, vi } from "vitest";

const catalogLoader = vi.hoisted(() => vi.fn());
vi.mock("../../../../src/catalog-package/authoring-bundle.js", () => ({
  loadCatalogAuthoringBundleV1: catalogLoader,
}));

it("does not read Catalog package data until the package-data getter is called", async () => {
  const sourceRecords = [{ bytes: "{}", sha256: "a".repeat(64) }];
  catalogLoader.mockReturnValue({ sourceRecords });
  const { packagedWorkbenchSourceDataInputV1 } = await import(
    "../../../../src/org-policy/workbench/core/packaged-source-data-data.js"
  );
  expect(catalogLoader).not.toHaveBeenCalled();
  expect(packagedWorkbenchSourceDataInputV1()).toEqual(sourceRecords);
  expect(catalogLoader).toHaveBeenCalledOnce();
});
