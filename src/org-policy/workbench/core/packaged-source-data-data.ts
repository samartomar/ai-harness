import { loadCatalogAuthoringBundleV1 } from "../../../catalog-package/authoring-bundle.js";

/** Package input is loaded on demand; consumers retain all existing seal and schema checks. */
export function packagedWorkbenchSourceDataInputV1(): readonly Readonly<{
  bytes: string;
  sha256: string;
}>[] {
  return loadCatalogAuthoringBundleV1().sourceRecords;
}
