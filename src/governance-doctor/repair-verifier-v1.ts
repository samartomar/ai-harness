import { assertExactKeysV1, assertRecordV1 } from "./capability-v1.js";
import { failGovernanceDoctorRepairV1 } from "./repair-capability-v1.js";
import {
  assertGovernanceDoctorRepairContentClosureV1,
  governanceDoctorRepairAttemptExpectedV1,
} from "./repair-content-v1.js";
import {
  governanceDoctorRepairCustodyPlanSha256V1,
  governanceDoctorRepairReadV1,
} from "./repair-custody-v1.js";
import {
  canonicalGovernanceDoctorRepairReceiptV1Bytes,
  createGovernanceDoctorRepairVerificationV1,
  type GovernanceDoctorRepairCheckOutcomeV1,
  type GovernanceDoctorRepairEffectResultV1,
  type GovernanceDoctorRepairReceiptV1,
  type GovernanceDoctorRepairVerificationV1,
} from "./repair-outcome-v1.js";
import {
  canonicalGovernanceDoctorRepairPlanV1Bytes,
  type GovernanceDoctorRepairEffectV1,
  type GovernanceDoctorRepairPlanV1,
} from "./repair-plan-v1.js";

/**
 * The independent verifier for a local mechanical Repair.
 *
 * It never imports the executor and never consults how a Receipt was produced. It
 * re-derives each effect's goal state from the live tree under the same plan-bound
 * custody, so a state that was applied and then undone reads as a failure rather
 * than as the executor's own success carried forward. It reads the Receipt only for
 * the one thing the V1 contract requires: an effect the Receipt does not record as
 * applied can never be reported verified.
 *
 * It writes nothing. Custody's read is the only filesystem operation it performs,
 * and no mutation is reachable from this module at all.
 *
 * A check that cannot complete -- an unreadable, aliased, symlinked, oversize, or
 * hostile shape where a managed path should be -- reports `unavailable` rather than
 * a verdict. The existing state resolver treats exact unavailability as neither
 * confirmation nor condemnation, so an applied repair stays `applied-unverified`
 * instead of being promoted or condemned on evidence nobody could read.
 *
 * The small argument reader below is deliberately not shared with the executor:
 * this module must remain constructible and reviewable without it.
 */
const VERIFICATION_FIELDS = ["content", "context", "custody", "plan", "receipt"] as const;

/** Whether an effect's goal state holds, does not hold, or could not be read. */
type GoalStateV1 = "absent" | "holds" | "unavailable";

/** One declared argument value, or a closed refusal. The Plan schema guarantees it. */
function effectArgument(effect: GovernanceDoctorRepairEffectV1, name: string): string {
  const value = effect.arguments[name];
  if (value === undefined) failGovernanceDoctorRepairV1("repair effect argument is missing");
  return value;
}

/**
 * Re-reads one effect's goal state from the live tree. Nothing about the attempt is
 * consulted: the same predicate would hold for a tree nobody ever repaired.
 */
function goalStateV1(
  custody: unknown,
  receipt: unknown,
  effect: GovernanceDoctorRepairEffectV1,
): GoalStateV1 {
  try {
    const expected = governanceDoctorRepairAttemptExpectedV1(receipt, effect.effectSha256);
    if (expected === undefined) return "unavailable";
    const live = governanceDoctorRepairReadV1(custody, effectArgument(effect, "path"));
    if (live.state === "unsafe") return "unavailable";
    if (expected.state === "directory") return live.state === "directory" ? "holds" : "absent";
    return live.state === "file" && live.bytes.equals(expected.bytes) ? "holds" : "absent";
  } catch {
    return "unavailable";
  }
}

/**
 * Maps one goal state plus the Receipt's own result to a closed check outcome.
 *
 * The Receipt's own record is read first, and an effect it does not record as
 * applied is `failed` -- not `unavailable`. `unavailable` means "nobody could
 * read this", and a failed or skipped effect is the one outcome this verifier
 * knows exactly. Reporting it as unreadable also made the not-applied case
 * unreachable in practice: attempt evidence exists only for effects a Receipt
 * records as applied, so a failed or skipped effect always resolves its goal
 * state to `unavailable` and could never reach a `holds` branch at all.
 *
 * `verified` still requires both that the state holds now and that the Receipt
 * recorded the effect as applied; an applied result this verifier cannot
 * attribute to the attempt stays `unavailable`.
 */
function checkOutcomeV1(
  goal: GoalStateV1,
  result: GovernanceDoctorRepairEffectResultV1,
): GovernanceDoctorRepairCheckOutcomeV1 {
  if (result !== "applied") return "failed";
  if (goal === "unavailable") return "unavailable";
  return goal === "holds" ? "verified" : "failed";
}

/**
 * Re-reads the live result of one repair attempt and mints the covering
 * Verification. Every identity is joined before the tree is read, and the outcome is
 * derived from the checks rather than asserted.
 */
export function verifyGovernanceDoctorRepairV1(
  input: unknown,
): GovernanceDoctorRepairVerificationV1 {
  const request = assertRecordV1(input, "repair verification request");
  assertExactKeysV1(request, VERIFICATION_FIELDS, "repair verification request");
  canonicalGovernanceDoctorRepairPlanV1Bytes(request.plan);
  canonicalGovernanceDoctorRepairReceiptV1Bytes(request.receipt);
  const plan = request.plan as GovernanceDoctorRepairPlanV1;
  const receipt = request.receipt as GovernanceDoctorRepairReceiptV1;

  if (receipt.planSha256 !== plan.planSha256)
    failGovernanceDoctorRepairV1("repair verification receipt does not bind this plan");
  if (governanceDoctorRepairCustodyPlanSha256V1(request.custody) !== plan.planSha256)
    failGovernanceDoctorRepairV1("repair custody was not minted for this plan");
  assertGovernanceDoctorRepairContentClosureV1(request.content, plan.effects);

  return createGovernanceDoctorRepairVerificationV1({
    checks: plan.effects.map((effect, index) => ({
      effectId: effect.effectId,
      outcome: checkOutcomeV1(
        goalStateV1(request.custody, receipt, effect),
        receipt.effects[index]?.result ?? "failed",
      ),
    })),
    context: request.context,
    plan,
    receipt,
    // Verification time is a local factual observation, never caller input.
    verifiedAtEpochMs: Date.now(),
  });
}
