import { loadFrameworkDescriptorSectionV1 } from "../catalog-package/framework-descriptors.js";
import { AihError } from "../errors.js";
import type { BaselineCatalog, BaselineCatalogComponent } from "./catalog.js";
import { defineBaselineCatalog } from "./catalog.js";
import { checkoutHeadV1, committedTreePathsV1 } from "./committed-checkout.js";
import {
  committedSkillDirectoriesV1,
  componentContainsCommittedSkillContentV1,
} from "./skill-content.js";

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

/**
 * Why a framework descriptor cannot state an exact declared definition for a pin, as a
 * stable machine reason on {@link DeclaredFrameworkCatalogRefusalError}:
 *
 * - `source-root-required` — no checkout at the declared pin was supplied, and the declared
 *   section alone cannot show what a directory contains;
 * - `checkout-not-at-pin` — the checkout's HEAD is not the declared commit;
 * - `committed-tree-unavailable` — the checkout does not carry the declared commit's tree;
 * - `missing-definition` — no `componentDefinitions` section, or no declared framework/assets;
 * - `unsupported-version` — a section version that is not `pinned-baseline/v1`;
 * - `unknown-asset-kind` — an asset kind outside the Catalog's asset vocabulary;
 * - `unknown-field` — a field the conversion does not read, at section, framework, asset or
 *   asset-source level;
 * - `missing-asset-source` — an asset without the `source` it is authored at;
 * - `asset-source-mismatch` — an asset whose source repository or commit is not the
 *   framework's own pin;
 * - `malformed-definition` — a present field with the wrong shape or value (framework id,
 *   repository, commit, asset id, paths).
 */
export type DeclaredFrameworkCatalogRefusalReasonV1 =
  | "source-root-required"
  | "checkout-not-at-pin"
  | "committed-tree-unavailable"
  | "missing-definition"
  | "unsupported-version"
  | "unknown-asset-kind"
  | "unknown-field"
  | "missing-asset-source"
  | "asset-source-mismatch"
  | "malformed-definition";

/**
 * A framework descriptor whose `componentDefinitions` section does not state the pinned
 * definition exactly: a missing field, another pin, a field Core does not read, or an entry
 * that cannot be read as a component. Core refuses instead of substituting another section's
 * component list.
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
/** The only `componentDefinitions` shape Core reads exactly. */
const DECLARED_SECTION_VERSION_V1 = "pinned-baseline/v1";
const DECLARED_SECTION_FIELDS_V1 = ["framework", "version"] as const;
const DECLARED_FRAMEWORK_FIELDS_V1 = ["assets", "commit", "id", "repository"] as const;
/**
 * The fields Catalog's compiler states an asset with. `curationKind`, `members`,
 * `dependencies`, `metadata` and `riders` are compiler bookkeeping the conversion does not
 * read; anything else is a field Core cannot account for and is refused.
 */
const DECLARED_ASSET_FIELDS_V1 = [
  "curationKind",
  "dependencies",
  "id",
  "kind",
  "members",
  "metadata",
  "riders",
  "source",
  "sourcePaths",
] as const;
const DECLARED_ASSET_SOURCE_FIELDS_V1 = ["commit", "path", "repository"] as const;
/** The asset kinds Catalog's compiler emits anywhere in its asset inventory. */
const DECLARED_ASSET_KINDS_V1: ReadonlySet<string> = new Set([
  "agent",
  "baseline",
  "capability",
  "framework",
  "hook",
  "lang",
  "mcp",
  "module",
  "profile",
  "runtime",
  "skill",
]);

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

/** The names of the fields a record carries that the conversion does not read, sorted. */
function unknownFieldsV1(value: Record<string, unknown>, known: readonly string[]): string {
  const admitted = new Set<string>(known);
  return Object.keys(value)
    .filter((key) => !admitted.has(key))
    .sort()
    .join(", ");
}

/**
 * `componentDefinitions` as the descriptor states it: the section version, and a framework
 * whose every asset declares the upstream repository, commit and primary path it is authored
 * at plus the material it covers (`sourcePaths`). Read strictly: an unknown field at any
 * level, a version Core does not know, an asset kind outside Catalog's vocabulary, an asset
 * with no source or one authored at another repository or commit, and a malformed field all
 * refuse with a stable reason instead of being normalized. The checks run in that order —
 * section, framework, then each asset — so a hostile declaration always yields the reason of
 * the outermost thing it got wrong.
 */
