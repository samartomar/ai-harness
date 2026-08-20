import { assertExactKeysV1, assertRecordV1 } from "./capability-v1.js";
import {
  GOVERNANCE_DOCTOR_REPAIR_EFFECT_KINDS_V1,
  type GovernanceDoctorRepairEffectKindV1,
} from "./repair-broker-v1.js";
import { failGovernanceDoctorRepairV1 } from "./repair-capability-v1.js";
import { acquireGovernanceDoctorRepairClaimV1 } from "./repair-claim-store-v1.js";
import {
  assertGovernanceDoctorRepairContentClosureV1,
  GOVERNANCE_DOCTOR_REPAIR_CONTENT_V1_LIMITS,
  governanceDoctorRepairContentBytesV1,
  normalizeGovernanceDoctorRepairLineEndingsV1,
  recordGovernanceDoctorRepairAttemptEvidenceV1,
  rewriteGovernanceDoctorRepairMarkerBlockV1,
} from "./repair-content-v1.js";
import {
  assertGovernanceDoctorRepairAuthorityWindowV1,
  createGovernanceDoctorRepairMutationGrantV1,
  GOVERNANCE_DOCTOR_REPAIR_CUSTODY_V1_LIMITS,
  governanceDoctorRepairCreateDirectoryV1,
  governanceDoctorRepairCustodyPlanSha256V1,
  governanceDoctorRepairCustodyRootRealPathV1,
  governanceDoctorRepairReadV1,
  governanceDoctorRepairWriteFileV1,
} from "./repair-custody-v1.js";
import {
  createGovernanceDoctorRepairReceiptV1,
  type GovernanceDoctorRepairEffectResultV1,
  type GovernanceDoctorRepairReceiptV1,
} from "./repair-outcome-v1.js";
import {
  canonicalGovernanceDoctorRepairPlanV1Bytes,
  type GovernanceDoctorRepairEffectV1,
  type GovernanceDoctorRepairPlanV1,
} from "./repair-plan-v1.js";

/**
 * The internal AIH Core local mechanical Repair executor.
 *
 * It applies exactly the four frozen V1 effect kinds and nothing else. Its whole
 * capability is the plan-bound custody handed to it: bounded reads, one declared
 * directory creation, and managed writes that publish by hard link and never
 * replace. Those writes are deliberately not described as atomic -- they are a
 * write / flush / displace / link / retire sequence with an explicit recovery,
 * and the recovery is the part that carries the guarantee: no failure path
 * destroys an object this executor did not create, and no partial body is ever
 * published under a managed name. There is no process, shell,
 * network, provider, scanner, signer, package, publication, selection, approval,
 * or deletion route in its import closure, and no seam through which a caller
 * could hand it something to run.
 *
 * Authority is assembled, never assumed. A run needs a branded Plan, a granted
 * out-of-band Consent for that same Plan, an execution context that binds both,
 * custody minted for that same Plan identity, and a trusted content input holding
 * exactly the digests the Plan's effects name -- no more and no fewer. The join is
 * checked in full before a single byte is written, and the foundation's own
 * Receipt constructor is what validates the consent decision and the attempt
 * window, so this module cannot grant itself something the contract would refuse.
 *
 * Durable single-use is enforced, and never from caller-provided replay state. A
 * granted Consent is spent exactly once per Plan per canonical checkout, and the
 * record that spends it is committed to the machine-local claim store before the
 * first byte moves. The claim is taken after every pure join above has already
 * passed, so a Plan this run was never going to apply does not burn its one
 * attempt; and it is taken before the first effect, so an interruption anywhere
 * after it leaves the Plan spent rather than replayable.
 *
 * Effects apply in Plan order and stop at the first one that does not reach its
 * goal state; the remainder are recorded as skipped. Applying an effect whose goal
 * state already holds writes nothing, so a second run over the same tree is
 * byte-identical and produces an identical Receipt.
 *
 * The Receipt reports what happened, and only that. It never claims verification:
 * a covering Verification comes from the separate verifier re-reading the result.
 * An effect that already committed is reported as applied even when a later effect
 * fails, because a rollback that did not occur must never be implied.
 *
 * Alongside the Receipt this run records the exact post-state it observed for the
 * effects it applied, keyed by the Receipt object itself. That record is local
 * evidence, not authority: it never travels, so a Receipt reconstructed from
 * transported bytes carries none of it and verifies as unavailable rather than
 * inheriting an attribution nobody local can vouch for.
 */
