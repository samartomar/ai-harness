import { randomBytes } from "node:crypto";
import type { GovernanceDoctorAuditV1Result } from "./audit-guide-v1.js";
import { assertEnumV1, assertExactKeysV1, assertRecordV1 } from "./capability-v1.js";
import type { GovernanceDoctorOperationV1 } from "./operational-v1.js";
import { createGovernanceDoctorRepairBrokerRegistryV1 } from "./repair-broker-v1.js";
import {
  createGovernanceDoctorRepairPlanV1,
  type GovernanceDoctorRepairEffectSummaryV1,
  governanceDoctorRepairEffectSummaryV1,
} from "./repair-plan-v1.js";

/**
 * Preview-only Repair plan presentation -- the one place `aih governance-doctor
 * --repair-plan` reaches.
 *
 * This module may only mint and present. Its inputs are the branded operation
 * the command's own single adapter run produced, the shipped profile, and the
 * single code-owned broker mapping below; no caller can supply a broker, a
 * recipe, an effect, a path, content, or any other authority through it. Its
 * output is a closed, bounded record whose `executable` field is permanently
 * `false`: no consent is captured, no claim is spent, no executor, custody, or
 * verifier module is imported, and nothing is written anywhere.
 *
 * The findings-to-effects mapping is deliberately a code-owned table. Today the
 * only finding code any shipped diagnostic reports is a success code, so no
 * mechanical effect is derivable from a real audit and every live preview
 * reports `no-mechanical-repair`; the minting path below is exercised by tests
 * against synthetic branded audits and becomes live only when a diagnostic
 * gains a mechanically mappable finding code -- a separately reviewed change to
 * this table.
 */
export const GOVERNANCE_DOCTOR_REPAIR_PREVIEW_BROKER_ID_V1 = "aih:governance-doctor.mechanical";

export const GOVERNANCE_DOCTOR_REPAIR_PREVIEW_RECIPE_ID_V1 = "governance-doctor-mechanical";

/** How long a previewed plan's own validity window runs from the minting instant. */
export const GOVERNANCE_DOCTOR_REPAIR_PLAN_PREVIEW_V1_LIMITS = Object.freeze({
  expiryWindowMs: 3_600_000,
});

const PROTOCOL = "GovernanceDoctorRepairPlanPreviewV1";

/** The fixed boundary sentence every preview carries, whatever its outcome. */
export const GOVERNANCE_DOCTOR_REPAIR_PREVIEW_NOTICE_V1 =
  "Preview only: no consent is captured, no claim is spent, and no repair is executed or executable.";

export type GovernanceDoctorRepairPlanPreviewOutcomeV1 =
  | "no-mechanical-repair"
  | "plan"
  | "posture-unavailable"
  | "unavailable";

/**
 * The closed preview payload. Its key set is fixed across every outcome --
 * absent values are `null`, never a missing key. Every populated field is drawn
 * from records that are already bounded and canonical: plan and summary
 * identities, the recipe name, and the summary's managed-relative effect
 * arguments. Absolute paths, content bytes, evidence, and OS diagnostics have
 * no field to occupy.
 */
