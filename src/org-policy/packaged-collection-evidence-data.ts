import { loadCatalogCoreMaterialV1 } from "../catalog-package/core-materials.js";

/** Package input is loaded on demand; consumers retain all existing seal and schema checks. */
export function packagedScannerCollectionEvidenceInputV1(): readonly Readonly<{
  bytes: string;
  sha256: string;
}>[] {
  const material = loadCatalogCoreMaterialV1("scanner");
  if (!Array.isArray(material.records))
    throw new TypeError("Catalog scanner evidence records are malformed");
  return material.records as readonly Readonly<{ bytes: string; sha256: string }>[];
}