export const GOVERNANCE_DOCTOR_REPAIR_EXECUTABLE_EFFECT_KINDS_V1: readonly GovernanceDoctorRepairEffectKindV1[] =
  Object.freeze([
    "create-managed-directory",
    "normalize-managed-line-endings",
    "restore-managed-file-content",
    "rewrite-managed-marker-block",
  ] as const);

// Load-time guard: this executor can never carry an authority the broker has not frozen.
for (const kind of GOVERNANCE_DOCTOR_REPAIR_EXECUTABLE_EFFECT_KINDS_V1)
  if (!GOVERNANCE_DOCTOR_REPAIR_EFFECT_KINDS_V1.includes(kind))
    failGovernanceDoctorRepairV1("repair executor names an unregistered effect kind");

// Load-time guard on a cross-module coupling this file depends on but does not
// own: every byte custody will accept for a managed file must still be a byte the
// content module can hold as attempt evidence. Were custody's ceiling raised
// alone, a large effect would apply and then throw while its evidence was being
// recorded -- discarding the receipt for work that already landed, the worst
// reporting state this authority can reach.
if (
  GOVERNANCE_DOCTOR_REPAIR_CONTENT_V1_LIMITS.maxContentBytes <
  GOVERNANCE_DOCTOR_REPAIR_CUSTODY_V1_LIMITS.maxManagedFileBytes
)
  failGovernanceDoctorRepairV1("repair executor cannot record evidence for every managed write");

const EXECUTION_FIELDS = ["consent", "content", "context", "custody", "plan"] as const;

/**
 * Opaque execution phases keep the high-level live-precondition orchestrator
 * from reaching either the custody root or the durable claim store itself.
 * Their bodies live only in these WeakMaps: a look-alike, a replay, or a token
 * from another phase is not authority.
 */
export interface GovernanceDoctorRepairPreparedExecutionV1 {
  readonly protocol: "GovernanceDoctorRepairPreparedExecutionV1";
}

export interface GovernanceDoctorRepairClaimedExecutionV1 {
  readonly protocol: "GovernanceDoctorRepairClaimedExecutionV1";
}

export interface GovernanceDoctorRepairExecutionOutcomeV1 {
  /** Internal per-effect mutation facts for the live-attempt provenance boundary. */
  readonly changes: readonly GovernanceDoctorRepairExecutionChangeFactV1[];
  readonly receipt: GovernanceDoctorRepairReceiptV1;
  /** Opaque spent-claim provenance for the high-level attempt only. */
  readonly spentClaim: unknown;
  readonly rootRealPath: string;
}

export interface GovernanceDoctorRepairExecutionChangeFactV1 {
  readonly changed: boolean;
  readonly effectSha256: string;
  readonly result: GovernanceDoctorRepairEffectResultV1;
}

interface PreparedExecutionBodyV1 {
  readonly plan: GovernanceDoctorRepairPlanV1;
  readonly preflight: GovernanceDoctorRepairReceiptV1;
  readonly receiptRequest: {
    readonly attemptedAtEpochMs: number;
    readonly consent: unknown;
    readonly context: unknown;
    readonly plan: GovernanceDoctorRepairPlanV1;
  };
  readonly request: Readonly<Record<string, unknown>>;
}

interface ClaimedExecutionBodyV1 extends PreparedExecutionBodyV1 {
  readonly rootRealPath: string;
  readonly spentClaim: unknown;
}

const preparedExecutions = new WeakMap<object, PreparedExecutionBodyV1>();
const claimedExecutions = new WeakMap<object, ClaimedExecutionBodyV1>();
const postClaimRefusals = new WeakSet<object>();

