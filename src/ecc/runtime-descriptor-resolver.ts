import { type BaselineCatalog, defineBaselineCatalog } from "../baseline-evidence/catalog.js";
import type { BaselineEvidenceLock } from "../baseline-evidence/schema.js";
import { canonicalStrictJsonSha256V1 } from "../contract/strict-json-v1.js";
import { packagedEccRuntimeDescriptorsV1 } from "../org-policy/workbench/core/packaged-source-data.js";
import {
  historicalEccRuntimeDescriptorsFromSourceDataV1,
  workbenchSourceDataRootV1,
} from "../org-policy/workbench/core/source-data.js";
import {
  assertHistoricalEccAdapterCompatibilityV1,
  type EccRuntimeAdapterCompatibilityV1,
} from "./runtime-adapter-compatibility.js";
import {
  assertEccRuntimeDescriptorCustodyV1,
  type EccRuntimeDescriptorV1,
} from "./runtime-descriptor.js";
import { deriveEccRuntimeDeclaredEvaluationV1 } from "./runtime-descriptor-evaluation.js";

/**
 * The policy shape needed to select an exact historical ECC source tuple.
 * Runtime resolution accepts no raw descriptor or evidence object from callers.
 */
export interface HistoricalEccRuntimePolicyV1 {
  readonly governance?: {
    readonly externalSelections?: readonly {
      readonly framework: string;
      readonly items: readonly {
        readonly source: { readonly repository: string; readonly commit: string };
      }[];
    }[];
  };
  /** Effective-policy callers carry selections at the top level. */
  readonly externalSelections?: readonly {
    readonly framework: string;
    readonly items: readonly {
      readonly source: { readonly repository: string; readonly commit: string };
    }[];
  }[];
}

/** Stable provider contract; evidence creation remains outside this resolver. */
export interface HistoricalEccRuntimeDescriptorContextV1 {
  readonly source: Readonly<{
    repository: string;
    commit: string;
    treeSha256: string;
    compilerInputDigest: string;
  }>;
  /** Canonical hash of the complete sealed descriptor retained by Core. */
  readonly descriptorSha256: string;
  readonly catalog: BaselineCatalog;
  readonly evidence: Readonly<{
    vendorLock: BaselineEvidenceLock;
    vendorLockSha256: string;
    expiresAt: string;
    /** Original authenticated Scanner report, never a display projection. */
    rawReport: EccRuntimeDescriptorV1["evidence"]["rawReport"];
    rawReportDigest: string;
    /** Original attestation custody facts; not a current report deadline. */
    custodyPublications: readonly Readonly<{
      publicationSha256: string;
      requestSha256: string;
      receiptSha256: string;
      reportSignedAt: string;
      reportVerificationExpiresAt: string;
      attestedAt: string;
    }>[];
    mappings: readonly Readonly<{ componentId: string; rawComponentIds: readonly string[] }>[];
    coreDerivedEvaluationDigest: string;
    projectionContractDigest: string;
  }>;
  readonly relations: Readonly<{
    mandatoryRequirementsById: ReadonlyMap<string, readonly string[]>;
    declarationRidersById: ReadonlyMap<string, readonly string[]>;
    moduleMembersById: ReadonlyMap<
      string,
      readonly Readonly<{ id: string; membership: "required" | "optional" }>[]
    >;
  }>;
  readonly componentPathsById: ReadonlyMap<string, readonly string[]>;
  readonly adapterCompatibility: EccRuntimeAdapterCompatibilityV1;
}

function fail(): never {
  throw new TypeError("Historical ECC runtime descriptor is unavailable or inconsistent");
}

function selectedEccSource(policy: HistoricalEccRuntimePolicyV1): {
  repository: string;
  commit: string;
} {
  const selections = policy.governance?.externalSelections ?? policy.externalSelections;
  if (selections === undefined) fail();
  const sources = new Map<string, { repository: string; commit: string }>();
  for (const selection of selections) {
    if (selection.framework !== "ecc") continue;
    for (const item of selection.items) {
      const source = item.source;
      if (
        !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(source.repository) ||
        !/^[a-f0-9]{40}$/.test(source.commit)
      )
        fail();
      sources.set(`${source.repository}\0${source.commit}`, source);
    }
  }
  if (sources.size !== 1) fail();
  const selected = sources.values().next().value;
  if (selected === undefined) fail();
  return selected;
}

function relationMap(
  relations: readonly { readonly from: string; readonly to: string }[],
): ReadonlyMap<string, readonly string[]> {
  const values = new Map<string, string[]>();
  for (const relation of relations) {
    const next = values.get(relation.from) ?? [];
    next.push(relation.to);
    values.set(relation.from, next);
  }
  return new Map(
    [...values.entries()].map(([id, targets]) => [id, Object.freeze([...targets].sort())]),
  );
}

