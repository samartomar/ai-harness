import type { GovernanceDoctorAuditCompletenessStateV1 } from "./audit-completeness-v1.js";
import type { GovernanceDoctorOperationV1 } from "./operational-v1.js";
import {
  deriveGovernanceDoctorRepairCanonicalPlanV1,
  type GovernanceDoctorRepairCanonicalPlanResultV1,
  type GovernanceDoctorRepairDerivedEffectsV1,
  mintGovernanceDoctorRepairCanonicalPlanV1,
} from "./repair-canon-plan-v1.js";

export {
  GOVERNANCE_DOCTOR_REPAIR_PLAN_PREVIEW_V1_LIMITS,
  GOVERNANCE_DOCTOR_REPAIR_PREVIEW_BROKER_ID_V1,
  GOVERNANCE_DOCTOR_REPAIR_PREVIEW_RECIPE_ID_V1,
  type GovernanceDoctorRepairDerivedEffectsV1,
  shippedGovernanceDoctorRepairBrokerRegistryV1,
} from "./repair-canon-plan-v1.js";

/**
 * Preview-only projection of a canonical Repair plan. This module never mints
 * authority: its `executable` bit is fixed false and it imports neither attempt
 * nor executor nor command surfaces.
 */
export const GOVERNANCE_DOCTOR_REPAIR_PREVIEW_NOTICE_V1 =
  "Preview only: no consent is captured, no claim is spent, and no repair is executed or executable.";

export type GovernanceDoctorRepairPlanPreviewOutcomeV1 =
  | "no-mechanical-repair"
  | "plan"
  | "posture-unavailable"
  | "unavailable";

export interface GovernanceDoctorRepairPlanPreviewV1 {
  readonly auditCompleteness: GovernanceDoctorAuditCompletenessStateV1 | null;
  readonly effects: readonly {
    readonly arguments: Readonly<Record<string, string>>;
    readonly effectId: string;
    readonly effectKind: string;
  }[];
  readonly executable: false;
  readonly expiresAtEpochMs: number | null;
  readonly notice: string;
  readonly outcome: GovernanceDoctorRepairPlanPreviewOutcomeV1;
  readonly planSha256: string | null;
  readonly protocol: "GovernanceDoctorRepairPlanPreviewV1";
  readonly recipeId: string | null;
  readonly summarySha256: string | null;
}

function preview(
  outcome: GovernanceDoctorRepairPlanPreviewOutcomeV1,
  auditCompleteness: GovernanceDoctorAuditCompletenessStateV1 | null,
  populated?: Pick<
    GovernanceDoctorRepairPlanPreviewV1,
    "effects" | "expiresAtEpochMs" | "planSha256" | "recipeId" | "summarySha256"
  >,
): GovernanceDoctorRepairPlanPreviewV1 {
  return Object.freeze({
    auditCompleteness,
    effects: Object.freeze(
      (populated?.effects ?? []).map((effect) =>
        Object.freeze({
          arguments: Object.freeze({ ...effect.arguments }),
          effectId: effect.effectId,
          effectKind: effect.effectKind,
        }),
      ),
    ),
    executable: false as const,
    expiresAtEpochMs: populated?.expiresAtEpochMs ?? null,
    notice: GOVERNANCE_DOCTOR_REPAIR_PREVIEW_NOTICE_V1,
    outcome,
    planSha256: populated?.planSha256 ?? null,
    protocol: "GovernanceDoctorRepairPlanPreviewV1" as const,
    recipeId: populated?.recipeId ?? null,
    summarySha256: populated?.summarySha256 ?? null,
  }) as GovernanceDoctorRepairPlanPreviewV1;
}

function projectCanonicalPlan(
  result: GovernanceDoctorRepairCanonicalPlanResultV1,
): GovernanceDoctorRepairPlanPreviewV1 {
  if (result.kind !== "plan") return preview(result.kind, result.auditCompleteness);
  return preview("plan", result.auditCompleteness, {
    effects: result.summary.effects,
    expiresAtEpochMs: result.plan.expiresAtEpochMs,
    planSha256: result.plan.planSha256,
    recipeId: result.plan.recipeId,
    summarySha256: result.summary.summarySha256,
  });
}

/** Kept as a public projection seam for existing preview callers and tests. */
export function mintGovernanceDoctorRepairPlanPreviewV1(
  operation: GovernanceDoctorOperationV1,
  profile: unknown,
  derived: GovernanceDoctorRepairDerivedEffectsV1,
): GovernanceDoctorRepairPlanPreviewV1 {
  return projectCanonicalPlan(
    mintGovernanceDoctorRepairCanonicalPlanV1(operation, profile, derived),
  );
}

/** Projects the common canonical factor into an irrevocably non-executable UI record. */
export function presentGovernanceDoctorRepairPlanPreviewV1(
  value: unknown,
): GovernanceDoctorRepairPlanPreviewV1 {
  return projectCanonicalPlan(deriveGovernanceDoctorRepairCanonicalPlanV1(value));
}
