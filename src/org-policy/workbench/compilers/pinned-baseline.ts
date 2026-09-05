import { createHash } from "node:crypto";
import { readVendorBaselineLock } from "../../../baseline-evidence/vendor.js";
import { canonicalStrictJsonBytesV1 } from "../../../contract/strict-json-v1.js";
import type { PolicyAuthoringAsset, PolicyAuthoringFramework } from "../../catalog.js";
import type { CompilerAssetDeclarationV1 } from "../contracts.js";
import type { CompiledDeclarationV1 } from "./registry.js";

function digest(bytes: Uint8Array | string): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

type VendorBaselineSourceV1 = ReturnType<typeof readVendorBaselineLock>["sources"][number];
type VendorBaselineComponentV1 = VendorBaselineSourceV1["components"][number];

function sourceContentDigest(
  framework: PolicyAuthoringFramework,
  source: VendorBaselineSourceV1 | undefined,
): string {
  if (source?.sourceTreeSha256 === undefined) {
    throw new Error(`pinned ${framework.id} source has no declared source-tree identity`);
  }
  return `sha256:${source.sourceTreeSha256}`;
}

function assetContentDigest(asset: PolicyAuthoringAsset): string {
  // A vetted component is represented by the immutable tree the scan covered.
  // A file digest can identify a declaration only when no component scan exists.
  const pinnedIdentity = asset.vet?.treeSha256 ?? asset.metadata?.sourceSha256;
  if (pinnedIdentity === undefined) {
    throw new Error(`pinned asset ${asset.id} has no declared content identity`);
  }
  return `sha256:${pinnedIdentity}`;
}

function evidenceComponentsByIdV1(
  source: VendorBaselineSourceV1 | undefined,
): Map<string, VendorBaselineComponentV1> {
  const components = new Map<string, VendorBaselineComponentV1>();
  for (const component of source?.components ?? []) {
    // Array.find() chose the first matching declaration. Preserve that behavior
    // while avoiding a full lock clone and linear scan for every vetted asset.
    if (!components.has(component.id)) components.set(component.id, component);
  }
  return components;
}

function evidenceCoveredPaths(
  asset: PolicyAuthoringAsset,
  componentsById: ReadonlyMap<string, VendorBaselineComponentV1>,
): string[] {
  if (asset.vet === undefined) return [];
  const component = componentsById.get(asset.id);
  if (component === undefined || component.treeSha256 !== asset.vet.treeSha256) {
    throw new Error(`pinned asset ${asset.id} has no matching evidence component`);
  }
  return [...component.paths].sort();
}

export interface CompiledPinnedBaselineV1 {
  source: {
    id: string;
    revisionId: string;
    contentDigest: string;
    frameworkId: string;
    repository: string;
  };
  declarations: CompiledDeclarationV1[];
  relations: Array<{
    fromAssetId: string;
    toAssetId: string;
    kind: "requires" | "member";
    membership?: "required" | "optional";
  }>;
  groups: Record<string, { id: string; label: string; assetIds: string[] }>;
  evidence: Record<string, unknown>;
  detailBytes: Record<string, string>;
}

