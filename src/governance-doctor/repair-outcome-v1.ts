import { canonicalStrictJsonBytesV1, deepFreezeStrictJsonV1 } from "../contract/strict-json-v1.js";
import {
  assertArrayV1,
  assertEnumV1,
  assertExactKeysV1,
  assertRecordV1,
  assertSha256V1,
  assertTokenV1,
  assertUniqueV1,
  GOVERNANCE_DOCTOR_QUALIFIED_ID_PATTERN,
  GOVERNANCE_DOCTOR_V1_LIMITS,
  governanceDoctorSha256V1,
} from "./capability-v1.js";
import {
  assertEpochMillisecondsV1,
  boundedRepairTransportV1,
  brandedRepairValueV1,
  failGovernanceDoctorRepairV1,
  GOVERNANCE_DOCTOR_REPAIR_DOMAIN_V1,
  GOVERNANCE_DOCTOR_REPAIR_V1_LIMITS,
} from "./repair-capability-v1.js";
import {
  canonicalGovernanceDoctorRepairConsentV1Bytes,
  type GovernanceDoctorRepairConsentV1,
} from "./repair-consent-v1.js";
import {
  canonicalGovernanceDoctorRepairPlanV1Bytes,
  type GovernanceDoctorRepairPlanV1,
} from "./repair-plan-v1.js";

/**
 * The three records that close a Governance Doctor Repair, plus the pure resolver
 * that reads them.
 *
 * A **Receipt** proves ownership of exactly the effects a plan named: the same
 * identities, the same digests, in the same order, with one closed result each.
 * It cannot report success it does not have -- `applied-unverified` is reachable
 * only when every single effect was applied, and any other combination is a
 * `failed` receipt that still records which individual effects went through.
 *
 * A **Verification** must cover that same set completely; partial coverage is
 * refused rather than read as a pass. It also cannot claim an effect verified
 * that the receipt says was never applied, and its overall outcome is derived
 * from its checks -- `failed` beats `unavailable` beats `verified` -- so an
 * applied failure can never be relabelled as success.
 *
 * The **resolver** is a pure function over those records plus an explicit
 * consumed-identity list and an evaluation instant. It reads no clock and holds
 * no state. Replay, mismatch, expiry, denial, effect failure, and failed
 * verification are all terminal and fail closed; exact unavailability is the one
 * outcome that stays where it is, leaving the repair `applied-unverified` rather
 * than promoting or condemning it. Whatever the verdict, `applied` records
 * whether anything actually changed, so a refusal never erases that fact.
 */
export type GovernanceDoctorRepairEffectResultV1 = "applied" | "failed" | "skipped";
export type GovernanceDoctorRepairCheckOutcomeV1 = "failed" | "unavailable" | "verified";
export type GovernanceDoctorRepairReceiptStateV1 = "applied-unverified" | "failed";

export type GovernanceDoctorRepairStateV1 =
  | "applied-unverified"
  | "consented"
  | "planned"
  | "refused"
  | "verified";

export type GovernanceDoctorRepairRefusalReasonV1 =
  | "consent-denied"
  | "consent-mismatch"
  | "effect-failed"
  | "expired"
  | "receipt-mismatch"
  | "replayed"
  | "verification-failed"
  | "verification-mismatch";

export interface GovernanceDoctorRepairReceiptV1 {
  readonly attemptedAtEpochMs: number;
  readonly brokerId: string;
  readonly consentSha256: string;
  readonly effects: readonly {
    readonly effectId: string;
    readonly effectSha256: string;
    readonly result: GovernanceDoctorRepairEffectResultV1;
  }[];
  readonly executorId: string;
  readonly owner: "aih";
  readonly planSha256: string;
  readonly protocol: "GovernanceDoctorRepairReceiptV1";
  readonly recipeSha256: string;
  readonly registrySha256: string;
  readonly receiptSha256: string;
  readonly state: GovernanceDoctorRepairReceiptStateV1;
  readonly rootSha256: string;
}

