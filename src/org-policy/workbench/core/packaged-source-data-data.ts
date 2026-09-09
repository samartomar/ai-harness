import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/** Package input is loaded on demand; consumers retain all existing seal and schema checks. */
export function packagedWorkbenchSourceDataInputV1(): readonly Readonly<{
  bytes: string;
  sha256: string;
}>[] {
  return require("./packaged-source-data-data.json");
}
