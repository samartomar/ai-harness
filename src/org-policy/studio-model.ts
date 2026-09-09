import { createHash } from "node:crypto";
import { isProxy } from "node:util/types";
import { z } from "zod";
import packageMetadata from "../../package.json";
import { SCANNER_BASELINE_ANALYZER_VERSIONS } from "../baseline-evidence/scanner-profile.js";
import { SCANNER_BASELINE_PUBLICATION_PUBLISHER_V1 } from "../baseline-evidence/scanner-publication-policy.js";
import { vendorBaselineLockSha256 } from "../baseline-evidence/vendor.js";
import {
  canonicalStrictJsonBytesV1,
  canonicalStrictJsonSha256V1,
  deepFreezeStrictJsonV1,
} from "../contract/strict-json-v1.js";
import { AihError } from "../errors.js";
import { DEFAULT_EVIDENCE_MAX_AGE_DAYS_V1 } from "../evidence-freshness.js";
import { VERSION } from "../version.js";
import {
  type AdminBaselineEvidenceProvenanceV1,
  type ResolvedAdminBaselineEvidenceV1,
  workbenchEvidenceFromVerifiedBaselineV1,
} from "./admin-baseline-evidence-operations-v1.js";
import type { AdminCatalogProvenanceV1 } from "./admin-catalog-operations-v1.js";
import { type AdoptionRecipe, buildAdoptionRecipe } from "./adoption-recipe.js";
import { type PolicyAuthoringCatalog, policyAuthoringCatalog } from "./catalog.js";
import { POLICY_APPROVER_EMAIL_PATTERN } from "./ecc-mcp-approval.js";
import {
  DISPOSITIONABLE_POLICY_FINDING_CODES,
  FENCED_POLICY_PREREQUISITE_CODES,
  UNWAIVABLE_POLICY_DANGER_CODES,
} from "./finding-codes.js";
import {
  canonicalGovernanceDecisionV1,
  type GovernanceDecisionV1,
  GovernanceDecisionV1Schema,
  parseGovernanceDecisionV1,
} from "./governance-decision-v1.js";
import { packagedScannerCollectionEvidenceInputV1 } from "./packaged-collection-evidence-data.js";
import {
  packagedScannerCollectionEvidenceV1,
  projectScannerCollectionEvidenceV1,
} from "./packaged-collection-evidence-v1.js";
import {
  PACKAGED_PUBLIC_BASELINE_BYTES_V1,
  PACKAGED_PUBLIC_BASELINE_SHA256_V1,
} from "./packaged-public-baseline-data.js";
import {
  PUBLIC_BASELINE_PUBLISHER_V1,
  packagedPublicBaselineEvidenceV1,
  packagedPublicBaselineOverlayV1,
} from "./packaged-public-baseline-v1.js";
import { stableJson } from "./policy-identity.js";
import {
  HTTPS_ORIGIN_ARGUMENT_PREFIXES,
  type OrgPolicy,
  OrgPolicySchema,
  POLICY_HTTPS_ORIGIN_PATTERN,
  PolicyBundleSchema,
  parseOrgPolicy,
} from "./schema.js";
import { verifyAuthoringCatalogBundleIntegrityV1 } from "./workbench/catalog-bundle.js";
import type { WorkbenchPolicyBindingsV1 } from "./workbench/compile-policy.js";
import {
  type AuthoringCatalogBundleV1,
  AuthoringCatalogBundleV1Schema,
  type WorkbenchSourceInputsV1,
  WorkbenchStateV1Schema,
} from "./workbench/contracts.js";
import { referencedWorkbenchSourcePinsV1 } from "./workbench/core/authoring-sources.js";
import { catalogQualificationPackageInputV1 } from "./workbench/core/catalog-qualification-data.js";
import { catalogQualificationReleasePolicyMetadataV1 } from "./workbench/core/catalog-qualification-policy-v1.js";
import {
  catalogQualificationPreparedBundleV1,
  preparePackagedCatalogQualificationV1,
} from "./workbench/core/catalog-qualification-v1.js";
import type { FreshOrganizationPreparationV1 } from "./workbench/core/organization-preparation.js";
import { packagedWorkbenchSourcePublicationsV1 } from "./workbench/core/packaged-source-data.js";
import { applyWorkbenchSourceDataV1 } from "./workbench/core/source-data.js";
import {
  defaultCatalogPreassemblyAdmissionV1,
  packagedDefaultCatalogPreassemblyCompanionV1,
} from "./workbench/default-catalog-preassembly.js";
import { withLegacyPolicyCandidateDefaultsV1 } from "./workbench/policy-import.js";
import type { PreparedWorkbenchCatalogV1 } from "./workbench/prepared-catalog.js";
import {
  packagedPreparedWorkbenchCatalogV1,
  prepareWorkbenchCatalog,
} from "./workbench/prepared-catalog.js";

/** Valid, no-repository starting point for the generated Policy Workbench. */
export function defaultStudioPolicy(): OrgPolicy {
  return parseOrgPolicy({
    schemaVersion: 2,
    minimumPosture: "vibe",
    references: { repoContract: "ai-coding/project.json" },
    governance: {
      policyVersion: "1",
      catalog: { reviewed: [], custom: [] },
      activations: [],
      authority: { approvals: [] },
      externalCuration: [],
      externalSelections: [],
    },
  });
}

/**
 * The generator's import/export boundary. It applies only the source-bound,
 * narrowing legacy Workbench migration below, then uses the product Zod
 * grammar and emits only the parsed policy shape. No generic or broadening
 * Studio adapter exists between a policy and its download.
 */
