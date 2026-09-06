import type { BaselineCatalog } from "./catalog.js";
import { eccBaselineCatalogV1 } from "./catalog-providers/ecc.js";
import { superpowersBaselineCatalogV1 } from "./catalog-providers/superpowers.js";

export const BASELINE_CATALOG_IDS = ["ecc", "superpowers"] as const;
export type BaselineCatalogId = (typeof BASELINE_CATALOG_IDS)[number];

/** Compatibility facade for callers that still select a source by id. */
export function baselineCatalogById(id: string, pin?: string): BaselineCatalog {
  if (id === "ecc") return eccBaselineCatalogV1(pin);
  if (id === "superpowers") return superpowersBaselineCatalogV1(pin);
  throw new Error(
    `unknown baseline catalog ${JSON.stringify(id)}; expected ${BASELINE_CATALOG_IDS.join("|")}`,
  );
}
