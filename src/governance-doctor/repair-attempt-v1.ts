import { assertExactKeysV1, assertRecordV1, assertSha256V1 } from "./capability-v1.js";
import {
  deriveGovernanceDoctorRepairCompletionV1,
  type GovernanceDoctorRepairCompletionV1,
} from "./repair-completion-v1.js";
import {
  applyGovernanceDoctorRepairExecutionOutcomeV1,
  claimGovernanceDoctorRepairExecutionV1,
  governanceDoctorRepairExecutionScopeMatchesV1,
  prepareGovernanceDoctorRepairExecutionV1,
} from "./repair-executor-v1.js";
import {
  canonicalGovernanceDoctorRepairReceiptV1Bytes,
  type GovernanceDoctorRepairReceiptV1,
} from "./repair-outcome-v1.js";
import { observeGovernanceDoctorRepairPreconditionV1 } from "./repair-precondition-v1.js";
import { assertGovernanceDoctorRepairPreconditionScopeV1 } from "./repair-scope-v1.js";

/**
 * The live repair boundary. It owns the two observations that license a repair;
 * the mechanical executor owns the claim, custody root, and mutations. Keeping
 * those authority classes separate makes a stale observation unable to become a
 * mutation capability.
 */
const ATTEMPT_FIELDS = ["consent", "content", "context", "custody", "plan", "scope"] as const;
const completionProvenance = new WeakMap<
  object,
  {
    readonly changes: readonly { readonly changed: boolean; readonly effectSha256: string }[];
    readonly claim: unknown;
    readonly plan: unknown;
    readonly precondition: unknown;
    readonly rootRealPath: string;
  }
>();

type ClaimExecutionV1 = typeof claimGovernanceDoctorRepairExecutionV1 & {
  readonly isPostClaimRefusalV1?: unknown;
};

const claimExecution = claimGovernanceDoctorRepairExecutionV1 as ClaimExecutionV1;

function isExecutorPostClaimRefusal(error: unknown): boolean {
  try {
    const predicate = claimExecution.isPostClaimRefusalV1;
    return (
      typeof predicate !== "function" || (predicate as (value: unknown) => unknown)(error) !== false
    );
  } catch {
    // A missing internal phase marker must never recast an irreversible claim as
    // a retryable pre-claim refusal.
    return true;
  }
}

export type GovernanceDoctorRepairPostClaimEffectStateV1 = "not-applied" | "unknown";

export class GovernanceDoctorRepairPostClaimRefusalV1 extends Error {
  readonly effectState: GovernanceDoctorRepairPostClaimEffectStateV1;

  constructor(effectState: GovernanceDoctorRepairPostClaimEffectStateV1) {
    super("GOVERNANCE_DOCTOR_V1: repair attempt precondition is not currently eligible");
    this.name = "GovernanceDoctorRepairPostClaimRefusalV1";
    this.effectState = effectState;
  }
}

export class GovernanceDoctorRepairPreClaimRefusalV1 extends Error {
  constructor() {
    super("GOVERNANCE_DOCTOR_V1: repair attempt precondition is not currently eligible");
    this.name = "GovernanceDoctorRepairPreClaimRefusalV1";
  }
}

export function isGovernanceDoctorRepairPostClaimRefusalV1(
  value: unknown,
): value is GovernanceDoctorRepairPostClaimRefusalV1 {
  return value instanceof GovernanceDoctorRepairPostClaimRefusalV1;
}

export function isGovernanceDoctorRepairPreClaimRefusalV1(
  value: unknown,
): value is GovernanceDoctorRepairPreClaimRefusalV1 {
  return value instanceof GovernanceDoctorRepairPreClaimRefusalV1;
}

function refuseIneligible(): never {
  throw new GovernanceDoctorRepairPreClaimRefusalV1();
}

function refuseAfterClaim(): never {
  throw new GovernanceDoctorRepairPostClaimRefusalV1("not-applied");
}

/**
 * Attempts the one canonical Governance Doctor repair only while fresh, branded
 * live evidence says its target is absent and the custody still names that same
 * root. A pre-claim refusal spends no claim; after a claim commits, a changed
 * precondition leaves the claim durable and applies no effect.
 */
