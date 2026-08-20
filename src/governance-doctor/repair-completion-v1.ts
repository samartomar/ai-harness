import { canonicalStrictJsonBytesV1, deepFreezeStrictJsonV1 } from "../contract/strict-json-v1.js";
import { deriveGovernanceDoctorAuditCompletenessV1 } from "./audit-completeness-v1.js";
import {
  assertEnumV1,
  assertExactKeysV1,
  assertRecordV1,
  assertSha256V1,
  GOVERNANCE_DOCTOR_READ_ONLY_DIAGNOSTIC_IDS,
  GOVERNANCE_DOCTOR_READ_ONLY_PROBES_COMPLETED_V1,
  GOVERNANCE_DOCTOR_V1_LIMITS,
  governanceDoctorSha256V1,
  sortByCodeUnitsV1,
} from "./capability-v1.js";
import { failGovernanceDoctorRepairV1 } from "./repair-capability-v1.js";
import {
  assertGovernanceDoctorRepairClaimSpentV1,
  governanceDoctorRepairClaimScopeSha256V1,
} from "./repair-claim-v1.js";
import { GOVERNANCE_DOCTOR_CANONICAL_CONTEXT_DIR_V1 } from "./repair-eligibility-v1.js";
import {
  canonicalGovernanceDoctorRepairReceiptV1Bytes,
  canonicalGovernanceDoctorRepairVerificationV1Bytes,
  type GovernanceDoctorRepairReceiptV1,
  type GovernanceDoctorRepairVerificationV1,
} from "./repair-outcome-v1.js";
import {
  canonicalGovernanceDoctorRepairPlanV1Bytes,
  type GovernanceDoctorRepairPlanV1,
} from "./repair-plan-v1.js";
import {
  type GovernanceDoctorRepairPreconditionV1,
  governanceDoctorRepairPreconditionSha256V1,
} from "./repair-precondition-v1.js";
import {
  GOVERNANCE_DOCTOR_REPAIR_CANON_CONTEXT_RECIPE_V1,
  governanceDoctorRepairPreconditionRootSha256V1,
} from "./repair-scope-v1.js";

/**
 * What one Repair attempt actually established -- as three separate facts that
 * are never allowed to stand in for one another.
 *
 * ## Why three
 *
 * Creating `ai-coding` is a small, verifiable thing. The temptation, once it
 * verifies, is to let that one success speak for the workstation: the effect
 * worked, so the repair is done, so the system is well. Each of those is a
 * different claim, and only the first was proved.
 *
 * - **effect verification** -- did the literal `ai-coding` effect independently
 *   verify against the live tree? A fact about one directory.
 * - **post-audit state** -- what does a *fresh* audit, run after the effect, say
 *   about the workstation? `healthy` only when it carries no finding and no
 *   unresolved diagnostic; `partial` when anything non-pass remains;
 *   `unavailable` when no valid audit was produced at all.
 * - **repair state** -- is the Repair complete? Only when the effect verified,
 *   the fresh audit is healthy, every trusted join holds, and the receipt itself
 *   verifies.
 *
 * A repair that fixed exactly what it set out to fix, in a workstation with
 * three unrelated problems, is `partial`. It is not a failure and it is not a
 * success, and the record says so rather than rounding it to whichever is
 * nearer.
 *
 * ## Why this is not an Audit
 *
 * Audit V1 is a closed contract with its own XOR between an audited result and
 * an audit-level refusal, and its own identity rules. Repair completion is a
 * different question in a different vocabulary, and widening Audit to carry it
 * would put a mutation's outcome inside the record a read-only diagnostic mints.
 * So this is a separate closed record that *consumes* a fresh branded Audit and
 * derives a repair-specific reading of it. Audit is unchanged.
 *
 * `healthy` is deliberately stricter than Audit's own `completed`: an audit that
 * resolved every diagnostic and still found problems is `completed` for a
 * diagnostic's purposes and `partial` for this one, because a repair may not
 * call a workstation well while it still reports problems.
 *
 * ## What a receipt is and is not
 *
 * A Receipt records what an executor did. It is evidence, not a certificate: it
 * says an effect was applied, never that the application was correct or that
 * anything else is well. Verification is a separate record from a separate
 * verifier against the live tree, and completion is derived from both plus a
 * fresh audit. Nothing here reads a receipt as proof of its own success.
 *
 * ## Refusal versus failure
 *
 * An input that is not what it claims to be -- unbranded, forged, a look-alike
 * parse -- is refused, and no record is minted, because a completion record
 * implies the attempt it describes was real. An input that is genuine but does
 * not *agree* -- a claim spent for another plan, a verification of another
 * receipt, a precondition from another checkout -- mints a record whose state is
 * `failed`. The first is "this did not happen"; the second is "this happened and
 * did not hold together", and only the second belongs in an audit trail.
 *
 * ## One residual the joins cannot close
 *
 * A Receipt and a Verification bind the Plan's *declared* root -- the strings the
 * plan was built from -- while a claim and a precondition bind the *resolved*
 * checkout. Those are digests of different things, the same structural gap the
 * evidence recorder documents, so two runs of one Plan against roots that
 * resolve differently produce receipts these joins cannot tell apart. Every
 * record here binds the Plan, and the Plan binds the declared root, so a receipt
 * from an unrelated plan is refused; pairing a receipt from one resolved
 * checkout with a claim from another needs an in-package caller deliberately
 * combining records from two runs, which the single production path does not do.
 * Closing it needs the resolved root inside the Receipt, which is a change to
 * the outcome contract rather than to this one.
 */