type ClaimStoreAcquisitionV1 = typeof acquireGovernanceDoctorRepairClaimV1 & {
  readonly isPostExclusiveCreateRefusalV1?: unknown;
};

const claimStoreAcquisition = acquireGovernanceDoctorRepairClaimV1 as ClaimStoreAcquisitionV1;

function isClaimStorePostExclusiveCreateRefusal(error: unknown): boolean {
  try {
    const predicate = claimStoreAcquisition.isPostExclusiveCreateRefusalV1;
    return (
      typeof predicate !== "function" || (predicate as (value: unknown) => unknown)(error) !== false
    );
  } catch {
    // A malformed or unavailable internal phase predicate cannot prove that the
    // claim was still unspent, so retain the conservative post-claim phase.
    return true;
  }
}

function rethrowPostClaimRefusal(error: unknown): never {
  if (typeof error === "object" && error !== null) {
    postClaimRefusals.add(error);
    throw error;
  }
  const refusal = new TypeError("GOVERNANCE_DOCTOR_REPAIR_V1: repair claim did not commit");
  postClaimRefusals.add(refusal);
  throw refusal;
}

function isPostClaimRefusal(value: unknown): boolean {
  return typeof value === "object" && value !== null && postClaimRefusals.has(value);
}

function takePreparedExecution(value: unknown): PreparedExecutionBodyV1 {
  if (typeof value !== "object" || value === null) {
    failGovernanceDoctorRepairV1("repair prepared execution requires a validated brand");
  }
  const prepared = preparedExecutions.get(value);
  if (prepared === undefined)
    failGovernanceDoctorRepairV1("repair prepared execution requires a validated brand");
  preparedExecutions.delete(value);
  return prepared;
}

function readPreparedExecution(value: unknown): PreparedExecutionBodyV1 | undefined {
  return typeof value === "object" && value !== null ? preparedExecutions.get(value) : undefined;
}

function takeClaimedExecution(value: unknown): ClaimedExecutionBodyV1 {
  if (typeof value !== "object" || value === null) {
    failGovernanceDoctorRepairV1("repair claimed execution requires a validated brand");
  }
  const claimed = claimedExecutions.get(value);
  if (claimed === undefined)
    failGovernanceDoctorRepairV1("repair claimed execution requires a validated brand");
  claimedExecutions.delete(value);
  return claimed;
}

interface AppliedEffectV1 {
  readonly changed?: boolean;
  readonly expected?:
    | { readonly effectSha256: string; readonly state: "directory" }
    | { readonly bytes: Buffer; readonly effectSha256: string; readonly state: "file" };
  readonly result: GovernanceDoctorRepairEffectResultV1;
}

/** One declared argument value, or a closed refusal. The Plan schema guarantees it. */
function effectArgument(effect: GovernanceDoctorRepairEffectV1, name: string): string {
  const value = effect.arguments[name];
  if (value === undefined) failGovernanceDoctorRepairV1("repair effect argument is missing");
  return value;
}

/**
 * Applies one effect and reports whether its goal state holds afterwards. Every
 * custody refusal is already a closed label; here it collapses into one closed
 * per-effect result, so no filesystem detail can reach the Receipt.
 */
/** The one mutation grant shape every effect branch needs. */
function grantFor(
  consent: unknown,
  custody: unknown,
  effect: GovernanceDoctorRepairEffectV1,
  receipt: GovernanceDoctorRepairReceiptV1,
): unknown {
  return createGovernanceDoctorRepairMutationGrantV1({
    consent,
    custody,
    effectId: effect.effectId,
    receipt,
  });
}

/**
 * The two applied results. Each branch reaches one of them twice -- once when
 * the tree already satisfies the effect and once after it was made to -- and the
 * post-state evidence must be identical in both, so it is written once.
 */