export interface GovernanceDoctorRepairExecutionContextV1 {
  readonly protocol: "GovernanceDoctorRepairExecutionContextV1";
}

export interface GovernanceDoctorRepairVerificationV1 {
  readonly brokerId: string;
  readonly checks: readonly {
    readonly effectId: string;
    readonly effectSha256: string;
    readonly outcome: GovernanceDoctorRepairCheckOutcomeV1;
  }[];
  readonly outcome: GovernanceDoctorRepairCheckOutcomeV1;
  readonly planSha256: string;
  readonly protocol: "GovernanceDoctorRepairVerificationV1";
  readonly recipeSha256: string;
  readonly registrySha256: string;
  readonly receiptSha256: string;
  readonly verificationSha256: string;
  readonly verifiedAtEpochMs: number;
  readonly verifierId: string;
  readonly rootSha256: string;
  readonly trustAnchorSha256: string;
}

export interface GovernanceDoctorRepairVerificationContextV1 {
  readonly protocol: "GovernanceDoctorRepairVerificationContextV1";
}

export interface GovernanceDoctorRepairResolutionV1 {
  readonly applied: boolean;
  readonly planSha256: string;
  readonly protocol: "GovernanceDoctorRepairStateV1";
  readonly reason: GovernanceDoctorRepairRefusalReasonV1 | null;
  readonly resolutionSha256: string;
  readonly state: GovernanceDoctorRepairStateV1;
}

const RECEIPT_PROTOCOL = "GovernanceDoctorRepairReceiptV1";
const VERIFICATION_PROTOCOL = "GovernanceDoctorRepairVerificationV1";
const STATE_PROTOCOL = "GovernanceDoctorRepairStateV1";

const EFFECT_RESULTS = ["applied", "failed", "skipped"] as const;
const CHECK_OUTCOMES = ["failed", "unavailable", "verified"] as const;

const RECEIPT_FIELDS = ["attemptedAtEpochMs", "consent", "context", "effects", "plan"] as const;
const VERIFICATION_FIELDS = ["checks", "context", "plan", "receipt", "verifiedAtEpochMs"] as const;
const RESOLVER_FIELDS = [
  "consent",
  "consumedPlanSha256",
  "evaluatedAtEpochMs",
  "plan",
  "receipt",
  "verification",
] as const;

type Json = Record<string, unknown>;

/** Anti-forgery brands: a structurally identical plain object is not a record. */
const receiptBytes = new WeakMap<object, Buffer>();
const verificationBytes = new WeakMap<object, Buffer>();
const resolutionBytes = new WeakMap<object, Buffer>();
const executionContexts = new WeakMap<
  object,
  {
    readonly brokerId: string;
    readonly executorId: string;
    readonly owner: "aih";
    readonly recipeSha256: string;
    readonly registrySha256: string;
    readonly rootSha256: string;
  }
>();
const verificationContexts = new WeakMap<
  object,
  {
    readonly brokerId: string;
    readonly recipeSha256: string;
    readonly registrySha256: string;
    readonly rootSha256: string;
    readonly trustAnchorSha256: string;
    readonly verifierId: string;
  }
>();

export function createGovernanceDoctorRepairExecutionContextV1(
  input: unknown,
): GovernanceDoctorRepairExecutionContextV1 {
  const record = assertRecordV1(input, "repair execution context");
  assertExactKeysV1(
    record,
    ["brokerId", "executorId", "owner", "recipeSha256", "registrySha256", "rootSha256"],
    "repair execution context",
  );
  const context = Object.freeze({ protocol: "GovernanceDoctorRepairExecutionContextV1" as const });
  executionContexts.set(context, {
    brokerId: assertTokenV1(
      record.brokerId,
      GOVERNANCE_DOCTOR_QUALIFIED_ID_PATTERN,
      GOVERNANCE_DOCTOR_V1_LIMITS.maxIdentifierCodeUnits,
      "repair execution broker ID",
    ),
    executorId: assertTokenV1(
      record.executorId,
      GOVERNANCE_DOCTOR_QUALIFIED_ID_PATTERN,
      GOVERNANCE_DOCTOR_V1_LIMITS.maxIdentifierCodeUnits,
      "repair execution executor ID",
    ),
    owner: assertEnumV1(record.owner, ["aih"] as const, "repair execution owner"),
    recipeSha256: assertSha256V1(record.recipeSha256, "repair execution recipe identity"),
    registrySha256: assertSha256V1(record.registrySha256, "repair execution registry identity"),
    rootSha256: assertSha256V1(record.rootSha256, "repair execution root identity"),
  });
  return context;
}

