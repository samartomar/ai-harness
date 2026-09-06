import type { PolicyAuthoringCatalog } from "../../catalog.js";

import type { PinnedBaselineSourceInputV1 } from "../compilers/pinned-baseline.js";
import { aihCatalogProviderV1 } from "./aih.js";
import { type CatalogProviderCompilationV1, compileCatalogProviderV1 } from "./contracts.js";
import { eccCatalogProviderV1 } from "./ecc.js";
import { getMattPocockPinnedSkillCollectionV1, mattpocockCatalogProviderV1 } from "./mattpocock.js";
import { organizationCatalogProviderV1 } from "./organization.js";
import { ponytailCatalogProviderV1, preparePonytailCatalogProviderV1 } from "./ponytail.js";
import { superpowersCatalogProviderV1 } from "./superpowers.js";
export interface RegisteredCatalogProviderV1 {
  readonly providerId: string;
  readonly providerVersion: string;
  compileFixture(): CatalogProviderCompilationV1;
  prepareBaseline?(
    catalog: PolicyAuthoringCatalog,
    sources: readonly PinnedBaselineSourceInputV1[],
  ): CatalogProviderCompilationV1;
}
function pinnedInput(
  catalog: PolicyAuthoringCatalog,
  sources: readonly PinnedBaselineSourceInputV1[],
  id: "ecc" | "superpowers",
) {
  const framework = catalog.frameworks.find((entry) => entry.id === id);
  const source = sources.find((entry) => entry.id === id);
  if (framework === undefined || source === undefined)
    throw new Error(`missing pinned provider source ${id}`);
  return { framework, source };
}
/** The sole reviewed provider enrollment, with mandatory fixtures and optional package input mapping. */
export const registeredCatalogProvidersV1: readonly RegisteredCatalogProviderV1[] = Object.freeze([
  {
    ...eccCatalogProviderV1,
    prepareBaseline: (catalog, sources) =>
      compileCatalogProviderV1(eccCatalogProviderV1, {
        ...pinnedInput(catalog, sources, "ecc"),
        composition: catalog.enterpriseComposition,
      }),
  },
  {
    ...superpowersCatalogProviderV1,
    prepareBaseline: (catalog, sources) =>
      compileCatalogProviderV1(
        superpowersCatalogProviderV1,
        pinnedInput(catalog, sources, "superpowers"),
      ),
  },
  {
    ...aihCatalogProviderV1,
    prepareBaseline: (catalog) =>
      compileCatalogProviderV1(aihCatalogProviderV1, {
        aihCapabilityPackage: catalog.aihCapabilityPackage,
        aihSkills: catalog.aihSkills,
        aihAgents: catalog.aihAgents,
        mcp: catalog.mcp,
        hooks: catalog.hooks,
        unavailableMcp: catalog.unavailableMcp,
        nonProjectableMcp: catalog.nonProjectableMcp,
      }),
  },
  organizationCatalogProviderV1,
  {
    ...mattpocockCatalogProviderV1,
    prepareBaseline: () =>
      compileCatalogProviderV1(mattpocockCatalogProviderV1, getMattPocockPinnedSkillCollectionV1()),
  },
  {
    ...ponytailCatalogProviderV1,
    prepareBaseline: () => preparePonytailCatalogProviderV1(),
  },
]);
