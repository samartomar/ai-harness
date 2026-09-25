import { loadFrameworkDescriptorV1 } from "../catalog-package/framework-descriptors.js";
import { AihError } from "../errors.js";
import type { BaselineCatalog, BaselineCatalogComponent } from "./catalog.js";
import { defineBaselineCatalog } from "./catalog.js";
import { componentContainsSkillContentV1 } from "./skill-content.js";

export const BASELINE_CATALOG_IDS = ["ecc", "superpowers"] as const;
export type BaselineCatalogId = (typeof BASELINE_CATALOG_IDS)[number];
const admittedCatalogs = new Map<string, Readonly<BaselineCatalog>>();

/** Why a framework descriptor cannot state an exact declared definition for a pin. */
export type DeclaredFrameworkCatalogRefusalReasonV1 = "missing-definition" | "malformed-definition";

/**
 * A framework descriptor whose `componentDefinitions` section does not state the pinned
 * definition exactly: a missing field, a different pin, or an entry that cannot be read as
 * a component. Core refuses instead of substituting another section's component list.
 */
export class DeclaredFrameworkCatalogRefusalError extends AihError {
  readonly reason: DeclaredFrameworkCatalogRefusalReasonV1;

  constructor(reason: DeclaredFrameworkCatalogRefusalReasonV1, detail: string) {
    super(`Catalog declared framework definition: ${detail}`, "AIH_CATALOG_DECLARED_DEFINITION");
    this.reason = reason;
  }
}

interface DeclaredAssetV1 {
  readonly id: string;
  readonly kind: string;
  readonly sourcePaths: readonly string[];
}

const DECLARED_PIN_V1 = /^[0-9a-f]{40}$/;
const DECLARED_REPOSITORY_V1 = /^([^/]+)\/([^/]+)$/;
const SKILL_ID_PREFIX_V1 = "skill:";

/** The installed Catalog carries one layout per framework, bound to its own pin; the policy never rebinds it. */
function refuseUncarriedPin(id: BaselineCatalogId, carried: string, pin: string): never {
  throw new AihError(
    `Catalog ${id} carries pin ${carried}; it does not carry requested pin ${pin}`,
    "AIH_TRUST",
  );
}

function refuseDeclared(reason: DeclaredFrameworkCatalogRefusalReasonV1, detail: string): never {
  throw new DeclaredFrameworkCatalogRefusalError(reason, detail);
}

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * `componentDefinitions.framework.assets` as the descriptor states it: every asset declares
 * the upstream repository, commit and primary path it is authored at, plus the material it
 * covers (`sourcePaths`).
 */
function declaredFrameworkAssetsV1(
  id: BaselineCatalogId,
  section: unknown,
): {
  readonly repository: string;
  readonly commit: string;
  readonly assets: readonly DeclaredAssetV1[];
} {
  const framework = recordOf(recordOf(section)?.framework);
  if (framework === undefined)
    refuseDeclared("missing-definition", `Catalog ${id} carries no componentDefinitions.framework`);
  const {
    assets,
    commit,
    id: declaredId,
    repository,
  } = framework as {
    assets?: unknown;
    commit?: unknown;
    id?: unknown;
    repository?: unknown;
  };
  if (
    typeof declaredId !== "string" ||
    typeof repository !== "string" ||
    typeof commit !== "string" ||
    !Array.isArray(assets) ||
    assets.length === 0
  )
    refuseDeclared(
      "malformed-definition",
      `Catalog ${id} componentDefinitions.framework is malformed`,
    );
  if (declaredId !== id)
    refuseDeclared(
      "malformed-definition",
      `Catalog ${id} componentDefinitions.framework names ${JSON.stringify(declaredId)}`,
    );
  if (!DECLARED_PIN_V1.test(commit))
    refuseDeclared(
      "malformed-definition",
      `Catalog ${id} componentDefinitions.framework pins ${JSON.stringify(commit)}`,
    );
  const declared: DeclaredAssetV1[] = [];
  for (const [index, entry] of assets.entries()) {
    const asset = recordOf(entry) as Partial<DeclaredAssetV1> | undefined;
    if (
      asset === undefined ||
      typeof asset.id !== "string" ||
      asset.id.length === 0 ||
      typeof asset.kind !== "string" ||
      !Array.isArray(asset.sourcePaths) ||
      asset.sourcePaths.length === 0 ||
      asset.sourcePaths.some((path) => typeof path !== "string" || path.length === 0)
    )
      refuseDeclared(
        "malformed-definition",
        `Catalog ${id} componentDefinitions asset ${index} is malformed`,
      );
    declared.push({ id: asset.id, kind: asset.kind, sourcePaths: asset.sourcePaths });
  }
  return { repository, commit, assets: declared };
}

