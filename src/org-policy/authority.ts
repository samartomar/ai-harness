import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, parse as parsePath, relative, resolve } from "node:path";
import { z } from "zod";
import { parseNativeStrictJsonObjectV1 } from "../contract/native-strict-json-object-v1.js";
import { readRegularFileWithStats } from "../internals/fsxn.js";
import type { FileAssertion, PlanContext } from "../internals/plan.js";
import { findOnPath } from "../live/runner.js";
import { PolicyAuthorityReceiptV3Schema } from "./authority-v3.js";
import {
  GovernanceDecisionRevocationV1Schema,
  GovernanceDecisionTimestampSchema,
  GovernanceDecisionV1Schema,
} from "./governance-decision-v1.js";
import {
  CandidateSourceSchema,
  hasExplicitOrgPolicySource,
  MAX_ORG_POLICY_BYTES,
  OrgPolicySchema,
  orgPolicyPath,
  PolicyApprovalSchema,
  PolicyDangerCodeSchema,
  parsePolicyBundle,
  schemaLeafPaths,
} from "./schema.js";

/** Fixed, regular-file-only external authority input. It is never generated from policy JSON. */
export const POLICY_AUTHORITY_RECEIPT_PATH = ".aih/policy-authority-receipt.json";

const SafeId = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const Sha256 = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const Repository = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
const IsoTimestamp = z.string().refine((value) => Number.isFinite(Date.parse(value)));
const Target = z.enum(["claude", "codex", "kiro"]);

const ReceiptEvidenceSchema = z
  .object({
    id: SafeId,
    candidate: SafeId,
    kind: z.enum(["mcp", "hook", "framework"]),
    source: CandidateSourceSchema,
    sourceDigest: Sha256,
    evidenceDigest: Sha256,
    identityDigest: Sha256,
    state: z.enum(["verified", "missing", "failed"]),
    waivable: z.boolean(),
    detectors: z
      .array(
        z
          .object({
            id: SafeId,
            required: z.boolean(),
            status: z.enum(["pass", "missing", "fail"]),
            reportDigest: Sha256.optional(),
          })
          .strict(),
      )
      .default([]),
    findings: z.array(PolicyDangerCodeSchema).default([]),
  })
  .strict();

const ReceiptIssuerSchema = z.object({ id: SafeId, githubRepository: Repository }).strict();

const ReceiptRevocationSchema = z
  .object({
    approval: SafeId,
    issuer: SafeId,
    revokedAt: IsoTimestamp,
    reason: z.string().min(1).max(500),
  })
  .strict();

const LegacyApprovalIdV2Schema = SafeId.refine(
  (id) => !id.startsWith("decision-"),
  "legacy approval ids must not use the decision- namespace",
);
const PolicyApprovalReceiptV2Schema = PolicyApprovalSchema.extend({
  id: LegacyApprovalIdV2Schema,
  notBefore: GovernanceDecisionTimestampSchema,
  expiresAt: GovernanceDecisionTimestampSchema,
}).strict();
const ReceiptRevocationV2Schema = ReceiptRevocationSchema.extend({
  approval: LegacyApprovalIdV2Schema,
  revokedAt: GovernanceDecisionTimestampSchema,
}).strict();

function ordinalCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortedUniqueBy<T>(items: readonly T[], id: (item: T) => string): boolean {
  return items.every(
    (item, index) => index === 0 || ordinalCompare(id(items[index - 1] as T), id(item)) < 0,
  );
}

const ReceiptDecisionsV2Schema = z
  .array(GovernanceDecisionV1Schema)
  .max(64)
  .refine(
    (decisions) => sortedUniqueBy(decisions, (decision) => decision.id),
    "decisions must be ordinal-sorted and unique by id",
  );
const ReceiptDecisionRevocationsV2Schema = z
  .array(GovernanceDecisionRevocationV1Schema)
  .max(64)
  .refine(
    (revocations) => sortedUniqueBy(revocations, (revocation) => revocation.decision),
    "decisionRevocations must be ordinal-sorted and unique by decision",
  );

function receiptBaseIssues(
  receipt: {
    issuedAt: string;
    expiresAt: string;
    trustedIssuers: readonly { id: string }[];
    evidence: readonly { id: string }[];
    approvals: readonly { id: string }[];
  },
  ctx: z.RefinementCtx,
): void {
  if (Date.parse(receipt.expiresAt) <= Date.parse(receipt.issuedAt)) {
    ctx.addIssue({ code: "custom", message: "receipt expiresAt must be after issuedAt" });
  }
  if (Date.parse(receipt.expiresAt) - Date.parse(receipt.issuedAt) > 90 * 24 * 60 * 60 * 1000) {
    ctx.addIssue({ code: "custom", message: "receipt lifetime must not exceed 90 days" });
  }
  const duplicate = <T extends { id: string }>(items: readonly T[], label: string) => {
    const seen = new Set<string>();
    for (const item of items) {
      if (seen.has(item.id))
        ctx.addIssue({ code: "custom", message: `duplicate ${label} ${item.id}` });
      seen.add(item.id);
    }
  };
  duplicate(receipt.trustedIssuers, "trusted issuer");
  duplicate(receipt.evidence, "evidence record");
  duplicate(receipt.approvals, "approval");
}

const PolicyAuthorityReceiptV1Schema = z
  .object({
    format: z.literal("aih-policy-authority-receipt"),
    version: z.literal(1),
    /** Must match the out-of-band organization authority registry. */
    issuerRepository: Repository,
    issuedAt: IsoTimestamp,
    expiresAt: IsoTimestamp,
    trustedIssuers: z.array(ReceiptIssuerSchema).default([]),
    evidence: z.array(ReceiptEvidenceSchema).default([]),
    approvals: z.array(PolicyApprovalSchema).default([]),
    revocations: z.array(ReceiptRevocationSchema).default([]),
    /** Receipt-wide control coverage, checked against every active activation. */
    targets: z.array(Target).min(1).max(3),
  })
  .strict()
  .superRefine(receiptBaseIssues);