export function createGovernanceDoctorRepairVerificationContextV1(
  input: unknown,
): GovernanceDoctorRepairVerificationContextV1 {
  const record = assertRecordV1(input, "repair verification context");
  assertExactKeysV1(
    record,
    ["brokerId", "recipeSha256", "registrySha256", "rootSha256", "trustAnchorSha256", "verifierId"],
    "repair verification context",
  );
  const context = Object.freeze({
    protocol: "GovernanceDoctorRepairVerificationContextV1" as const,
  });
  verificationContexts.set(context, {
    brokerId: assertTokenV1(
      record.brokerId,
      GOVERNANCE_DOCTOR_QUALIFIED_ID_PATTERN,
      GOVERNANCE_DOCTOR_V1_LIMITS.maxIdentifierCodeUnits,
      "repair verification broker ID",
    ),
    recipeSha256: assertSha256V1(record.recipeSha256, "repair verification recipe identity"),
    registrySha256: assertSha256V1(record.registrySha256, "repair verification registry identity"),
    rootSha256: assertSha256V1(record.rootSha256, "repair verification root identity"),
    trustAnchorSha256: assertSha256V1(record.trustAnchorSha256, "repair verification trust anchor"),
    verifierId: assertTokenV1(
      record.verifierId,
      GOVERNANCE_DOCTOR_QUALIFIED_ID_PATTERN,
      GOVERNANCE_DOCTOR_V1_LIMITS.maxIdentifierCodeUnits,
      "repair verifier ID",
    ),
  });
  return context;
}

function brandedPlan(value: unknown): GovernanceDoctorRepairPlanV1 {
  canonicalGovernanceDoctorRepairPlanV1Bytes(value);
  return value as GovernanceDoctorRepairPlanV1;
}

function brandedConsent(value: unknown): GovernanceDoctorRepairConsentV1 {
  canonicalGovernanceDoctorRepairConsentV1Bytes(value);
  return value as GovernanceDoctorRepairConsentV1;
}

function brandedReceipt(value: unknown): GovernanceDoctorRepairReceiptV1 {
  brandedRepairValueV1(receiptBytes, value, "repair receipt");
  return value as GovernanceDoctorRepairReceiptV1;
}

function brandedVerification(value: unknown): GovernanceDoctorRepairVerificationV1 {
  brandedRepairValueV1(verificationBytes, value, "repair verification");
  return value as GovernanceDoctorRepairVerificationV1;
}

/**
 * Reads one per-effect entry, requiring the plan's own effect identity in the
 * plan's own position. Missing, extra, reordered, or renamed coverage is refused
 * here rather than reconciled downstream.
 */
function coveringEntries<T extends string>(
  value: unknown,
  plan: GovernanceDoctorRepairPlanV1,
  field: "outcome" | "result",
  allowed: readonly T[],
  label: string,
): readonly { readonly effectId: string; readonly effectSha256: string; readonly value: T }[] {
  const entries = assertArrayV1(value, plan.effects.length, plan.effects.length, label).map(
    (item, index) => {
      const record = assertRecordV1(item, label);
      assertExactKeysV1(record, ["effectId", field], label);
      const effect = plan.effects[index];
      if (effect === undefined || record.effectId !== effect.effectId)
        failGovernanceDoctorRepairV1(`${label} does not cover the plan effects in order`);
      return {
        effectId: effect.effectId,
        effectSha256: effect.effectSha256,
        value: assertEnumV1(record[field], allowed, `${label} ${field}`),
      };
    },
  );
  assertUniqueV1(
    entries.map((entry) => entry.effectId),
    label,
  );
  return entries;
}

