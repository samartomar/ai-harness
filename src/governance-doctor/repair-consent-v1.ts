import { canonicalStrictJsonBytesV1, deepFreezeStrictJsonV1 } from "../contract/strict-json-v1.js";
import {
  assertEnumV1,
  assertExactKeysV1,
  assertRecordV1,
  assertSha256V1,
  assertTokenV1,
  GOVERNANCE_DOCTOR_QUALIFIED_ID_PATTERN,
  GOVERNANCE_DOCTOR_V1_LIMITS,
  governanceDoctorSha256V1,
} from "./capability-v1.js";
import {
  assertEpochMillisecondsV1,
  assertRepairNonceV1,
  boundedRepairTransportV1,
  brandedRepairValueV1,
  failGovernanceDoctorRepairV1,
  GOVERNANCE_DOCTOR_REPAIR_DOMAIN_V1,
} from "./repair-capability-v1.js";
import {
  canonicalGovernanceDoctorRepairEffectSummaryV1Bytes,
  canonicalGovernanceDoctorRepairPlanV1Bytes,
  type GovernanceDoctorRepairEffectSummaryV1,
  type GovernanceDoctorRepairPlanV1,
} from "./repair-plan-v1.js";

/**
 * `GovernanceDoctorRepairConsentV1` -- explicit, out-of-band consent bound to
 * exactly one Repair Plan.
 *
 * There is no ambient and no inferred consent here. A consent record can only be
 * minted from a trusted consent context this module itself branded, and that
 * context has exactly one permitted channel: `out-of-band`. A caller cannot
 * assemble a context literal, cannot widen the channel, and cannot reach the
 * consent record without one.
 *
 * The binding is byte-for-byte. Consent carries the plan's domain-separated
 * identity *and* a digest over the plan's exact canonical bytes, plus the digest
 * of the human-visible effect summary that was actually shown. Re-presenting a
 * consent against a different plan, a re-encoded plan, or a different summary is
 * refused rather than tolerated, so an approval taken over one set of effects can
 * never be transplanted onto another.
 *
 * A denial is recorded, not deduced. `decision` is a closed two-value field with
 * no default, so silence is never read as agreement.
 */
export interface GovernanceDoctorRepairConsentContextV1 {
  readonly protocol: "GovernanceDoctorRepairConsentContextV1";
}

export interface GovernanceDoctorRepairConsentV1 {
  readonly channel: "out-of-band";
  readonly consentNonce: string;
  readonly consentSha256: string;
  readonly consentedAtEpochMs: number;
  readonly decision: "denied" | "granted";
  readonly planBytesSha256: string;
  readonly planSha256: string;
  readonly protocol: "GovernanceDoctorRepairConsentV1";
  readonly signerId: string;
  readonly subjectId: string;
  readonly summarySha256: string;
  readonly trustAnchorSha256: string;
}

interface ConsentContextBodyV1 {
  readonly channel: "out-of-band";
  readonly signerId: string;
  readonly subjectId: string;
  readonly trustAnchorSha256: string;
}

const PROTOCOL = "GovernanceDoctorRepairConsentV1";
const CONTEXT_PROTOCOL = "GovernanceDoctorRepairConsentContextV1";
const CHANNELS = ["out-of-band"] as const;
const DECISIONS = ["denied", "granted"] as const;

const CONSENT_FIELDS = [
  "consentNonce",
  "consentedAtEpochMs",
  "context",
  "decision",
  "plan",
  "summary",
] as const;

const TRANSPORT_FIELDS = [
  "channel",
  "consentNonce",
  "consentSha256",
  "consentedAtEpochMs",
  "decision",
  "planBytesSha256",
  "planSha256",
  "protocol",
  "signerId",
  "subjectId",
  "summarySha256",
  "trustAnchorSha256",
] as const;

type Json = Record<string, unknown>;

/** Anti-forgery brands: a structurally identical plain object is not consent. */
const consentContexts = new WeakMap<object, ConsentContextBodyV1>();
const consentBytes = new WeakMap<object, Buffer>();

function qualifiedId(value: unknown, label: string): string {
  return assertTokenV1(
    value,
    GOVERNANCE_DOCTOR_QUALIFIED_ID_PATTERN,
    GOVERNANCE_DOCTOR_V1_LIMITS.maxIdentifierCodeUnits,
    label,
  );
}

/**
 * Brands one explicit out-of-band consent context. The returned value carries no
 * detail of its own: the signer, subject, and trust anchor stay behind the brand,
 * so a caller cannot read them back out, edit them, and present the result.
 */
export function createGovernanceDoctorRepairConsentContextV1(
  input: unknown,
): GovernanceDoctorRepairConsentContextV1 {
  const record = assertRecordV1(input, "repair consent context");
  assertExactKeysV1(
    record,
    ["channel", "signerId", "subjectId", "trustAnchorSha256"],
    "repair consent context",
  );
  const body: ConsentContextBodyV1 = {
    channel: assertEnumV1(record.channel, CHANNELS, "repair consent channel"),
    signerId: qualifiedId(record.signerId, "repair consent signer ID"),
    subjectId: qualifiedId(record.subjectId, "repair consent subject ID"),
    trustAnchorSha256: assertSha256V1(record.trustAnchorSha256, "repair consent trust anchor"),
  };
  const context = Object.freeze({ protocol: CONTEXT_PROTOCOL as typeof CONTEXT_PROTOCOL });
  consentContexts.set(context, body);
  return context;
}