function appliedDirectory(
  effect: GovernanceDoctorRepairEffectV1,
  changed: boolean,
): AppliedEffectV1 {
  return {
    changed,
    expected: { effectSha256: effect.effectSha256, state: "directory" },
    result: "applied",
  };
}

function appliedFile(
  effect: GovernanceDoctorRepairEffectV1,
  bytes: Buffer,
  changed: boolean,
): AppliedEffectV1 {
  return {
    changed,
    expected: { bytes, effectSha256: effect.effectSha256, state: "file" },
    result: "applied",
  };
}

function applyEffectV1(
  custody: unknown,
  consent: unknown,
  content: unknown,
  effect: GovernanceDoctorRepairEffectV1,
  receipt: GovernanceDoctorRepairReceiptV1,
): AppliedEffectV1 {
  try {
    // Before every effect, including the ones that will turn out to need no
    // grant. A closed window makes this effect fail exactly as a closed window
    // at grant time already did, which halts the run before the next one.
    assertGovernanceDoctorRepairAuthorityWindowV1({ consent, custody });
    const path = effectArgument(effect, "path");
    const kind = effect.effectKind;

    if (kind === "create-managed-directory") {
      const live = governanceDoctorRepairReadV1(custody, path);
      if (live.state === "directory") return appliedDirectory(effect, false);
      if (live.state !== "absent") return { result: "failed" };
      return appliedDirectory(
        effect,
        governanceDoctorRepairCreateDirectoryV1(grantFor(consent, custody, effect, receipt)),
      );
    }

    if (kind === "normalize-managed-line-endings") {
      const live = governanceDoctorRepairReadV1(custody, path);
      if (live.state !== "file") return { result: "failed" };
      const normalized = normalizeGovernanceDoctorRepairLineEndingsV1(live.bytes);
      if (normalized === null) return { result: "failed" };
      if (normalized.equals(live.bytes)) return appliedFile(effect, normalized, false);
      governanceDoctorRepairWriteFileV1(
        grantFor(consent, custody, effect, receipt),
        normalized,
        live,
      );
      return appliedFile(effect, normalized, true);
    }

    if (kind === "restore-managed-file-content") {
      const desired = governanceDoctorRepairContentBytesV1(
        content,
        effectArgument(effect, "contentSha256"),
      );
      const live = governanceDoctorRepairReadV1(custody, path);
      if (live.state === "file" && live.bytes.equals(desired))
        return appliedFile(effect, desired, false);
      if (live.state !== "file" && live.state !== "absent") return { result: "failed" };
      governanceDoctorRepairWriteFileV1(grantFor(consent, custody, effect, receipt), desired, live);
      return appliedFile(effect, desired, true);
    }

    if (kind === "rewrite-managed-marker-block") {
      const body = governanceDoctorRepairContentBytesV1(
        content,
        effectArgument(effect, "contentSha256"),
      );
      const live = governanceDoctorRepairReadV1(custody, path);
      if (live.state !== "file") return { result: "failed" };
      const next = rewriteGovernanceDoctorRepairMarkerBlockV1(
        live.bytes,
        effectArgument(effect, "blockId"),
        body,
      );
      if (next === null) return { result: "failed" };
      if (next.equals(live.bytes)) return appliedFile(effect, next, false);
      governanceDoctorRepairWriteFileV1(grantFor(consent, custody, effect, receipt), next, live);
      return appliedFile(effect, next, true);
    }

    // Closed default: an effect kind outside the frozen allowlist is never applied.
    return { result: "failed" };
  } catch {
    return { result: "failed" };
  }
}

/**
 * Every join this run's authority rests on, gathered so it can be taken twice.
 *
 * Once is the ordinary preflight. The second time is the last instant before the
 * claim is spent, which is the last instant a refusal is still free: the claim is
 * irreversible by design, so a plan refused after it is spent is finished rather
 * than merely stopped. Re-taking these costs nothing -- every one is pure or
 * in-memory over frozen branded records -- and re-taking them together with the
 * live authority window is what makes "these facts held" and "the claim was spent
 * on the strength of them" the same moment rather than two.
 */
