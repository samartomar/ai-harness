import { loadCatalogCoreMaterialV1 } from "../../../catalog-package/core-materials.js";

/** Package input is loaded on demand; consumers retain all existing seal and schema checks. */
export function catalogQualificationPackageInputV1(): unknown {
  const material = loadCatalogCoreMaterialV1("qualification");
  if (
    material.records === null ||
    typeof material.records !== "object" ||
    Array.isArray(material.records)
  )
    throw new TypeError("Catalog qualification records are malformed");
  return material.records;
}
