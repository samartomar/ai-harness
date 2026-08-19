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
// The operation record's own module, not the adapter that also re-exports it:
// the adapter loads the Doctor and policy command specs, and loading it here to
// reach one pure canonicalizer would give this module their filesystem reach by
// transitivity. The remaining edge to the adapter is types only, and erases.
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
  governanceDoctorRepairEffectSummaryV1,
} from "./repair-plan-v1.js";

/**
 * Preview-only Repair plan presentation -- the one place `aih governance-doctor
 * --repair-plan` reaches.
 *
 * This module may only mint and present. Its inputs are the branded operation
 * the command's own single adapter run produced, the shipped profile, the
 * branded eligibility record the trusted command boundary minted for that same
 * run, and the single code-owned broker mapping below; no caller can supply a
 * broker, a recipe, an effect, a path, content, or any other authority through
 * it. Its output is a closed, bounded record whose `executable` field is
 * permanently `false`: no consent is captured, no claim is spent, no executor,
 * custody, or verifier module is imported, and nothing is written anywhere.
 *
 * The module is deliberately capability-free. It reads no file, no setting, no
 * marker, and no environment value, and it holds no callback that could read one
 * on its behalf, so every fact about the repository it relies on has to arrive
 * as an already-validated, already-branded record. That is what the eligibility
 * record is: a conclusion the command boundary reached, not a question this
 * module asks.
 *
 * The findings-to-effects mapping is a code-owned table with exactly one entry.
 * Today's shipped audit can report two finding codes: a success code, which maps
 * to nothing, and the missing canonical context directory, which maps to a
 * single `create-managed-directory` effect at the module's own constant path.
 * Nothing else derives an effect, and widening the table is a separately
 * reviewed change to this module.
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
  /**
   * How much of the workstation the audit this plan was derived from actually
   * saw. A plan may be derived from a `partial` audit -- the finding it repairs
   * is real either way -- but a reader must never take "a repair was planned"
   * as "the audit was complete", so the classification travels with the plan
   * rather than being inferred from its presence. `null` only where there is no
   * audited result to classify.
   */
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
 * The code-owned findings-to-effects table. A finding code absent from it --
 * including `AIH_READ_ONLY_PROBES_COMPLETED`, which reports success -- derives
 * nothing. Widening it is a reviewed edit to this module, never a caller input.
 *
 * Each entry pairs an AIH-owned finding code with an AIH-owned effect. The path
 * is a module constant, not a field: nothing a marker, a command option, an
 * environment variable, or a diagnostic's own detail or location carries can
 * move an effect off the canonical directory, because there is no expression in
 * this table that reads any of them.
 *
 * Widening this table is also what keeps the mint path's own preconditions under
 * review: the plan module requires at least one evidence citation and caps
 * findings at 16 and refusals at 8, and `createdAtEpochMs` must sit inside the
 * module's accepted clock era. Today an audit can carry at most two of each, so
 * forwarding the audit's evidence verbatim is exact; past those caps, minting
 * collapses into the fixed `unavailable` outcome rather than truncating
 * evidence silently.
 */
const MECHANICAL_EFFECTS_V1 = Object.freeze([
  Object.freeze({
    code: "AIH_CANON_CONTEXT_DIR_MISSING",
    diagnosticId: "aih.doctor.root",
    effectId: "ensure-canonical-context-dir",
    templateId: "ensure-managed-directory",
  }),
] as const);

function deriveMechanicalEffects(
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
    : {
        effects: [...effects.values()],
        scopePaths: [GOVERNANCE_DOCTOR_CANONICAL_CONTEXT_DIR_V1],
      };
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
  if (audit.kind !== "audited") return preview("unavailable", null);
  const completeness = deriveGovernanceDoctorAuditCompletenessV1(audit).state;
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
  return preview("plan", completeness, {
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
  // Held outside the try so the collapse below can still report how much the
  // audit saw when the failure came *after* the audit was classified -- an
  // unusable eligibility record says nothing about the audit, and `null` is
  // reserved for having no audited result at all.
  let completeness: GovernanceDoctorAuditCompletenessStateV1 | null = null;
  try {
    const request = assertRecordV1(value, "repair plan preview request");
    assertExactKeysV1(
      request,
      ["eligibility", "operation", "profile"],
      "repair plan preview request",
    );
    const operation = assertRecordV1(request.operation, "repair plan preview operation");
    assertExactKeysV1(operation, ["audit", "guide", "record"], "repair plan preview operation");
    // Brand checks before any classification: a structurally shaped parse of a
    // real operation's own facts must never earn even the no-repair label,
    // because a label implies the audit it summarizes was a real one.
    canonicalGovernanceDoctorOperationV1Bytes(operation.record);
    canonicalGovernanceDoctorAuditV1Bytes(operation.audit);
    canonicalGovernanceDoctorGuideV1Bytes(operation.guide);
    const audit = assertRecordV1(operation.audit, "repair plan preview audit");
    if (audit.kind !== "audited") return preview("unavailable", null);
    // Classified here, once, so every outcome below reports how much the audit
    // saw -- including the ones that derive no plan at all, and the collapse.
    completeness = deriveGovernanceDoctorAuditCompletenessV1(operation.audit).state;
    // The posture is read from the Guide, whose repair posture is digest-bound
    // into the operation record -- never from the looser profile record also
    // present in the request.
    const guide = assertRecordV1(operation.guide, "repair plan preview guide");
    const posture = assertEnumV1(
      guide.repairPosture,
      ["guided-only", "unavailable"] as const,
      "repair plan preview posture",
    );
    if (posture !== "guided-only") return preview("posture-unavailable", completeness);
    const derived = deriveMechanicalEffects(operation.audit as GovernanceDoctorAuditV1Result);
    if (derived.effects.length === 0) return preview("no-mechanical-repair", completeness);
    // Eligibility is consulted only once an effect is already derivable, so a
    // healthy audit reports no-mechanical-repair whether or not this repository
    // is eligible -- eligibility gates minting, it does not describe the audit.
    // An absent or hostile record throws into the closed collapse below.
    //
    // The root comparison is defense in depth, not an active guard: the one
    // shipped caller mints the record from this same operation's own root
    // digest, so it cannot disagree today. It is kept so that a second caller,
    // or a record held across runs, cannot present eligibility earned for one
    // repository beside another repository's audit.
    const eligibility = assertGovernanceDoctorRepairEligibilityV1(request.eligibility);
    const record = operation.record as GovernanceDoctorOperationRecordV1;
    if (eligibility.rootSha256 !== record.rootSha256) return preview("unavailable", completeness);
    return mintGovernanceDoctorRepairPlanPreviewV1(
      request.operation as GovernanceDoctorOperationV1,
      request.profile,
      derived,
    );
  } catch {
    // Closed collapse: a refusal is never an output channel for the input that
    // caused it. The completeness is not such a channel -- it is derived from
    // the operation's own already-branded audit, and stays `null` whenever the
    // failure happened before that audit was classified.
    return preview("unavailable", completeness);
  }
}