export type GovernanceDoctorRepairEffectVerificationV1 = "unverified" | "verified";

export type GovernanceDoctorRepairPostAuditStateV1 = "healthy" | "partial" | "unavailable";

export type GovernanceDoctorRepairCompletionStateV1 = "complete" | "failed" | "partial";

/** One residual reason the workstation is still not clean, and how many carry it. */
export interface GovernanceDoctorRepairResidualV1 {
  readonly code: string;
  readonly count: number;
}

export interface GovernanceDoctorRepairCompletionV1 {
  readonly claimSha256: string;
  readonly consentSha256: string;
  readonly effectSha256: string;
  readonly effectVerification: GovernanceDoctorRepairEffectVerificationV1;
  readonly planSha256: string;
  readonly postAuditSha256: string | null;
  readonly postAuditState: GovernanceDoctorRepairPostAuditStateV1;
  readonly preconditionSha256: string;
  readonly protocol: "GovernanceDoctorRepairCompletionV1";
  readonly receiptSha256: string;
  readonly recipeId: "aih.repair.recipe.canon-context-dir-v1";
  readonly repairState: GovernanceDoctorRepairCompletionStateV1;
  readonly reportSha256: string;
  readonly residual: readonly GovernanceDoctorRepairResidualV1[];
  readonly scopeSha256: string;
  readonly targetPath: "ai-coding";
}

const PROTOCOL = "GovernanceDoctorRepairCompletionV1";

const REPORT_DOMAIN = "aih.governance-doctor-repair-completion-v1";

const COMPLETION_FIELDS = [
  "claimSha256",
  "consentSha256",
  "effectSha256",
  "effectVerification",
  "planSha256",
  "postAuditSha256",
  "postAuditState",
  "preconditionSha256",
  "protocol",
  "receiptSha256",
  "recipeId",
  "repairState",
  "reportSha256",
  "residual",
  "scopeSha256",
  "targetPath",
] as const;

const EFFECT_VERIFICATIONS = ["unverified", "verified"] as const;
const POST_AUDIT_STATES = ["healthy", "partial", "unavailable"] as const;
const COMPLETION_STATES = ["complete", "failed", "partial"] as const;

const REQUEST_FIELDS = [
  "claim",
  "effectSha256",
  "plan",
  "postAudit",
  "precondition",
  "receipt",
  "rootRealPath",
  "verification",
] as const;

const MAX_RESIDUAL_CODE_UNITS = 64;

/** Findings plus unresolved diagnostics is the widest this list can ever be. */
const MAX_RESIDUAL =
  GOVERNANCE_DOCTOR_V1_LIMITS.maxFindings + GOVERNANCE_DOCTOR_READ_ONLY_DIAGNOSTIC_IDS.length;

const bytes = new WeakMap<object, Buffer>();