const PolicyAuthorityReceiptV2Schema = z
  .object({
    format: z.literal("aih-policy-authority-receipt"),
    version: z.literal(2),
    /** Must match the out-of-band organization authority registry. */
    issuerRepository: Repository,
    issuedAt: GovernanceDecisionTimestampSchema,
    expiresAt: GovernanceDecisionTimestampSchema,
    trustedIssuers: z.array(ReceiptIssuerSchema).default([]),
    evidence: z.array(ReceiptEvidenceSchema).default([]),
    approvals: z.array(PolicyApprovalReceiptV2Schema).default([]),
    revocations: z.array(ReceiptRevocationV2Schema).default([]),
    /** Receipt-wide control coverage, checked against every active activation. */
    targets: z.array(Target).min(1).max(3),
    /** Exact signed decision artifacts; policy may only reference their ids. */
    decisions: ReceiptDecisionsV2Schema,
    /** Exact signed revocation artifacts, never an inline decision state. */
    decisionRevocations: ReceiptDecisionRevocationsV2Schema,
  })
  .strict()
  .superRefine((receipt, ctx) => {
    receiptBaseIssues(receipt, ctx);
    const trustedIssuers = new Set(receipt.trustedIssuers.map((issuer) => issuer.id));
    const receiptTargets = new Set<string>(receipt.targets);
    const receiptIssuedAt = Date.parse(receipt.issuedAt);
    const decisions = new Map(receipt.decisions.map((decision) => [decision.id, decision]));
    const approvalCandidates = new Set(receipt.approvals.map((approval) => approval.candidate));

    for (const decision of receipt.decisions) {
      if (!trustedIssuers.has(decision.issuer)) {
        ctx.addIssue({ code: "custom", message: `decision ${decision.id} issuer is not trusted` });
      }
      if (
        decision.targets.some((target) => !receiptTargets.has(target as z.infer<typeof Target>))
      ) {
        ctx.addIssue({
          code: "custom",
          message: `decision ${decision.id} exceeds receipt targets`,
        });
      }
      if (Date.parse(decision.issuedAt) > receiptIssuedAt) {
        ctx.addIssue({
          code: "custom",
          message: `decision ${decision.id} was issued after the receipt`,
        });
      }
      if (approvalCandidates.has(decision.candidate)) {
        ctx.addIssue({
          code: "custom",
          message: `decision ${decision.id} candidate overlaps a legacy approval`,
        });
      }
    }
    for (const revocation of receipt.decisionRevocations) {
      const decision = decisions.get(revocation.decision);
      if (decision === undefined) {
        ctx.addIssue({
          code: "custom",
          message: `decision revocation targets unknown ${revocation.decision}`,
        });
        continue;
      }
      const revokedAt = Date.parse(revocation.revokedAt);
      if (revocation.issuer !== decision.issuer) {
        ctx.addIssue({
          code: "custom",
          message: `decision revocation issuer mismatches ${decision.id}`,
        });
      }
      if (revokedAt < Date.parse(decision.issuedAt) || revokedAt > receiptIssuedAt) {
        ctx.addIssue({
          code: "custom",
          message: `decision revocation time is invalid for ${decision.id}`,
        });
      }
    }
  });

/**
 * Strict decision-authority payload shared by the optional GitHub-attested
 * receipt transport and the administrator-protected PolicyBundle V2 transport.
 */
export const PolicyAuthorityReceiptSchema = z.discriminatedUnion("version", [
  PolicyAuthorityReceiptV1Schema,
  PolicyAuthorityReceiptV2Schema,
  PolicyAuthorityReceiptV3Schema,
]);

export type PolicyAuthorityReceipt = z.infer<typeof PolicyAuthorityReceiptSchema>;

/** Every externally-authored receipt leaf must have an authority consumer too. */
export function policyAuthorityReceiptLeafPaths(): string[] {
  return [
    ...new Set(
      schemaLeafPaths(
        z.toJSONSchema(PolicyAuthorityReceiptSchema, { io: "input" }),
        "authorityReceipt",
      ),
    ),
  ].sort((left, right) => left.localeCompare(right));
}

const V3_TRANSPORT_ONLY_PREFIX = "V3 downstream resolver: ";
const V3_ORGANIZATION_QUALIFICATION_RUNTIME_LEAVES = new Set([
  "decisionRevocations.*.decisionDigest",
  "decisionRevocations.*.revokedAt",
  "decisions.*.allowedEffects.*",
  "decisions.*.disposition",
  "decisions.*.evidence.attestor",
  "decisions.*.evidence.digest",
  "decisions.*.evidence.id",
  "decisions.*.expiresAt",
  "decisions.*.id",
  "decisions.*.issuedAt",
  "decisions.*.notBefore",
  "decisions.*.qualificationBasis.attestor",
  "decisions.*.qualificationBasis.evidenceDigest",
  "decisions.*.qualificationBasis.kind",
  "decisions.*.reviewBy",
  "decisions.*.subject.id",
  "decisions.*.subject.kind",
  "decisions.*.subject.sourceDigest",
  "decisions.*.subject.subjectDigest",
  "decisions.*.targets.*",
  "expiresAt",
  "issuedAt",
  "version",
]);

