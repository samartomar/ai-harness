import {
  deriveGovernanceDoctorAuditCompletenessV1,
  type GovernanceDoctorAuditCompletenessStateV1,
} from "./audit-completeness-v1.js";
import {
  canonicalGovernanceDoctorAuditV1Bytes,
  canonicalGovernanceDoctorGuideV1Bytes,
} from "./audit-guide-v1.js";
import { assertEnumV1, assertExactKeysV1, assertRecordV1 } from "./capability-v1.js";
import {
  canonicalGovernanceDoctorOperationV1Bytes,
  type GovernanceDoctorOperationRecordV1,
} from "./operation-record-v1.js";
import {
  type GovernanceDoctorOperationV1,
  governanceDoctorOperationalRootSha256V1,
} from "./operational-v1.js";
import {
  type GovernanceDoctorRepairDerivedEffectsV1,
  governanceDoctorRepairCanonContextDerivedEffectsV1,
  mintGovernanceDoctorRepairCanonicalPlanV1,
} from "./repair-canon-plan-v1.js";
import {
  assertGovernanceDoctorRepairEligibilityV1,
  GOVERNANCE_DOCTOR_CANONICAL_CONTEXT_DIR_V1,
} from "./repair-eligibility-v1.js";
import type {
  GovernanceDoctorRepairEffectSummaryV1,
  GovernanceDoctorRepairPlanV1,
} from "./repair-plan-v1.js";
import {
  assertGovernanceDoctorRepairPreconditionV1,
  type GovernanceDoctorRepairPreconditionV1,
  governanceDoctorRepairPreconditionSha256V1,
} from "./repair-precondition-v1.js";
import { assertGovernanceDoctorRepairPreconditionScopeV1 } from "./repair-scope-v1.js";

export type GovernanceDoctorRepairLiveCanonicalPlanResultV1 =
  | {
      readonly auditCompleteness: GovernanceDoctorAuditCompletenessStateV1;
      readonly kind: "plan";
      readonly plan: GovernanceDoctorRepairPlanV1;
      readonly preconditionSha256: string;
      readonly summary: GovernanceDoctorRepairEffectSummaryV1;
      readonly targetOccupancy: GovernanceDoctorRepairPreconditionV1["targetOccupancy"];
    }
  | {
      readonly auditCompleteness: GovernanceDoctorAuditCompletenessStateV1;
      readonly kind: "no-mechanical-repair" | "posture-unavailable";
      readonly preconditionSha256: string | null;
      readonly targetOccupancy: GovernanceDoctorRepairPreconditionV1["targetOccupancy"] | null;
    }
  | {
      readonly auditCompleteness: GovernanceDoctorAuditCompletenessStateV1;
      readonly kind: "target-occupancy-indeterminate";
      readonly preconditionSha256: string;
      readonly targetOccupancy: "indeterminate";
    }
  | {
      readonly auditCompleteness: GovernanceDoctorAuditCompletenessStateV1 | null;
      readonly kind: "unavailable";
      readonly preconditionSha256: string | null;
      readonly targetOccupancy: GovernanceDoctorRepairPreconditionV1["targetOccupancy"] | null;
    };

function unavailable(
  auditCompleteness: GovernanceDoctorAuditCompletenessStateV1 | null,
  preconditionSha256: string | null = null,
  targetOccupancy: GovernanceDoctorRepairPreconditionV1["targetOccupancy"] | null = null,
): GovernanceDoctorRepairLiveCanonicalPlanResultV1 {
  return Object.freeze({
    auditCompleteness,
    kind: "unavailable" as const,
    preconditionSha256,
    targetOccupancy,
  });
}

function deriveGovernanceDoctorRepairPreconditionEffectsV1(
  precondition: GovernanceDoctorRepairPreconditionV1,
): GovernanceDoctorRepairDerivedEffectsV1 {
  if (!precondition.eligible || precondition.targetOccupancy !== "unoccupied")
    return { effects: [], scopePaths: [] };
  return governanceDoctorRepairCanonContextDerivedEffectsV1();
}