export function parseStudioPolicyImport(text: string): OrgPolicy {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Policy import is not valid JSON");
  }
  return parseOrgPolicy(narrowLegacyStudioActivationTargets(value));
}

function narrowLegacyStudioActivationTargets(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const policy = value as Record<string, unknown>;
  if (policy.schemaVersion !== 2) return value;
  if (typeof policy.governance !== "object" || policy.governance === null) return value;
  const governance = policy.governance as Record<string, unknown>;
  if (!Array.isArray(governance.supportedClis) || governance.supportedClis.length === 0)
    return value;
  const supportedClis = governance.supportedClis;
  if (typeof governance.catalog !== "object" || governance.catalog === null) return value;
  const catalog = governance.catalog as Record<string, unknown>;
  if (!Array.isArray(catalog.reviewed) || !Array.isArray(governance.activations)) return value;

  const authored = policyAuthoringCatalog();
  const controls = [
    ...authored.mcp.map((item) => item.control),
    ...authored.hooks.map((item) => item.control),
  ];
  const controlById = new Map(controls.map((control) => [control.id, control]));
  const reviewedById = new Map(
    catalog.reviewed.flatMap((candidate) => {
      if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate))
        return [];
      const id = (candidate as Record<string, unknown>).id;
      return typeof id === "string" ? [[id, candidate] as const] : [];
    }),
  );
  const clone = structuredClone(value) as Record<string, unknown>;
  const clonedGovernance = clone.governance as Record<string, unknown>;
  const clonedActivations = clonedGovernance.activations as Array<Record<string, unknown>>;
  let changed = false;

  for (const activation of clonedActivations) {
    if (typeof activation !== "object" || activation === null || Array.isArray(activation))
      continue;
    const candidateId = activation.candidate;
    if (typeof candidateId !== "string") continue;
    const control = controlById.get(candidateId);
    const candidate = reviewedById.get(candidateId);
    if (control === undefined || candidate === undefined) continue;
    // Legacy schema-v2 policy text can omit fields whose grammar supplies
    // canonical defaults. Compare those semantic defaults, while retaining the
    // exact identity check for every explicit or extra candidate field.
    const normalizedCandidate = withLegacyPolicyCandidateDefaultsV1(candidate);
    const expectedCandidate = {
      id: control.id,
      kind: control.kind,
      description: "AIH-provided governed control",
      capabilities: [],
      risks: [],
      source: control.source,
      targets: control.targets,
      projector: control.projector,
      lifecycle: control.lifecycle,
      evidence: { record: `aih-${control.id}` },
      findings: [],
      autoExecute: false,
    };
    if (stableJson(normalizedCandidate) !== stableJson(expectedCandidate)) continue;
    if (stableJson(activation.targets) !== stableJson(control.targets)) continue;
    const sanctionedTargets = control.targets.filter((target) => supportedClis.includes(target));
    if (sanctionedTargets.length === 0 || sanctionedTargets.length === control.targets.length)
      continue;
    activation.targets = sanctionedTargets;
    changed = true;
  }

  return changed ? clone : value;
}

export function exportStudioPolicy(policy: unknown): string {
  return `${JSON.stringify(parseOrgPolicy(policy), null, 2)}\n`;
}

/** Strict, standalone decision transport for the Workbench's inert inspection surface. */
export function parseStudioDecisionImport(text: string): GovernanceDecisionV1 {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Decision import is not valid JSON");
  }
  return parseGovernanceDecisionV1(value);
}

/** Canonical decision bytes are a transport identity only; this function verifies no authority. */
export function exportStudioDecision(decision: unknown): string {
  return `${canonicalGovernanceDecisionV1(parseGovernanceDecisionV1(decision))}\n`;
}

/**
 * Browser data for legacy governance forms. All selectable source assets live
 * only in the workbench bundle, so this projection cannot duplicate an
 * inventory or grant a browser a Core projection binding.
 */
export type StudioFormCatalogV1 = Pick<
  PolicyAuthoringCatalog,
  "hosts" | "eccHookControls" | "externalMcp" | "eccMcpApproval"
> & {
  frameworks: Array<{ id: string; repository: string; commit: string }>;
};

function studioFormCatalog(catalog: PolicyAuthoringCatalog): StudioFormCatalogV1 {
  return {
    hosts: catalog.hosts,
    eccHookControls: catalog.eccHookControls,
    externalMcp: catalog.externalMcp,
    eccMcpApproval: catalog.eccMcpApproval,
    frameworks: catalog.frameworks.map(({ id, repository, commit }) => ({
      id,
      repository,
      commit,
    })),
  };
}