/**
 * The one completion rule. `complete` needs every part; `partial` is the single
 * shape where a verified effect coexists with a workstation that is still not
 * clean; everything else is `failed`. No path leads from a verified effect to
 * `complete` without also passing through a healthy fresh audit.
 */
function classify(
  effectVerification: GovernanceDoctorRepairEffectVerificationV1,
  postAuditState: GovernanceDoctorRepairPostAuditStateV1,
  joinsHold: boolean,
  attemptSucceeded: boolean,
): GovernanceDoctorRepairCompletionStateV1 {
  if (
    !joinsHold ||
    !attemptSucceeded ||
    effectVerification !== "verified" ||
    postAuditState === "unavailable"
  )
    return "failed";
  return postAuditState === "healthy" ? "complete" : "partial";
}

/**
 * The repair-specific reading of a fresh audit. `healthy` means nothing non-pass
 * survived: no finding, and no diagnostic that failed to resolve.
 */
function readPostAudit(value: unknown): {
  readonly residual: readonly GovernanceDoctorRepairResidualV1[];
  readonly sha256: string | null;
  readonly state: GovernanceDoctorRepairPostAuditStateV1;
} {
  let completeness: ReturnType<typeof deriveGovernanceDoctorAuditCompletenessV1>;
  try {
    completeness = deriveGovernanceDoctorAuditCompletenessV1(value);
  } catch {
    // An audit-level refusal, an unbranded value, a malformed one: in every case
    // no valid post-execution audit exists. That is a fact about this attempt,
    // not a reason to refuse recording it.
    return { residual: [], sha256: null, state: "unavailable" };
  }
  const audited = value as {
    readonly auditSha256: string;
    readonly findings: readonly { readonly code: string; readonly severity: string }[];
  };
  const counts = new Map<string, number>();
  for (const finding of audited.findings) {
    if (
      finding.code === GOVERNANCE_DOCTOR_READ_ONLY_PROBES_COMPLETED_V1 &&
      finding.severity === "info"
    )
      continue;
    counts.set(finding.code, (counts.get(finding.code) ?? 0) + 1);
  }
  for (const unresolved of completeness.unresolved)
    counts.set(unresolved.state, (counts.get(unresolved.state) ?? 0) + 1);
  const residual = sortByCodeUnitsV1(
    [...counts].map(([code, count]) => Object.freeze({ code, count })),
    (item) => item.code,
  );
  return {
    residual: Object.freeze(residual),
    sha256: audited.auditSha256,
    state: residual.length === 0 ? "healthy" : "partial",
  };
}

/**
 * Derives one completion record from an attempt's own bound evidence.
 *
 * Brands are checked first and refuse outright, because a record implies the
 * attempt was real. Agreement between those branded records is checked second
 * and produces `failed`, because a disagreement is something that happened.
 */
