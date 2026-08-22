import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { readRegularFile } from "../internals/fsxn.js";
import type { PlanContext } from "../internals/plan.js";
import { findOnPath } from "../live/runner.js";
import {
  GovernanceDecisionRevocationV1Schema,
  GovernanceDecisionTimestampSchema,
  GovernanceDecisionV1Schema,
} from "./governance-decision-v1.js";
import {
  GovernanceDecisionRevocationV2Schema,
  GovernanceDecisionTargetV2Schema,
  GovernanceDecisionV2Schema,
  governanceDecisionDigestV2,
} from "./governance-decision-v2.js";
import {
  CandidateSourceSchema,
  PolicyApprovalSchema,
  PolicyDangerCodeSchema,
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

function sortedUniqueByString(items: readonly string[]): boolean {
  return sortedUniqueBy(items, (item) => item);
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

const ReceiptDecisionsV3Schema = z
  .array(GovernanceDecisionV2Schema)
  .max(64)
  .superRefine((decisions, ctx) => {
    if (!sortedUniqueBy(decisions, (decision) => decision.id)) {
      ctx.addIssue({
        code: "custom",
        message: "decisions must be ordinal-sorted and unique by id",
      });
    }
    const digests = decisions.map(governanceDecisionDigestV2);
    if (new Set(digests).size !== digests.length) {
      ctx.addIssue({ code: "custom", message: "decisions must be unique by immutable digest" });
    }
  });
const ReceiptDecisionRevocationsV3Schema = z
  .array(GovernanceDecisionRevocationV2Schema)
  .max(64)
  .refine(
    (revocations) => sortedUniqueBy(revocations, (revocation) => revocation.decisionDigest),
    "decisionRevocations must be ordinal-sorted and unique by immutable decision digest",
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
 * V3 is deliberately decision-only: it cannot carry V1/V2 approvals,
 * revocations, or evidence. A verified attestation is still required before
 * this parsed data becomes a usable authority object.
 */
const PolicyAuthorityReceiptV3Schema = z
  .object({
    format: z.literal("aih-policy-authority-receipt"),
    version: z.literal(3),
    issuerRepository: Repository,
    issuedAt: GovernanceDecisionTimestampSchema,
    expiresAt: GovernanceDecisionTimestampSchema,
    trustedIssuers: z
      .array(ReceiptIssuerSchema)
      .min(1)
      .max(64)
      .refine(
        (issuers) => sortedUniqueBy(issuers, (issuer) => issuer.id),
        "trustedIssuers must be ordinal-sorted and unique by id",
      ),
    targets: z
      .array(GovernanceDecisionTargetV2Schema)
      .min(1)
      .max(64)
      .refine(sortedUniqueByString, "targets must be ordinal-sorted and unique"),
    decisions: ReceiptDecisionsV3Schema,
    decisionRevocations: ReceiptDecisionRevocationsV3Schema,
  })
  .strict()
  .superRefine((receipt, ctx) => {
    const issuedAt = Date.parse(receipt.issuedAt);
    const expiresAt = Date.parse(receipt.expiresAt);
    if (expiresAt <= issuedAt) {
      ctx.addIssue({ code: "custom", message: "receipt expiresAt must be after issuedAt" });
    }
    if (expiresAt - issuedAt > 90 * 24 * 60 * 60 * 1000) {
      ctx.addIssue({ code: "custom", message: "receipt lifetime must not exceed 90 days" });
    }
    const trustedIssuers = new Set(receipt.trustedIssuers.map((issuer) => issuer.id));
    const receiptTargets = new Set<string>(receipt.targets);
    const decisions = new Map(
      receipt.decisions.map((decision) => [governanceDecisionDigestV2(decision), decision]),
    );
    for (const decision of receipt.decisions) {
      const digest = governanceDecisionDigestV2(decision);
      if (!trustedIssuers.has(decision.issuer)) {
        ctx.addIssue({ code: "custom", message: `decision ${digest} issuer is not trusted` });
      }
      if (decision.targets.some((target) => !receiptTargets.has(target))) {
        ctx.addIssue({ code: "custom", message: `decision ${digest} exceeds receipt targets` });
      }
      if (Date.parse(decision.issuedAt) > issuedAt || Date.parse(decision.expiresAt) > expiresAt) {
        ctx.addIssue({ code: "custom", message: `decision ${digest} is outside receipt validity` });
      }
    }
    for (const revocation of receipt.decisionRevocations) {
      const decision = decisions.get(revocation.decisionDigest);
      if (decision === undefined) {
        ctx.addIssue({
          code: "custom",
          message: `decision revocation targets unknown ${revocation.decisionDigest}`,
        });
        continue;
      }
      const revokedAt = Date.parse(revocation.revokedAt);
      if (revocation.issuer !== decision.issuer) {
        ctx.addIssue({ code: "custom", message: "decision revocation issuer mismatches decision" });
      }
      if (revokedAt < Date.parse(decision.issuedAt) || revokedAt > issuedAt) {
        ctx.addIssue({ code: "custom", message: "decision revocation time is invalid" });
      }
    }
  });

/** Strict external authority receipt contract; policy JSON cannot supply these facts. */
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
  "decisions.*.issuedAt":
    "receipt schema: decision issuance bound to the externally verified receipt",
  "decisions.*.issuer": "effective resolver: trusted decision issuer binding",
  "decisions.*.kind": "effective resolver: exact governed kind binding",
  "decisions.*.notBefore": "effective resolver: signed decision not-before gate",
  "decisions.*.policyVersion": "effective resolver: exact policy-version binding",
  "decisions.*.policy.digest": "V3 downstream resolver: exact policy binding",
  "decisions.*.policy.id": "V3 downstream resolver: policy identity binding",
  "decisions.*.policy.version": "V3 downstream resolver: policy version binding",
  "decisions.*.qualification":
    "V3 downstream resolver: approval provenance only; never unqualified",
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
  "decisions.*.subject.source.origin": "V3 downstream resolver: exact remote origin binding",
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
    ...prefixedReceiptConsumers("authorityReceipt", RECEIPT_TOP_LEVEL_CONSUMERS),
    ...prefixedReceiptConsumers("authorityReceipt.trustedIssuers.*", RECEIPT_ISSUER_CONSUMERS),
    ...prefixedReceiptConsumers("authorityReceipt.evidence.*", RECEIPT_EVIDENCE_CONSUMERS),
    ...prefixedReceiptConsumers("authorityReceipt.evidence.*.source", RECEIPT_SOURCE_CONSUMERS),
    ...prefixedReceiptConsumers("authorityReceipt.approvals.*", RECEIPT_APPROVAL_CONSUMERS),
    ...prefixedReceiptConsumers("authorityReceipt.approvals.*.source", RECEIPT_SOURCE_CONSUMERS),
    ...prefixedReceiptConsumers("authorityReceipt.revocations.*", RECEIPT_REVOCATION_CONSUMERS),
  });

const verifiedAuthorities = new WeakSet<object>();

/** Opaque result: only `verifyPolicyAuthorityReceipt` can mint a usable authority object. */
export interface VerifiedPolicyAuthority {
  readonly receipt: PolicyAuthorityReceipt;
  readonly receiptDigest: string;
  readonly repository: string;
}

export function isVerifiedPolicyAuthority(value: unknown): value is VerifiedPolicyAuthority {
  return typeof value === "object" && value !== null && verifiedAuthorities.has(value);
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

/**
 * Verify the fixed authority receipt against an organization-admin registry set
 * outside the target checkout (`AIH_POLICY_AUTHORITY_REPOSITORY`, optionally
 * `AIH_POLICY_AUTHORITY_WORKFLOW`). The governed repository's origin and its
 * policy JSON are never trust roots. The receipt remains untrusted data until
 * `gh attestation verify` succeeds against that exact external identity.
 */
export async function verifyPolicyAuthorityReceipt(
  ctx: PlanContext,
): Promise<PolicyAuthorityVerification> {
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
  const contents = readRegularFile(path, { maxBytes: 1_000_000 });
  if (contents === undefined) {
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
    receipt = PolicyAuthorityReceiptSchema.parse(JSON.parse(contents.toString("utf8")));
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
    writeFileSync(verifierPath, contents, { flag: "wx", mode: 0o600 });
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
  const authority: VerifiedPolicyAuthority = Object.freeze({
    receipt,
    receiptDigest: `sha256:${createHash("sha256").update(contents).digest("hex")}`,
    repository: root.repository,
  });
  verifiedAuthorities.add(authority);
  return { authority };
}