const V3_AIH_SUPPORTED_QUALIFICATION_RUNTIME_LEAVES = new Set([
  "decisions.*.qualificationBasis.catalogDigest",
  "decisions.*.qualificationBasis.catalogHeadDigest",
  "decisions.*.qualificationBasis.catalogMemberDigest",
  "decisions.*.qualificationBasis.catalogSignerIdentity",
  "decisions.*.qualificationBasis.subjectDigest",
  "decisions.*.qualificationBasis.subjectKind",
  "decisions.*.subject.source.commit",
  "decisions.*.subject.source.contentDigest",
  "decisions.*.subject.source.endpoint",
  "decisions.*.subject.source.filename",
  "decisions.*.subject.source.indexDigest",
  "decisions.*.subject.source.integrity",
  "decisions.*.subject.source.manifestDigest",
  "decisions.*.subject.source.package",
  "decisions.*.subject.source.path",
  "decisions.*.subject.source.platform.architecture",
  "decisions.*.subject.source.platform.os",
  "decisions.*.subject.source.platform.variant",
  "decisions.*.subject.source.registry",
  "decisions.*.subject.source.release",
  "decisions.*.subject.source.repository",
  "decisions.*.subject.source.revision",
  "decisions.*.subject.source.sha256",
  "decisions.*.subject.source.type",
  "decisions.*.subject.source.version",
]);

function phaseHonestV3Consumer(leaf: string, consumer: string): string {
  const detail = consumer.startsWith(V3_TRANSPORT_ONLY_PREFIX)
    ? consumer.slice(V3_TRANSPORT_ONLY_PREFIX.length)
    : consumer;
  if (V3_ORGANIZATION_QUALIFICATION_RUNTIME_LEAVES.has(leaf)) {
    return `V3 verified transport/schema validation; current organization-qualified upstream-observation runtime: ${detail}`;
  }
  if (V3_AIH_SUPPORTED_QUALIFICATION_RUNTIME_LEAVES.has(leaf)) {
    return `V3 verified transport/schema validation; current AIH-supported qualification runtime: ${detail}`;
  }
  if (!consumer.startsWith(V3_TRANSPORT_ONLY_PREFIX)) return consumer;
  return `V3 verified transport/schema validation; legacy effective resolver deliberately withholds V3 runtime use: ${consumer.slice(V3_TRANSPORT_ONLY_PREFIX.length)}`;
}

const RECEIPT_TOP_LEVEL_CONSUMERS: Readonly<Record<string, string>> = {
  "decisionRevocations.*.decision": "effective resolver: exact signed decision revocation lookup",
  "decisionRevocations.*.decisionDigest":
    "V3 downstream resolver: immutable decision revocation lookup",
  "decisionRevocations.*.format": "receipt schema: fixed signed revocation artifact protocol",
  "decisionRevocations.*.issuer": "effective resolver: exact revoking issuer binding",
  "decisionRevocations.*.reason": "signed revocation audit-only record; never authorizes an effect",
  "decisionRevocations.*.revokedAt": "effective resolver: signed decision revocation time gate",
  "decisionRevocations.*.version": "receipt schema: fixed signed revocation artifact protocol",
  "decisions.*.acceptedFindings.*": "effective resolver: exact accepted finding coverage",
  "decisions.*.acceptedGaps.*":
    "effective resolver: exact accepted named-gap coverage; empty until a consumer registers a waivable gap class",
  "decisions.*.allowedEffects.*": "V3 downstream resolver: exact allowed effect binding",
  "decisions.*.actor": "public-safe effective summary: signed decision actor audit binding",
  "decisions.*.candidate": "effective resolver: exact governed candidate binding",
  "decisions.*.control.digest": "V3 downstream resolver: exact reviewed control binding",
  "decisions.*.control.id": "V3 downstream resolver: reviewed control identity binding",
  "decisions.*.conditions.*": "public-safe effective summary: signed condition audit binding",
  "decisions.*.disposition": "effective resolver: signed disposition gate",
  "decisions.*.evidence.attestor": "V3 downstream resolver: attributable evidence attestor binding",
  "decisions.*.evidence.digest": "V3 downstream resolver: exact evidence digest binding",
  "decisions.*.evidence.id": "V3 downstream resolver: evidence record identity binding",
  "decisions.*.effects.*": "effective resolver: exact registered effect-scope binding",
  "decisions.*.evidenceDigest": "effective resolver: exact verified evidence binding",
  "decisions.*.expiresAt": "effective resolver: signed decision expiry gate",
  "decisions.*.format": "receipt schema: fixed signed decision artifact protocol",
  "decisions.*.id": "effective resolver: exact policy decision-reference lookup",
  "decisions.*.issuedAt": "authority schema: decision issuance bound to verified authority",
  "decisions.*.issuer": "effective resolver: trusted decision issuer binding",
  "decisions.*.kind": "effective resolver: exact governed kind binding",
  "decisions.*.notBefore": "effective resolver: signed decision not-before gate",
  "decisions.*.policyVersion": "effective resolver: exact policy-version binding",
  "decisions.*.policy.digest": "V3 downstream resolver: exact policy binding",
  "decisions.*.policy.id": "V3 downstream resolver: policy identity binding",
  "decisions.*.policy.version": "V3 downstream resolver: policy version binding",
  "decisions.*.qualificationBasis.attestor":
    "V3 downstream resolver: attributable organization qualification attestor binding",
  "decisions.*.qualificationBasis.catalogDigest":
    "V3 downstream resolver: exact AIH qualification catalog binding",
  "decisions.*.qualificationBasis.catalogHeadDigest":
    "V3 downstream resolver: exact AIH qualification catalog head binding",
  "decisions.*.qualificationBasis.catalogSignerIdentity":
    "V3 downstream resolver: exact AIH qualification catalog signer identity binding",
  "decisions.*.qualificationBasis.evidenceDigest":
    "V3 downstream resolver: exact organization qualification evidence binding",
  "decisions.*.qualificationBasis.kind":
    "V3 downstream resolver: qualification provenance variant binding",
  "decisions.*.qualificationBasis.catalogMemberDigest":
    "V3 downstream resolver: exact AIH qualification catalog member binding",
  "decisions.*.qualificationBasis.subjectKind":
    "V3 downstream resolver: exact AIH qualification subject-kind binding",
  "decisions.*.qualificationBasis.subjectDigest":
    "V3 downstream resolver: exact AIH qualification subject digest binding",
  "decisions.*.reason": "signed decision audit-only record; never authorizes an effect",
  "decisions.*.reviewBy": "effective resolver: accepted-risk review deadline gate",
  "decisions.*.reviewedControlDigest": "effective resolver: exact reviewed-control binding",
  "decisions.*.sourceDigest": "effective resolver: exact immutable source binding",
  "decisions.*.subject.id": "V3 downstream resolver: exact subject identity binding",
  "decisions.*.subject.kind": "V3 downstream resolver: exact subject kind binding",
  "decisions.*.subject.source.commit": "V3 downstream resolver: immutable git commit binding",
  "decisions.*.subject.source.contentDigest":
    "V3 downstream resolver: immutable remote content binding",
  "decisions.*.subject.source.filename": "V3 downstream resolver: immutable PyPI filename binding",
  "decisions.*.subject.source.indexDigest": "V3 downstream resolver: immutable OCI index binding",
  "decisions.*.subject.source.integrity": "V3 downstream resolver: immutable npm integrity binding",
  "decisions.*.subject.source.manifestDigest":
    "V3 downstream resolver: immutable OCI platform manifest binding",
  "decisions.*.subject.source.endpoint": "V3 downstream resolver: exact remote endpoint binding",
  "decisions.*.subject.source.package": "V3 downstream resolver: exact npm package binding",
  "decisions.*.subject.source.path": "V3 downstream resolver: immutable git path binding",
  "decisions.*.subject.source.platform.architecture":
    "V3 downstream resolver: OCI platform architecture binding",
  "decisions.*.subject.source.platform.os": "V3 downstream resolver: OCI platform OS binding",
  "decisions.*.subject.source.platform.variant":
    "V3 downstream resolver: OCI platform variant binding",
  "decisions.*.subject.source.registry": "V3 downstream resolver: exact npm registry binding",
  "decisions.*.subject.source.release": "V3 downstream resolver: exact AIH release binding",
  "decisions.*.subject.source.repository":
    "V3 downstream resolver: immutable git repository binding",
  "decisions.*.subject.source.revision": "V3 downstream resolver: immutable AIH revision binding",
  "decisions.*.subject.source.sha256": "V3 downstream resolver: immutable PyPI artifact binding",
  "decisions.*.subject.source.type": "V3 downstream resolver: immutable source variant binding",
  "decisions.*.subject.source.version": "V3 downstream resolver: exact npm version binding",
  "decisions.*.subject.sourceDigest": "V3 downstream resolver: exact source digest binding",
  "decisions.*.subject.subjectDigest":
    "V3 downstream resolver: exact canonical subject digest binding",
  "decisions.*.targets.*": "effective resolver: exact requested-target scope binding",
  "decisions.*.version": "receipt schema: fixed signed decision artifact protocol",
  expiresAt: "authority verifier: receipt validity and 90-day lifetime",
  format: "authority verifier: fixed receipt protocol",
  issuedAt: "authority verifier: receipt validity and 90-day lifetime",
  issuerRepository: "authority verifier: external organization root binding",
  "targets.*": "authority resolver: receipt-wide declared target coverage",
  version: "authority verifier: fixed receipt protocol",
};