/**
 * Validates one repair attempt and mints a branded, frozen receipt owning exactly
 * the plan's effects. A receipt requires a granted consent for that same plan:
 * there is no path from a denied or absent ruling to an attempt record.
 */
export function createGovernanceDoctorRepairReceiptV1(
  input: unknown,
): GovernanceDoctorRepairReceiptV1 {
  const request = assertRecordV1(input, "repair receipt request");
  assertExactKeysV1(request, RECEIPT_FIELDS, "repair receipt request");
  const plan = brandedPlan(request.plan);
  const consent = brandedConsent(request.consent);
  const context = brandedRepairValueV1(
    executionContexts,
    request.context,
    "repair execution context",
  );
  if (consent.planSha256 !== plan.planSha256)
    failGovernanceDoctorRepairV1("repair receipt consent does not bind this plan");
  if (consent.decision !== "granted")
    failGovernanceDoctorRepairV1("repair receipt requires a granted consent");
  if (
    context.brokerId !== plan.brokerId ||
    context.recipeSha256 !== plan.recipeSha256 ||
    context.registrySha256 !== plan.registrySha256 ||
    context.rootSha256 !== plan.rootSha256
  )
    failGovernanceDoctorRepairV1("repair execution context does not bind this plan");

  const attemptedAtEpochMs = assertEpochMillisecondsV1(
    request.attemptedAtEpochMs,
    "repair attempt instant",
  );
  if (
    attemptedAtEpochMs < consent.consentedAtEpochMs ||
    attemptedAtEpochMs >= plan.expiresAtEpochMs
  )
    failGovernanceDoctorRepairV1("repair attempt falls outside the consented validity window");

  const effects = coveringEntries(
    request.effects,
    plan,
    "result",
    EFFECT_RESULTS,
    "repair receipt effects",
  ).map((entry) => ({
    effectId: entry.effectId,
    effectSha256: entry.effectSha256,
    result: entry.value,
  }));
  const body: Json = {
    attemptedAtEpochMs,
    brokerId: context.brokerId,
    consentSha256: consent.consentSha256,
    effects,
    executorId: context.executorId,
    owner: context.owner,
    planSha256: plan.planSha256,
    protocol: RECEIPT_PROTOCOL,
    recipeSha256: context.recipeSha256,
    registrySha256: context.registrySha256,
    // Success is not asserted, it is earned: every effect must have applied.
    state: effects.every((effect) => effect.result === "applied") ? "applied-unverified" : "failed",
    rootSha256: context.rootSha256,
  };
  const receipt = deepFreezeStrictJsonV1({
    ...body,
    receiptSha256: governanceDoctorSha256V1(GOVERNANCE_DOCTOR_REPAIR_DOMAIN_V1.receipt, body),
  }) as GovernanceDoctorRepairReceiptV1;
  receiptBytes.set(receipt, canonicalStrictJsonBytesV1(receipt));
  return receipt;
}

/**
 * Validates one covering verification and mints a branded, frozen record. The
 * checks must cover every planned effect, and a check may only read `verified`
 * for an effect the receipt says was actually applied.
 */
