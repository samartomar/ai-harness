import { canonicalStrictJsonSha256V1 } from "../../../contract/strict-json-v1.js";
import type { AuthoringCatalogBundleV1 } from "../contracts.js";

const COMPOSITION_PROFILES = [
  {
    profileAssetId: "ecc/profile:methodology",
    sourceId: "source:ecc",
    templateId: "template:ecc/methodology",
    methodologyKey: "ecc",
  },
  {
    profileAssetId: "superpowers/profile:methodology",
    sourceId: "source:superpowers",
    templateId: "template:superpowers/methodology",
    methodologyKey: "superpowers",
  },
  {
    profileAssetId: "ponytail/profile:methodology",
    sourceId: "source:ponytail",
    templateId: "template:ponytail/methodology",
    methodologyKey: "ponytail",
  },
] as const;

type ProfileSpec = (typeof COMPOSITION_PROFILES)[number];
type CompositionProof =
  | Readonly<{ state: "valid"; integrityDigest: string; constituentAssetIds: readonly string[] }>
  | Readonly<{ state: "invalid" }>;
type CompositionPayload = Readonly<{
  bundle: AuthoringCatalogBundleV1;
  proofs: Readonly<Record<string, CompositionProof>>;
}>;

/** Opaque release-only object. Structural lookalikes have no readiness authority. */
export interface WorkbenchEvidenceCompositionsV1 {
  readonly kind: "workbench-evidence-compositions/v1";
}

const compositionPayloads = new WeakMap<object, CompositionPayload>();

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function profileClosureRelations(
  profileAssetId: string,
  constituentIds: ReadonlySet<string>,
  relations: AuthoringCatalogBundleV1["relations"],
): AuthoringCatalogBundleV1["relations"] | undefined {
  if (relations.some((relation) => relation.toAssetId === profileAssetId)) return undefined;
  const known = new Set([profileAssetId]);
  const selected: AuthoringCatalogBundleV1["relations"] = [];
  const queue = [profileAssetId];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;
    for (const relation of relations) {
      if (relation.fromAssetId !== current || relation.kind === "conflicts") continue;
      if (!constituentIds.has(relation.toAssetId)) return undefined;
      selected.push(relation);
      if (!known.has(relation.toAssetId)) {
        known.add(relation.toAssetId);
        queue.push(relation.toAssetId);
      }
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const relation of selected)
      if (relation.fromAssetId === id && visit(relation.toAssetId)) return true;
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  if (visit(profileAssetId)) return undefined;
  return selected.sort((left, right) =>
    compare(
      `${left.fromAssetId}\u0000${left.toAssetId}\u0000${left.kind}`,
      `${right.fromAssetId}\u0000${right.toAssetId}\u0000${right.kind}`,
    ),
  );
}
function proofFor(bundle: AuthoringCatalogBundleV1, spec: ProfileSpec): CompositionProof {
  try {
    const profile = bundle.assets[spec.profileAssetId];
    const source = bundle.sources[spec.sourceId];
    const template = bundle.templates[spec.templateId];
    if (
      profile === undefined ||
      source === undefined ||
      template === undefined ||
      profile.sourceId !== spec.sourceId ||
      profile.sourceRevisionId !== source.revision.id ||
      profile.derivation !== "core-derived" ||
      profile.kind !== "profile" ||
      profile.exclusiveSlot !== "methodology" ||
      profile.methodologyKey !== spec.methodologyKey ||
      template.roots.length !== 1 ||
      template.roots[0]?.assetId !== profile.id ||
      template.roots[0]?.mode !== "select" ||
      template.roots[0]?.includeOptionalMembers !== false ||
      template.exclusions.length !== 0
    )
      return { state: "invalid" };
    const profileDetail = bundle.detailChunks[profile.detailChunkId];
    if (profileDetail === undefined) return { state: "invalid" };
    const constituents = Object.values(bundle.assets)
      .filter((asset) => asset.sourceId === spec.sourceId && asset.derivation === "upstream")
      .sort((left, right) => compare(left.id, right.id));
    if (
      constituents.length === 0 ||
      constituents.some(
        (asset) =>
          asset.sourceRevisionId !== source.revision.id ||
          bundle.detailChunks[asset.detailChunkId] === undefined,
      )
    )
      return { state: "invalid" };
    const relations = profileClosureRelations(
      profile.id,
      new Set(constituents.map((asset) => asset.id)),
      bundle.relations,
    );
    if (relations === undefined) return { state: "invalid" };
    const integrityDigest = `sha256:${canonicalStrictJsonSha256V1({
      domain: "aih.workbench.core-derived-evidence-composition/v1",
      source: {
        id: source.id,
        revision: source.revision,
        compiler: source.compiler,
        inputFormat: source.inputFormat,
      },
      profile: {
        asset: profile,
        detailDigest: profileDetail.digest,
      },
      template,
      constituents: constituents.map((asset) => {
        const detail = bundle.detailChunks[asset.detailChunkId];
        if (detail === undefined) throw new Error("missing constituent detail");
        return {
          assetId: asset.id,
          sourceId: asset.sourceId,
          sourceRevisionId: asset.sourceRevisionId,
          contentDigest: asset.contentDigest,
          detailDigest: detail.digest,
        };
      }),
      relations,
    })}`;
    return {
      state: "valid",
      integrityDigest,
      constituentAssetIds: constituents.map((asset) => asset.id),
    };
  } catch {
    return { state: "invalid" };
  }
}

/** Builds code-owned structural proofs for the release inspection entry point only. */
export function prepareWorkbenchEvidenceCompositionsForReleaseV1(
  bundle: AuthoringCatalogBundleV1,
): WorkbenchEvidenceCompositionsV1 {
  const result: WorkbenchEvidenceCompositionsV1 = Object.freeze({
    kind: "workbench-evidence-compositions/v1",
  });
  compositionPayloads.set(
    result,
    Object.freeze({
      bundle,
      proofs: Object.freeze(
        Object.fromEntries(
          COMPOSITION_PROFILES.map((spec) => [spec.profileAssetId, proofFor(bundle, spec)]),
        ),
      ),
    }),
  );
  return result;
}

export type WorkbenchEvidenceCompositionResolutionV1 =
  | Readonly<{ state: "missing" }>
  | Readonly<{ state: "invalid" }>
  | Readonly<{ state: "valid"; constituentAssetIds: readonly string[] }>;

/** Resolves only the opaque composition produced for this exact in-memory release bundle. */
export function resolveWorkbenchEvidenceCompositionV1(
  bundle: AuthoringCatalogBundleV1,
  compositions: WorkbenchEvidenceCompositionsV1 | undefined,
  assetId: string,
): WorkbenchEvidenceCompositionResolutionV1 | undefined {
  const spec = COMPOSITION_PROFILES.find((candidate) => candidate.profileAssetId === assetId);
  if (spec === undefined) return undefined;
  if (compositions === undefined) return { state: "missing" };
  const payload = compositionPayloads.get(compositions);
  if (payload === undefined || payload.bundle !== bundle) return { state: "missing" };
  const original = payload.proofs[assetId];
  const current = proofFor(bundle, spec);
  if (
    original === undefined ||
    original.state !== "valid" ||
    current.state !== "valid" ||
    original.integrityDigest !== current.integrityDigest ||
    original.constituentAssetIds.length !== current.constituentAssetIds.length ||
    original.constituentAssetIds.some((id, index) => id !== current.constituentAssetIds[index])
  )
    return { state: "invalid" };
  return { state: "valid", constituentAssetIds: [...current.constituentAssetIds] };
}