const RECEIPT_ISSUER_CONSUMERS: Readonly<Record<string, string>> = {
  githubRepository: "authority resolver: signer repository binding",
  id: "authority resolver: approved issuer lookup",
};

const RECEIPT_EVIDENCE_CONSUMERS: Readonly<Record<string, string>> = {
  candidate: "authority resolver: exact candidate binding",
  "detectors.*.id": "authority resolver: detector identity report",
  "detectors.*.reportDigest": "authority resolver: detector evidence identity report",
  "detectors.*.required": "authority resolver: mandatory detector safety gate",
  "detectors.*.status": "authority resolver: mandatory detector safety gate",
  evidenceDigest: "authority resolver: exact approval and evidence binding",
  "findings.*": "authority resolver: unwaivable danger safety gate",
  id: "authority resolver: policy evidence record lookup",
  identityDigest: "authority resolver: immutable candidate identity drift gate",
  kind: "authority resolver: candidate kind binding",
  sourceDigest: "authority resolver: exact immutable source digest binding",
  state: "authority resolver: evidence/approval activation decision",
  waivable: "authority resolver: only waivable evidence gap approval gate",
};

const RECEIPT_SOURCE_CONSUMERS: Readonly<Record<string, string>> = {
  "approval.allowedDataClasses.*": "authority resolver: exact remote source binding",
  "approval.approvedBy": "authority resolver: exact remote source binding",
  "approval.authenticationMode": "authority resolver: exact remote source binding",
  administrativeStatus: "authority resolver: administrator-managed remote availability binding",
  contentScanned: "authority resolver: exact remote source binding",
  "args.*": "authority resolver: immutable source binding",
  command: "authority resolver: immutable source binding",
  commit: "authority resolver: immutable source binding",
  executableDigest: "authority resolver: immutable source binding",
  handler: "authority resolver: immutable source binding",
  integrity: "authority resolver: immutable package integrity binding",
  origin: "authority resolver: exact remote HTTPS origin binding",
  package: "authority resolver: canonical package launch binding",
  registry: "authority resolver: canonical registry launch binding",
  repository: "authority resolver: immutable source binding",
  resolver: "authority resolver: canonical package resolver binding",
  scriptDigest: "authority resolver: immutable source binding",
  server: "authority resolver: immutable source binding",
  subject: "authority resolver: immutable source binding",
  toolSurfaceDigest: "authority resolver: exact remote tool-surface binding",
  tree: "authority resolver: immutable source binding",
  type: "authority resolver: source union binding",
  verdict: "authority resolver: exact remote verdict binding",
  version: "authority resolver: canonical exact version binding",
};