export interface PolicyStudioModel {
  evidenceDelivery?: {
    coreVersion: string;
    workbenchCatalogDigest: string;
    vendorLockDigest: string;
    scannerLibraryVersion: string;
    freshnessDays?: number;
    expectedCatalogPublisher?: {
      repository: string;
      workflow: string;
      catalogCommit: string;
      version: number;
    };
    scanPublications?: Array<{ source: string; publisher: string; commit: string; digest: string }>;
    qualificationPublications?: Array<{
      publisher: string;
      commit: string;
      catalogDigest: string;
      receiptSetDigest: string;
    }>;
    expectedScannerPublisher: { repository: string; workflow: string; ref: string; commit: string };
    publicBaseline?: {
      publisher: string;
      workflow: string;
      artifactDigest: string;
      verifiedAt: string;
      validUntil: string;
    };
  };
  initialPolicy: OrgPolicy;
  /** The sole browser inventory for portable authoring selections. */
  workbenchBundle: AuthoringCatalogBundleV1;
  /** Compact compatibility mapping; Core reconstructs and verifies it on consume. */
  workbenchBindings: WorkbenchPolicyBindingsV1;
  /** Exact organization compiler inputs for portable V3 source reconstruction. */
  workbenchSourceInputs: WorkbenchSourceInputsV1;
  catalog: StudioFormCatalogV1;
  /** Code-owned inert guidance; policy bytes never carry or depend on it. */
  adoptionRecipe: AdoptionRecipe;
  /**
   * Verified supported-catalog provenance when the administrator route resolved
   * one, else absent. The visible provenance line renders tier, source,
   * channel, resolved time, age, and bootstrap provenance; this closed embedded
   * model also carries its safe sequence, digests, posture, member count, and
   * verification time — never a locator, path, token, signature, raw
   * attestation, signer identity, root digest, or machine detail.
   */
  catalogProvenance?: AdminCatalogProvenanceV1;
  baselineEvidenceProvenance?: AdminBaselineEvidenceProvenanceV1;
  schema: Record<string, unknown>;
  protectedBundleSchema: Record<string, unknown>;
  decisionSchema: Record<string, unknown>;
  unwaivable: readonly string[];
  /**
   * The two halves of the finding model. `unwaivable` stays as their union so
   * existing consumers keep working, but a surface that tells an administrator
   * what it may act on must read these, not that.
   */
  findings: {
    dispositionable: readonly string[];
    fenced: readonly string[];
  };
  semantics: {
    httpsOriginArgumentPrefixes: readonly string[];
    httpsOriginPattern: string;
    approverEmailPattern: string;
  };
}

function invalidBaselineEvidenceWorkbenchProvenance(): never {
  throw new AihError(
    "Policy Workbench baseline evidence provenance is invalid",
    "AIH_POLICY_GENERATE",
  );
}

function ownData(record: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (descriptor === undefined || !("value" in descriptor))
    invalidBaselineEvidenceWorkbenchProvenance();
  return descriptor.value;
}

function exactSourceIds(value: unknown): readonly ["ecc", "superpowers"] {
  if (
    isProxy(value) ||
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length !== 2
  )
    invalidBaselineEvidenceWorkbenchProvenance();
  const sourceIds: ["ecc", "superpowers"] = ["ecc", "superpowers"];
  for (let index = 0; index < sourceIds.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (
      descriptor === undefined ||
      !("value" in descriptor) ||
      descriptor.value !== sourceIds[index]
    )
      invalidBaselineEvidenceWorkbenchProvenance();
  }
  return Object.freeze(sourceIds);
}

function baselineEvidenceWorkbenchProvenance(
  provenance: AdminBaselineEvidenceProvenanceV1,
): AdminBaselineEvidenceProvenanceV1 {
  if (
    typeof provenance !== "object" ||
    provenance === null ||
    isProxy(provenance) ||
    Array.isArray(provenance) ||
    Object.getPrototypeOf(provenance) !== Object.prototype
  )
    invalidBaselineEvidenceWorkbenchProvenance();
  const record = provenance as unknown as Record<string, unknown>;
  const ageSeconds = ownData(record, "ageSeconds");
  const digest = ownData(record, "digest");
  const resolvedAt = ownData(record, "resolvedAt");
  const schemaVersion = ownData(record, "schemaVersion");
  const sourceIds = exactSourceIds(ownData(record, "sourceIds"));
  const tier = ownData(record, "tier");
  const validAgeSeconds =
    tier === "fresh" && ageSeconds === 0
      ? 0
      : tier === "packaged" && ageSeconds === null
        ? null
        : tier === "last-downloaded" &&
            typeof ageSeconds === "number" &&
            Number.isSafeInteger(ageSeconds) &&
            ageSeconds >= 0 &&
            ageSeconds <= 31_536_000
          ? ageSeconds
          : invalidBaselineEvidenceWorkbenchProvenance();
  const validDigest =
    typeof digest === "string" && /^[a-f0-9]{64}$/.test(digest)
      ? digest
      : invalidBaselineEvidenceWorkbenchProvenance();
  const validResolvedAt =
    typeof resolvedAt === "string" &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(resolvedAt) &&
    Number.isFinite(Date.parse(resolvedAt)) &&
    new Date(Date.parse(resolvedAt)).toISOString() === `${resolvedAt.slice(0, -1)}.000Z`
      ? resolvedAt
      : invalidBaselineEvidenceWorkbenchProvenance();
  const validSchemaVersion =
    typeof schemaVersion === "number" && Number.isSafeInteger(schemaVersion) && schemaVersion === 1
      ? schemaVersion
      : invalidBaselineEvidenceWorkbenchProvenance();
  const validTier =
    tier === "fresh" || tier === "last-downloaded" || tier === "packaged"
      ? tier
      : invalidBaselineEvidenceWorkbenchProvenance();
  return Object.freeze({
    ageSeconds: validAgeSeconds,
    digest: validDigest,
    resolvedAt: validResolvedAt,
    schemaVersion: validSchemaVersion,
    sourceIds,
    tier: validTier,
  });
}