/**
 * Command-only canonical derivation. It derives the one executable effect from
 * the branded live precondition rather than from Audit findings; Audit remains
 * bounded context and completeness evidence.
 */
export function deriveGovernanceDoctorRepairLiveCanonicalPlanV1(
  value: unknown,
): GovernanceDoctorRepairLiveCanonicalPlanResultV1 {
  let auditCompleteness: GovernanceDoctorAuditCompletenessStateV1 | null = null;
  let preconditionSha256: string | null = null;
  let targetOccupancy: GovernanceDoctorRepairPreconditionV1["targetOccupancy"] | null = null;
  try {
    const request = assertRecordV1(value, "live repair canonical plan request");
    assertExactKeysV1(
      request,
      ["eligibility", "operation", "precondition", "profile", "scope"],
      "live repair canonical plan request",
    );
    const operation = assertRecordV1(request.operation, "live repair canonical plan operation");
    assertExactKeysV1(
      operation,
      ["audit", "guide", "record"],
      "live repair canonical plan operation",
    );
    canonicalGovernanceDoctorOperationV1Bytes(operation.record);
    canonicalGovernanceDoctorAuditV1Bytes(operation.audit);
    canonicalGovernanceDoctorGuideV1Bytes(operation.guide);
    const audit = assertRecordV1(operation.audit, "live repair canonical plan audit");
    if (audit.kind !== "audited") return unavailable(null);
    auditCompleteness = deriveGovernanceDoctorAuditCompletenessV1(operation.audit).state;
    const guide = assertRecordV1(operation.guide, "live repair canonical plan guide");
    const posture = assertEnumV1(
      guide.repairPosture,
      ["guided-only", "unavailable"] as const,
      "live repair canonical plan posture",
    );
    const eligibility = assertGovernanceDoctorRepairEligibilityV1(request.eligibility);
    const scope = assertGovernanceDoctorRepairPreconditionScopeV1(request.scope);
    const precondition = assertGovernanceDoctorRepairPreconditionV1(request.precondition);
    preconditionSha256 = governanceDoctorRepairPreconditionSha256V1(precondition);
    targetOccupancy = precondition.targetOccupancy;
    const record = operation.record as GovernanceDoctorOperationRecordV1;
    const operationalRootSha256 = governanceDoctorOperationalRootSha256V1({
      contextDir: GOVERNANCE_DOCTOR_CANONICAL_CONTEXT_DIR_V1,
      root: scope.rootRealPath,
    });
    if (
      eligibility.rootSha256 !== record.rootSha256 ||
      operationalRootSha256 !== record.rootSha256 ||
      precondition.rootSha256 !== scope.rootSha256 ||
      precondition.targetPath !== GOVERNANCE_DOCTOR_CANONICAL_CONTEXT_DIR_V1
    )
      return unavailable(auditCompleteness, preconditionSha256, targetOccupancy);
    if (posture !== "guided-only")
      return Object.freeze({
        auditCompleteness,
        kind: "posture-unavailable" as const,
        preconditionSha256,
        targetOccupancy,
      });
    if (precondition.targetOccupancy === "indeterminate")
      return Object.freeze({
        auditCompleteness,
        kind: "target-occupancy-indeterminate" as const,
        preconditionSha256,
        targetOccupancy: "indeterminate",
      });
    const derived = deriveGovernanceDoctorRepairPreconditionEffectsV1(precondition);
    if (derived.effects.length === 0)
      return Object.freeze({
        auditCompleteness,
        kind: "no-mechanical-repair" as const,
        preconditionSha256,
        targetOccupancy,
      });
    const canonical = mintGovernanceDoctorRepairCanonicalPlanV1(
      request.operation as GovernanceDoctorOperationV1,
      request.profile,
      derived,
    );
    if (canonical.kind !== "plan")
      return unavailable(auditCompleteness, preconditionSha256, targetOccupancy);
    return Object.freeze({
      auditCompleteness,
      kind: "plan" as const,
      plan: canonical.plan,
      preconditionSha256,
      summary: canonical.summary,
      targetOccupancy,
    });
  } catch {
    return unavailable(auditCompleteness, preconditionSha256, targetOccupancy);
  }
}