const RECEIPT_APPROVAL_CONSUMERS: Readonly<Record<string, string>> = {
  candidate: "authority resolver: exact candidate binding",
  clarification: "authority resolver: signed clarification binding and effective report",
  evidenceDigest: "authority resolver: exact verified evidence binding",
  expiresAt: "authority resolver: approval expiry and maximum lifetime gate",
  "github.attestationId": "effective report: signed receipt transport locator",
  "github.repository": "authority resolver: approved signer repository binding",
  "github.subjectDigest": "authority resolver: full approval subject digest",
  id: "authority resolver: exact receipt and revocation lookup",
  issuer: "authority resolver: trusted issuer lookup",
  kind: "authority resolver: candidate kind binding",
  notBefore: "authority resolver: approval not-before and lifetime gate",
  policyVersion: "authority resolver: policy-version binding",
  projector: "authority resolver: projector/control binding",
  reason: "authority resolver: signed reason and effective report",
  "scope.*": "authority resolver: signed target scope binding",
  sourceDigest: "authority resolver: exact source digest binding",
};

const RECEIPT_REVOCATION_CONSUMERS: Readonly<Record<string, string>> = {
  approval: "authority resolver: revoked approval lookup",
  issuer: "authority resolver: revoked issuer binding",
  reason: "effective report: revocation audit record",
  revokedAt: "authority resolver: revocation time gate",
};

function prefixedReceiptConsumers(
  prefix: string,
  values: Readonly<Record<string, string>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(values).map(([leaf, consumer]) => [`${prefix}.${leaf}`, consumer]),
  );
}

/** Exact map compared to `policyAuthorityReceiptLeafPaths()` by the consumer-contract test. */
export const POLICY_AUTHORITY_RECEIPT_FIELD_CONSUMERS: Readonly<Record<string, string>> =
  Object.freeze({
    ...prefixedReceiptConsumers(
      "authorityReceipt",
      Object.fromEntries(
        Object.entries(RECEIPT_TOP_LEVEL_CONSUMERS).map(([leaf, consumer]) => [
          leaf,
          phaseHonestV3Consumer(leaf, consumer),
        ]),
      ),
    ),
    ...prefixedReceiptConsumers("authorityReceipt.trustedIssuers.*", RECEIPT_ISSUER_CONSUMERS),
    ...prefixedReceiptConsumers("authorityReceipt.evidence.*", RECEIPT_EVIDENCE_CONSUMERS),
    ...prefixedReceiptConsumers("authorityReceipt.evidence.*.source", RECEIPT_SOURCE_CONSUMERS),
    ...prefixedReceiptConsumers("authorityReceipt.approvals.*", RECEIPT_APPROVAL_CONSUMERS),
    ...prefixedReceiptConsumers("authorityReceipt.approvals.*.source", RECEIPT_SOURCE_CONSUMERS),
    ...prefixedReceiptConsumers("authorityReceipt.revocations.*", RECEIPT_REVOCATION_CONSUMERS),
  });

const verifiedAuthorities = new WeakSet<object>();

function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value as object)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Opaque result: only `verifyPolicyAuthorityReceipt` can mint a usable authority object. */
export interface VerifiedPolicyAuthority {
  readonly receipt: PolicyAuthorityReceipt;
  readonly receiptDigest: string;
  readonly repository: string;
  /** Optional signer-workflow root verified with the authority receipt. */
  readonly workflow?: string;
  /** Transport that established the opaque authority capability. */
  readonly source?: "github-attestation" | "policy-file";
  /** Exact transaction pin for the verified source file. */
  readonly sourceAssertion?: FileAssertion;
}

export function isVerifiedPolicyAuthority(value: unknown): value is VerifiedPolicyAuthority {
  return typeof value === "object" && value !== null && verifiedAuthorities.has(value);
}

/** Read-only transaction pin for the exact no-follow authority receipt just verified. */
export function verifiedPolicyAuthorityReceiptAssertionV1(
  authority: VerifiedPolicyAuthority,
): FileAssertion | undefined {
  if (
    !isVerifiedPolicyAuthority(authority) ||
    !/^sha256:[0-9a-f]{64}$/.test(authority.receiptDigest)
  )
    return undefined;
  return authority.sourceAssertion === undefined
    ? {
        path: POLICY_AUTHORITY_RECEIPT_PATH,
        sha256: authority.receiptDigest.slice("sha256:".length),
        maxBytes: MAX_ORG_POLICY_BYTES,
        describe: "assert verified policy authority receipt remains exact",
      }
    : { ...authority.sourceAssertion };
}

export interface PolicyAuthorityVerification {
  authority?: VerifiedPolicyAuthority;
  /** Deliberately scrubbed: trust-verifier child output may contain credentials. */
  problem?: string;
}

function externalAuthorityRoot(
  ctx: PlanContext,
): { repository: string; workflow?: string } | undefined {
  const repository = ctx.env.AIH_POLICY_AUTHORITY_REPOSITORY?.trim();
  if (repository === undefined || !Repository.safeParse(repository).success) return undefined;
  const workflow = ctx.env.AIH_POLICY_AUTHORITY_WORKFLOW?.trim();
  const hasControl =
    workflow !== undefined &&
    [...workflow].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 0x20 || code === 0x7f;
    });
  if (workflow !== undefined && (workflow.length === 0 || workflow.length > 1_000 || hasControl)) {
    return undefined;
  }
  return { repository, ...(workflow === undefined ? {} : { workflow }) };
}

function receiptHasSymlinkParent(root: string): boolean {
  const parts = POLICY_AUTHORITY_RECEIPT_PATH.split("/");
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) return true;
    } catch {
      return false;
    }
  }
  return false;
}

interface CustodiedPathIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

interface CustodiedAuthorityReceipt {
  readonly contents: Buffer;
  readonly root: CustodiedPathIdentity;
  readonly parent: CustodiedPathIdentity;
  readonly file: CustodiedPathIdentity;
}