function declaredFrameworkAssetsV1(
  id: BaselineCatalogId,
  section: unknown,
): {
  readonly owner: string;
  readonly repo: string;
  readonly commit: string;
  readonly assets: readonly DeclaredAssetV1[];
} {
  const definitions = recordOf(section);
  if (definitions === undefined)
    refuseDeclared("missing-definition", `Catalog ${id} carries no componentDefinitions section`);
  const sectionUnknown = unknownFieldsV1(definitions, DECLARED_SECTION_FIELDS_V1);
  if (sectionUnknown.length > 0)
    refuseDeclared(
      "unknown-field",
      `Catalog ${id} componentDefinitions carries unknown field(s) ${sectionUnknown}`,
    );
  const { version } = definitions;
  if (typeof version !== "string")
    refuseDeclared(
      "malformed-definition",
      `Catalog ${id} componentDefinitions.version is ${JSON.stringify(version)}`,
    );
  if (version !== DECLARED_SECTION_VERSION_V1)
    refuseDeclared(
      "unsupported-version",
      `Catalog ${id} componentDefinitions.version is ${JSON.stringify(version)}; expected ${DECLARED_SECTION_VERSION_V1}`,
    );
  const framework = recordOf(definitions.framework);
  if (framework === undefined)
    refuseDeclared("missing-definition", `Catalog ${id} carries no componentDefinitions.framework`);
  const frameworkUnknown = unknownFieldsV1(framework, DECLARED_FRAMEWORK_FIELDS_V1);
  if (frameworkUnknown.length > 0)
    refuseDeclared(
      "unknown-field",
      `Catalog ${id} componentDefinitions.framework carries unknown field(s) ${frameworkUnknown}`,
    );
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
  const split = DECLARED_REPOSITORY_V1.exec(repository);
  if (split?.[1] === undefined || split[2] === undefined)
    refuseDeclared(
      "malformed-definition",
      `Catalog ${id} componentDefinitions.framework.repository is ${JSON.stringify(repository)}`,
    );
  if (!DECLARED_PIN_V1.test(commit))
    refuseDeclared(
      "malformed-definition",
      `Catalog ${id} componentDefinitions.framework pins ${JSON.stringify(commit)}`,
    );
  const declared: DeclaredAssetV1[] = [];
  for (const [index, entry] of assets.entries()) {
    const asset = recordOf(entry);
    if (asset === undefined || typeof asset.id !== "string" || asset.id.length === 0)
      refuseDeclared(
        "malformed-definition",
        `Catalog ${id} componentDefinitions asset ${index} is malformed`,
      );
    const assetUnknown = unknownFieldsV1(asset, DECLARED_ASSET_FIELDS_V1);
    if (assetUnknown.length > 0)
      refuseDeclared(
        "unknown-field",
        `Catalog ${id} componentDefinitions asset ${asset.id} carries unknown field(s) ${assetUnknown}`,
      );
    const { kind, source, sourcePaths } = asset as {
      kind?: unknown;
      source?: unknown;
      sourcePaths?: unknown;
    };
    if (typeof kind !== "string")
      refuseDeclared(
        "malformed-definition",
        `Catalog ${id} componentDefinitions asset ${asset.id} has no kind`,
      );
    if (!DECLARED_ASSET_KINDS_V1.has(kind))
      refuseDeclared(
        "unknown-asset-kind",
        `Catalog ${id} componentDefinitions asset ${asset.id} has kind ${JSON.stringify(kind)}`,
      );
    const authored = recordOf(source);
    if (authored === undefined)
      refuseDeclared(
        "missing-asset-source",
        `Catalog ${id} componentDefinitions asset ${asset.id} declares no source`,
      );
    const sourceUnknown = unknownFieldsV1(authored, DECLARED_ASSET_SOURCE_FIELDS_V1);
    if (sourceUnknown.length > 0)
      refuseDeclared(
        "unknown-field",
        `Catalog ${id} componentDefinitions asset ${asset.id} source carries unknown field(s) ${sourceUnknown}`,
      );
    const {
      commit: assetCommit,
      path: assetPath,
      repository: assetRepository,
    } = authored as { commit?: unknown; path?: unknown; repository?: unknown };
    if (
      typeof assetRepository !== "string" ||
      typeof assetCommit !== "string" ||
      typeof assetPath !== "string" ||
      assetPath.length === 0
    )
      refuseDeclared(
        "missing-asset-source",
        `Catalog ${id} componentDefinitions asset ${asset.id} source is not a repository, commit and path`,
      );
    if (assetRepository !== repository || assetCommit !== commit)
      refuseDeclared(
        "asset-source-mismatch",
        `Catalog ${id} componentDefinitions asset ${asset.id} is authored at ${assetRepository}@${assetCommit}, not ${repository}@${commit}`,
      );
    if (
      !Array.isArray(sourcePaths) ||
      sourcePaths.length === 0 ||
      sourcePaths.some((path) => typeof path !== "string" || path.length === 0)
    )
      refuseDeclared(
        "malformed-definition",
        `Catalog ${id} componentDefinitions asset ${asset.id} sourcePaths are malformed`,
      );
    declared.push({ id: asset.id, kind, sourcePaths: sourcePaths as readonly string[] });
  }
  return { owner: split[1], repo: split[2], commit, assets: declared };
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
   * The checkout at the declared pin. `skillContent` is decided from the PINNED COMMIT's tree
   * in this checkout's own object store, never from the working tree, so an untracked or
   * modified file cannot change the carried definition. There is no checkout-free form of a
   * declared catalog: the section alone cannot show what a directory contains.
   */
  readonly sourceRoot: string;
}