function assertTrustedJoinV1(request: Record<string, unknown>, plan: GovernanceDoctorRepairPlanV1) {
  if (governanceDoctorRepairCustodyPlanSha256V1(request.custody) !== plan.planSha256)
    failGovernanceDoctorRepairV1("repair custody was not minted for this plan");
  for (const effect of plan.effects)
    if (!GOVERNANCE_DOCTOR_REPAIR_EXECUTABLE_EFFECT_KINDS_V1.includes(effect.effectKind))
      failGovernanceDoctorRepairV1("repair plan names an effect this executor cannot apply");
  assertGovernanceDoctorRepairContentClosureV1(request.content, plan.effects);
}

/**
 * Performs every pure execution join and creates the authority preflight
 * receipt. It neither acquires a durable claim nor changes the managed tree.
 */
export function prepareGovernanceDoctorRepairExecutionV1(
  input: unknown,
): GovernanceDoctorRepairPreparedExecutionV1 {
  const request = assertRecordV1(input, "repair execution request");
  assertExactKeysV1(request, EXECUTION_FIELDS, "repair execution request");
  canonicalGovernanceDoctorRepairPlanV1Bytes(request.plan);
  const plan = request.plan as GovernanceDoctorRepairPlanV1;

  assertTrustedJoinV1(request, plan);

  // Authority preflight: the foundation's own Receipt constructor validates the
  // plan, granted consent, execution context, and attempt window. Minting a
  // discarded all-skipped Receipt runs that check before anything is written.
  const receiptRequest = {
    // Read the clock only after all non-effectful joins and immediately before
    // the first authority-consuming preflight. Callers cannot choose this fact.
    attemptedAtEpochMs: Date.now(),
    consent: request.consent,
    context: request.context,
    plan,
  };
  const preflight = createGovernanceDoctorRepairReceiptV1({
    ...receiptRequest,
    effects: plan.effects.map((effect) => ({ effectId: effect.effectId, result: "skipped" })),
  });

  const prepared = Object.freeze({
    protocol: "GovernanceDoctorRepairPreparedExecutionV1" as const,
  });
  preparedExecutions.set(prepared, {
    plan,
    preflight,
    receiptRequest: Object.freeze(receiptRequest),
    request: Object.freeze({
      consent: request.consent,
      content: request.content,
      context: request.context,
      custody: request.custody,
      plan: request.plan,
    }),
  });
  return prepared;
}

/**
 * Checks whether a prepared custody remains the root named by an already
 * trusted live-precondition scope. The absolute root never crosses this module's
 * boundary: it is compared here and returned only as a boolean.
 */
export function governanceDoctorRepairExecutionScopeMatchesV1(
  execution: unknown,
  scopeRootRealPath: unknown,
): boolean {
  const body =
    readPreparedExecution(execution) ??
    (typeof execution === "object" && execution !== null
      ? claimedExecutions.get(execution)
      : undefined);
  if (body === undefined || typeof scopeRootRealPath !== "string") return false;
  try {
    return governanceDoctorRepairCustodyRootRealPathV1(body.request.custody) === scopeRootRealPath;
  } catch {
    return false;
  }
}

/**
 * Takes the irreversible durable claim only after rechecking every join and the
 * live authority window. Consuming the prepared phase makes it impossible to
 * substitute or replay preparation after this point.
 */
export function claimGovernanceDoctorRepairExecutionV1(
  prepared: unknown,
): GovernanceDoctorRepairClaimedExecutionV1 {
  const body = takePreparedExecution(prepared);
  assertTrustedJoinV1(body.request, body.plan);
  assertGovernanceDoctorRepairAuthorityWindowV1({
    consent: body.request.consent,
    custody: body.request.custody,
  });

  const rootRealPath = governanceDoctorRepairCustodyRootRealPathV1(body.request.custody);
  let spentClaim: unknown;
  try {
    spentClaim = claimStoreAcquisition({
      consent: body.request.consent,
      plan: body.plan,
      rootRealPath,
    });
  } catch (error) {
    if (isClaimStorePostExclusiveCreateRefusal(error)) rethrowPostClaimRefusal(error);
    throw error;
  }
  const claimed = Object.freeze({
    protocol: "GovernanceDoctorRepairClaimedExecutionV1" as const,
  });
  claimedExecutions.set(claimed, { ...body, rootRealPath, spentClaim });
  return claimed;
}