function safeDirectoryIdentity(path: string): CustodiedPathIdentity | undefined {
  try {
    const stats = lstatSync(path, { bigint: true });
    if (stats.isSymbolicLink() || !stats.isDirectory() || stats.dev === 0n || stats.ino === 0n) {
      return undefined;
    }
    return { dev: stats.dev, ino: stats.ino };
  } catch {
    return undefined;
  }
}

function sameCustodiedPath(left: CustodiedPathIdentity, right: CustodiedPathIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

/**
 * Capture the fixed receipt through one no-follow descriptor and pin every path
 * component that makes those bytes reachable. The descriptor stats ensure a
 * regular, single-link file; the path stat immediately after the read closes
 * the path-replacement window before the external verifier consumes its copy.
 */
function readCustodiedAuthorityReceipt(
  root: string,
  path: string,
): CustodiedAuthorityReceipt | undefined {
  const rootIdentity = safeDirectoryIdentity(root);
  const parentIdentity = safeDirectoryIdentity(join(root, ".aih"));
  if (rootIdentity === undefined || parentIdentity === undefined) return undefined;

  const read = readRegularFileWithStats(path, { maxBytes: MAX_ORG_POLICY_BYTES });
  if (
    read === undefined ||
    read.identity.dev === 0n ||
    read.identity.ino === 0n ||
    read.identity.nlink !== 1n
  ) {
    return undefined;
  }
  try {
    const current = lstatSync(path, { bigint: true });
    if (
      current.isSymbolicLink() ||
      !current.isFile() ||
      current.dev === 0n ||
      current.ino === 0n ||
      current.nlink !== 1n ||
      current.dev !== read.identity.dev ||
      current.ino !== read.identity.ino
    ) {
      return undefined;
    }
  } catch {
    return undefined;
  }
  return {
    contents: read.contents,
    root: rootIdentity,
    parent: parentIdentity,
    file: { dev: read.identity.dev, ino: read.identity.ino },
  };
}

function sameCustodiedAuthorityReceipt(
  left: CustodiedAuthorityReceipt,
  right: CustodiedAuthorityReceipt,
): boolean {
  return (
    left.contents.equals(right.contents) &&
    sameCustodiedPath(left.root, right.root) &&
    sameCustodiedPath(left.parent, right.parent) &&
    sameCustodiedPath(left.file, right.file)
  );
}

interface CustodiedExternalPolicyBundle {
  readonly contents: Buffer;
  readonly parents: readonly ({ readonly path: string } & CustodiedPathIdentity)[];
  readonly file: CustodiedPathIdentity;
}

function custodiedAbsoluteParentChain(
  path: string,
): readonly ({ readonly path: string } & CustodiedPathIdentity)[] | undefined {
  const absolute = resolve(path);
  const volumeRoot = parsePath(absolute).root;
  const parent = dirname(absolute);
  const rel = relative(volumeRoot, parent);
  if (rel.startsWith("..") || isAbsolute(rel)) return undefined;
  const chain: ({ path: string } & CustodiedPathIdentity)[] = [];
  let current = volumeRoot;
  const capture = (): boolean => {
    const identity = safeDirectoryIdentity(current);
    if (identity === undefined) return false;
    chain.push({ path: current, ...identity });
    return true;
  };
  if (!capture()) return undefined;
  for (const segment of rel.split(/[\\/]+/).filter((part) => part.length > 0)) {
    current = join(current, segment);
    if (!capture()) return undefined;
  }
  return chain;
}

function hasSymlinkedAbsoluteParent(path: string): boolean {
  const absolute = resolve(path);
  const root = parsePath(absolute).root;
  const parent = dirname(absolute);
  const rel = relative(root, parent);
  if (rel.startsWith("..") || isAbsolute(rel)) return true;
  let current = root;
  for (const part of rel.split(/[\\/]+/).filter((segment) => segment.length > 0)) {
    current = join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) return true;
    } catch {
      return true;
    }
  }
  return false;
}