/** Serializable payload embedded in every portable workbench artifact. */
function buildPolicyStudioModel(
  catalogProvenance?: AdminCatalogProvenanceV1,
  baselineEvidenceProvenance?: AdminBaselineEvidenceProvenanceV1,
  options?: {
    organizationManifestBytes?: readonly string[];
    freshOrganizationPreparations?: readonly FreshOrganizationPreparationV1[];
    verifiedBaseline?: { resolved: ResolvedAdminBaselineEvidenceV1; now: string };
    initialPolicy?: OrgPolicy;
  },
): PolicyStudioModel {
  const boundedBaselineProvenance =
    baselineEvidenceProvenance === undefined
      ? undefined
      : baselineEvidenceWorkbenchProvenance(baselineEvidenceProvenance);
  const publicBaseline = packagedPublicBaselineEvidenceV1();
  const initialPolicy = options?.initialPolicy ?? defaultStudioPolicy();
  const savedState =
    initialPolicy.schemaVersion === 3 && initialPolicy.authoringSelections
      ? WorkbenchStateV1Schema.parse(
          (({ selectionVersion: _version, ...state }) => state)(initialPolicy.authoringSelections),
        )
      : undefined;
  const sourceDataPins =
    savedState === undefined ? undefined : referencedWorkbenchSourcePinsV1(savedState);
  let prepared =
    options?.organizationManifestBytes?.length ||
    options?.freshOrganizationPreparations?.length ||
    sourceDataPins !== undefined
      ? prepareWorkbenchCatalog(undefined, { ...options, sourceDataPins, packageDataOnly: true })
      : packagedPreparedWorkbenchCatalogV1();
  const scannerCollectionRecords = packagedScannerCollectionEvidenceV1();
  const packagedEvidence = {
    ...packagedPublicBaselineOverlayV1(prepared.bundle),
    ...projectScannerCollectionEvidenceV1(prepared.bundle, scannerCollectionRecords),
  };
  let evidenceChanged = false;
  if (Object.keys(packagedEvidence).length > 0) {
    prepared.bundle.evidence = { ...prepared.bundle.evidence, ...packagedEvidence };
    evidenceChanged = true;
  }
  if (options?.verifiedBaseline !== undefined) {
    const evidence = workbenchEvidenceFromVerifiedBaselineV1(
      options.verifiedBaseline.resolved,
      prepared.bundle,
      options.verifiedBaseline.now,
    );
    prepared.bundle.evidence = { ...prepared.bundle.evidence, ...evidence };
    evidenceChanged = true;
  }
  const qualification = preparePackagedCatalogQualificationV1(prepared.bundle);
  if (qualification !== undefined) {
    const qualified = catalogQualificationPreparedBundleV1(prepared.bundle, qualification);
    if (qualified === undefined) throw new Error("Prepared Catalog qualification lost custody.");
    prepared.bundle = qualified;
    evidenceChanged = true;
  }
  // These independently verified overlays change only evidence/qualification.
  // Seal and inspect their final composition before any source update consumes it.
  if (evidenceChanged) {
    prepared.bundle.provenance.bundleDigest = `sha256:${canonicalStrictJsonSha256V1({ ...prepared.bundle, provenance: {} })}`;
    verifyAuthoringCatalogBundleIntegrityV1(prepared.bundle);
  }
  // Signed external snapshots supersede only their exact source after package overlays.
  prepared = applyWorkbenchSourceDataV1(prepared, { pins: sourceDataPins });
  return {
    evidenceDelivery: {
      coreVersion: VERSION,
      workbenchCatalogDigest: prepared.bundle.provenance.bundleDigest,
      vendorLockDigest: `sha256:${vendorBaselineLockSha256()}`,
      scannerLibraryVersion: packageMetadata.devDependencies["@aihq/scan"],
      freshnessDays: DEFAULT_EVIDENCE_MAX_AGE_DAYS_V1,
      expectedCatalogPublisher: catalogQualificationReleasePolicyMetadataV1,
      scanPublications: [
        ...packagedWorkbenchSourcePublicationsV1(prepared.bundle),
        ...scannerCollectionRecords.flatMap((record) =>
          record.publications.map((publication) => ({
            source: record.catalog.id,
            publisher: publication.repository,
            commit: publication.sourceCommit,
            digest: `sha256:${publication.publicationSha256}`,
          })),
        ),
      ],
      qualificationPublications: [
        ...new Map(
          Object.values(prepared.bundle.qualifications ?? {}).map((summary) => [
            summary.receiptSetDigest,
            {
              publisher: summary.publisher.repository,
              commit: summary.publisher.commit,
              catalogDigest: summary.catalogDigest,
              receiptSetDigest: summary.receiptSetDigest,
            },
          ]),
        ).values(),
      ],
      expectedScannerPublisher: SCANNER_BASELINE_PUBLICATION_PUBLISHER_V1,
      ...(publicBaseline === undefined
        ? {}
        : {
            publicBaseline: {
              publisher: publicBaseline.publisher.repository,
              workflow: publicBaseline.publisher.workflow,
              artifactDigest: publicBaseline.artifactSubjectDigest,
              verifiedAt: publicBaseline.verifiedAt,
              validUntil: publicBaseline.validUntil,
            },
          }),
    },
    initialPolicy,
    catalog: studioFormCatalog(prepared.catalog),
    workbenchBundle: prepared.bundle,
    workbenchBindings: prepared.bindings,
    workbenchSourceInputs: prepared.sourceInputs,
    adoptionRecipe: buildAdoptionRecipe(),
    ...(catalogProvenance === undefined ? {} : { catalogProvenance }),
    ...(boundedBaselineProvenance === undefined
      ? {}
      : { baselineEvidenceProvenance: boundedBaselineProvenance }),
    schema: z.toJSONSchema(OrgPolicySchema, { io: "input" }) as Record<string, unknown>,
    protectedBundleSchema: z.toJSONSchema(PolicyBundleSchema, { io: "input" }) as Record<
      string,
      unknown
    >,
    decisionSchema: z.toJSONSchema(GovernanceDecisionV1Schema, { io: "input" }) as Record<
      string,
      unknown
    >,
    unwaivable: UNWAIVABLE_POLICY_DANGER_CODES,
    findings: {
      dispositionable: DISPOSITIONABLE_POLICY_FINDING_CODES,
      fenced: FENCED_POLICY_PREREQUISITE_CODES,
    },
    semantics: {
      httpsOriginArgumentPrefixes: HTTPS_ORIGIN_ARGUMENT_PREFIXES,
      httpsOriginPattern: POLICY_HTTPS_ORIGIN_PATTERN,
      approverEmailPattern: POLICY_APPROVER_EMAIL_PATTERN,
    },
  };
}