export function attemptGovernanceDoctorRepairV1(input: unknown): GovernanceDoctorRepairReceiptV1 {
  const request = assertRecordV1(input, "repair attempt request");
  assertExactKeysV1(request, ATTEMPT_FIELDS, "repair attempt request");
  const scope = assertGovernanceDoctorRepairPreconditionScopeV1(request.scope);

  // Preparation validates every plan/consent/content/custody join and builds the
  // preflight receipt, but has no mutation or durable-claim capability.
  const prepared = prepareGovernanceDoctorRepairExecutionV1({
    consent: request.consent,
    content: request.content,
    context: request.context,
    custody: request.custody,
    plan: request.plan,
  });
  if (!governanceDoctorRepairExecutionScopeMatchesV1(prepared, scope.rootRealPath))
    return refuseIneligible();

  // Never reuse caller-supplied or earlier observer output. This is a fresh
  // filesystem observation immediately before the irreversible claim.
  const precondition = observeGovernanceDoctorRepairPreconditionV1(scope);
  if (!precondition.eligible) return refuseIneligible();

  let claimed: ReturnType<typeof claimGovernanceDoctorRepairExecutionV1>;
  try {
    claimed = claimExecution(prepared);
  } catch (error) {
    if (isExecutorPostClaimRefusal(error)) return refuseAfterClaim();
    throw error;
  }

  // The claim survives every outcome below. Re-observe independently before the
  // first effect, then prove custody still binds the same root without leaking
  // its root capability to this orchestrator.
  let outcome: ReturnType<typeof applyGovernanceDoctorRepairExecutionOutcomeV1>;
  try {
    if (!observeGovernanceDoctorRepairPreconditionV1(scope).eligible) return refuseAfterClaim();
    if (!governanceDoctorRepairExecutionScopeMatchesV1(claimed, scope.rootRealPath))
      return refuseAfterClaim();
    outcome = applyGovernanceDoctorRepairExecutionOutcomeV1(claimed);
  } catch (error) {
    if (isGovernanceDoctorRepairPostClaimRefusalV1(error)) throw error;
    // Once the durable claim succeeds, every later failure belongs to a finished
    // attempt even if custody cannot report whether a partially begun effect
    // changed the tree. The command can then preserve --apply and report the
    // spent claim without inventing target mutation evidence.
    throw new GovernanceDoctorRepairPostClaimRefusalV1("unknown");
  }
  completionProvenance.set(outcome.receipt, {
    changes: outcome.changes.map(({ changed, effectSha256 }) =>
      Object.freeze({ changed, effectSha256 }),
    ),
    claim: outcome.spentClaim,
    plan: request.plan,
    precondition,
    rootRealPath: outcome.rootRealPath,
  });
  return outcome.receipt;
}

/**
 * Returns an actual mutation fact only for an in-memory receipt minted by this
 * live attempt. It deliberately exposes neither claim nor resolved root and
 * accepts no effect object or caller-supplied change assertion.
 */
export function didGovernanceDoctorRepairAttemptEffectChangeV1(input: unknown): boolean {
  const request = assertRecordV1(input, "repair attempt change request");
  assertExactKeysV1(request, ["effectSha256", "receipt"], "repair attempt change request");
  const effectSha256 = assertSha256V1(
    request.effectSha256,
    "repair attempt change effect identity",
  );
  canonicalGovernanceDoctorRepairReceiptV1Bytes(request.receipt);
  if (typeof request.receipt !== "object" || request.receipt === null)
    throw new TypeError(
      "GOVERNANCE_DOCTOR_REPAIR_V1: repair attempt change requires live provenance",
    );
  const provenance = completionProvenance.get(request.receipt);
  if (provenance === undefined)
    throw new TypeError(
      "GOVERNANCE_DOCTOR_REPAIR_V1: repair attempt change requires live provenance",
    );
  return provenance.changes.some(
    (fact) => fact.effectSha256 === effectSha256 && fact.changed === true,
  );
}

/** Derives completion only from provenance held for a real live attempt receipt. */
export function deriveGovernanceDoctorRepairAttemptCompletionV1(
  input: unknown,
): GovernanceDoctorRepairCompletionV1 {
  const request = assertRecordV1(input, "repair attempt completion request");
  assertExactKeysV1(
    request,
    ["effectSha256", "postAudit", "receipt", "verification"],
    "repair attempt completion request",
  );
  const provenance = completionProvenance.get(request.receipt as object);
  if (provenance === undefined)
    throw new TypeError(
      "GOVERNANCE_DOCTOR_REPAIR_V1: repair attempt completion requires live provenance",
    );
  return deriveGovernanceDoctorRepairCompletionV1({
    claim: provenance.claim,
    effectSha256: request.effectSha256,
    plan: provenance.plan,
    postAudit: request.postAudit,
    precondition: provenance.precondition,
    receipt: request.receipt,
    rootRealPath: provenance.rootRealPath,
    verification: request.verification,
  });
}
