import { randomBytes } from "node:crypto";
import {
  deriveGovernanceDoctorAuditCompletenessV1,
  type GovernanceDoctorAuditCompletenessStateV1,
} from "./audit-completeness-v1.js";
import {
  canonicalGovernanceDoctorAuditV1Bytes,
  canonicalGovernanceDoctorGuideV1Bytes,
  type GovernanceDoctorAuditV1Result,
} from "./audit-guide-v1.js";
import { assertEnumV1, assertExactKeysV1, assertRecordV1 } from "./capability-v1.js";
import {
  canonicalGovernanceDoctorOperationV1Bytes,
  type GovernanceDoctorOperationRecordV1,
} from "./operation-record-v1.js";
import type { GovernanceDoctorOperationV1 } from "./operational-v1.js";
import { createGovernanceDoctorRepairBrokerRegistryV1 } from "./repair-broker-v1.js";
import {
  assertGovernanceDoctorRepairEligibilityV1,
  GOVERNANCE_DOCTOR_CANONICAL_CONTEXT_DIR_V1,
} from "./repair-eligibility-v1.js";
import {
  createGovernanceDoctorRepairPlanV1,
  type GovernanceDoctorRepairEffectSummaryV1,
  type GovernanceDoctorRepairPlanV1,
  governanceDoctorRepairEffectSummaryV1,
} from "./repair-plan-v1.js";

/**
 * The single shipped mechanical broker and recipe. This module is deliberately
 * capability-free: it receives already-branded operational facts, performs
 * only closed joins and canonical construction, and neither reads the marker
 * nor observes the filesystem. Preview projects its result; the command uses
 * the same result before consent. Neither caller may supply a broker, recipe,
 * path, template, nonce, or expiry window.
 */
export const GOVERNANCE_DOCTOR_REPAIR_PREVIEW_BROKER_ID_V1 = "aih:governance-doctor.mechanical";
export const GOVERNANCE_DOCTOR_REPAIR_PREVIEW_RECIPE_ID_V1 = "governance-doctor-mechanical";

/** The validity window is code-owned, never command or diagnostic input. */
export const GOVERNANCE_DOCTOR_REPAIR_PLAN_PREVIEW_V1_LIMITS = Object.freeze({
  expiryWindowMs: 3_600_000,
});

/**
 * The sole source of the shipped effect templates. It is minted per call so a
 * previous caller cannot mutate a later canonical construction.
 */
export function shippedGovernanceDoctorRepairBrokerRegistryV1(): unknown {
  return createGovernanceDoctorRepairBrokerRegistryV1({
    brokerId: GOVERNANCE_DOCTOR_REPAIR_PREVIEW_BROKER_ID_V1,
    owner: "aih",
    recipes: [
      {
        effectVersion: "1",
        effects: [
          {
            argumentSchema: [{ name: "path", type: "managed-relative-path" }],
            effectKind: "create-managed-directory",
            templateId: "ensure-managed-directory",
          },
          {
            argumentSchema: [{ name: "path", type: "managed-relative-path" }],
            effectKind: "normalize-managed-line-endings",
            templateId: "normalize-managed-line-endings",
          },
          {
            argumentSchema: [
              { name: "contentSha256", type: "sha256" },
              { name: "path", type: "managed-relative-path" },
            ],
            effectKind: "restore-managed-file-content",
            templateId: "restore-managed-file-content",
          },
          {
            argumentSchema: [
              { name: "blockId", type: "managed-token" },
              { name: "contentSha256", type: "sha256" },
              { name: "path", type: "managed-relative-path" },
            ],
            effectKind: "rewrite-managed-marker-block",
            templateId: "rewrite-managed-marker-block",
          },
        ],
        recipeId: GOVERNANCE_DOCTOR_REPAIR_PREVIEW_RECIPE_ID_V1,
        schemaVersion: "1",
      },
    ],
  });
}

export interface GovernanceDoctorRepairDerivedEffectsV1 {
  readonly effects: readonly {
    readonly arguments: Readonly<Record<string, string>>;
    readonly effectId: string;
    readonly templateId: string;
  }[];
  readonly scopePaths: readonly string[];
}

/**
 * The only finding-to-effect mapping. Its literal create-managed-directory
 * target is intentionally not derived from a marker, option, or diagnostic.
 * The table has exactly one entry; success and every unknown finding derive no
 * effect. Widening it is a reviewed source change, not a data/configuration
 * path. Plan construction retains its own bounded evidence/refusal cardinality
 * checks, so an oversized audit collapses at the constructor rather than being
 * truncated into a misleading plan.
 */
const MECHANICAL_EFFECTS_V1 = Object.freeze([
  Object.freeze({
    code: "AIH_CANON_CONTEXT_DIR_MISSING",
    diagnosticId: "aih.doctor.root",
    effectId: "ensure-canonical-context-dir",
    templateId: "ensure-managed-directory",
  }),
] as const);

export function deriveGovernanceDoctorRepairMechanicalEffectsV1(
  audit: GovernanceDoctorAuditV1Result,
): GovernanceDoctorRepairDerivedEffectsV1 {
  if (audit.kind !== "audited") return { effects: [], scopePaths: [] };
  const effects = new Map<string, GovernanceDoctorRepairDerivedEffectsV1["effects"][number]>();
  for (const finding of audit.findings) {
    const entry = MECHANICAL_EFFECTS_V1.find(
      (candidate) =>
        candidate.code === finding.code && candidate.diagnosticId === finding.diagnosticId,
    );
    if (entry === undefined) continue;
    effects.set(entry.effectId, {
      arguments: { path: GOVERNANCE_DOCTOR_CANONICAL_CONTEXT_DIR_V1 },
      effectId: entry.effectId,
      templateId: entry.templateId,
    });
  }
  return effects.size === 0
    ? { effects: [], scopePaths: [] }
    : { effects: [...effects.values()], scopePaths: [GOVERNANCE_DOCTOR_CANONICAL_CONTEXT_DIR_V1] };
}