function pathIsInside(root: string, path: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function readCustodiedExternalPolicyBundle(
  path: string,
): CustodiedExternalPolicyBundle | undefined {
  const parents = custodiedAbsoluteParentChain(path);
  if (parents === undefined) return undefined;
  const read = readRegularFileWithStats(path, { maxBytes: MAX_ORG_POLICY_BYTES });
  if (
    read === undefined ||
    read.identity.dev === 0n ||
    read.identity.ino === 0n ||
    read.identity.nlink !== 1n
  ) {
    return undefined;
  }
  try {
    const current = lstatSync(path, { bigint: true });
    if (
      current.isSymbolicLink() ||
      !current.isFile() ||
      current.dev === 0n ||
      current.ino === 0n ||
      current.nlink !== 1n ||
      current.dev !== read.identity.dev ||
      current.ino !== read.identity.ino
    ) {
      return undefined;
    }
  } catch {
    return undefined;
  }
  return {
    contents: read.contents,
    parents,
    file: { dev: read.identity.dev, ino: read.identity.ino },
  };
}

function sameCustodiedExternalPolicyBundle(
  left: CustodiedExternalPolicyBundle,
  right: CustodiedExternalPolicyBundle,
): boolean {
  return (
    left.contents.equals(right.contents) &&
    left.parents.length === right.parents.length &&
    left.parents.every((parent, index) => {
      const current = right.parents[index];
      return (
        current !== undefined && parent.path === current.path && sameCustodiedPath(parent, current)
      );
    }) &&
    sameCustodiedPath(left.file, right.file)
  );
}

type ProtectedPolicyFileAuthority =
  | { state: "absent" }
  | { state: "problem"; problem: string }
  | { state: "verified"; authority: VerifiedPolicyAuthority };

/**
 * A V2 active policy bundle is itself the authority transport when an
 * administrator supplies it as one absolute file outside the governed target.
 * Core does not claim to prove the host ACL: read-only distribution is the
 * administrator's trust root. Core proves only exact no-follow custody and
 * pins those same bytes across every local transaction.
 */
function protectedPolicyFileAuthority(ctx: PlanContext): ProtectedPolicyFileAuthority {
  if (!hasExplicitOrgPolicySource(ctx.env)) return { state: "absent" };
  const configured = ctx.env.AIH_ORG_POLICY?.trim();
  if (configured === undefined) return { state: "absent" };
  const path = orgPolicyPath(ctx.root, ctx.env);
  const candidate = readRegularFileWithStats(path, { maxBytes: MAX_ORG_POLICY_BYTES });
  if (candidate === undefined) {
    try {
      const stats = lstatSync(path, { bigint: true });
      if (stats.size > BigInt(MAX_ORG_POLICY_BYTES)) {
        return {
          state: "problem",
          problem: `protected policy bundle authority exceeds the ${MAX_ORG_POLICY_BYTES.toLocaleString("en-US")}-byte safety limit`,
        };
      }
    } catch {
      // The fail-closed custody diagnostic below also covers a missing path.
    }
    return {
      state: "problem",
      problem: "protected policy bundle authority has unsafe file custody",
    };
  }

  let value: unknown;
  try {
    value = parseNativeStrictJsonObjectV1(
      new TextDecoder("utf-8", { fatal: true }).decode(candidate.contents),
      "protected policy bundle authority",
    );
  } catch {
    return { state: "problem", problem: "protected policy bundle authority is malformed" };
  }
  const looksLikeV2Bundle =
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as { schemaVersion?: unknown }).schemaVersion === 2 &&
    Object.hasOwn(value, "bundleVersion") &&
    Object.hasOwn(value, "policy");
  const parsed = parsePolicyBundle(value);
  if (!parsed.ok) {
    return looksLikeV2Bundle
      ? { state: "problem", problem: "protected policy bundle authority is malformed" }
      : OrgPolicySchema.safeParse(value).success
        ? { state: "absent" }
        : { state: "problem", problem: "explicit organization policy is malformed" };
  }
  if (parsed.bundle.schemaVersion !== 2) return { state: "absent" };
  if (!isAbsolute(configured) || pathIsInside(ctx.root, path)) {
    return {
      state: "problem",
      problem:
        "protected policy bundle authority requires an absolute file outside the governed target",
    };
  }
  if (hasSymlinkedAbsoluteParent(path)) {
    return {
      state: "problem",
      problem: "protected policy bundle authority has unsafe file custody",
    };
  }
  const observed = readCustodiedExternalPolicyBundle(path);
  if (observed === undefined || !observed.contents.equals(candidate.contents)) {
    return {
      state: "problem",
      problem: "protected policy bundle authority has unsafe file custody",
    };
  }
  const now = Date.now();
  const receipt = parsed.bundle.authorityReceipt;
  if (now < Date.parse(receipt.issuedAt) || now >= Date.parse(receipt.expiresAt)) {
    return {
      state: "problem",
      problem: "protected policy bundle authority is not currently valid",
    };
  }
  const reobserved = readCustodiedExternalPolicyBundle(path);
  if (reobserved === undefined || !sameCustodiedExternalPolicyBundle(observed, reobserved)) {
    return {
      state: "problem",
      problem: "protected policy bundle authority has unsafe file custody",
    };
  }
  const digest = createHash("sha256").update(observed.contents).digest("hex");
  const authority: VerifiedPolicyAuthority = Object.freeze({
    receipt: deepFreeze(structuredClone(receipt)) as PolicyAuthorityReceipt,
    receiptDigest: `sha256:${digest}`,
    repository: receipt.issuerRepository,
    source: "policy-file" as const,
    sourceAssertion: Object.freeze({
      path,
      sha256: digest,
      maxBytes: MAX_ORG_POLICY_BYTES,
      describe: "verified policy authority policy file",
      external: true as const,
      trustedBase: dirname(path),
      externalCustody: deepFreeze({
        file: { dev: observed.file.dev.toString(10), ino: observed.file.ino.toString(10) },
        parents: observed.parents.map((parent) => ({
          path: parent.path,
          dev: parent.dev.toString(10),
          ino: parent.ino.toString(10),
        })),
      }),
    }),
  });
  verifiedAuthorities.add(authority);
  return { state: "verified", authority };
}

export interface VerifiedPolicyAuthoritySourceCustodyV1 {
  readonly assertion: FileAssertion;
  readonly rawDigest: string;
  unchanged(): boolean;
}

/** Re-open the opaque authority source for same-invocation live custody checks. */
export function verifiedPolicyAuthoritySourceCustodyV1(
  ctx: PlanContext,
  authority: VerifiedPolicyAuthority,
): VerifiedPolicyAuthoritySourceCustodyV1 | undefined {
  const assertion = verifiedPolicyAuthorityReceiptAssertionV1(authority);
  if (assertion === undefined) return undefined;
  const expectedDigest = `sha256:${assertion.sha256}`;
  if (expectedDigest !== authority.receiptDigest) return undefined;
  if (assertion.external === true) {
    if (
      assertion.trustedBase === undefined ||
      hasSymlinkedAbsoluteParent(assertion.path) ||
      resolve(assertion.trustedBase) !== resolve(dirname(assertion.path))
    ) {
      return undefined;
    }
    const observed = readCustodiedExternalPolicyBundle(assertion.path);
    if (
      observed === undefined ||
      createHash("sha256").update(observed.contents).digest("hex") !== assertion.sha256
    ) {
      return undefined;
    }
    return {
      assertion,
      rawDigest: expectedDigest,
      unchanged: () => {
        const current = readCustodiedExternalPolicyBundle(assertion.path);
        return current !== undefined && sameCustodiedExternalPolicyBundle(observed, current);
      },
    };
  }
  if (assertion.path !== POLICY_AUTHORITY_RECEIPT_PATH) return undefined;
  const observed = readCustodiedAuthorityReceipt(ctx.root, join(ctx.root, assertion.path));
  if (
    observed === undefined ||
    createHash("sha256").update(observed.contents).digest("hex") !== assertion.sha256
  ) {
    return undefined;
  }
  return {
    assertion,
    rawDigest: expectedDigest,
    unchanged: () => {
      const current = readCustodiedAuthorityReceipt(ctx.root, join(ctx.root, assertion.path));
      return current !== undefined && sameCustodiedAuthorityReceipt(observed, current);
    },
  };
}

