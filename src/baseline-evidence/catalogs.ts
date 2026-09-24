import { loadFrameworkDescriptorSectionV1 } from "../catalog-package/framework-descriptors.js";
import { AihError } from "../errors.js";
import type { BaselineCatalog } from "./catalog.js";
import { defineBaselineCatalog } from "./catalog.js";

export const BASELINE_CATALOG_IDS = ["ecc", "superpowers"] as const;
export type BaselineCatalogId = (typeof BASELINE_CATALOG_IDS)[number];
const admittedCatalogs = new Map<BaselineCatalogId, Readonly<BaselineCatalog>>();

interface FrameworkDefinitionsV1 {
  readonly framework: {
    readonly id: string;
    readonly repository: string;
    readonly commit: string;
    readonly assets: readonly {
      readonly id: string;
      readonly curationKind?: string;
      readonly sourcePaths: readonly string[];
    }[];
  };
}

/** The installed Catalog carries one layout per framework, bound to its own pin; the policy never rebinds it. */
function refuseUncarriedPin(id: BaselineCatalogId, carried: string, pin: string): never {
  throw new AihError(
    `Catalog ${id} carries pin ${carried}; it does not carry requested pin ${pin}`,
    "AIH_TRUST",
  );
}

function catalogFromDescriptor(id: BaselineCatalogId, pin?: string): BaselineCatalog {
  const admitted = admittedCatalogs.get(id);
  if (admitted !== undefined) {
    if (pin !== undefined && pin !== admitted.pinnedSha)
      refuseUncarriedPin(id, admitted.pinnedSha, pin);
    return structuredClone(admitted);
  }
  const { framework } = loadFrameworkDescriptorSectionV1<FrameworkDefinitionsV1>(
    id,
    "componentDefinitions",
  );
  const vendor = loadFrameworkDescriptorSectionV1<{
    owner: string;
    repo: string;
    pinnedSha: string;
    components: readonly {
      id: string;
      paths: readonly string[];
      analyzers?: readonly { name: string }[];
    }[];
  }>(id, "vendorLock");
  const repository = /^([^/]+)\/([^/]+)$/.exec(framework.repository);
  if (framework.id !== id || repository === null) {
    throw new TypeError(`Catalog ${id} framework definitions are malformed`);
  }
  if (pin !== undefined && pin !== vendor.pinnedSha) refuseUncarriedPin(id, vendor.pinnedSha, pin);
  const catalog = defineBaselineCatalog({
    id,
    owner: vendor.owner,
    repo: vendor.repo,
    pinnedSha: vendor.pinnedSha,
    components: vendor.components.map((component) => ({
      id: component.id,
      paths: [...component.paths],
      ...(component.analyzers?.some((analyzer) => analyzer.name === "cisco@uvx") === true ||
      component.id.startsWith("skill:") ||
      component.paths.some((path) => path === "skills" || path.includes("/skills/"))
        ? { skillContent: true as const }
        : {}),
    })),
  });
  admittedCatalogs.set(id, catalog);
  return structuredClone(catalog);
}

/** Compatibility facade for callers that still select a source by id. */
export function baselineCatalogById(id: string, pin?: string): BaselineCatalog {
  if (id === "ecc" || id === "superpowers") return catalogFromDescriptor(id, pin);
  throw new Error(
    `unknown baseline catalog ${JSON.stringify(id)}; expected ${BASELINE_CATALOG_IDS.join("|")}`,
  );
}