/** The digest over a plan's exact canonical bytes, not merely over its identity. */
function planBytesDigest(plan: GovernanceDoctorRepairPlanV1): string {
  return governanceDoctorSha256V1(GOVERNANCE_DOCTOR_REPAIR_DOMAIN_V1.planBytes, {
    bytesBase64: canonicalGovernanceDoctorRepairPlanV1Bytes(plan).toString("base64"),
  });
}

/** The exact plan and summary a consent ruling may be taken over. */
function consentedSubject(
  planValue: unknown,
  summaryValue: unknown,
  context: ConsentContextBodyV1,
): { readonly plan: GovernanceDoctorRepairPlanV1; readonly summarySha256: string } {
  canonicalGovernanceDoctorRepairPlanV1Bytes(planValue);
  canonicalGovernanceDoctorRepairEffectSummaryV1Bytes(summaryValue);
  const plan = planValue as GovernanceDoctorRepairPlanV1;
  const summary = summaryValue as GovernanceDoctorRepairEffectSummaryV1;
  if (summary.planSha256 !== plan.planSha256)
    failGovernanceDoctorRepairV1("repair consent summary does not describe this plan");
  if (context.subjectId !== plan.targetId)
    failGovernanceDoctorRepairV1("repair consent subject is not this plan's target");
  return { plan, summarySha256: summary.summarySha256 };
}

function mint(body: Json): GovernanceDoctorRepairConsentV1 {
  const consent = deepFreezeStrictJsonV1({
    ...body,
    consentSha256: governanceDoctorSha256V1(GOVERNANCE_DOCTOR_REPAIR_DOMAIN_V1.consent, body),
  }) as GovernanceDoctorRepairConsentV1;
  consentBytes.set(consent, canonicalStrictJsonBytesV1(consent));
  return consent;
}

function consentBody(
  context: ConsentContextBodyV1,
  plan: GovernanceDoctorRepairPlanV1,
  summarySha256: string,
  consentNonce: string,
  consentedAtEpochMs: number,
  decision: "denied" | "granted",
): Json {
  if (consentedAtEpochMs < plan.createdAtEpochMs || consentedAtEpochMs >= plan.expiresAtEpochMs)
    failGovernanceDoctorRepairV1("repair consent falls outside the plan validity window");
  return {
    channel: context.channel,
    consentNonce,
    consentedAtEpochMs,
    decision,
    planBytesSha256: planBytesDigest(plan),
    planSha256: plan.planSha256,
    protocol: PROTOCOL,
    signerId: context.signerId,
    subjectId: context.subjectId,
    summarySha256,
    trustAnchorSha256: context.trustAnchorSha256,
  };
}

/**
 * Validates one explicit consent ruling and mints a branded, frozen record bound
 * to exactly one plan, its exact canonical bytes, and the exact summary shown.
 */
export function createGovernanceDoctorRepairConsentV1(
  input: unknown,
): GovernanceDoctorRepairConsentV1 {
  const request = assertRecordV1(input, "repair consent request");
  assertExactKeysV1(request, CONSENT_FIELDS, "repair consent request");
  const context = brandedRepairValueV1(consentContexts, request.context, "repair consent context");
  const { plan, summarySha256 } = consentedSubject(request.plan, request.summary, context);
  return mint(
    consentBody(
      context,
      plan,
      summarySha256,
      assertRepairNonceV1(request.consentNonce, "repair consent nonce"),
      assertEpochMillisecondsV1(request.consentedAtEpochMs, "repair consent instant"),
      assertEnumV1(request.decision, DECISIONS, "repair consent decision"),
    ),
  );
}

/** The exact canonical JCS UTF-8 bytes of a minted consent, as a defensive copy. */
export function canonicalGovernanceDoctorRepairConsentV1Bytes(value: unknown): Buffer {
  return Buffer.from(brandedRepairValueV1(consentBytes, value, "repair consent"));
}

/**
 * Parses consent transport against the exact plan, summary, and trusted context
 * it must belong to. Consent is never rehydrated on its own: without all three
 * bindings there is nothing to check a replayed record against, so the parser
 * requires them rather than accepting bytes in isolation.
 */
export function parseGovernanceDoctorRepairConsentV1Json(
  input: unknown,
): GovernanceDoctorRepairConsentV1 {
  const request = assertRecordV1(input, "repair consent transport request");
  assertExactKeysV1(
    request,
    ["bytes", "context", "plan", "summary"],
    "repair consent transport request",
  );
  const context = brandedRepairValueV1(consentContexts, request.context, "repair consent context");
  const { plan, summarySha256 } = consentedSubject(request.plan, request.summary, context);

  const [bytes, record] = boundedRepairTransportV1(request.bytes, "repair consent");
  assertExactKeysV1(record, TRANSPORT_FIELDS, "repair consent transport");
  if (record.protocol !== PROTOCOL)
    failGovernanceDoctorRepairV1("repair consent transport is malformed");
  const supplied = assertSha256V1(record.consentSha256, "repair consent identity");
  const consent = mint(
    consentBody(
      context,
      plan,
      summarySha256,
      assertRepairNonceV1(record.consentNonce, "repair consent nonce"),
      assertEpochMillisecondsV1(record.consentedAtEpochMs, "repair consent instant"),
      assertEnumV1(record.decision, DECISIONS, "repair consent decision"),
    ),
  );
  if (consent.consentSha256 !== supplied)
    failGovernanceDoctorRepairV1("repair consent identity does not match its content");
  if (!canonicalGovernanceDoctorRepairConsentV1Bytes(consent).equals(bytes))
    failGovernanceDoctorRepairV1("repair consent bytes are not canonical");
  return consent;
}