/**
 * Performs effects for a durably claimed execution. A claimed phase is
 * deliberately single-use: once it is entered, a crash or refusal cannot turn
 * the existing claim into permission to retry.
 */
export function applyGovernanceDoctorRepairExecutionOutcomeV1(
  claimed: unknown,
): GovernanceDoctorRepairExecutionOutcomeV1 {
  const body = takeClaimedExecution(claimed);
  const { plan, preflight, receiptRequest, request, rootRealPath, spentClaim } = body;

  const results: AppliedEffectV1[] = [];
  let halted = false;
  for (const effect of plan.effects) {
    if (halted) {
      results.push({ result: "skipped" });
      continue;
    }
    const result = applyEffectV1(
      request.custody,
      request.consent,
      request.content,
      effect,
      preflight,
    );
    results.push(result);
    halted = result.result !== "applied";
  }

  const receipt = createGovernanceDoctorRepairReceiptV1({
    ...receiptRequest,
    effects: plan.effects.map((effect, index) => ({
      effectId: effect.effectId,
      result: results[index]?.result ?? "skipped",
    })),
  });
  // Applied-only, and strictly so: the post-state is recorded for an effect this
  // run actually applied and for no other. A failed or skipped effect contributes
  // nothing, so the verifier can never read local evidence as a claim about work
  // that did not happen.
  try {
    recordGovernanceDoctorRepairAttemptEvidenceV1(
      receipt,
      results.flatMap((result, index) =>
        result.result === "applied" &&
        result.expected !== undefined &&
        receipt.effects[index]?.result === "applied"
          ? [result.expected]
          : [],
      ),
      // The claim this run spent before the first effect, carried here as the
      // authority to record what that run observed.
      spentClaim,
      // And the checkout it observed them in. Custody resolved this path before
      // any effect ran, and the claim store digested the same one when it minted
      // the claim, so the recorder can refuse a claim spent for another checkout.
      rootRealPath,
    );
  } catch {
    // The effect and claim are already durable. Evidence is auxiliary and a
    // recorder failure must make later verification unavailable, not erase this
    // Receipt or pretend the attempt never happened.
  }
  const changes = Object.freeze(
    plan.effects.map((effect, index) =>
      Object.freeze({
        changed: results[index]?.changed === true,
        effectSha256: effect.effectSha256,
        result: results[index]?.result ?? "skipped",
      }),
    ),
  );
  return { changes, receipt, rootRealPath, spentClaim };
}

/** Applies a claimed phase and returns only its receipt for ordinary callers. */
export function applyGovernanceDoctorRepairExecutionV1(
  claimed: unknown,
): GovernanceDoctorRepairReceiptV1 {
  return applyGovernanceDoctorRepairExecutionOutcomeV1(claimed).receipt;
}

/**
 * Applies one consented Repair Plan under its own root and returns the bound
 * Receipt. The legacy one-shot surface composes the same guarded phases used by
 * the high-level live-precondition attempt.
 */
export function executeGovernanceDoctorRepairV1(input: unknown): GovernanceDoctorRepairReceiptV1 {
  return applyGovernanceDoctorRepairExecutionV1(
    claimGovernanceDoctorRepairExecutionV1(prepareGovernanceDoctorRepairExecutionV1(input)),
  );
}

// See the matching claim-store property. The high-level attempt can distinguish
// this executor-owned phase fact without receiving a broader executor export.
Object.defineProperty(claimGovernanceDoctorRepairExecutionV1, "isPostClaimRefusalV1", {
  configurable: false,
  enumerable: false,
  value: isPostClaimRefusal,
  writable: false,
});