type StudioEvidenceDeliveryV1 = NonNullable<PolicyStudioModel["evidenceDelivery"]>;
type StaticStudioShellV1 = {
  defaultPolicy: OrgPolicy;
  catalog: StudioFormCatalogV1;
  adoptionRecipe: AdoptionRecipe;
  schema: Record<string, unknown>;
  protectedBundleSchema: Record<string, unknown>;
  decisionSchema: Record<string, unknown>;
  unwaivable: readonly string[];
  findings: PolicyStudioModel["findings"];
  semantics: PolicyStudioModel["semantics"];
  evidence: Omit<
    StudioEvidenceDeliveryV1,
    "workbenchCatalogDigest" | "scanPublications" | "qualificationPublications"
  > & {
    scanPublications: NonNullable<StudioEvidenceDeliveryV1["scanPublications"]>;
  };
};
export type DefaultStudioPackageBaseV1 = {
  prepared: PreparedWorkbenchCatalogV1;
  shell: StaticStudioShellV1;
};

function staticStudioShellV1(
  catalog: PolicyAuthoringCatalog,
  scannerCollectionRecords: ReturnType<typeof packagedScannerCollectionEvidenceV1>,
  publicBaseline: ReturnType<typeof packagedPublicBaselineEvidenceV1>,
): StaticStudioShellV1 {
  return {
    defaultPolicy: defaultStudioPolicy(),
    catalog: studioFormCatalog(catalog),
    adoptionRecipe: buildAdoptionRecipe(),
    schema: z.toJSONSchema(OrgPolicySchema, { io: "input" }) as Record<string, unknown>,
    protectedBundleSchema: z.toJSONSchema(PolicyBundleSchema, { io: "input" }) as Record<
      string,
      unknown
    >,
    decisionSchema: z.toJSONSchema(GovernanceDecisionV1Schema, { io: "input" }) as Record<
      string,
      unknown
    >,
    unwaivable: UNWAIVABLE_POLICY_DANGER_CODES,
    findings: {
      dispositionable: DISPOSITIONABLE_POLICY_FINDING_CODES,
      fenced: FENCED_POLICY_PREREQUISITE_CODES,
    },
    semantics: {
      httpsOriginArgumentPrefixes: HTTPS_ORIGIN_ARGUMENT_PREFIXES,
      httpsOriginPattern: POLICY_HTTPS_ORIGIN_PATTERN,
      approverEmailPattern: POLICY_APPROVER_EMAIL_PATTERN,
    },
    evidence: {
      coreVersion: VERSION,
      vendorLockDigest: `sha256:${vendorBaselineLockSha256()}`,
      scannerLibraryVersion: packageMetadata.devDependencies["@aihq/scan"],
      freshnessDays: DEFAULT_EVIDENCE_MAX_AGE_DAYS_V1,
      expectedCatalogPublisher: catalogQualificationReleasePolicyMetadataV1,
      expectedScannerPublisher: SCANNER_BASELINE_PUBLICATION_PUBLISHER_V1,
      scanPublications: scannerCollectionRecords.flatMap((record) =>
        record.publications.map((publication) => ({
          source: record.catalog.id,
          publisher: publication.repository,
          commit: publication.sourceCommit,
          digest: `sha256:${publication.publicationSha256}`,
        })),
      ),
      ...(publicBaseline === undefined
        ? {}
        : {
            publicBaseline: {
              publisher: publicBaseline.publisher.repository,
              workflow: publicBaseline.publisher.workflow,
              artifactDigest: publicBaseline.artifactSubjectDigest,
              verifiedAt: publicBaseline.verifiedAt,
              validUntil: publicBaseline.validUntil,
            },
          }),
    },
  };
}