export function deriveGovernanceDoctorRepairCompletionV1(
  input: unknown,
): GovernanceDoctorRepairCompletionV1 {
  const request = assertRecordV1(input, "repair completion request");
  assertExactKeysV1(request, REQUEST_FIELDS, "repair completion request");
  canonicalGovernanceDoctorRepairPlanV1Bytes(request.plan);
  canonicalGovernanceDoctorRepairReceiptV1Bytes(request.receipt);
  canonicalGovernanceDoctorRepairVerificationV1Bytes(request.verification);
  const claim = assertGovernanceDoctorRepairClaimSpentV1(request.claim);
  const preconditionSha256 = governanceDoctorRepairPreconditionSha256V1(request.precondition);
  const precondition = request.precondition as GovernanceDoctorRepairPreconditionV1;
  const plan = request.plan as GovernanceDoctorRepairPlanV1;
  const receipt = request.receipt as GovernanceDoctorRepairReceiptV1;
  const verification = request.verification as GovernanceDoctorRepairVerificationV1;
  const effectSha256 = assertSha256V1(request.effectSha256, "repair completion effect identity");
  // The named effect must be this recipe's own, read from the branded Plan
  // rather than taken on the caller's word. Without the Plan, `effectSha256`
  // could name any applied effect in any receipt -- a line-ending normalization
  // on some other managed path -- and the record would still stamp it with this
  // recipe and the `ai-coding` target. Being asked to describe a different
  // effect is a category error, not an outcome, so it refuses.
  const declared = plan.effects.find((effect) => effect.effectSha256 === effectSha256);
  if (
    declared === undefined ||
    declared.effectKind !== "create-managed-directory" ||
    declared.arguments.path !== GOVERNANCE_DOCTOR_CANONICAL_CONTEXT_DIR_V1
  )
    failGovernanceDoctorRepairV1("repair completion effect is not this recipe's managed directory");
  const rootRealPath = request.rootRealPath;
  if (typeof rootRealPath !== "string" || rootRealPath.length === 0)
    failGovernanceDoctorRepairV1("repair completion requires the resolved checkout path");
  const scopeSha256 = governanceDoctorRepairClaimScopeSha256V1({ realPath: rootRealPath });

  // Every join this record rests on. Each compares two records minted
  // independently, so agreement is evidence and disagreement is a recorded
  // failure rather than a refusal.
  const joinsHold =
    receipt.planSha256 === plan.planSha256 &&
    receipt.rootSha256 === plan.rootSha256 &&
    verification.rootSha256 === plan.rootSha256 &&
    claim.planSha256 === receipt.planSha256 &&
    claim.consentSha256 === receipt.consentSha256 &&
    claim.scopeSha256 === scopeSha256 &&
    verification.receiptSha256 === receipt.receiptSha256 &&
    verification.planSha256 === receipt.planSha256 &&
    precondition.rootSha256 === governanceDoctorRepairPreconditionRootSha256V1(rootRealPath) &&
    precondition.recipeId === GOVERNANCE_DOCTOR_REPAIR_CANON_CONTEXT_RECIPE_V1 &&
    precondition.targetPath === GOVERNANCE_DOCTOR_CANONICAL_CONTEXT_DIR_V1;

  // The effect is verified only if this exact identity was applied *and* the
  // independent verifier confirmed it. A receipt alone never establishes this.
  const applied = receipt.effects.some(
    (effect) => effect.effectSha256 === effectSha256 && effect.result === "applied",
  );
  const checked = verification.checks.filter((check) => check.effectSha256 === effectSha256);
  const effectVerification: GovernanceDoctorRepairEffectVerificationV1 =
    applied && checked.length === 1 && checked[0]?.outcome === "verified"
      ? "verified"
      : "unverified";
  // One effect verifying does not make the attempt a success. A Plan may declare
  // several, and a Receipt reads `applied-unverified` only when every one of
  // them applied; the verifier's own overall outcome covers them all the same
  // way. Without this, a multi-effect Plan whose canon directory landed and
  // whose other effect failed would report the whole Repair complete.
  const attemptSucceeded =
    receipt.state === "applied-unverified" && verification.outcome === "verified";

  const post = readPostAudit(request.postAudit);
  const body = {
    claimSha256: claim.claimSha256,
    consentSha256: receipt.consentSha256,
    effectSha256,
    effectVerification,
    planSha256: receipt.planSha256,
    postAuditSha256: post.sha256,
    postAuditState: post.state,
    preconditionSha256,
    protocol: PROTOCOL,
    receiptSha256: receipt.receiptSha256,
    recipeId: GOVERNANCE_DOCTOR_REPAIR_CANON_CONTEXT_RECIPE_V1,
    repairState: classify(effectVerification, post.state, joinsHold, attemptSucceeded),
    residual: post.residual,
    scopeSha256,
    targetPath: GOVERNANCE_DOCTOR_CANONICAL_CONTEXT_DIR_V1,
  };
  const record = deepFreezeStrictJsonV1({
    ...body,
    reportSha256: governanceDoctorSha256V1(REPORT_DOMAIN, body),
  }) as unknown as GovernanceDoctorRepairCompletionV1;
  bytes.set(record, canonicalStrictJsonBytesV1(record));
  return record;
}

/** The canonical transport bytes of a record this module minted. */
export function canonicalGovernanceDoctorRepairCompletionV1Bytes(value: unknown): Buffer {
  const held = typeof value === "object" && value !== null ? bytes.get(value) : undefined;
  if (held === undefined)
    failGovernanceDoctorRepairV1("repair completion requires a validated brand");
  return Buffer.from(held);
}