export interface GovernanceDoctorRepairPlanPreviewV1 {
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

/**
 * The single shipped broker registry: one code-owned mechanical broker, one
 * recipe, exactly the four frozen effect templates. Minted fresh per call so a
 * caller holding a previous result can never mutate what a later preview
 * consumes.
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

/** The requested effects plus the scope paths that make them plan-declarable. */
export interface GovernanceDoctorRepairDerivedEffectsV1 {
  readonly effects: readonly {
    readonly arguments: Readonly<Record<string, string>>;
    readonly effectId: string;
    readonly templateId: string;
  }[];
  readonly scopePaths: readonly string[];
}

/**
 * The code-owned findings-to-effects table. A finding code absent from this
 * table -- including today's only real code, `AIH_READ_ONLY_PROBES_COMPLETED`,
 * which reports success -- derives nothing. Widening this table is a reviewed
 * edit to this module, never a caller input.
 */
function deriveMechanicalEffects(
  audit: GovernanceDoctorAuditV1Result,
): GovernanceDoctorRepairDerivedEffectsV1 {
  if (audit.kind !== "audited") return { effects: [], scopePaths: [] };
  // No shipped finding code maps to a mechanical effect yet: every current code
  // either reports success or reports a state no frozen effect kind can change.
  //
  // Widening this table is what makes the mint path below live, so that review
  // owns the mint path's own preconditions too: the plan module requires at
  // least one evidence citation and caps findings at 16 and refusals at 8, and
  // `createdAtEpochMs` must sit inside the module's accepted clock era. Today
  // an audit can carry at most two of each, so forwarding the audit's evidence
  // verbatim is exact; past those caps, minting would collapse into the fixed
  // `unavailable` outcome rather than truncating evidence silently.
  return { effects: [], scopePaths: [] };
}

function preview(
  outcome: GovernanceDoctorRepairPlanPreviewOutcomeV1,
  populated?: Pick<
    GovernanceDoctorRepairPlanPreviewV1,
    "effects" | "expiresAtEpochMs" | "planSha256" | "recipeId" | "summarySha256"
  >,
): GovernanceDoctorRepairPlanPreviewV1 {
  return Object.freeze({
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
    protocol: PROTOCOL,
    recipeId: populated?.recipeId ?? null,
    summarySha256: populated?.summarySha256 ?? null,
  }) as GovernanceDoctorRepairPlanPreviewV1;
}

/**
 * Mints one plan from already-derived effects and projects its bounded summary.
 * Every validation -- registry membership, template joins, scope containment,
 * path distinctness, evidence agreement with the audit -- is the plan module's
 * own; nothing is re-derived or trusted here.
 */
export function mintGovernanceDoctorRepairPlanPreviewV1(
  operation: GovernanceDoctorOperationV1,
  profile: unknown,
  derived: GovernanceDoctorRepairDerivedEffectsV1,
): GovernanceDoctorRepairPlanPreviewV1 {
  const audit = operation.audit;
  if (audit.kind !== "audited") return preview("unavailable");
  const createdAtEpochMs = Date.now();
  const built = createGovernanceDoctorRepairPlanV1({
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
  const summary: GovernanceDoctorRepairEffectSummaryV1 =
    governanceDoctorRepairEffectSummaryV1(built);
  return preview("plan", {
    effects: summary.effects,
    expiresAtEpochMs: built.expiresAtEpochMs,
    planSha256: built.planSha256,
    recipeId: GOVERNANCE_DOCTOR_REPAIR_PREVIEW_RECIPE_ID_V1,
    summarySha256: summary.summarySha256,
  });
}

/**
 * Projects one adapter run into the closed preview. A run whose audit refused,
 * whose profile does not declare the guided-only repair posture, or whose
 * minting refuses for any reason collapses into a fixed no-plan outcome: a
 * failure here can carry no OS text, path, or partial plan out.
 */
export function presentGovernanceDoctorRepairPlanPreviewV1(
  value: unknown,
): GovernanceDoctorRepairPlanPreviewV1 {
  try {
    const request = assertRecordV1(value, "repair plan preview request");
    assertExactKeysV1(request, ["operation", "profile"], "repair plan preview request");
    const operation = assertRecordV1(request.operation, "repair plan preview operation");
    assertExactKeysV1(operation, ["audit", "guide", "record"], "repair plan preview operation");
    const audit = assertRecordV1(operation.audit, "repair plan preview audit");
    if (audit.kind !== "audited") return preview("unavailable");
    // The posture is read from the Guide, whose repair posture is digest-bound
    // into the operation record -- never from the looser profile record also
    // present in the request.
    const guide = assertRecordV1(operation.guide, "repair plan preview guide");
    const posture = assertEnumV1(
      guide.repairPosture,
      ["guided-only", "unavailable"] as const,
      "repair plan preview posture",
    );
    if (posture !== "guided-only") return preview("posture-unavailable");
    const derived = deriveMechanicalEffects(operation.audit as GovernanceDoctorAuditV1Result);
    if (derived.effects.length === 0) return preview("no-mechanical-repair");
    return mintGovernanceDoctorRepairPlanPreviewV1(
      request.operation as GovernanceDoctorOperationV1,
      request.profile,
      derived,
    );
  } catch {
    // Closed collapse: a refusal is never an output channel for the input that
    // caused it.
    return preview("unavailable");
  }
}