export function createGovernanceDoctorRepairVerificationV1(
  input: unknown,
): GovernanceDoctorRepairVerificationV1 {
  const request = assertRecordV1(input, "repair verification request");
  assertExactKeysV1(request, VERIFICATION_FIELDS, "repair verification request");
  const plan = brandedPlan(request.plan);
  const receipt = brandedReceipt(request.receipt);
  const context = brandedRepairValueV1(
    verificationContexts,
    request.context,
    "repair verification context",
  );
  if (receipt.planSha256 !== plan.planSha256)
    failGovernanceDoctorRepairV1("repair verification receipt does not bind this plan");
  if (
    context.brokerId !== plan.brokerId ||
    context.recipeSha256 !== plan.recipeSha256 ||
    context.registrySha256 !== plan.registrySha256 ||
    context.rootSha256 !== plan.rootSha256 ||
    receipt.brokerId !== context.brokerId ||
    receipt.recipeSha256 !== context.recipeSha256 ||
    receipt.registrySha256 !== context.registrySha256 ||
    receipt.rootSha256 !== context.rootSha256
  )
    failGovernanceDoctorRepairV1("repair verification context does not bind plan and receipt");

  const verifiedAtEpochMs = assertEpochMillisecondsV1(
    request.verifiedAtEpochMs,
    "repair verification instant",
  );
  if (verifiedAtEpochMs < receipt.attemptedAtEpochMs)
    failGovernanceDoctorRepairV1("repair verification precedes the attempt it covers");

  const checks = coveringEntries(
    request.checks,
    plan,
    "outcome",
    CHECK_OUTCOMES,
    "repair verification checks",
  ).map((entry, index) => {
    if (entry.value === "verified" && receipt.effects[index]?.result !== "applied")
      failGovernanceDoctorRepairV1(
        "repair verification claims an effect the receipt never applied",
      );
    return { effectId: entry.effectId, effectSha256: entry.effectSha256, outcome: entry.value };
  });
  const body: Json = {
    brokerId: context.brokerId,
    checks,
    // Failure outranks unavailability, which outranks success.
    outcome: checks.some((check) => check.outcome === "failed")
      ? "failed"
      : checks.some((check) => check.outcome === "unavailable")
        ? "unavailable"
        : "verified",
    planSha256: plan.planSha256,
    protocol: VERIFICATION_PROTOCOL,
    recipeSha256: context.recipeSha256,
    registrySha256: context.registrySha256,
    receiptSha256: receipt.receiptSha256,
    verifiedAtEpochMs,
    verifierId: context.verifierId,
    rootSha256: context.rootSha256,
    trustAnchorSha256: context.trustAnchorSha256,
  };
  const verification = deepFreezeStrictJsonV1({
    ...body,
    verificationSha256: governanceDoctorSha256V1(
      GOVERNANCE_DOCTOR_REPAIR_DOMAIN_V1.verification,
      body,
    ),
  }) as GovernanceDoctorRepairVerificationV1;
  verificationBytes.set(verification, canonicalStrictJsonBytesV1(verification));
  return verification;
}

/** The exact canonical JCS UTF-8 bytes of a minted receipt, as a defensive copy. */
export function canonicalGovernanceDoctorRepairReceiptV1Bytes(value: unknown): Buffer {
  return Buffer.from(brandedRepairValueV1(receiptBytes, value, "repair receipt"));
}

/** The exact canonical JCS UTF-8 bytes of a minted verification, as a copy. */
export function canonicalGovernanceDoctorRepairVerificationV1Bytes(value: unknown): Buffer {
  return Buffer.from(brandedRepairValueV1(verificationBytes, value, "repair verification"));
}

/** The exact canonical JCS UTF-8 bytes of a resolved state, as a defensive copy. */
export function canonicalGovernanceDoctorRepairStateV1Bytes(value: unknown): Buffer {
  return Buffer.from(brandedRepairValueV1(resolutionBytes, value, "repair state resolution"));
}

/**
 * Reconstructs a receipt from canonical transport only after its exact trusted
 * plan, granted consent, and execution context have been supplied. Bytes alone
 * therefore cannot mint an attempt authority.
 */