/**
 * The MCP names the descriptor declares as source-locked inventory options rather than
 * components of the pin. Catalog's compiler appends one `mcp:<name>` asset per ECC-owned
 * entry of `mcp-configs/mcp-servers.json` (`externalEccMcpAssets`) so an administrator can
 * see them, and refuses to build when such an id duplicates a pinned component — so a name
 * in this set can never be a component of the definition. The `mcpInventory` and
 * `aihOwnedMcpExclusions` sections decide it; a descriptor that carries an inventory without
 * the exclusion list cannot be read exactly and is refused.
 */
function inventoryOptionNamesV1(
  id: BaselineCatalogId,
  sections: Readonly<Record<string, unknown>>,
): ReadonlySet<string> {
  const inventory = sections.mcpInventory;
  if (inventory === undefined) return new Set();
  const servers = recordOf(recordOf(inventory)?.mcpServers);
  if (servers === undefined)
    refuseDeclared("malformed-definition", `Catalog ${id} mcpInventory.mcpServers is malformed`);
  const owned = sections.aihOwnedMcpExclusions;
  if (!Array.isArray(owned) || owned.some((name) => typeof name !== "string"))
    refuseDeclared(
      "missing-definition",
      `Catalog ${id} declares an MCP inventory without aihOwnedMcpExclusions`,
    );
  const aihOwned = new Set(owned as readonly string[]);
  return new Set(Object.keys(servers).filter((name) => !aihOwned.has(name)));
}

/**
 * The definition paths a declared asset names. Catalog's compiler adapter derives
 * `sourcePaths` from the component by adding two selection aliases
 * (`policyAuthoringSelectionSourcePathsV1`): `rules` for `baseline:rules`, and
 * `skills/<name>/SKILL.md` for `skill:<name>`. Each alias is removed only when the same
 * asset also declares the path that covers it, so a definition that declares no more than
 * the alias keeps it — the conversion never invents a shorter definition.
 */
function declaredComponentPathsV1(asset: DeclaredAssetV1): string[] {
  const paths = [...asset.sourcePaths];
  if (asset.id === "baseline:rules" && paths.some((path) => path.startsWith("rules/")))
    return paths.filter((path) => path !== "rules");
  if (asset.id.startsWith(SKILL_ID_PREFIX_V1)) {
    const directory = `skills/${asset.id.slice(SKILL_ID_PREFIX_V1.length)}`;
    if (paths.includes(directory)) return paths.filter((path) => path !== `${directory}/SKILL.md`);
  }
  return paths;
}

export interface DeclaredFrameworkCatalogOptionsV1 {
  /**
   * The checkout at the pin. It decides `skillContent` for components whose declared paths
   * name a container or host directory rather than skill material (`componentContainsSkillContentV1`).
   * Omitted by callers that need no checkout; those components then keep the flag unset,
   * because the declared section alone cannot show what a directory contains.
   */
  readonly sourceRoot?: string;
}