/**
 * The declared commit's own tree, read from the checkout's object store. The checkout's HEAD
 * must already be that commit: the material that decides `skillContent` is committed material,
 * and a checkout somewhere else cannot state it. Fails closed, never falls back to the
 * working tree.
 */
function committedTreeAtPinV1(
  id: BaselineCatalogId,
  sourceRoot: string,
  commit: string,
): readonly string[] {
  let head: string;
  try {
    head = checkoutHeadV1(sourceRoot);
  } catch (error) {
    return refuseDeclared(
      "committed-tree-unavailable",
      `Catalog ${id} cannot read the checkout at ${sourceRoot} (${error instanceof Error ? error.message : error})`,
    );
  }
  if (head !== commit)
    refuseDeclared(
      "checkout-not-at-pin",
      `Catalog ${id} declares pin ${commit}; the checkout at ${sourceRoot} is at ${head}`,
    );
  try {
    return committedTreePathsV1(sourceRoot, commit);
  } catch (error) {
    return refuseDeclared(
      "committed-tree-unavailable",
      `Catalog ${id} cannot read commit ${commit} at ${sourceRoot} (${error instanceof Error ? error.message : error})`,
    );
  }
}

/**
 * The pin the declared definition states for one framework: the whole declaration is
 * validated strictly (section, framework and every asset), but no checkout is read. The
 * definition resolver uses it to decide whether the installed Catalog carries a supplied
 * definition's pin at all — an uncarried pin keeps today's route and never needs the checkout
 * that decides `skillContent`.
 */
export function declaredFrameworkCatalogPinV1(
  id: BaselineCatalogId,
  sections: Readonly<Record<string, unknown>>,
): string {
  return declaredFrameworkAssetsV1(id, sections.componentDefinitions).commit;
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
 * - `skillContent` is decided from the DECLARED PIN's own tree in the checkout's object store
 *   (`componentContainsCommittedSkillContentV1`), never from the working tree.
 *
 * Anything the section cannot state exactly — a missing section or field, another
 * framework id or repository shape, a malformed asset, an unknown field or asset kind, or an
 * asset authored at another repository or commit — refuses with
 * `DeclaredFrameworkCatalogRefusalError`. There is no fallback to another descriptor section.
 */
export function declaredFrameworkCatalogV1(
  id: BaselineCatalogId,
  sections: Readonly<Record<string, unknown>>,
  options: DeclaredFrameworkCatalogOptionsV1,
): BaselineCatalog {
  const sourceRoot = options?.sourceRoot;
  if (typeof sourceRoot !== "string" || sourceRoot.length === 0)
    refuseDeclared(
      "source-root-required",
      `Catalog ${id} declared definition needs the checkout at its pin to decide skillContent`,
    );
  const framework = declaredFrameworkAssetsV1(id, sections.componentDefinitions);
  const committedSkillDirectories = committedSkillDirectoriesV1(
    committedTreeAtPinV1(id, sourceRoot, framework.commit),
  );
  const optionNames = inventoryOptionNamesV1(id, sections);
  const components: BaselineCatalogComponent[] = framework.assets.flatMap((asset) => {
    if (asset.kind === "mcp" && optionNames.has(asset.id.slice("mcp:".length))) return [];
    const paths = declaredComponentPathsV1(asset);
    const component: BaselineCatalogComponent = { id: asset.id, paths };
    if (componentContainsCommittedSkillContentV1(component, committedSkillDirectories))
      return [{ ...component, skillContent: true as const }];
    return [component];
  });
  try {
    return defineBaselineCatalog({
      id,
      owner: framework.owner,
      repo: framework.repo,
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

/**
 * The catalog of the SEALED evidence lock the accepted descriptor carries: the
 * `vendorLock` section's component list. Every evidence consumer joins against this
 * (coverage, installability, package graph, plugin runtime), exactly as before D79 —
 * the lock is the evidence those joins bind to, whatever definition it was sealed for.
 * Only the definition resolver route (`resolveScannerDefinitionV1`) and the Scanner
 * bridge read the DECLARED definition instead ({@link declaredFrameworkCatalogV1}).
 */
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