export function parseGovernanceDoctorRepairReceiptV1Json(
  input: unknown,
): GovernanceDoctorRepairReceiptV1 {
  const request = assertRecordV1(input, "repair receipt transport request");
  assertExactKeysV1(
    request,
    ["bytes", "consent", "context", "plan"],
    "repair receipt transport request",
  );
  const plan = brandedPlan(request.plan);
  const consent = brandedConsent(request.consent);
  brandedRepairValueV1(executionContexts, request.context, "repair execution context");
  const [bytes, record] = boundedRepairTransportV1(request.bytes, "repair receipt");
  assertExactKeysV1(
    record,
    [
      "attemptedAtEpochMs",
      "brokerId",
      "consentSha256",
      "effects",
      "executorId",
      "owner",
      "planSha256",
      "protocol",
      "recipeSha256",
      "receiptSha256",
      "registrySha256",
      "rootSha256",
      "state",
    ],
    "repair receipt transport",
  );
  if (record.protocol !== RECEIPT_PROTOCOL)
    failGovernanceDoctorRepairV1("repair receipt transport protocol is invalid");
  const receipt = createGovernanceDoctorRepairReceiptV1({
    attemptedAtEpochMs: record.attemptedAtEpochMs,
    consent,
    context: request.context,
    effects: assertArrayV1(
      record.effects,
      1,
      GOVERNANCE_DOCTOR_REPAIR_V1_LIMITS.maxEffects,
      "repair receipt transport effects",
    ).map((entry) => {
      const effect = assertRecordV1(entry, "repair receipt transport effect");
      assertExactKeysV1(
        effect,
        ["effectId", "effectSha256", "result"],
        "repair receipt transport effect",
      );
      return { effectId: effect.effectId, result: effect.result };
    }),
    plan,
  });
  if (!canonicalGovernanceDoctorRepairReceiptV1Bytes(receipt).equals(bytes))
    failGovernanceDoctorRepairV1("repair receipt transport does not match trusted identities");
  return receipt;
}

/**
 * Reconstructs a verification from canonical transport only under an exact
 * trusted plan, receipt, and verification context.
 */
export function parseGovernanceDoctorRepairVerificationV1Json(
  input: unknown,
): GovernanceDoctorRepairVerificationV1 {
  const request = assertRecordV1(input, "repair verification transport request");
  assertExactKeysV1(
    request,
    ["bytes", "context", "plan", "receipt"],
    "repair verification transport request",
  );
  const plan = brandedPlan(request.plan);
  const receipt = brandedReceipt(request.receipt);
  brandedRepairValueV1(verificationContexts, request.context, "repair verification context");
  const [bytes, record] = boundedRepairTransportV1(request.bytes, "repair verification");
  assertExactKeysV1(
    record,
    [
      "brokerId",
      "checks",
      "outcome",
      "planSha256",
      "protocol",
      "recipeSha256",
      "receiptSha256",
      "registrySha256",
      "rootSha256",
      "trustAnchorSha256",
      "verificationSha256",
      "verifiedAtEpochMs",
      "verifierId",
    ],
    "repair verification transport",
  );
  if (record.protocol !== VERIFICATION_PROTOCOL)
    failGovernanceDoctorRepairV1("repair verification transport protocol is invalid");
  const verification = createGovernanceDoctorRepairVerificationV1({
    checks: assertArrayV1(
      record.checks,
      1,
      GOVERNANCE_DOCTOR_REPAIR_V1_LIMITS.maxEffects,
      "repair verification transport checks",
    ).map((entry) => {
      const check = assertRecordV1(entry, "repair verification transport check");
      assertExactKeysV1(
        check,
        ["effectId", "effectSha256", "outcome"],
        "repair verification transport check",
      );
      return { effectId: check.effectId, outcome: check.outcome };
    }),
    context: request.context,
    plan,
    receipt,
    verifiedAtEpochMs: record.verifiedAtEpochMs,
  });
  if (!canonicalGovernanceDoctorRepairVerificationV1Bytes(verification).equals(bytes))
    failGovernanceDoctorRepairV1("repair verification transport does not match trusted identities");
  return verification;
}

function resolution(
  planSha256: string,
  state: GovernanceDoctorRepairStateV1,
  reason: GovernanceDoctorRepairRefusalReasonV1 | null,
  applied: boolean,
): GovernanceDoctorRepairResolutionV1 {
  const body: Json = { applied, planSha256, protocol: STATE_PROTOCOL, reason, state };
  const resolved = deepFreezeStrictJsonV1({
    ...body,
    resolutionSha256: governanceDoctorSha256V1(GOVERNANCE_DOCTOR_REPAIR_DOMAIN_V1.state, body),
  }) as GovernanceDoctorRepairResolutionV1;
  resolutionBytes.set(resolved, canonicalStrictJsonBytesV1(resolved));
  return resolved;
}

