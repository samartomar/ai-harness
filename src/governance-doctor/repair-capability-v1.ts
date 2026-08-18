import {
  assertSafeRelativePosixPathV1,
  assertWellFormedNfcV1,
  parseStrictJsonObjectV1,
} from "../contract/strict-json-v1.js";
import {
  assertNotProxyV1,
  assertTokenV1,
  GOVERNANCE_DOCTOR_LOCAL_ID_PATTERN,
} from "./capability-v1.js";

/**
 * The closed, capability-free toolkit shared by the Governance Doctor Repair V1
 * contracts: the Broker registry, the Repair Plan, out-of-band Consent, the
 * Receipt, the covering Verification, and the pure state resolver.
 *
 * Everything in this foundation is data and validation. It holds no filesystem,
 * process, network, provider, scanner, or signing capability; it reads no clock
 * and no ambient state; and it exposes no seam through which a caller could hand
 * it something to run. Every value that could ever name a change is a closed
 * enum, a bounded token, a safe relative POSIX location, or a digest -- never
 * text to interpret and never bytes to execute.
 *
 * Instants arrive as integer epoch milliseconds supplied by the caller. That
 * keeps every record reproducible and every validator pure: nothing here can
 * observe when it ran, so nothing here can behave differently on a second run.
 */

/** Hard, non-negotiable ceilings. Every bound is a raw count, code unit, or byte. */
export const GOVERNANCE_DOCTOR_REPAIR_V1_LIMITS = Object.freeze({
  maxConsumedPlanIdentities: 256,
  maxEffectArguments: 4,
  maxEffects: 16,
  maxEpochMs: 4_102_444_800_000,
  maxEvidenceFindings: 16,
  maxEvidenceRefusals: 8,
  maxManagedPathCodeUnits: 200,
  maxManagedTokenCodeUnits: 64,
  maxPlanLifetimeMs: 86_400_000,
  maxRecipeEffects: 8,
  maxRecipes: 16,
  maxScopePaths: 16,
  maxTransportBytes: 64 * 1024,
  minEpochMs: 1_577_836_800_000,
});

/**
 * Authority classes a mechanical Repair broker may never carry. This substring
 * exclusion is applied to every broker, recipe, and template identity, so an
 * entry cannot smuggle a governance ruling, a selection intent, an approval, a
 * destructive override, a publication, a raw invocation, a provider callback, a
 * scanner, a signing operation, a network reach, or package/runtime execution in
 * under a mechanical-looking name. Widening it is a reviewed edit here, never a
 * value a registry can supply.
 */
export const GOVERNANCE_DOCTOR_PROHIBITED_REPAIR_AUTHORITIES_V1: readonly string[] = Object.freeze([
  "approval",
  "approve",
  "argv",
  "command",
  "decision",
  "destructive",
  "exec",
  "install",
  "network",
  "override",
  "package",
  "provider",
  "publish",
  "runtime",
  "scan",
  "select",
  "shell",
  "sign",
]);

/** Domain labels. A digest minted under one label can never be presented as another. */
export const GOVERNANCE_DOCTOR_REPAIR_DOMAIN_V1 = Object.freeze({
  authority: "aih.governance-doctor-repair-authority-v1",
  brokerRegistry: "aih.governance-doctor-repair-broker-registry-v1",
  claim: "aih.governance-doctor-repair-claim-v1",
  claimRecord: "aih.governance-doctor-repair-claim-record-v1",
  claimScope: "aih.governance-doctor-repair-claim-scope-v1",
  consent: "aih.governance-doctor-repair-consent-v1",
  effect: "aih.governance-doctor-repair-effect-v1",
  effectSummary: "aih.governance-doctor-repair-effect-summary-v1",
  evidence: "aih.governance-doctor-repair-evidence-v1",
  plan: "aih.governance-doctor-repair-plan-v1",
  planBytes: "aih.governance-doctor-repair-plan-bytes-v1",
  receipt: "aih.governance-doctor-repair-receipt-v1",
  recipe: "aih.governance-doctor-repair-recipe-v1",
  scope: "aih.governance-doctor-repair-scope-v1",
  state: "aih.governance-doctor-repair-state-v1",
  verification: "aih.governance-doctor-repair-verification-v1",
});

/** 256-bit single-use nonces, in lowercase hex. */
export const GOVERNANCE_DOCTOR_REPAIR_NONCE_PATTERN = /^[a-f0-9]{64}$/;
/** Broker identities are AIH-owned by construction; no other namespace parses. */
export const GOVERNANCE_DOCTOR_AIH_BROKER_ID_PATTERN = /^aih:[a-z0-9][a-z0-9.-]*$/;
/** Argument names are code-owned lowerCamelCase labels, never caller prose. */
export const GOVERNANCE_DOCTOR_REPAIR_ARGUMENT_NAME_PATTERN = /^[a-z][A-Za-z0-9]*$/;

/**
 * Control, format, unassigned, private-use, surrogate, separator, noncharacter,
 * and default-ignorable code points. A managed location carrying any of these --
 * including a zero-width joiner, a bidi override, or a byte-order mark -- would
 * read as one location to a reviewer and resolve as another, so it is refused
 * rather than stripped.
 */
