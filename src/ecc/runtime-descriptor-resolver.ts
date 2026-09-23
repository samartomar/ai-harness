import { createHash } from "node:crypto";
import { type BaselineCatalog, defineBaselineCatalog } from "../baseline-evidence/catalog.js";
import type { BaselineEvidenceLock } from "../baseline-evidence/schema.js";
import {
  CATALOG_PACKAGE_NAME,
  type CatalogPackageAccessV1,
  CatalogPackageRefusalError,
  loadCatalogPackageV1,
} from "../catalog-package/load-catalog-package.js";
import { canonicalStrictJsonSha256V1 } from "../contract/strict-json-v1.js";
import { AihError } from "../errors.js";
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
  inspectEccRuntimeDescriptorSealV1,
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
  /** Where the descriptor bytes came from; see HISTORICAL_ECC_RUNTIME_DESCRIPTOR_RESOLUTION_ORDER_V1. */
  readonly descriptorSource: HistoricalEccRuntimeDescriptorSourceV1;
  /** Every stage consulted, in order, and what it answered. The last one is `selected`. */
  readonly descriptorResolution: readonly HistoricalEccRuntimeDescriptorResolutionStepV1[];
  /** The installed Catalog that carried the bytes; present only for `installed-catalog`. */
  readonly descriptorCarrier?: Readonly<{
    package: typeof CATALOG_PACKAGE_NAME;
    version: string | undefined;
    runtimeDescriptorsFormat: string;
    runtimeDescriptorsVersion: number;
    runtimeDescriptorsDigest: string;
    indexDigest: string;
  }>;
}

/**
 * The order the historical ECC runtime descriptor is resolved in. Each stage is
 * consulted only when every earlier one had no descriptor for the selected
 * source; a stage that HAS one but cannot vouch for it refuses, and nothing
 * later is consulted:
 *
 * 1. `local-source-data` — a machine-local, trust-verified source-data receipt
 *    (active first, then retained history). Unchanged from before.
 * 2. `installed-catalog` — the `./catalog-runtime-descriptors.json` sidecar of
 *    the INSTALLED `@aihq/catalog`, read with Catalog's own
 *    `readCatalogRuntimeDescriptorsV1Result` against Catalog's own index, and
 *    accepted only when the descriptor bytes' sha256 is one Core pins in
 *    `ACCEPTED_CATALOG_ECC_RUNTIME_DESCRIPTORS_V1`. Catalog is the carrier; the
 *    Core pin is the custody. A Catalog that is installed but incompatible,
 *    refuses its sidecar or index, lacks the selected source, reports the bytes
 *    unverified, or carries bytes Core has not pinned is a named refusal.
 *    An absent `@aihq/catalog` is itself a named refusal
 *    (`catalog-package-unavailable`); the copy this Core embeds for other
 *    Workbench consumers is not a resolution fallback.
 *
 * Every descriptor then passes the unchanged seal, schema, source-identity,
 * expiry, custody and adapter-compatibility checks.
 */
export const HISTORICAL_ECC_RUNTIME_DESCRIPTOR_RESOLUTION_ORDER_V1 = Object.freeze([
  "local-source-data",
  "installed-catalog",
] as const);

export type HistoricalEccRuntimeDescriptorSourceV1 =
  (typeof HISTORICAL_ECC_RUNTIME_DESCRIPTOR_RESOLUTION_ORDER_V1)[number];

export type HistoricalEccRuntimeDescriptorResolutionStepV1 = Readonly<{
  stage: HistoricalEccRuntimeDescriptorSourceV1;
  outcome: "selected" | "no-match" | "catalog-package-unavailable";
}>;

/**
 * Core's custody of Catalog-carried descriptors (WO Step 3A decision D1, option
 * (a)): the exact descriptor bytes Core accepts from an installed Catalog, by
 * sha256 over those bytes. These are the bytes this Core also embeds, so the
 * trust basis is unchanged; a new descriptor needs a Core release that pins it.
 */
export const ACCEPTED_CATALOG_ECC_RUNTIME_DESCRIPTORS_V1 = Object.freeze([
  Object.freeze({
    framework: "ecc",
    format: "ecc-runtime-descriptor/v1",
    repository: "affaan-m/ECC",
    commit: "5064474d4d762dc9640234a41617cccb79185cec",
    sha256: "158f63e265f1ca18a7e65c97e372b1259200d6fb60eab87d70c20600d9d9abf0",
  } as const),
]);

export type HistoricalEccRuntimeDescriptorRefusalReasonV1 =
  | "catalog-index-refused"
  | "catalog-runtime-descriptors-refused"
  | "catalog-descriptor-absent"
  | "catalog-descriptor-unverified"
  | "catalog-descriptor-not-accepted";

