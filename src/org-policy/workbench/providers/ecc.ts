import type { PolicyAuthoringComposition } from "../../catalog-provider-types.js";
import { defineCatalogProviderV1 } from "./contracts.js";
import {
  compilePinnedProviderV1,
  methodologyTemplateV1,
  type PinnedProviderInputV1,
  pinnedProviderFixtureV1,
} from "./pinned.js";
export interface EccProviderInputV1 extends PinnedProviderInputV1 {
  composition: PolicyAuthoringComposition;
}
export const eccCatalogProviderV1 = defineCatalogProviderV1({
  providerId: "ecc",
  providerVersion: "1",
  fixture: (): EccProviderInputV1 => ({
    ...pinnedProviderFixtureV1("ecc"),
    composition: { framework: "ecc", parts: [] },
  }),
  compile(input: EccProviderInputV1) {
    if (input.framework.id !== "ecc") throw new TypeError("ECC provider requires its exact source");
    const templates = input.composition.parts.map((part) => ({
      id: `template:ecc/${part.id}`,
      label: part.label,
      roots: part.componentIds.map((id) => ({
        assetId: `ecc/${id}`,
        mode: "select" as const,
        includeOptionalMembers: false,
      })),
      exclusions: [],
    }));
    return [compilePinnedProviderV1(input, [...templates, methodologyTemplateV1(input.framework)])];
  },
});