/**
 * Mint current organization authority from either an explicitly selected,
 * administrator-protected PolicyBundle V2 outside the target or the legacy
 * fixed GitHub-attested receipt. The file transport is exact-byte and
 * transaction pinned; the deployment, not Core, owns its host ACL.
 */
export async function verifyPolicyAuthorityReceipt(
  ctx: PlanContext,
): Promise<PolicyAuthorityVerification> {
  const policyFile = protectedPolicyFileAuthority(ctx);
  if (policyFile.state === "problem") return { problem: policyFile.problem };
  if (policyFile.state === "verified") return { authority: policyFile.authority };
  const root = externalAuthorityRoot(ctx);
  if (root === undefined) {
    return {
      problem:
        "external organization authority registry is unavailable (set AIH_POLICY_AUTHORITY_REPOSITORY outside the governed checkout)",
    };
  }
  const path = join(ctx.root, POLICY_AUTHORITY_RECEIPT_PATH);
  if (receiptHasSymlinkParent(ctx.root)) {
    return {
      problem: `verified authority receipt ${POLICY_AUTHORITY_RECEIPT_PATH} has an unsafe symlinked parent`,
    };
  }
  const observed = readCustodiedAuthorityReceipt(ctx.root, path);
  if (observed === undefined) {
    try {
      if (lstatSync(path).isSymbolicLink()) {
        return {
          problem: `verified authority receipt ${POLICY_AUTHORITY_RECEIPT_PATH} is an unsafe symlink`,
        };
      }
    } catch {
      // The normal unavailable diagnostic below covers a missing receipt.
    }
    return {
      problem: `verified authority receipt ${POLICY_AUTHORITY_RECEIPT_PATH} is unavailable`,
    };
  }
  let receipt: PolicyAuthorityReceipt;
  try {
    receipt = PolicyAuthorityReceiptSchema.parse(JSON.parse(observed.contents.toString("utf8")));
  } catch {
    return { problem: `verified authority receipt ${POLICY_AUTHORITY_RECEIPT_PATH} is malformed` };
  }
  if (receipt.issuerRepository !== root.repository) {
    return {
      problem:
        "authority receipt issuer does not match the external organization authority registry",
    };
  }
  const now = Date.now();
  if (now < Date.parse(receipt.issuedAt) || now >= Date.parse(receipt.expiresAt)) {
    return { problem: "authority receipt is not currently valid" };
  }
  let verified: Awaited<ReturnType<PlanContext["run"]>>;
  let verifierDir: string | undefined;
  try {
    // Verify an exclusive private copy of the exact no-follow bytes we parsed;
    // a live receipt path could otherwise be swapped between parse and `gh`.
    verifierDir = mkdtempSync(join(tmpdir(), "aih-policy-authority-"));
    const verifierPath = join(verifierDir, "receipt.json");
    writeFileSync(verifierPath, observed.contents, { flag: "wx", mode: 0o600 });
    // Never let exec lookup fall back to the governed checkout's cwd. In
    // particular, Windows SearchPath would otherwise prefer a malicious
    // `gh.exe` planted at the repository root over the organization toolchain.
    const gh = findOnPath("gh", ctx.env, process.platform, {
      excludeRoot: ctx.root,
      // `execFile` does not safely execute command shims. Authority verification
      // accepts only a native executable on Windows.
      windowsExeOnly: true,
    });
    if (gh === undefined)
      return { problem: "GitHub authority verifier is unavailable on absolute PATH" };
    const argv = [gh, "attestation", "verify", verifierPath, "--repo", root.repository];
    if (root.workflow !== undefined) argv.push("--signer-workflow", root.workflow);
    verified = await ctx.run(argv, { cwd: ctx.root });
  } catch {
    return { problem: "GitHub authority receipt attestation could not be verified" };
  } finally {
    if (verifierDir !== undefined) {
      try {
        rmSync(verifierDir, { recursive: true, force: true });
      } catch {
        // Receipts must not contain credentials. A cleanup failure does not
        // change the verified byte-binding verdict above.
      }
    }
  }
  if (verified.spawnError || verified.code !== 0) {
    return { problem: "GitHub authority receipt attestation could not be verified" };
  }
  const reobserved = readCustodiedAuthorityReceipt(ctx.root, path);
  if (reobserved === undefined || !sameCustodiedAuthorityReceipt(observed, reobserved)) {
    return { problem: "GitHub authority receipt attestation could not be verified" };
  }
  const authority: VerifiedPolicyAuthority = Object.freeze({
    receipt: deepFreeze(structuredClone(receipt)) as PolicyAuthorityReceipt,
    receiptDigest: `sha256:${createHash("sha256").update(observed.contents).digest("hex")}`,
    repository: root.repository,
    ...(root.workflow === undefined ? {} : { workflow: root.workflow }),
    source: "github-attestation" as const,
    sourceAssertion: Object.freeze({
      path: POLICY_AUTHORITY_RECEIPT_PATH,
      sha256: createHash("sha256").update(observed.contents).digest("hex"),
      maxBytes: MAX_ORG_POLICY_BYTES,
      describe: "verified policy authority receipt",
    }),
  });
  verifiedAuthorities.add(authority);
  return { authority };
}
