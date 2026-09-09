import { existsSync } from "node:fs";
import { join } from "node:path";
import { isProxy } from "node:util/types";
import { z } from "zod";
import packageMetadata from "../../package.json";
import { SCANNER_BASELINE_PUBLICATION_PUBLISHER_V1 } from "../baseline-evidence/scanner-publication-policy.js";
import { vendorBaselineLockSha256 } from "../baseline-evidence/vendor.js";
import { canonicalStrictJsonSha256V1, deepFreezeStrictJsonV1 } from "../contract/strict-json-v1.js";
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
  stableJson,
  UNWAIVABLE_POLICY_DANGER_CODES,
} from "./effective.js";
import {
  canonicalGovernanceDecisionV1,
  type GovernanceDecisionV1,
  GovernanceDecisionV1Schema,
  parseGovernanceDecisionV1,
} from "./governance-decision-v1.js";
import {
  packagedScannerCollectionEvidenceV1,
  projectScannerCollectionEvidenceV1,
} from "./packaged-collection-evidence-v1.js";
import {
  packagedPublicBaselineEvidenceV1,
  packagedPublicBaselineOverlayV1,
} from "./packaged-public-baseline-v1.js";
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
import type { AuthoringCatalogBundleV1, WorkbenchSourceInputsV1 } from "./workbench/contracts.js";
import { WorkbenchStateV1Schema } from "./workbench/contracts.js";
import { referencedWorkbenchSourcePinsV1 } from "./workbench/core/authoring-sources.js";
import { catalogQualificationReleasePolicyMetadataV1 } from "./workbench/core/catalog-qualification-policy-v1.js";
import {
  catalogQualificationPreparedBundleV1,
  preparePackagedCatalogQualificationV1,
} from "./workbench/core/catalog-qualification-v1.js";
import type { FreshOrganizationPreparationV1 } from "./workbench/core/organization-preparation.js";
import { packagedWorkbenchSourcePublicationsV1 } from "./workbench/core/packaged-source-data.js";
import {
  applyWorkbenchSourceDataV1,
  workbenchSourceDataRootV1,
} from "./workbench/core/source-data.js";
import { withLegacyPolicyCandidateDefaultsV1 } from "./workbench/policy-import.js";
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
    ...(baselineEvidenceProvenance === undefined
      ? {}
      : {
          baselineEvidenceProvenance: baselineEvidenceWorkbenchProvenance(
            baselineEvidenceProvenance,
          ),
        }),
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

let defaultStudioModelPrototype: Readonly<PolicyStudioModel> | undefined;

function defaultStudioModelV1(): PolicyStudioModel {
  defaultStudioModelPrototype ??= deepFreezeStrictJsonV1(structuredClone(buildPolicyStudioModel()));
  return structuredClone(defaultStudioModelPrototype);
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
  if (
    catalogProvenance === undefined &&
    baselineEvidenceProvenance === undefined &&
    options === undefined &&
    !existsSync(join(workbenchSourceDataRootV1(), "active.json"))
  ) {
    return defaultStudioModelV1();
  }
  return buildPolicyStudioModel(catalogProvenance, baselineEvidenceProvenance, options);
}