/**
 * The DECLARED definition of one framework pin (decision D79): the accepted descriptor's
 * `componentDefinitions` section, and nothing else. This is the definition authority for a
 * pin the installed Catalog carries — not `vendorLock`, which is the component list of an
 * evidence lock produced for whatever definition was current when that evidence was sealed.
 *
 * The conversion is exact, and every step of it is an inversion of how Catalog's compiler
 * states a definition as assets (verified against K1's ECC descriptor: the result has the
 * identity `sha256:8c476a370769a9d15601cc2c1fcdc2d879ce4e04224d2f5536a3fe0e5ea6f5b3` of the
 * P'' definition `evidence/EI1/def/ecc.json`):
 *
 * - `id`, `owner`, `repo`, `pinnedSha` are the descriptor's `framework.id`, the two halves of
 *   `framework.repository` and `framework.commit`;
 * - a component is one declared asset, in declared order, except the source-locked MCP
 *   inventory options (`inventoryOptionNamesV1`);
 * - its `paths` are the declared `sourcePaths` without the selection aliases above
 *   (`declaredComponentPathsV1`), in declared order;
 * - `skillContent` is the decision Core's analyzer profile makes for that component at the
 *   pin (`componentContainsSkillContentV1`).
 *
 * Anything the section cannot state exactly — a missing section or field, another
 * framework id or repository shape, a malformed asset, or a pin other than the requested
 * one — refuses with `DeclaredFrameworkCatalogRefusalError`. There is no fallback to another
 * descriptor section.
 */
export function declaredFrameworkCatalogV1(
  id: BaselineCatalogId,
  sections: Readonly<Record<string, unknown>>,
  options: DeclaredFrameworkCatalogOptionsV1 = {},
): BaselineCatalog {
  const framework = declaredFrameworkAssetsV1(id, sections.componentDefinitions);
  const repository = DECLARED_REPOSITORY_V1.exec(framework.repository);
  const owner = repository?.[1];
  const repo = repository?.[2];
  if (owner === undefined || repo === undefined)
    refuseDeclared(
      "malformed-definition",
      `Catalog ${id} componentDefinitions.framework.repository is ${JSON.stringify(framework.repository)}`,
    );
  const optionNames = inventoryOptionNamesV1(id, sections);
  const components: BaselineCatalogComponent[] = framework.assets.flatMap((asset) => {
    if (asset.kind === "mcp" && optionNames.has(asset.id.slice("mcp:".length))) return [];
    const paths = declaredComponentPathsV1(asset);
    const component: BaselineCatalogComponent = { id: asset.id, paths };
    if (componentContainsSkillContentV1(component, options.sourceRoot))
      return [{ ...component, skillContent: true as const }];
    return [component];
  });
  try {
    return defineBaselineCatalog({
      id,
      owner,
      repo,
      pinnedSha: framework.commit,
      components,
    });
  } catch (error) {
    return refuseDeclared(
      "malformed-definition",
      `Catalog ${id} declared components are malformed (${error instanceof Error ? error.message : error})`,
    );
  }
}

function catalogFromDescriptor(
  id: BaselineCatalogId,
  pin?: string,
  options: DeclaredFrameworkCatalogOptionsV1 = {},
): BaselineCatalog {
  const key = options.sourceRoot === undefined ? id : `${id}\u0000${options.sourceRoot}`;
  const admitted = admittedCatalogs.get(key);
  if (admitted !== undefined) {
    if (pin !== undefined && pin !== admitted.pinnedSha)
      refuseUncarriedPin(id, admitted.pinnedSha, pin);
    return structuredClone(admitted);
  }
  const catalog = declaredFrameworkCatalogV1(id, loadFrameworkDescriptorV1(id).sections, options);
  if (pin !== undefined && pin !== catalog.pinnedSha)
    refuseUncarriedPin(id, catalog.pinnedSha, pin);
  admittedCatalogs.set(key, catalog);
  return structuredClone(catalog);
}

/** Compatibility facade for callers that still select a source by id. */
export function baselineCatalogById(
  id: string,
  pin?: string,
  options: DeclaredFrameworkCatalogOptionsV1 = {},
): BaselineCatalog {
  if (id === "ecc" || id === "superpowers") return catalogFromDescriptor(id, pin, options);
  throw new Error(
    `unknown baseline catalog ${JSON.stringify(id)}; expected ${BASELINE_CATALOG_IDS.join("|")}`,
  );
}