export type GovernanceDoctorRepairCanonicalPlanResultV1 =
  | {
      readonly auditCompleteness: GovernanceDoctorAuditCompletenessStateV1;
      readonly kind: "plan";
      readonly plan: GovernanceDoctorRepairPlanV1;
      readonly summary: GovernanceDoctorRepairEffectSummaryV1;
    }
  | {
      readonly auditCompleteness: GovernanceDoctorAuditCompletenessStateV1;
      readonly kind: "no-mechanical-repair" | "posture-unavailable";
    }
  | {
      readonly auditCompleteness: GovernanceDoctorAuditCompletenessStateV1 | null;
      readonly kind: "unavailable";
    };

function unavailable(
  auditCompleteness: GovernanceDoctorAuditCompletenessStateV1 | null,
): GovernanceDoctorRepairCanonicalPlanResultV1 {
  return Object.freeze({ auditCompleteness, kind: "unavailable" });
}

/** Mints a plan from already code-derived effects. */
export function mintGovernanceDoctorRepairCanonicalPlanV1(
  operation: GovernanceDoctorOperationV1,
  profile: unknown,
  derived: GovernanceDoctorRepairDerivedEffectsV1,
): GovernanceDoctorRepairCanonicalPlanResultV1 {
  const audit = operation.audit;
  if (audit.kind !== "audited") return unavailable(null);
  const auditCompleteness = deriveGovernanceDoctorAuditCompletenessV1(audit).state;
  const createdAtEpochMs = Date.now();
  const plan = createGovernanceDoctorRepairPlanV1({
    createdAtEpochMs,
    effects: derived.effects.map((effect) => ({
      arguments: { ...effect.arguments },
      effectId: effect.effectId,
      templateId: effect.templateId,
    })),
    evidence: {
      findings: audit.findings.map((finding) => ({
        code: finding.code,
        diagnosticId: finding.diagnosticId,
      })),
      refusals: audit.refusals.map((refusal) => ({
        diagnosticId: refusal.diagnosticId,
        state: refusal.state,
      })),
    },
    expiresAtEpochMs:
      createdAtEpochMs + GOVERNANCE_DOCTOR_REPAIR_PLAN_PREVIEW_V1_LIMITS.expiryWindowMs,
    operation,
    planNonce: randomBytes(32).toString("hex"),
    profile,
    recipeId: GOVERNANCE_DOCTOR_REPAIR_PREVIEW_RECIPE_ID_V1,
    registry: shippedGovernanceDoctorRepairBrokerRegistryV1(),
    scope: { paths: [...derived.scopePaths] },
  });
  return Object.freeze({
    auditCompleteness,
    kind: "plan" as const,
    plan,
    summary: governanceDoctorRepairEffectSummaryV1(plan),
  });
}

/**
 * The one capability-free intake gate for both preview and repair. Every
 * hostile or unbranded input collapses to a bounded no-plan result.
 */
export function deriveGovernanceDoctorRepairCanonicalPlanV1(
  value: unknown,
): GovernanceDoctorRepairCanonicalPlanResultV1 {
  let auditCompleteness: GovernanceDoctorAuditCompletenessStateV1 | null = null;
  try {
    const request = assertRecordV1(value, "repair canonical plan request");
    assertExactKeysV1(
      request,
      ["eligibility", "operation", "profile"],
      "repair canonical plan request",
    );
    const operation = assertRecordV1(request.operation, "repair canonical plan operation");
    assertExactKeysV1(operation, ["audit", "guide", "record"], "repair canonical plan operation");
    canonicalGovernanceDoctorOperationV1Bytes(operation.record);
    canonicalGovernanceDoctorAuditV1Bytes(operation.audit);
    canonicalGovernanceDoctorGuideV1Bytes(operation.guide);
    const audit = assertRecordV1(operation.audit, "repair canonical plan audit");
    if (audit.kind !== "audited") return unavailable(null);
    auditCompleteness = deriveGovernanceDoctorAuditCompletenessV1(operation.audit).state;
    const guide = assertRecordV1(operation.guide, "repair canonical plan guide");
    const posture = assertEnumV1(
      guide.repairPosture,
      ["guided-only", "unavailable"] as const,
      "repair canonical plan posture",
    );
    if (posture !== "guided-only")
      return Object.freeze({ auditCompleteness, kind: "posture-unavailable" });
    const derived = deriveGovernanceDoctorRepairMechanicalEffectsV1(
      operation.audit as GovernanceDoctorAuditV1Result,
    );
    if (derived.effects.length === 0)
      return Object.freeze({ auditCompleteness, kind: "no-mechanical-repair" });
    const eligibility = assertGovernanceDoctorRepairEligibilityV1(request.eligibility);
    const record = operation.record as GovernanceDoctorOperationRecordV1;
    if (eligibility.rootSha256 !== record.rootSha256) return unavailable(auditCompleteness);
    return mintGovernanceDoctorRepairCanonicalPlanV1(
      request.operation as GovernanceDoctorOperationV1,
      request.profile,
      derived,
    );
  } catch {
    return unavailable(auditCompleteness);
  }
}
