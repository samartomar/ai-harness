import { canonicalStrictJsonSha256V1 } from "../src/contract/strict-json-v1.js";
import { type PolicyStudioModel, policyStudioModel } from "../src/org-policy/studio-model.js";
import { verifyAuthoringCatalogBundleIntegrityV1 } from "../src/org-policy/workbench/catalog-bundle.js";
import {
  type AuthoringCatalogBundleV1,
  parseAuthoringCatalogBundleV1,
} from "../src/org-policy/workbench/contracts.js";

let compactJourneyPrototype: PolicyStudioModel | undefined;

function requiredAsset(
  model: PolicyStudioModel,
  label: string,
  predicate: (asset: AuthoringCatalogBundleV1["assets"][string]) => boolean,
): AuthoringCatalogBundleV1["assets"][string] {
  const matches = Object.values(model.workbenchBundle.assets)
    .filter(predicate)
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  const asset = matches[0];
  if (asset === undefined) throw new Error(`missing compact journey ${label} asset`);
  return asset;
}

function uniqueRequiredAsset(
  model: PolicyStudioModel,
  label: string,
  predicate: (asset: AuthoringCatalogBundleV1["assets"][string]) => boolean,
): AuthoringCatalogBundleV1["assets"][string] {
  const matches = Object.values(model.workbenchBundle.assets).filter(predicate);
  if (matches.length !== 1)
    throw new Error(`expected exactly one compact journey ${label} asset, found ${matches.length}`);
  const asset = matches[0];
  if (asset === undefined) throw new Error(`missing compact journey ${label} asset`);
  return asset;
}
function hasOutgoingRelation(bundle: AuthoringCatalogBundleV1, assetId: string): boolean {
  return bundle.relations.some((relation) => relation.fromAssetId === assetId);
}

function requiredClosure(
  bundle: AuthoringCatalogBundleV1,
  roots: readonly string[],
): Set<string> {
  const retained = new Set(roots);
  const pending = [...roots];
  while (pending.length > 0) {
    const assetId = pending.shift();
    if (assetId === undefined) continue;
    for (const relation of bundle.relations) {
      if (
        relation.fromAssetId !== assetId ||
        (relation.kind !== "requires" && relation.membership !== "required") ||
        retained.has(relation.toAssetId)
      )
        continue;
      retained.add(relation.toAssetId);
      pending.push(relation.toAssetId);
    }
  }
  return retained;
}

function compactJourneyModel(): PolicyStudioModel {
  const model = policyStudioModel();
  const bundle = model.workbenchBundle;
  const context7 = uniqueRequiredAsset(
    model,
    "context7 request",
    (asset) =>
      asset.authoring.action === "record-request" &&
      model.workbenchBindings[asset.id]?.legacyRequestId === "context7",
  );
  const control = requiredAsset(
    model,
    "codex control",
    (asset) =>
      asset.authoring.action === "select-control" &&
      model.workbenchBindings[asset.id]?.candidate?.targets.includes("codex") === true,
  );
  const eccSkill = requiredAsset(
    model,
    "ECC additive skill without relation closure",
    (asset) =>
      asset.sourceId === "source:ecc" &&
      asset.kind === "skill" &&
      asset.authoring.action === "record-selection" &&
      asset.exclusiveSlot === undefined &&
      !hasOutgoingRelation(bundle, asset.id),
  );
  const superpowersSkill = requiredAsset(
    model,
    "Superpowers additive skill without relation closure",
    (asset) =>
      asset.sourceId === "source:superpowers" &&
      asset.kind === "skill" &&
      asset.authoring.action === "record-selection" &&
      asset.exclusiveSlot === undefined &&
      !hasOutgoingRelation(bundle, asset.id),
  );

  const retainedAssetIds = requiredClosure(bundle, [
    context7.id,
    control.id,
    eccSkill.id,
    superpowersSkill.id,
  ]);
  const assets = Object.fromEntries(
    [...retainedAssetIds].sort().map((assetId) => {
      const asset = bundle.assets[assetId];
      if (asset === undefined) throw new Error(`missing compact journey closure asset: ${assetId}`);
      return [assetId, asset];
    }),
  );
  const sourceIds = new Set(Object.values(assets).map((asset) => asset.sourceId));
  const sources = Object.fromEntries(
    [...sourceIds].sort().map((sourceId) => {
      const source = bundle.sources[sourceId];
      if (source === undefined) throw new Error(`missing compact journey source: ${sourceId}`);
      return [sourceId, source];
    }),
  );
  const detailChunks = Object.fromEntries(
    Object.values(assets).map((asset) => {
      const chunk = bundle.detailChunks[asset.detailChunkId];
      if (chunk === undefined)
        throw new Error(`missing compact journey detail chunk: ${asset.detailChunkId}`);
      return [asset.detailChunkId, chunk];
    }),
  );
  const groups = Object.fromEntries(
    Object.values(bundle.groups).flatMap((group) => {
      const assetIds = group.assetIds.filter((assetId) => assets[assetId] !== undefined);
      return assetIds.length === 0 ? [] : [[group.id, { ...group, assetIds }]];
    }),
  );
  const templates = Object.fromEntries(
    Object.entries(bundle.templates).filter(
      ([, template]) =>
        template.roots.every((root) => assets[root.assetId] !== undefined) &&
        template.exclusions.every((assetId) => assets[assetId] !== undefined),
    ),
  );
  const evidence = Object.fromEntries(
    Object.entries(bundle.evidence).filter(([, summary]) =>
      summary.subjects.every((subject) => assets[subject.assetId] !== undefined),
    ),
  );
  const compactBundle = {
    version: bundle.version,
    sources,
    assets,
    groups,
    relations: bundle.relations.filter(
      (relation) =>
        assets[relation.fromAssetId] !== undefined && assets[relation.toAssetId] !== undefined,
    ),
    templates,
    evidence,
    provenance: { bundleDigest: "" },
    detailChunks,
  };
  compactBundle.provenance.bundleDigest = `sha256:${canonicalStrictJsonSha256V1({
    ...compactBundle,
    provenance: {},
  })}`;
  const parsedBundle = parseAuthoringCatalogBundleV1(compactBundle);
  verifyAuthoringCatalogBundleIntegrityV1(parsedBundle);

  model.workbenchBundle = parsedBundle;
  model.workbenchBindings = Object.fromEntries(
    Object.keys(assets).sort().map((assetId) => {
      const binding = model.workbenchBindings[assetId];
      if (binding === undefined) throw new Error(`missing compact journey binding: ${assetId}`);
      return [assetId, binding];
    }),
  );
  model.workbenchSourceInputs = Object.fromEntries(
    [...sourceIds].sort().flatMap((sourceId) => {
      const sourceInput = model.workbenchSourceInputs[sourceId];
      return sourceInput === undefined ? [] : [[sourceId, sourceInput]];
    }),
  );
  return model;
}

/**
 * Compact production-derived fixture for browser journeys that require actual
 * legacy bridge bindings without parsing the full baseline artifact.
 */
export function compactJourneyWorkbenchModel(): PolicyStudioModel {
  compactJourneyPrototype ??= compactJourneyModel();
  return structuredClone(compactJourneyPrototype);
}