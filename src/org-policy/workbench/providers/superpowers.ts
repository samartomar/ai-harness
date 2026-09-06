import { defineCatalogProviderV1 } from "./contracts.js";
import {
  compilePinnedProviderV1,
  methodologyTemplateV1,
  type PinnedProviderInputV1,
  pinnedProviderFixtureV1,
} from "./pinned.js";
export const superpowersCatalogProviderV1 = defineCatalogProviderV1({
  providerId: "superpowers",
  providerVersion: "1",
  fixture: () => pinnedProviderFixtureV1("superpowers"),
  compile(input: PinnedProviderInputV1) {
    if (input.framework.id !== "superpowers")
      throw new TypeError("Superpowers provider requires its exact source");
    return [compilePinnedProviderV1(input, [methodologyTemplateV1(input.framework)])];
  },
});