/** Build-only package base. It cannot discover or apply machine-local source data. */
export function buildDefaultStudioPackageBaseV1(
  base: PreparedWorkbenchCatalogV1,
): DefaultStudioPackageBaseV1 {
  const prepared = structuredClone(base);
  const scannerCollectionRecords = packagedScannerCollectionEvidenceV1();
  const publicBaseline = packagedPublicBaselineEvidenceV1();
  const packagedEvidence = {
    ...packagedPublicBaselineOverlayV1(prepared.bundle),
    ...projectScannerCollectionEvidenceV1(prepared.bundle, scannerCollectionRecords),
  };
  let evidenceChanged = false;
  if (Object.keys(packagedEvidence).length > 0) {
    prepared.bundle.evidence = { ...prepared.bundle.evidence, ...packagedEvidence };
    evidenceChanged = true;
  }
  const qualification = preparePackagedCatalogQualificationV1(prepared.bundle);
  if (qualification !== undefined) {
    const qualified = catalogQualificationPreparedBundleV1(prepared.bundle, qualification);
    if (qualified === undefined) throw new Error("Prepared Catalog qualification lost custody.");
    prepared.bundle = qualified;
    evidenceChanged = true;
  }
  if (evidenceChanged) {
    prepared.bundle.provenance.bundleDigest = `sha256:${canonicalStrictJsonSha256V1({ ...prepared.bundle, provenance: {} })}`;
    verifyAuthoringCatalogBundleIntegrityV1(prepared.bundle);
  }
  return {
    prepared,
    shell: staticStudioShellV1(prepared.catalog, scannerCollectionRecords, publicBaseline),
  };
}

function qualificationsForPreparedBundleV1(
  prepared: PreparedWorkbenchCatalogV1,
): NonNullable<StudioEvidenceDeliveryV1["qualificationPublications"]> {
  return [
    ...new Map(
      Object.values(prepared.bundle.qualifications ?? {}).map((summary) => [
        summary.receiptSetDigest,
        {
          publisher: summary.publisher.repository,
          commit: summary.publisher.commit,
          catalogDigest: summary.catalogDigest,
          receiptSetDigest: summary.receiptSetDigest,
        },
      ]),
    ).values(),
  ];
}

function modelFromDefaultStudioPackageBaseV1(
  base: DefaultStudioPackageBaseV1,
  prepared: PreparedWorkbenchCatalogV1,
  initialPolicy: OrgPolicy,
  catalogProvenance?: AdminCatalogProvenanceV1,
  baselineEvidenceProvenance?: AdminBaselineEvidenceProvenanceV1,
): PolicyStudioModel {
  const boundedBaselineProvenance =
    baselineEvidenceProvenance === undefined
      ? undefined
      : baselineEvidenceWorkbenchProvenance(baselineEvidenceProvenance);
  return {
    evidenceDelivery: {
      coreVersion: base.shell.evidence.coreVersion,
      workbenchCatalogDigest: prepared.bundle.provenance.bundleDigest,
      vendorLockDigest: base.shell.evidence.vendorLockDigest,
      scannerLibraryVersion: base.shell.evidence.scannerLibraryVersion,
      freshnessDays: base.shell.evidence.freshnessDays,
      expectedCatalogPublisher: structuredClone(base.shell.evidence.expectedCatalogPublisher),
      scanPublications: [
        ...packagedWorkbenchSourcePublicationsV1(prepared.bundle),
        ...base.shell.evidence.scanPublications,
      ],
      qualificationPublications: qualificationsForPreparedBundleV1(prepared),
      expectedScannerPublisher: structuredClone(base.shell.evidence.expectedScannerPublisher),
      ...(base.shell.evidence.publicBaseline === undefined
        ? {}
        : { publicBaseline: structuredClone(base.shell.evidence.publicBaseline) }),
    },
    initialPolicy: structuredClone(initialPolicy),
    catalog: structuredClone(base.shell.catalog),
    workbenchBundle: prepared.bundle,
    workbenchBindings: prepared.bindings,
    workbenchSourceInputs: prepared.sourceInputs,
    adoptionRecipe: structuredClone(base.shell.adoptionRecipe),
    ...(catalogProvenance === undefined ? {} : { catalogProvenance }),
    ...(boundedBaselineProvenance === undefined
      ? {}
      : { baselineEvidenceProvenance: boundedBaselineProvenance }),
    schema: structuredClone(base.shell.schema),
    protectedBundleSchema: structuredClone(base.shell.protectedBundleSchema),
    decisionSchema: structuredClone(base.shell.decisionSchema),
    unwaivable: [...base.shell.unwaivable],
    findings: structuredClone(base.shell.findings),
    semantics: structuredClone(base.shell.semantics),
  };
}

const STUDIO_PREASSEMBLY_VERSION = "default-studio-preassembly/v1";
const digestHex = /^[a-f0-9]{64}$/;
type StudioPreassemblyInputV1 = Readonly<{ bytes: string; sha256: string }>;
type StudioPreassemblyPayloadV1 = {
  version: typeof STUDIO_PREASSEMBLY_VERSION;
  admission: Record<string, unknown>;
  base: DefaultStudioPackageBaseV1;
  output: {
    baseDigest: string;
    bundleDigest: string;
    bindingsDigest: string;
    sourceInputsDigest: string;
  };
};

function studioCanonical(value: unknown): string {
  return canonicalStrictJsonBytesV1(value).toString("utf8");
}

function studioDigest(value: unknown): string {
  return `sha256:${canonicalStrictJsonSha256V1(value)}`;
}

function studioObject(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new TypeError(`Default Studio preassembly ${label} is malformed`);
  return value as Record<string, unknown>;
}

function studioExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  if (
    Object.keys(value).length !== keys.length ||
    Object.keys(value).some((key) => !keys.includes(key))
  )
    throw new TypeError(`Default Studio preassembly ${label} is malformed`);
}

function parseStudioCanonicalObject(bytes: string, label: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(bytes);
  } catch {
    throw new TypeError(`Default Studio preassembly ${label} is not JSON`);
  }
  const parsed = studioObject(value, label);
  if (studioCanonical(parsed) !== bytes)
    throw new TypeError(`Default Studio preassembly ${label} is not canonical`);
  return parsed;
}