/** Compile source-locked upstream inventory without fetching, installing, or executing it. */
export function compilePinnedBaselineV1(
  framework: PolicyAuthoringFramework,
): CompiledPinnedBaselineV1 {
  // readVendorBaselineLock() returns a defensive clone. Keep that one exact
  // snapshot for all declaration, evidence, and source-identity lookups.
  const source = readVendorBaselineLock().sources.find(
    (candidate) => candidate.id === framework.id,
  );
  const componentsById = evidenceComponentsByIdV1(source);
  const sourceId = `source:${framework.id}`;
  const detailBytes: Record<string, string> = {};
  const declarations = framework.assets.map((asset): CompiledDeclarationV1 => {
    const id = `${framework.id}/${asset.id}`;
    const detailChunkId = `detail:${id}`;
    detailBytes[detailChunkId] = canonicalStrictJsonBytesV1({
      version: "pinned-baseline-detail/v1",
      asset: {
        id: asset.id,
        kind: asset.kind,
        ...(asset.curationKind === undefined ? {} : { curationKind: asset.curationKind }),
        ...(asset.riders === undefined ? {} : { riders: asset.riders }),
        ...(asset.dependencies === undefined ? {} : { dependencies: asset.dependencies }),
        ...(asset.members === undefined ? {} : { members: asset.members }),
        source: asset.source,
        sourcePaths: asset.sourcePaths,
        ...(asset.metadata === undefined ? {} : { metadata: asset.metadata }),
        ...(asset.vet === undefined ? {} : { vet: asset.vet }),
      },
    }).toString("utf8");
    const declaration: CompilerAssetDeclarationV1 = {
      id,
      sourceId,
      sourceRevisionId: framework.commit,
      contentDigest: assetContentDigest(asset),
      originalPath: asset.source.path,
      derivation: "upstream",
      kind: asset.kind,
      label: asset.metadata?.title ?? asset.id,
      detailChunkId,
      declaredHostCapabilities: [],
    };
    return {
      declaration,
      inputFormat: "pinned-baseline/v1",
    };
  });
  const methodologyId = `${framework.id}/profile:methodology`;
  const methodologyChunkId = `detail:${methodologyId}`;
  const methodologyBytes = canonicalStrictJsonBytesV1({
    version: "methodology-profile-declaration/v1",
    framework: framework.id,
    source: { repository: framework.repository, commit: framework.commit },
  });
  const methodologyDigest = digest(methodologyBytes);
  detailBytes[methodologyChunkId] = canonicalStrictJsonBytesV1({
    version: "pinned-baseline-detail/v1",
    profile: {
      id: "methodology",
      framework: framework.id,
      identity: { kind: "declaration", digest: methodologyDigest },
    },
  }).toString("utf8");
  declarations.push({
    declaration: {
      id: methodologyId,
      sourceId,
      sourceRevisionId: framework.commit,
      contentDigest: methodologyDigest,
      originalPath: "profiles/methodology",
      derivation: "core-derived",
      kind: "profile",
      label: `${framework.id} methodology profile`,
      detailChunkId: methodologyChunkId,
      declaredHostCapabilities: [],
      exclusiveSlot: "methodology",
      methodologyKey: framework.id,
    },
    inputFormat: "pinned-baseline/v1",
  });
  const known = new Set(framework.assets.map((asset) => asset.id));
  const relations = framework.assets.flatMap((asset) => {
    const fromAssetId = `${framework.id}/${asset.id}`;
    const required = [...(asset.dependencies ?? []), ...(asset.riders ?? [])].map((id) => ({
      fromAssetId,
      toAssetId: `${framework.id}/${id}`,
      kind: "requires" as const,
    }));
    const members = (asset.members ?? []).map((id) => ({
      fromAssetId,
      toAssetId: `${framework.id}/${id}`,
      kind: "member" as const,
      membership: "optional" as const,
    }));
    for (const relation of [...required, ...members]) {
      if (!known.has(relation.toAssetId.slice(`${framework.id}/`.length))) {
        throw new Error(`pinned ${framework.id} relation names absent asset ${relation.toAssetId}`);
      }
    }
    return [...required, ...members];
  });
  const groups = Object.fromEntries(
    [...new Set(framework.assets.map((asset) => asset.kind))].sort().map((kind) => {
      const id = `group:${framework.id}/${kind}`;
      return [
        id,
        {
          id,
          label: `${framework.id} ${kind}`,
          assetIds: declarations
            .filter(({ declaration }) => declaration.kind === kind)
            .map(({ declaration }) => declaration.id)
            .sort(),
        },
      ];
    }),
  );
  const evidence = Object.fromEntries(
    framework.assets.flatMap((asset) => {
      if (asset.vet === undefined) return [];
      const assetId = `${framework.id}/${asset.id}`;
      const coveredPaths = evidenceCoveredPaths(asset, componentsById);
      const evidenceBytes = canonicalStrictJsonBytesV1({
        version: "pinned-baseline-evidence/v1",
        source: { repository: framework.repository, commit: framework.commit },
        asset: { id: asset.id, treeSha256: asset.vet.treeSha256, coveredPaths },
        verdict: asset.vet.verdict,
        analyzers: asset.vet.analyzers,
        findings: asset.vet.findings,
      });
      return [
        [
          `evidence:${assetId}`,
          {
            id: `evidence:${assetId}`,
            projectionVersion: "evidence-summary/v1",
            subjects: [
              {
                assetId,
                sourceId,
                sourceRevisionId: framework.commit,
                contentDigest: assetContentDigest(asset),
              },
            ],
            evidenceDigest: digest(evidenceBytes),
            coveredPaths,
            verification: { state: "unverified" },
            scan: {
              outcome: asset.vet.verdict === "pass" ? "pass" : "failed",
              coverage: "complete",
            },
            qualification: { state: "unknown" },
            findings: asset.vet.findings.map((finding) => `${finding.code}: ${finding.detail}`),
          },
        ],
      ];
    }),
  );
  return {
    source: {
      id: sourceId,
      revisionId: framework.commit,
      contentDigest: sourceContentDigest(framework, source),
      frameworkId: framework.id,
      repository: framework.repository,
    },
    declarations,
    relations,
    groups,
    evidence,
    detailBytes,
  };
}
