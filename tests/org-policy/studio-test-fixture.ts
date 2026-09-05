import { canonicalStrictJsonSha256V1 } from "../../src/contract/strict-json-v1.js";
import { type PolicyStudioModel, policyStudioModel } from "../../src/org-policy/studio-model.js";
import { verifyAuthoringCatalogBundleIntegrityV1 } from "../../src/org-policy/workbench/catalog-bundle.js";
import { defaultPreparedWorkbenchCatalog } from "../../src/org-policy/workbench/prepared-catalog.js";

/**
 * Keeps generic Workbench UI tests independent of the production catalog size.
 * Source-specific inventory and selector tests retain their production fixtures.
 */
function createTinyStudioModelPrototype(): PolicyStudioModel {
  const model = structuredClone(policyStudioModel());
  const legacyCatalog = defaultPreparedWorkbenchCatalog().catalog;
  const preparedAssetId = (label: string, predicate: (id: string) => boolean): string => {
    const id = Object.keys(model.workbenchBundle.assets).find(predicate);
    if (id === undefined) throw new Error(`expected prepared Workbench ${label} asset`);
    return id;
  };
  const assetIds = [
    preparedAssetId(
      "control",
      (id) =>
        model.workbenchBundle.assets[id]?.authoring.action === "select-control" &&
        model.workbenchBindings[id]?.kind === "control",
    ),
    preparedAssetId(
      "request",
      (id) => model.workbenchBundle.assets[id]?.authoring.action === "record-request",
    ),
    preparedAssetId(
      "external selection",
      (id) =>
        model.workbenchBundle.assets[id]?.authoring.action === "record-selection" &&
        model.workbenchBindings[id]?.kind === "external-selection",
    ),
  ];
  const assets = Object.fromEntries(
    assetIds.map((id) => {
      const asset = model.workbenchBundle.assets[id];
      if (asset === undefined) throw new Error(`expected prepared Workbench asset: ${id}`);
      return [id, asset];
    }),
  );
  const sourceIds = new Set(Object.values(assets).map((asset) => asset.sourceId));
  const sources = Object.fromEntries(
    [...sourceIds].map((id) => {
      const source = model.workbenchBundle.sources[id];
      if (source === undefined) throw new Error(`expected prepared Workbench source: ${id}`);
      return [id, source];
    }),
  );
  const detailChunks = Object.fromEntries(
    Object.values(assets).map((asset) => {
      const detailChunk = model.workbenchBundle.detailChunks[asset.detailChunkId];
      if (detailChunk === undefined)
        throw new Error(`expected prepared Workbench detail chunk: ${asset.detailChunkId}`);
      return [asset.detailChunkId, detailChunk];
    }),
  );
  const groups = Object.fromEntries(
    Object.values(model.workbenchBundle.groups).flatMap((group) => {
      const retainedAssetIds = group.assetIds.filter((id) => assets[id] !== undefined);
      return retainedAssetIds.length === 0
        ? []
        : [[group.id, { ...group, assetIds: retainedAssetIds }]];
    }),
  );

  model.catalog = {
    ...model.catalog,
    externalMcp: legacyCatalog.externalMcp.slice(0, 1),
    frameworks: legacyCatalog.frameworks
      .slice(0, 2)
      .map(({ id, repository, commit }) => ({ id, repository, commit })),
  };
  model.workbenchBundle = {
    ...model.workbenchBundle,
    sources,
    assets,
    groups,
    relations: [],
    templates: {},
    evidence: {},
    detailChunks,
  };
  model.workbenchBundle = {
    ...model.workbenchBundle,
    provenance: {
      bundleDigest: `sha256:${canonicalStrictJsonSha256V1({ ...model.workbenchBundle, provenance: {} })}`,
    },
  };
  verifyAuthoringCatalogBundleIntegrityV1(model.workbenchBundle);
  model.workbenchBindings = Object.fromEntries(
    assetIds.map((id) => {
      const binding = model.workbenchBindings[id];
      if (binding === undefined) throw new Error(`expected Workbench binding: ${id}`);
      return [id, binding];
    }),
  );
  return model;
}

// Build and verify once before handing callers independent mutable clones.
const verifiedTinyStudioModelPrototype = createTinyStudioModelPrototype();

export function tinyStudioModel(): PolicyStudioModel {
  return structuredClone(verifiedTinyStudioModelPrototype);
}

export function tinyEnterpriseStudioModel(): PolicyStudioModel {
  const model = tinyStudioModel();
  const governance = model.initialPolicy.governance;
  if (governance === undefined) throw new Error("expected default studio governance");
  model.initialPolicy.minimumPosture = "enterprise";
  governance.supportedClis = ["codex"];
  return model;
}