function studioInputSeals(input: readonly Readonly<{ bytes: string; sha256: string }>[]) {
  return input.map(({ bytes, sha256 }) => {
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (
      !/^(?:sha256:)?[a-f0-9]{64}$/.test(sha256) ||
      (sha256 !== actual && sha256 !== `sha256:${actual}`)
    )
      throw new TypeError("Default Studio preassembly package input seal mismatch");
    return { bytes: Buffer.byteLength(bytes, "utf8"), sha256 };
  });
}

function studioStaticInputV1() {
  const shell = staticStudioShellV1(policyAuthoringCatalog(), [], undefined);
  return {
    defaultPolicy: shell.defaultPolicy,
    catalog: shell.catalog,
    adoptionRecipe: shell.adoptionRecipe,
    schema: shell.schema,
    protectedBundleSchema: shell.protectedBundleSchema,
    decisionSchema: shell.decisionSchema,
    unwaivable: shell.unwaivable,
    findings: shell.findings,
    semantics: shell.semantics,
  };
}

function defaultStudioPreassemblyAdmissionV1() {
  return {
    coreVersion: VERSION,
    catalogAdmissionDigest: studioDigest(defaultCatalogPreassemblyAdmissionV1()),
    scannerRecordSeals: studioInputSeals(packagedScannerCollectionEvidenceInputV1()),
    qualificationInputDigest: studioDigest(catalogQualificationPackageInputV1()),
    qualificationPolicyDigest: studioDigest(catalogQualificationReleasePolicyMetadataV1),
    publicBaselineInputDigest: studioDigest({
      bytes: PACKAGED_PUBLIC_BASELINE_BYTES_V1,
      sha256: PACKAGED_PUBLIC_BASELINE_SHA256_V1,
    }),
    publicBaselinePublisherDigest: studioDigest(PUBLIC_BASELINE_PUBLISHER_V1),
    scannerAnalyzerPolicyDigest: studioDigest(SCANNER_BASELINE_ANALYZER_VERSIONS),
    scannerPublicationPolicyDigest: studioDigest(SCANNER_BASELINE_PUBLICATION_PUBLISHER_V1),
    scannerLibraryVersion: packageMetadata.devDependencies["@aihq/scan"],
    freshnessDays: DEFAULT_EVIDENCE_MAX_AGE_DAYS_V1,
    staticInputDigest: studioDigest(studioStaticInputV1()),
  };
}

/** Build-only helper: input must be freshly package-compiled and never host-applied. */
export function createDefaultStudioPreassemblyV1(
  base: DefaultStudioPackageBaseV1,
): StudioPreassemblyInputV1 {
  const payload: StudioPreassemblyPayloadV1 = {
    version: STUDIO_PREASSEMBLY_VERSION,
    admission: defaultStudioPreassemblyAdmissionV1(),
    base,
    output: {
      baseDigest: studioDigest(base),
      bundleDigest: base.prepared.bundle.provenance.bundleDigest,
      bindingsDigest: studioDigest(base.prepared.bindings),
      sourceInputsDigest: studioDigest(base.prepared.sourceInputs),
    },
  };
  const payloadBytes = studioCanonical(payload);
  const bytes = studioCanonical({
    version: STUDIO_PREASSEMBLY_VERSION,
    bytes: payloadBytes,
    sha256: createHash("sha256").update(payloadBytes).digest("hex"),
  });
  return Object.freeze({ bytes, sha256: createHash("sha256").update(bytes).digest("hex") });
}

function parseDefaultStudioPreassemblyV1(
  input: StudioPreassemblyInputV1,
): StudioPreassemblyPayloadV1 {
  if (
    !digestHex.test(input.sha256) ||
    createHash("sha256").update(input.bytes).digest("hex") !== input.sha256
  )
    throw new TypeError("Default Studio preassembly companion seal mismatch");
  const envelope = parseStudioCanonicalObject(input.bytes, "envelope");
  studioExactKeys(envelope, ["version", "bytes", "sha256"], "envelope");
  if (
    envelope.version !== STUDIO_PREASSEMBLY_VERSION ||
    typeof envelope.bytes !== "string" ||
    typeof envelope.sha256 !== "string" ||
    !digestHex.test(envelope.sha256) ||
    createHash("sha256").update(envelope.bytes).digest("hex") !== envelope.sha256
  )
    throw new TypeError("Default Studio preassembly envelope is malformed");
  const payload = parseStudioCanonicalObject(envelope.bytes, "payload");
  studioExactKeys(payload, ["version", "admission", "base", "output"], "payload");
  if (payload.version !== STUDIO_PREASSEMBLY_VERSION)
    throw new TypeError("Default Studio preassembly payload version is invalid");
  return payload as unknown as StudioPreassemblyPayloadV1;
}