export interface HistoricalEccRuntimeDescriptorRefusalV1 {
  readonly reason: HistoricalEccRuntimeDescriptorRefusalReasonV1;
  /** One bounded, control-free sentence. */
  readonly detail: string;
  /** The Catalog reader's own refusal or byte-verdict reason, when it gave one. */
  readonly catalogReason?: string;
  /** For Catalog's `unknown-format` / `unknown-version`: the declared value. */
  readonly observed?: string;
}

/** A named refusal from the installed-Catalog stage. Never answered with the embedded copy. */
export class HistoricalEccRuntimeDescriptorRefusalError extends AihError {
  readonly refusal: HistoricalEccRuntimeDescriptorRefusalV1;

  constructor(refusal: HistoricalEccRuntimeDescriptorRefusalV1) {
    super(`${refusal.reason}: ${refusal.detail}`, "AIH_TRUST");
    this.refusal = refusal;
  }
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
): Omit<
  HistoricalEccRuntimeDescriptorContextV1,
  "descriptorSource" | "descriptorResolution" | "descriptorCarrier"
> {
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

/** Refusal text reaches a report, so bound it and keep control characters out. */
function bounded(value: string): string {
  const visible = value.replace(/[\p{C}]/gu, " ").trim();
  return visible.length > 400 ? `${visible.slice(0, 397)}...` : visible;
}

function refuse(refusal: HistoricalEccRuntimeDescriptorRefusalV1): never {
  throw new HistoricalEccRuntimeDescriptorRefusalError({
    ...refusal,
    detail: bounded(refusal.detail),
    ...(refusal.observed === undefined ? {} : { observed: bounded(refusal.observed) }),
  });
}

type InstalledCatalogDescriptorV1 = {
  readonly descriptor: EccRuntimeDescriptorV1;
  readonly carrier: NonNullable<HistoricalEccRuntimeDescriptorContextV1["descriptorCarrier"]>;
};

/**
 * Stage 2 (final): the installed Catalog's runtime-descriptors sidecar,
 * custodied by Core's pin. An absent or unloadable package throws the loader's
 * named `CatalogPackageRefusalError`; index, sidecar and pinned-byte refusals
 * keep their named historical refusal type. Neither falls back to embedded bytes.
 */
async function installedCatalogDescriptor(
  selected: { repository: string; commit: string },
  access: CatalogPackageAccessV1 | undefined,
): Promise<InstalledCatalogDescriptorV1> {
  const loaded = await loadCatalogPackageV1(
    ["readCatalogContentV1Result", "readCatalogRuntimeDescriptorsV1Result"],
    ["./catalog-index.json", "./catalog-runtime-descriptors.json"],
    access,
  );
  if (!loaded.ok) throw new CatalogPackageRefusalError(loaded.refusal);
  const { readCatalogContentV1Result, readCatalogRuntimeDescriptorsV1Result } = loaded.exports;
  const carrier = `the installed ${CATALOG_PACKAGE_NAME}${loaded.version === undefined ? "" : ` ${loaded.version}`}`;
  const index = readCatalogContentV1Result({ bytes: loaded.files["./catalog-index.json"].bytes });
  if (index.state !== "read")
    refuse({
      reason: "catalog-index-refused",
      detail: `${carrier} refused its own catalog index (${index.reason})`,
      catalogReason: index.reason,
      ...(index.observed === undefined ? {} : { observed: index.observed }),
    });
  const sidecar = readCatalogRuntimeDescriptorsV1Result({
    bytes: loaded.files["./catalog-runtime-descriptors.json"].bytes,
    index: index.content,
    input: { root: loaded.root, verifyDescriptors: true },
  });
  if (sidecar.state !== "read")
    refuse({
      reason: "catalog-runtime-descriptors-refused",
      detail: `${carrier} refused its runtime-descriptors sidecar (${sidecar.reason}${sidecar.observed === undefined ? "" : `, declared ${sidecar.observed}`})`,
      catalogReason: sidecar.reason,
      ...(sidecar.observed === undefined ? {} : { observed: sidecar.observed }),
    });
  const { runtimeDescriptors } = sidecar;
  const tuple = `${selected.repository}@${selected.commit}`;
  const entries = runtimeDescriptors.descriptors.filter(
    (candidate) =>
      candidate.framework === "ecc" &&
      candidate.source.repository === selected.repository &&
      candidate.source.commit === selected.commit,
  );
  const entry = entries[0];
  if (entry === undefined || entries.length !== 1)
    refuse({
      reason: "catalog-descriptor-absent",
      detail: `${carrier} carries ${entries.length === 0 ? "no" : "more than one"} ECC runtime descriptor for the selected source ${tuple}`,
    });
  const file = entry.descriptor;
  if (file.state !== "verified")
    refuse({
      reason: "catalog-descriptor-unverified",
      detail: `${carrier} could not verify the ECC runtime descriptor for ${tuple} (${file.state === "unverified" ? file.reason : file.state})`,
      ...(file.state === "unverified" ? { catalogReason: file.reason } : {}),
    });
  // Custody: Core's own digest over the exact bytes, never the sidecar's claim.
  const sha256 = createHash("sha256").update(file.bytes).digest("hex");
  const accepted = ACCEPTED_CATALOG_ECC_RUNTIME_DESCRIPTORS_V1.filter(
    (pin) =>
      pin.repository === selected.repository &&
      pin.commit === selected.commit &&
      pin.format === entry.format,
  );
  if (!accepted.some((pin) => pin.sha256 === sha256))
    refuse({
      reason: "catalog-descriptor-not-accepted",
      detail: `${carrier} carries ECC runtime descriptor bytes sha256 ${sha256} (${entry.format}) for ${tuple}; this Core accepts ${accepted.length === 0 ? "no descriptor for that source" : `only sha256 ${accepted.map((pin) => pin.sha256).join(", ")}`}`,
    });
  const descriptor = inspectEccRuntimeDescriptorSealV1({
    bytesBase64: Buffer.from(file.bytes).toString("base64"),
    sha256: `sha256:${sha256}`,
  });
  return {
    descriptor,
    carrier: Object.freeze({
      package: CATALOG_PACKAGE_NAME,
      version: loaded.version,
      runtimeDescriptorsFormat: runtimeDescriptors.format,
      runtimeDescriptorsVersion: runtimeDescriptors.version,
      runtimeDescriptorsDigest: runtimeDescriptors.digest,
      indexDigest: index.content.digest,
    }),
  };
}

/**
 * Reconstructs a historical verifier input from a machine-local receipt that
 * rebinds the same source-data envelope and trust, or else from the installed
 * Catalog's Core-pinned descriptor bytes. A missing or unloadable package has
 * a loader refusal; rejected Catalog data has a historical descriptor refusal.
 * The order is
 * HISTORICAL_ECC_RUNTIME_DESCRIPTOR_RESOLUTION_ORDER_V1 and the result records it.
 */
export async function resolveHistoricalEccRuntimeDescriptorV1(
  policy: HistoricalEccRuntimePolicyV1,
  options: { now?: string; dataRoot?: string; catalog?: CatalogPackageAccessV1 } = {},
): Promise<HistoricalEccRuntimeDescriptorContextV1> {
  const now = options.now ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(now))) fail();
  const selected = selectedEccSource(policy);
  const matches = (descriptor: EccRuntimeDescriptorV1) =>
    descriptor.source.repository === selected.repository &&
    descriptor.source.commit === selected.commit;
  const resolution: HistoricalEccRuntimeDescriptorResolutionStepV1[] = [];
  let source: HistoricalEccRuntimeDescriptorSourceV1;
  let carrier: HistoricalEccRuntimeDescriptorContextV1["descriptorCarrier"];
  // Stage 1. Source-data receipts are an ordered protected local state: active
  // first, then retained history. A matching local fact therefore supersedes
  // any package-carried descriptor, even if both source tuples are identical.
  // If that local fact is stale or incompatible, fail below rather than
  // falling back.
  const localCandidates = historicalEccRuntimeDescriptorsFromSourceDataV1(
    options.dataRoot ?? workbenchSourceDataRootV1(),
    now,
  ).filter(matches);
  let descriptor: EccRuntimeDescriptorV1 | undefined = localCandidates[0];
  if (descriptor !== undefined) {
    source = "local-source-data";
    resolution.push({ stage: "local-source-data", outcome: "selected" });
  } else {
    resolution.push({ stage: "local-source-data", outcome: "no-match" });
    // Stage 2 (final). The installed Catalog, or a named package/data refusal.
    // An absent @aihq/catalog is catalog-package-unavailable; nothing falls
    // back to the embedded copy.
    const installed = await installedCatalogDescriptor(selected, options.catalog);
    descriptor = installed.descriptor;
    carrier = installed.carrier;
    source = "installed-catalog";
    resolution.push({ stage: "installed-catalog", outcome: "selected" });
  }
  if (!matches(descriptor) || Date.parse(descriptor.evidence.validUntil) <= Date.parse(now)) fail();
  assertEccRuntimeDescriptorCustodyV1(descriptor, now);
  return Object.freeze({
    ...contextForDescriptor(descriptor),
    descriptorSource: source,
    descriptorResolution: Object.freeze(resolution.map((step) => Object.freeze({ ...step }))),
    ...(carrier === undefined ? {} : { descriptorCarrier: carrier }),
  });
}