const FORBIDDEN_PATH_CATEGORY =
  /[\p{Cc}\p{Cf}\p{Cn}\p{Co}\p{Cs}\p{Z}\p{Default_Ignorable_Code_Point}\p{Noncharacter_Code_Point}]/u;

/**
 * Fails with a label only. The offending value is never interpolated, so a
 * hostile record cannot use an error message as an output channel.
 */
export function failGovernanceDoctorRepairV1(label: string): never {
  throw new TypeError(`GOVERNANCE_DOCTOR_REPAIR_V1: ${label}`);
}

/** An integer epoch-millisecond instant inside a bounded, reviewable era. */
export function assertEpochMillisecondsV1(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value))
    failGovernanceDoctorRepairV1(`${label} must be an integer epoch millisecond instant`);
  const instant = value as number;
  if (
    instant < GOVERNANCE_DOCTOR_REPAIR_V1_LIMITS.minEpochMs ||
    instant > GOVERNANCE_DOCTOR_REPAIR_V1_LIMITS.maxEpochMs
  )
    failGovernanceDoctorRepairV1(`${label} is outside its bounded era`);
  return instant;
}

/** A 256-bit lowercase-hex single-use nonce. */
export function assertRepairNonceV1(value: unknown, label: string): string {
  return assertTokenV1(value, GOVERNANCE_DOCTOR_REPAIR_NONCE_PATTERN, 64, label);
}

/** A bounded lower-kebab token: a marker block name, a recipe, an effect identity. */
export function assertManagedTokenV1(value: unknown, label: string): string {
  return assertTokenV1(
    value,
    GOVERNANCE_DOCTOR_LOCAL_ID_PATTERN,
    GOVERNANCE_DOCTOR_REPAIR_V1_LIMITS.maxManagedTokenCodeUnits,
    label,
  );
}

/**
 * A safe, bounded, NFC, visible relative POSIX location under the run's own root.
 * Absolute, drive-qualified, traversing, percent-encoded, separator-confusable,
 * and invisible forms are all refused; nothing is normalized on the caller's
 * behalf, so what a reviewer reads is exactly what the record holds.
 */
export function assertManagedRelativePathV1(value: unknown, label: string): string {
  if (typeof value !== "string") failGovernanceDoctorRepairV1(`${label} must be a string`);
  const path = value as string;
  if (path.length === 0 || path.length > GOVERNANCE_DOCTOR_REPAIR_V1_LIMITS.maxManagedPathCodeUnits)
    failGovernanceDoctorRepairV1(`${label} is outside its bounded length`);
  assertWellFormedNfcV1(path, `GOVERNANCE_DOCTOR_REPAIR_V1: ${label}`);
  if (FORBIDDEN_PATH_CATEGORY.test(path))
    failGovernanceDoctorRepairV1(`${label} contains a control, format, or invisible code point`);
  return assertSafeRelativePosixPathV1(path, `GOVERNANCE_DOCTOR_REPAIR_V1: ${label}`);
}

/** Refuses any identity whose name reaches for an authority this foundation excludes. */
export function assertNoProhibitedRepairAuthorityV1(value: string, label: string): string {
  for (const prohibited of GOVERNANCE_DOCTOR_PROHIBITED_REPAIR_AUTHORITIES_V1)
    if (value.includes(prohibited))
      failGovernanceDoctorRepairV1(`${label} names an authority this foundation excludes`);
  return value;
}

/**
 * Rejects pathological nesting before the general JSON parser walks unknown
 * fields. The closed schemas then reject those fields without traversing them.
 */
function assertBoundedNesting(text: string, label: string): void {
  let depth = 0;
  let escaped = false;
  let inString = false;
  for (const character of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "{" || character === "[") {
      depth += 1;
      if (depth > 32)
        failGovernanceDoctorRepairV1(`${label} transport exceeds its bounded nesting`);
    } else if (character === "}" || character === "]") depth -= 1;
  }
}

/**
 * Transport is bytes, never a decoded string: the canonical form is defined in
 * UTF-8 bytes, and a strict decoder is what rejects malformed input up front.
 */
export function boundedRepairTransportV1(
  value: unknown,
  label: string,
): readonly [Buffer, Record<string, unknown>] {
  assertNotProxyV1(value, `${label} transport`);
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array))
    return failGovernanceDoctorRepairV1(`${label} transport must be UTF-8 bytes`);
  const bytes = Buffer.from(value);
  if (bytes.length === 0 || bytes.length > GOVERNANCE_DOCTOR_REPAIR_V1_LIMITS.maxTransportBytes)
    failGovernanceDoctorRepairV1(`${label} transport exceeds its bounded byte length`);
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
    failGovernanceDoctorRepairV1(`${label} transport must not carry a byte-order mark`);
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  assertBoundedNesting(text, label);
  return [bytes, parseStrictJsonObjectV1(text, label)];
}

/** Returns a branded snapshot, or fails closed when the value was never minted here. */
export function brandedRepairValueV1<T>(
  brand: WeakMap<object, T>,
  value: unknown,
  label: string,
): T {
  const held = typeof value === "object" && value !== null ? brand.get(value) : undefined;
  if (held === undefined) failGovernanceDoctorRepairV1(`${label} requires a validated brand`);
  return held;
}
