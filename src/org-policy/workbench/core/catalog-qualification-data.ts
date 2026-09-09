import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** Package input is loaded on demand; consumers retain all existing seal and schema checks. */
export function catalogQualificationPackageInputV1(): unknown {
  return require("./catalog-qualification-data.json");
}