function residualFrom(value: unknown): GovernanceDoctorRepairResidualV1 {
  const record = assertRecordV1(value, "repair completion residual");
  assertExactKeysV1(record, ["code", "count"], "repair completion residual");
  const code = record.code;
  const count = record.count;
  if (typeof code !== "string" || code.length === 0 || code.length > MAX_RESIDUAL_CODE_UNITS)
    failGovernanceDoctorRepairV1("repair completion residual code is outside its bound");
  if (
    typeof count !== "number" ||
    !Number.isSafeInteger(count) ||
    count < 1 ||
    count > MAX_RESIDUAL
  )
    failGovernanceDoctorRepairV1("repair completion residual count is outside its bound");
  return { code, count };
}

/**
 * Closed-schema validation. The shape is checked before the brand, and the three
 * states are checked against one another last: a record claiming `complete` on
 * an unverified effect, or on a post-audit that is not healthy, contradicts
 * itself and is refused however it was produced.
 */
export function assertGovernanceDoctorRepairCompletionV1(
  value: unknown,
): GovernanceDoctorRepairCompletionV1 {
  const record = assertRecordV1(value, "repair completion");
  assertExactKeysV1(record, COMPLETION_FIELDS, "repair completion");
  if (record.protocol !== PROTOCOL)
    failGovernanceDoctorRepairV1("repair completion protocol is not this version");
  if (
    record.recipeId !== GOVERNANCE_DOCTOR_REPAIR_CANON_CONTEXT_RECIPE_V1 ||
    record.targetPath !== GOVERNANCE_DOCTOR_CANONICAL_CONTEXT_DIR_V1
  )
    failGovernanceDoctorRepairV1("repair completion is not this recipe");
  for (const field of [
    "claimSha256",
    "consentSha256",
    "effectSha256",
    "planSha256",
    "preconditionSha256",
    "receiptSha256",
    "reportSha256",
    "scopeSha256",
  ] as const)
    assertSha256V1(record[field], `repair completion ${field}`);
  const effectVerification = assertEnumV1(
    record.effectVerification,
    EFFECT_VERIFICATIONS,
    "repair completion effect verification",
  );
  const postAuditState = assertEnumV1(
    record.postAuditState,
    POST_AUDIT_STATES,
    "repair completion post-audit state",
  );
  const repairState = assertEnumV1(
    record.repairState,
    COMPLETION_STATES,
    "repair completion state",
  );
  if (record.postAuditSha256 !== null)
    assertSha256V1(record.postAuditSha256, "repair completion post-audit identity");
  if ((record.postAuditSha256 === null) !== (postAuditState === "unavailable"))
    failGovernanceDoctorRepairV1("repair completion post-audit identity does not match its state");
  if (!Array.isArray(record.residual) || record.residual.length > MAX_RESIDUAL)
    failGovernanceDoctorRepairV1("repair completion residual is outside its bounded cardinality");
  const residual = record.residual.map(residualFrom);
  if (new Set(residual.map((item) => item.code)).size !== residual.length)
    failGovernanceDoctorRepairV1("repair completion residual repeats a code");
  // A partial post-audit has something residual; healthy and unavailable have
  // nothing -- the first because nothing survived, the second because nothing
  // was learned, and those must not be told apart by an empty list alone.
  if (residual.length > 0 !== (postAuditState === "partial"))
    failGovernanceDoctorRepairV1("repair completion residual does not match its post-audit state");
  // The repair state may never be better than its own parts allow. `failed`
  // stays reachable from facts this record does not carry -- a join that did not
  // hold, a sibling effect that failed -- so only the two optimistic states are
  // pinned here.
  if (repairState !== "failed" && effectVerification !== "verified")
    failGovernanceDoctorRepairV1("repair completion claims more than its effect verification");
  if (repairState === "complete" && postAuditState !== "healthy")
    failGovernanceDoctorRepairV1("repair completion claims more than its post-audit state");
  if (repairState === "partial" && postAuditState !== "partial")
    failGovernanceDoctorRepairV1("repair completion partial state does not match its post-audit");
  canonicalGovernanceDoctorRepairCompletionV1Bytes(record);
  return record as unknown as GovernanceDoctorRepairCompletionV1;
}
