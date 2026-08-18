import { canonicalStrictJsonBytesV1, deepFreezeStrictJsonV1 } from "../contract/strict-json-v1.js";
import {
  canonicalGovernanceDoctorAuditV1Bytes,
  canonicalGovernanceDoctorGuideV1Bytes,
  type GovernanceDoctorAuditedV1,
  type GovernanceDoctorAuditRefusalStateV1,
  type GovernanceDoctorAuditV1Result,
  type GovernanceDoctorGuideAvailableV1,
  type GovernanceDoctorGuideV1,
  type GovernanceDoctorGuideWithheldV1,
} from "./audit-guide-v1.js";
import {
  assertArrayV1,
  assertEnumV1,
  assertExactKeysV1,
  assertReadOnlyDiagnosticIdV1,
  assertRecordV1,
  assertSha256V1,
  assertTokenV1,
  failGovernanceDoctorV1,
  GOVERNANCE_DOCTOR_QUALIFIED_ID_PATTERN,
  GOVERNANCE_DOCTOR_V1_LIMITS,
  governanceDoctorSha256V1,
} from "./capability-v1.js";

/** Capability-free canonical binding emitted by the operational adapter. */
export interface GovernanceDoctorOperationCompletedV1 {
  readonly auditSha256: string;
  readonly contextSha256: string;
  readonly dispatchedDiagnosticIds: readonly string[];
  readonly guideSha256: string;
  readonly kind: "completed";
  readonly operationSha256: string;
  readonly policyRevisionSha256: string;
  readonly profileSha256: string;
  readonly protocol: "GovernanceDoctorOperationV1";
  readonly rootSha256: string;
  readonly surfaceRevisionSha256: string;
  readonly targetId: string;
}

export interface GovernanceDoctorOperationRefusedV1 {
  readonly actionable: false;
  readonly auditSha256: string;
  readonly contextSha256: string;
  readonly guideSha256: string;
  readonly kind: "refused";
  readonly operationSha256: string;
  readonly policyRevisionSha256: string;
  readonly profileSha256: string;
  readonly protocol: "GovernanceDoctorOperationV1";
  readonly rootSha256: string;
  readonly state: GovernanceDoctorAuditRefusalStateV1;
  readonly surfaceRevisionSha256: string;
  readonly targetId: string;
}

export type GovernanceDoctorOperationRecordV1 =
  | GovernanceDoctorOperationCompletedV1
  | GovernanceDoctorOperationRefusedV1;

const OPERATION_DOMAIN = "aih.governance-doctor-operation-v1";
const operationBytes = new WeakMap<object, Buffer>();

/** Mints only an exactly joined branded Audit/Guide operation binding. */
export function createGovernanceDoctorOperationV1Record(
  input: unknown,
): GovernanceDoctorOperationRecordV1 {
  const request = assertRecordV1(input, "governance doctor operation record request");
  assertExactKeysV1(
    request,
    ["audit", "guide", "record"],
    "governance doctor operation record request",
  );
  canonicalGovernanceDoctorAuditV1Bytes(request.audit);
  canonicalGovernanceDoctorGuideV1Bytes(request.guide);
  const audit = request.audit as GovernanceDoctorAuditV1Result;
  const guide = request.guide as GovernanceDoctorGuideV1;
  const body = assertRecordV1(request.record, "governance doctor operation record");
  const completed = body.kind === "completed";
  assertExactKeysV1(
    body,
    completed
      ? [
          "auditSha256",
          "contextSha256",
          "dispatchedDiagnosticIds",
          "guideSha256",
          "kind",
          "policyRevisionSha256",
          "profileSha256",
          "protocol",
          "rootSha256",
          "surfaceRevisionSha256",
          "targetId",
        ]
      : [
          "actionable",
          "auditSha256",
          "contextSha256",
          "guideSha256",
          "kind",
          "policyRevisionSha256",
          "profileSha256",
          "protocol",
          "rootSha256",
          "state",
          "surfaceRevisionSha256",
          "targetId",
        ],
    "governance doctor operation record",
  );
  if (
    body.protocol !== "GovernanceDoctorOperationV1" ||
    (body.kind !== "completed" && body.kind !== "refused") ||
    body.auditSha256 !== audit.auditSha256 ||
    body.guideSha256 !== guide.guideSha256 ||
    body.profileSha256 !== audit.profileSha256 ||
    body.policyRevisionSha256 !== audit.policyRevisionSha256
  )
    failGovernanceDoctorV1("governance doctor operation identities do not join");
  if (completed) {
    const audited = audit as GovernanceDoctorAuditedV1;
    const available = guide as GovernanceDoctorGuideAvailableV1;
    if (
      audited.kind !== "audited" ||
      available.kind !== "available" ||
      available.auditSha256 !== audited.auditSha256 ||
      available.profileSha256 !== audited.profileSha256 ||
      available.policy.revisionSha256 !== audited.policyRevisionSha256 ||
      body.targetId !== available.targetId
    )
      failGovernanceDoctorV1("governance doctor operation identities do not join");
    const dispatched = assertArrayV1(
      body.dispatchedDiagnosticIds,
      1,
      GOVERNANCE_DOCTOR_V1_LIMITS.maxFindings,
      "governance doctor operation dispatched diagnostics",
    ).map((id) => assertReadOnlyDiagnosticIdV1(id, "governance doctor operation diagnostic ID"));
    if (new Set(dispatched).size !== dispatched.length)
      failGovernanceDoctorV1("governance doctor operation diagnostics must be unique");
  } else {
    const refusedAudit = audit as Extract<GovernanceDoctorAuditV1Result, { kind: "refused" }>;
    const withheldGuide = guide as GovernanceDoctorGuideWithheldV1;
    if (
      refusedAudit.kind !== "refused" ||
      withheldGuide.kind !== "withheld" ||
      withheldGuide.profileSha256 !== refusedAudit.profileSha256 ||
      withheldGuide.policyRevisionSha256 !== refusedAudit.policyRevisionSha256 ||
      assertEnumV1(
        body.state,
        ["compatibility-required", "policy-denied"] as const,
        "governance doctor operation refusal state",
      ) !== refusedAudit.state ||
      body.actionable !== false
    )
      failGovernanceDoctorV1("governance doctor operation identities do not join");
  }
  for (const field of ["contextSha256", "rootSha256", "surfaceRevisionSha256"] as const)
    assertSha256V1(body[field], `governance doctor operation ${field}`);
  assertTokenV1(
    body.targetId,
    GOVERNANCE_DOCTOR_QUALIFIED_ID_PATTERN,
    GOVERNANCE_DOCTOR_V1_LIMITS.maxIdentifierCodeUnits,
    "governance doctor operation target",
  );
  const record = deepFreezeStrictJsonV1({
    ...body,
    operationSha256: governanceDoctorSha256V1(OPERATION_DOMAIN, body),
  }) as GovernanceDoctorOperationRecordV1;
  operationBytes.set(record, canonicalStrictJsonBytesV1(record));
  return record;
}

/** Exact canonical bytes remain brand-gated and cannot rehydrate authority. */
export function canonicalGovernanceDoctorOperationV1Bytes(value: unknown): Buffer {
  const bytes = typeof value === "object" && value !== null ? operationBytes.get(value) : undefined;
  if (bytes === undefined)
    failGovernanceDoctorV1("governance doctor operation requires a validated brand");
  return Buffer.from(bytes);
}