/** Missing or stale package data falls back; malformed present data fails closed. */
export function admitDefaultStudioPreassemblyV1(
  input: StudioPreassemblyInputV1,
): DefaultStudioPackageBaseV1 | undefined {
  const payload = parseDefaultStudioPreassemblyV1(input);
  if (studioCanonical(payload.admission) !== studioCanonical(defaultStudioPreassemblyAdmissionV1()))
    return undefined;
  const output = studioObject(payload.output, "output");
  studioExactKeys(
    output,
    ["baseDigest", "bundleDigest", "bindingsDigest", "sourceInputsDigest"],
    "output",
  );
  const baseRecord = studioObject(payload.base, "base");
  studioExactKeys(baseRecord, ["prepared", "shell"], "base");
  const preparedRecord = studioObject(baseRecord.prepared, "prepared base");
  studioExactKeys(
    preparedRecord,
    ["catalog", "bundle", "bindings", "sourceInputs"],
    "prepared base",
  );
  const shellRecord = studioObject(baseRecord.shell, "static shell");
  studioExactKeys(
    shellRecord,
    [
      "defaultPolicy",
      "catalog",
      "adoptionRecipe",
      "schema",
      "protectedBundleSchema",
      "decisionSchema",
      "unwaivable",
      "findings",
      "semantics",
      "evidence",
    ],
    "static shell",
  );
  const evidence = studioObject(shellRecord.evidence, "static evidence");
  const evidenceKeys = [
    "coreVersion",
    "vendorLockDigest",
    "scannerLibraryVersion",
    "freshnessDays",
    "expectedCatalogPublisher",
    "expectedScannerPublisher",
    "scanPublications",
    ...(Object.hasOwn(evidence, "publicBaseline") ? ["publicBaseline"] : []),
  ];
  studioExactKeys(evidence, evidenceKeys, "static evidence");
  const base = baseRecord as unknown as DefaultStudioPackageBaseV1;
  if (
    studioDigest(base) !== output.baseDigest ||
    base.prepared.bundle.provenance.bundleDigest !== output.bundleDigest ||
    studioDigest(base.prepared.bindings) !== output.bindingsDigest ||
    studioDigest(base.prepared.sourceInputs) !== output.sourceInputsDigest
  )
    throw new TypeError("Default Studio preassembly output integrity mismatch");
  parseOrgPolicy(base.shell.defaultPolicy);
  const bundle = AuthoringCatalogBundleV1Schema.parse(base.prepared.bundle);
  verifyAuthoringCatalogBundleIntegrityV1(bundle);
  // This graph was parsed privately for this call. Cache consumers freeze their
  // own snapshot; returning it directly preserves detached mutable output.
  return base;
}

let admittedDefaultStudioPackageBaseV1: Readonly<DefaultStudioPackageBaseV1> | undefined;
let fallbackDefaultStudioPackageBasePrototypeV1: Readonly<DefaultStudioPackageBaseV1> | undefined;

function packagedDefaultStudioPreassemblyV1(): DefaultStudioPackageBaseV1 | undefined {
  if (admittedDefaultStudioPackageBaseV1 !== undefined)
    return structuredClone(admittedDefaultStudioPackageBaseV1);
  const companion = packagedDefaultCatalogPreassemblyCompanionV1();
  if (companion === undefined) return undefined;
  const admitted = admitDefaultStudioPreassemblyV1(companion.studio);
  if (admitted === undefined) return undefined;
  admittedDefaultStudioPackageBaseV1 = deepFreezeStrictJsonV1(
    structuredClone(admitted),
  ) as DefaultStudioPackageBaseV1;
  return structuredClone(admittedDefaultStudioPackageBaseV1);
}

/** Development fallback retains package-only work but never captures local source state. */
function fallbackDefaultStudioPackageBaseV1(): DefaultStudioPackageBaseV1 {
  fallbackDefaultStudioPackageBasePrototypeV1 ??= deepFreezeStrictJsonV1(
    buildDefaultStudioPackageBaseV1(packagedPreparedWorkbenchCatalogV1()),
  ) as DefaultStudioPackageBaseV1;
  return structuredClone(fallbackDefaultStudioPackageBasePrototypeV1);
}

/** Serializable payload embedded in every portable workbench artifact. */
export function policyStudioModel(
  catalogProvenance?: AdminCatalogProvenanceV1,
  baselineEvidenceProvenance?: AdminBaselineEvidenceProvenanceV1,
  options?: {
    organizationManifestBytes?: readonly string[];
    freshOrganizationPreparations?: readonly FreshOrganizationPreparationV1[];
    verifiedBaseline?: { resolved: ResolvedAdminBaselineEvidenceV1; now: string };
    initialPolicy?: OrgPolicy;
  },
): PolicyStudioModel {
  // Reject display provenance before selecting either package cache; it must not trigger preparation.
  if (baselineEvidenceProvenance !== undefined)
    baselineEvidenceWorkbenchProvenance(baselineEvidenceProvenance);
  const initialPolicy = options?.initialPolicy ?? defaultStudioPolicy();
  const savedState =
    initialPolicy.schemaVersion === 3 && initialPolicy.authoringSelections
      ? WorkbenchStateV1Schema.parse(
          (({ selectionVersion: _version, ...state }) => state)(initialPolicy.authoringSelections),
        )
      : undefined;
  const sourceDataPins =
    savedState === undefined ? undefined : referencedWorkbenchSourcePinsV1(savedState);
  if (
    options?.verifiedBaseline === undefined &&
    options?.initialPolicy === undefined &&
    !options?.organizationManifestBytes?.length &&
    !options?.freshOrganizationPreparations?.length
  ) {
    const base = packagedDefaultStudioPreassemblyV1() ?? fallbackDefaultStudioPackageBaseV1();
    // Source selection, signature checks, expiry and protected local receipts remain live.
    const prepared = applyWorkbenchSourceDataV1(structuredClone(base.prepared), {
      pins: sourceDataPins,
    });
    return modelFromDefaultStudioPackageBaseV1(
      base,
      prepared,
      initialPolicy,
      catalogProvenance,
      baselineEvidenceProvenance,
    );
  }
  return buildPolicyStudioModel(catalogProvenance, baselineEvidenceProvenance, options);
}