function contextForDescriptor(
  descriptor: EccRuntimeDescriptorV1,
): HistoricalEccRuntimeDescriptorContextV1 {
  const [owner, repo] = descriptor.source.repository.split("/");
  if (owner === undefined || repo === undefined) fail();
  const evaluation = deriveEccRuntimeDeclaredEvaluationV1({
    rawReport: descriptor.evidence.rawReport,
    mappings: descriptor.evidence.mappings,
    components: descriptor.components.map((component) => ({
      id: component.id,
      paths: component.paths,
      identityTreeSha256: component.identityTreeSha256,
    })),
  });
  if (
    evaluation.coreDerivedEvaluationDigest !== descriptor.evidence.coreDerivedEvaluationDigest ||
    evaluation.projectionContractDigest !== descriptor.evidence.projectionContractDigest
  )
    fail();
  // Package/local seals prove the historical contract; this closed Core must
  // still recognize its exact per-file target outcomes before acquisition.
  try {
    assertHistoricalEccAdapterCompatibilityV1(
      descriptor.adapterCompatibility as EccRuntimeAdapterCompatibilityV1,
      descriptor.components,
    );
  } catch {
    fail();
  }
  const catalog = defineBaselineCatalog({
    id: "ecc",
    owner,
    repo,
    pinnedSha: descriptor.source.commit,
    components: descriptor.components.map((component) => ({
      id: component.id,
      paths: component.paths,
      ...(component.kind === "skill" ? { skillContent: true as const } : {}),
    })),
  });
  const members = new Map<
    string,
    Readonly<{ id: string; membership: "required" | "optional" }>[]
  >();
  for (const relation of descriptor.relations) {
    if (relation.kind !== "member" || relation.membership === undefined) continue;
    const next = members.get(relation.from) ?? [];
    next.push(Object.freeze({ id: relation.to, membership: relation.membership }));
    members.set(relation.from, next);
  }
  const riderPairs = new Set(
    descriptor.riderRelations.map((relation) => `${relation.from}\0${relation.to}`),
  );
  return Object.freeze({
    source: Object.freeze({
      repository: descriptor.source.repository,
      commit: descriptor.source.commit,
      treeSha256: descriptor.source.treeSha256,
      compilerInputDigest: descriptor.compilerInputDigest,
    }),
    descriptorSha256: `sha256:${canonicalStrictJsonSha256V1(descriptor)}`,
    catalog,
    evidence: Object.freeze({
      vendorLock: evaluation.vendorLock,
      vendorLockSha256: evaluation.coreDerivedEvaluationDigest.slice("sha256:".length),
      expiresAt: descriptor.evidence.validUntil,
      rawReport: descriptor.evidence.rawReport,
      rawReportDigest: descriptor.evidence.rawReportDigest,
      custodyPublications: Object.freeze(
        descriptor.evidence.custodyPublications.map((publication) =>
          Object.freeze({ ...publication }),
        ),
      ),
      mappings: Object.freeze(
        descriptor.evidence.mappings.map((mapping) =>
          Object.freeze({
            componentId: mapping.componentId,
            rawComponentIds: Object.freeze([...mapping.rawComponentIds]),
          }),
        ),
      ),
      coreDerivedEvaluationDigest: descriptor.evidence.coreDerivedEvaluationDigest,
      projectionContractDigest: descriptor.evidence.projectionContractDigest,
    }),
    relations: Object.freeze({
      mandatoryRequirementsById: relationMap(
        descriptor.relations
          // The pinned compiler intentionally merges dependencies and riders
          // into `requires`; the separately sealed template rider relation is
          // the only way to preserve an optional edge. A dependency/rider
          // overlap was removed during preparation and remains mandatory.
          .filter(
            (relation) =>
              relation.kind === "requires" && !riderPairs.has(`${relation.from}\0${relation.to}`),
          )
          .map((relation) => ({ from: relation.from, to: relation.to })),
      ),
      declarationRidersById: relationMap(descriptor.riderRelations),
      moduleMembersById: new Map(
        [...members.entries()].map(([id, values]) => [id, Object.freeze([...values])]),
      ),
    }),
    componentPathsById: new Map(
      descriptor.components.map((component) => [component.id, Object.freeze([...component.paths])]),
    ),
    adapterCompatibility: descriptor.adapterCompatibility as EccRuntimeAdapterCompatibilityV1,
  });
}

/**
 * Reconstructs a historical verifier input only from sealed package data or a
 * machine-local receipt that rebinds the same source-data envelope and trust.
 */
export function resolveHistoricalEccRuntimeDescriptorV1(
  policy: HistoricalEccRuntimePolicyV1,
  options: { now?: string; dataRoot?: string } = {},
): HistoricalEccRuntimeDescriptorContextV1 {
  const now = options.now ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(now))) fail();
  const selected = selectedEccSource(policy);
  const matches = (descriptor: EccRuntimeDescriptorV1) =>
    descriptor.source.repository === selected.repository &&
    descriptor.source.commit === selected.commit;
  // Source-data receipts are an ordered protected local state: active first,
  // then retained history. A matching local fact therefore supersedes a
  // package literal, even if both source tuples are identical. If that local
  // fact is stale or incompatible, fail below rather than falling back.
  const localCandidates = historicalEccRuntimeDescriptorsFromSourceDataV1(
    options.dataRoot ?? workbenchSourceDataRootV1(),
    now,
  ).filter(matches);
  const local = localCandidates[0];
  const descriptor =
    local ??
    (() => {
      const packageCandidates = packagedEccRuntimeDescriptorsV1().filter(matches);
      // Package literals have no active/history order. Exact duplicates are
      // one fact; divergent canonical bytes for the same selected tuple are
      // ambiguous and fail closed.
      const unique = new Map(
        packageCandidates.map((candidate) => [
          `sha256:${canonicalStrictJsonSha256V1(candidate)}`,
          candidate,
        ]),
      );
      if (unique.size !== 1) fail();
      return unique.values().next().value;
    })();
  if (descriptor === undefined || Date.parse(descriptor.evidence.validUntil) <= Date.parse(now))
    fail();
  assertEccRuntimeDescriptorCustodyV1(descriptor, now);
  return contextForDescriptor(descriptor);
}