function consumedPlanIdentities(value: unknown): ReadonlySet<string> {
  const identities = assertArrayV1(
    value,
    0,
    GOVERNANCE_DOCTOR_REPAIR_V1_LIMITS.maxConsumedPlanIdentities,
    "consumed repair plan identities",
  ).map((item) => assertSha256V1(item, "consumed repair plan identity"));
  assertUniqueV1(identities, "consumed repair plan identities");
  return new Set(identities);
}

/**
 * Resolves the terminal state of one repair from the records that exist. Pure:
 * every input is data, nothing is read from the environment, and the same inputs
 * always produce the same resolution.
 */
export function resolveGovernanceDoctorRepairStateV1(
  input: unknown,
): GovernanceDoctorRepairResolutionV1 {
  const request = assertRecordV1(input, "repair state request");
  assertExactKeysV1(request, RESOLVER_FIELDS, "repair state request");
  const plan = brandedPlan(request.plan);
  const evaluatedAtEpochMs = assertEpochMillisecondsV1(
    request.evaluatedAtEpochMs,
    "repair state evaluation instant",
  );
  const consumed = consumedPlanIdentities(request.consumedPlanSha256);
  const consent = request.consent === null ? null : brandedConsent(request.consent);
  const receipt = request.receipt === null ? null : brandedReceipt(request.receipt);
  const verification =
    request.verification === null ? null : brandedVerification(request.verification);
  const refuse = (reason: GovernanceDoctorRepairRefusalReasonV1, applied = false) =>
    resolution(plan.planSha256, "refused", reason, applied);

  // A single-use plan identity that has already been consumed is terminal
  // regardless of how complete the rest of the evidence looks.
  const knownApplied =
    receipt !== null &&
    receipt.planSha256 === plan.planSha256 &&
    (consent === null || receipt.consentSha256 === consent.consentSha256) &&
    receipt.effects.some((effect) => effect.result === "applied");
  if (consumed.has(plan.planSha256)) return refuse("replayed", knownApplied);

  if (consent === null) {
    if (receipt !== null || verification !== null) return refuse("receipt-mismatch");
    if (evaluatedAtEpochMs >= plan.expiresAtEpochMs) return refuse("expired");
    return resolution(plan.planSha256, "planned", null, false);
  }
  if (
    consent.planSha256 !== plan.planSha256 ||
    consent.subjectId !== plan.targetId ||
    consent.consentedAtEpochMs < plan.createdAtEpochMs ||
    consent.consentedAtEpochMs >= plan.expiresAtEpochMs
  )
    return refuse("consent-mismatch");
  if (consent.decision !== "granted") return refuse("consent-denied");

  if (receipt === null) {
    if (verification !== null) return refuse("receipt-mismatch");
    if (evaluatedAtEpochMs >= plan.expiresAtEpochMs) return refuse("expired");
    return resolution(plan.planSha256, "consented", null, false);
  }
  if (receipt.planSha256 !== plan.planSha256 || receipt.consentSha256 !== consent.consentSha256)
    return refuse("receipt-mismatch");

  // Whatever the verdict, the fact that something changed is never erased.
  const applied = receipt.effects.some((effect) => effect.result === "applied");
  if (receipt.state !== "applied-unverified") return refuse("effect-failed", applied);

  if (verification === null)
    return resolution(plan.planSha256, "applied-unverified", null, applied);
  if (
    verification.planSha256 !== plan.planSha256 ||
    verification.receiptSha256 !== receipt.receiptSha256
  )
    return refuse("verification-mismatch", applied);
  if (verification.outcome === "failed") return refuse("verification-failed", applied);
  // Exact unavailability stays unavailable: it neither confirms nor condemns.
  if (verification.outcome === "unavailable")
    return resolution(plan.planSha256, "applied-unverified", null, applied);
  return resolution(plan.planSha256, "verified", null, applied);
}
