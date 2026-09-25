import { canonicalStrictJsonSha256V1 } from "../../../contract/strict-json-v1.js";
import {
  authoringCatalogDigestV1,
  verifyAuthoringCatalogBundleIntegrityV1,
} from "../catalog-integrity.js";
import { rejectTrustedCompilerEvidence } from "../compiler-input.js";
import { actionForCompilerDeclarationV1 } from "../compilers/formats.js";
import {
  type AuthoringCatalogBundleV1,
  assembleAuthoringAssetV1,
  parseAuthoringCatalogBundleV1,
} from "../contracts.js";
import { compileOrganizationManifestAssemblyInputV1 } from "./organization-compiler.js";
import {
  consumeFreshOrganizationPreparationV1,
  type FreshOrganizationPreparationV1,
} from "./organization-preparation.js";

export { compileOrganizationManifestAssemblyInputV1 } from "./organization-compiler.js";

function mergeRecord<T>(
  label: string,
  baseline: Readonly<Record<string, T>>,
  additions: readonly Readonly<Record<string, T>>[],
): Record<string, T> {
  const merged = structuredClone(baseline) as Record<string, T>;
  for (const addition of additions) {
    for (const [id, value] of Object.entries(addition)) {
      if (merged[id] !== undefined) throw new TypeError(`duplicate organization ${label} ${id}`);
      merged[id] = structuredClone(value);
    }
  }
  return merged;
}

/** Add only organization-authored declarations to Catalog's admitted baseline. */
export function extendCatalogBundleWithOrganizationInputsV1(
  baseline: AuthoringCatalogBundleV1,
  manifests: readonly string[],
  preparations: readonly FreshOrganizationPreparationV1[],
): AuthoringCatalogBundleV1 {
  const ordinary = manifests.map(compileOrganizationManifestAssemblyInputV1);
  rejectTrustedCompilerEvidence(ordinary);
  const witnessed = preparations.map((preparation) => {
    const input = consumeFreshOrganizationPreparationV1(preparation);
    if (input === undefined)
      throw new TypeError("fresh organization preparation custody is unavailable");
    return input;
  });
  const inputs = [...ordinary, ...witnessed];
  if (inputs.length === 0) return structuredClone(baseline);
  const declarations = inputs.flatMap((input) => input.declarations);
  const assets = { ...structuredClone(baseline.assets) };
  for (const { declaration, inputFormat } of declarations) {
    if (assets[declaration.id] !== undefined)
      throw new TypeError(`duplicate organization asset ${declaration.id}`);
    assets[declaration.id] = assembleAuthoringAssetV1(declaration, [
      {
        assetId: declaration.id,
        sourceId: declaration.sourceId,
        sourceRevisionId: declaration.sourceRevisionId,
        contentDigest: declaration.contentDigest,
        action: actionForCompilerDeclarationV1(inputFormat, declaration.kind),
        supportedTargets: [],
      },
    ]);
  }
  const relations = [
    ...structuredClone(baseline.relations),
    ...inputs.flatMap((input) => structuredClone(input.relations ?? [])),
  ];
  const relationKeys = new Set<string>();
  for (const relation of relations) {
    const key = `${relation.fromAssetId}\u0000${relation.toAssetId}`;
    if (relationKeys.has(key)) throw new TypeError("duplicate organization relation");
    relationKeys.add(key);
  }
  const detailChunks = { ...structuredClone(baseline.detailChunks) };
  for (const input of inputs) {
    for (const [id, bytes] of Object.entries(input.detailBytes)) {
      if (detailChunks[id] !== undefined)
        throw new TypeError(`duplicate organization detail ${id}`);
      detailChunks[id] = { bytes, digest: authoringCatalogDigestV1(bytes) };
    }
  }
  const withoutProvenance = {
    version: baseline.version,
    sources: mergeRecord(
      "source",
      baseline.sources,
      inputs.map((input) => input.sources),
    ),
    assets,
    groups: mergeRecord(
      "group",
      baseline.groups,
      inputs.map((input) => input.groups ?? {}),
    ),
    relations,
    templates: mergeRecord(
      "template",
      baseline.templates,
      inputs.map((input) => input.templates ?? {}),
    ),
    evidence: mergeRecord(
      "evidence",
      baseline.evidence,
      inputs.map((input) => input.evidence ?? {}),
    ),
    // Optional in the bundle schema: a Catalog without summaries carries no key.
    ...(baseline.qualifications === undefined
      ? {}
      : { qualifications: structuredClone(baseline.qualifications) }),
    detailChunks,
  };
  const bundle = parseAuthoringCatalogBundleV1({
    ...withoutProvenance,
    provenance: {
      bundleDigest: `sha256:${canonicalStrictJsonSha256V1({
        ...withoutProvenance,
        provenance: {},
      })}`,
    },
  });
  verifyAuthoringCatalogBundleIntegrityV1(bundle);
  return bundle;
}
