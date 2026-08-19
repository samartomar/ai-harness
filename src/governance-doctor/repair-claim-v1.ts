import { canonicalStrictJsonBytesV1, deepFreezeStrictJsonV1 } from "../contract/strict-json-v1.js";
import {
  assertEnumV1,
  assertExactKeysV1,
  assertRecordV1,
  assertSha256V1,
  governanceDoctorSha256V1,
} from "./capability-v1.js";
import {
  assertEpochMillisecondsV1,
  boundedRepairTransportV1,
  brandedRepairValueV1,
  failGovernanceDoctorRepairV1,
  GOVERNANCE_DOCTOR_REPAIR_DOMAIN_V1,
} from "./repair-capability-v1.js";

/**
 * `GovernanceDoctorRepairClaimV1` -- the durable single-use claim record for one
 * granted Repair Plan, expressed as data and nothing else.
 *
 * This module is the schema, the identity, and the canonical bytes. It is
 * capability-free by construction: it opens no file, resolves no path, reads no
 * clock, and reaches no environment. Every instant arrives as an integer the
 * caller already holds, and the one filesystem fact it ever sees -- the canonical
 * real path of the managed root -- arrives as a string it digests rather than
 * resolves. The effectful half lives in the separate claim store, so parsing a
 * hostile record can never be a way to reach a filesystem.
 *
 * Two digests do two different jobs, and conflating them would break the store.
 *
 * `claimSha256` is the *authority identity*: a domain-separated digest over
 * exactly the plan and the canonical root scope. It does not depend on the
 * record's state, on when it was written, or on which granted consent authorized
 * it, so one plan under one root has exactly one claim identity and therefore
 * exactly one fixed, digest-derived file name for its whole lifetime. A later
 * state can never move to a second name and read as absent at the first.
 *
 * The consent is deliberately outside that digest. A claimed record permanently
 * spends the plan for its root scope, so a second granted consent for the same
 * plan under the same root is a replay of one spent authority, not a new one. If
 * the consent were part of the identity, minting a fresh consent would mint a
 * fresh file name, the already-spent plan would read as absent at it, and the
 * single-use rule would be opt-out for anyone able to consent twice.
 *
 * `recordSha256` is the *content integrity* of the record itself. It covers every
 * field -- the consent that authorized this claim included, which is where that
 * provenance is kept -- so a record edited in place is refused rather than
 * believed.
 *
 * The scope digest binds the canonical real path exactly, as raw UTF-8 bytes.
 * Nothing is normalized, case-folded, or trimmed on the caller's behalf: a
 * checkout that moves, or is reached through a different canonical spelling, is a
 * different authority scope by design, not by accident.
 */
export interface GovernanceDoctorRepairClaimV1 {
  readonly claimSha256: string;
  readonly claimedAtEpochMs: number;
  readonly consentSha256: string;
  readonly planSha256: string;
  readonly protocol: "GovernanceDoctorRepairClaimV1";
  readonly recordSha256: string;
  readonly scopeSha256: string;
  readonly state: GovernanceDoctorRepairClaimStateV1;
}

/**
 * Both states spend the plan. `claimed` is written before the first effect and is
 * never rewritten; `consumed` is the terminal form a later transition could
 * publish. The store treats either one as proof the plan is spent, so a record
 * that survives an interruption is never a licence to try again.
 */
export type GovernanceDoctorRepairClaimStateV1 = "claimed" | "consumed";

/** Hard, non-negotiable ceilings. Every bound is a raw byte count or code unit. */
export const GOVERNANCE_DOCTOR_REPAIR_CLAIM_V1_LIMITS = Object.freeze({
  maxClaimBytes: 1024,
  maxScopePathCodeUnits: 4096,
});

const PROTOCOL = "GovernanceDoctorRepairClaimV1";
const STATES = ["claimed", "consumed"] as const;

const CLAIM_FIELDS = [
  "claimedAtEpochMs",
  "consentSha256",
  "planSha256",
  "scopeSha256",
  "state",
] as const;

/** Exactly the authority identity. The consent has no representation here. */
const IDENTITY_FIELDS = ["planSha256", "scopeSha256"] as const;

const TRANSPORT_FIELDS = [
  "claimSha256",
  "claimedAtEpochMs",
  "consentSha256",
  "planSha256",
  "protocol",
  "recordSha256",
  "scopeSha256",
  "state",
] as const;

/** Anti-forgery brand: a structurally identical plain object is not a claim. */
const claimBytes = new WeakMap<object, Buffer>();

interface ClaimIdentityV1 {
  readonly consentSha256: string;
  readonly planSha256: string;
  readonly scopeSha256: string;
}

/**
 * The authority scope of one managed checkout, digested from the exact canonical
 * real path.
 *
 * The path is carried as base64 UTF-8 rather than as text. A real path is whatever
 * the filesystem reports and need not be NFC -- macOS hands back decomposed
 * forms -- so digesting the bytes is what keeps a legitimate path from being
 * refused by a normalization rule it was never subject to, while malformed
 * Unicode is still refused outright rather than silently replaced.
 */
export function governanceDoctorRepairClaimScopeSha256V1(input: unknown): string {
  const record = assertRecordV1(input, "repair claim scope");
  assertExactKeysV1(record, ["realPath"], "repair claim scope");
  const realPath = record.realPath;
  if (typeof realPath !== "string")
    failGovernanceDoctorRepairV1("repair claim scope must name a canonical real path");
  if (
    realPath.length === 0 ||
    realPath.length > GOVERNANCE_DOCTOR_REPAIR_CLAIM_V1_LIMITS.maxScopePathCodeUnits
  )
    failGovernanceDoctorRepairV1("repair claim scope is outside its bounded length");
  for (let index = 0; index < realPath.length; index += 1) {
    const unit = realPath.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = realPath.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff))
        failGovernanceDoctorRepairV1("repair claim scope contains malformed Unicode");
      index += 1;
      continue;
    }
    if (unit >= 0xdc00 && unit <= 0xdfff)
      failGovernanceDoctorRepairV1("repair claim scope contains malformed Unicode");
  }
  return governanceDoctorSha256V1(GOVERNANCE_DOCTOR_REPAIR_DOMAIN_V1.claimScope, {
    realPathBase64: Buffer.from(realPath, "utf8").toString("base64"),
  });
}

function claimIdentity(record: Record<string, unknown>, label: string): ClaimIdentityV1 {
  return {
    consentSha256: assertSha256V1(record.consentSha256, `${label} consent identity`),
    planSha256: assertSha256V1(record.planSha256, `${label} plan identity`),
    scopeSha256: assertSha256V1(record.scopeSha256, `${label} scope identity`),
  };
}

/**
 * The stable authority identity of one claim: the plan and the canonical root
 * scope, and nothing else. This is the whole basis of the store's fixed file name,
 * so widening it is what would let one spent plan occupy a second name.
 */
export function governanceDoctorRepairClaimSha256V1(input: unknown): string {
  const record = assertRecordV1(input, "repair claim identity");
  assertExactKeysV1(record, IDENTITY_FIELDS, "repair claim identity");
  return governanceDoctorSha256V1(GOVERNANCE_DOCTOR_REPAIR_DOMAIN_V1.claim, {
    planSha256: assertSha256V1(record.planSha256, "repair claim identity plan identity"),
    scopeSha256: assertSha256V1(record.scopeSha256, "repair claim identity scope identity"),
  });
}

function mint(
  identity: ClaimIdentityV1,
  claimedAtEpochMs: number,
  state: GovernanceDoctorRepairClaimStateV1,
): GovernanceDoctorRepairClaimV1 {
  const body = {
    claimSha256: governanceDoctorRepairClaimSha256V1({
      planSha256: identity.planSha256,
      scopeSha256: identity.scopeSha256,
    }),
    claimedAtEpochMs,
    consentSha256: identity.consentSha256,
    planSha256: identity.planSha256,
    protocol: PROTOCOL,
    scopeSha256: identity.scopeSha256,
    state,
  };
  const claim = deepFreezeStrictJsonV1({
    ...body,
    recordSha256: governanceDoctorSha256V1(GOVERNANCE_DOCTOR_REPAIR_DOMAIN_V1.claimRecord, body),
  }) as GovernanceDoctorRepairClaimV1;
  const bytes = canonicalStrictJsonBytesV1(claim);
  if (bytes.length > GOVERNANCE_DOCTOR_REPAIR_CLAIM_V1_LIMITS.maxClaimBytes)
    failGovernanceDoctorRepairV1("repair claim exceeds its bounded byte length");
  claimBytes.set(claim, bytes);
  return claim;
}

/** Validates one claim request and mints a branded, frozen, bounded claim record. */
export function createGovernanceDoctorRepairClaimV1(input: unknown): GovernanceDoctorRepairClaimV1 {
  const request = assertRecordV1(input, "repair claim request");
  assertExactKeysV1(request, CLAIM_FIELDS, "repair claim request");
  return mint(
    claimIdentity(request, "repair claim request"),
    assertEpochMillisecondsV1(request.claimedAtEpochMs, "repair claim instant"),
    assertEnumV1(request.state, STATES, "repair claim state"),
  );
}

/** The exact canonical JCS UTF-8 bytes of a minted claim, as a defensive copy. */
export function canonicalGovernanceDoctorRepairClaimV1Bytes(value: unknown): Buffer {
  return Buffer.from(brandedRepairValueV1(claimBytes, value, "repair claim"));
}

/**
 * Parses one durable claim record from its exact bytes.
 *
 * The record is re-minted from the fields it declares and then checked twice: the
 * identity and record digests it carries must be the ones its own content
 * produces, and its bytes must be exactly the canonical encoding. A record that is
 * truncated, re-encoded, re-ordered, padded, or edited in place fails all the way
 * closed -- which is what lets the store refuse it rather than read it as absent.
 */
export function parseGovernanceDoctorRepairClaimV1(input: unknown): GovernanceDoctorRepairClaimV1 {
  const [bytes, record] = boundedRepairTransportV1(input, "repair claim");
  if (bytes.length > GOVERNANCE_DOCTOR_REPAIR_CLAIM_V1_LIMITS.maxClaimBytes)
    failGovernanceDoctorRepairV1("repair claim exceeds its bounded byte length");
  assertExactKeysV1(record, TRANSPORT_FIELDS, "repair claim transport");
  if (record.protocol !== PROTOCOL)
    failGovernanceDoctorRepairV1("repair claim transport is malformed");
  const declaredClaim = assertSha256V1(record.claimSha256, "repair claim identity");
  const declaredRecord = assertSha256V1(record.recordSha256, "repair claim record identity");
  const claim = mint(
    claimIdentity(record, "repair claim transport"),
    assertEpochMillisecondsV1(record.claimedAtEpochMs, "repair claim instant"),
    assertEnumV1(record.state, STATES, "repair claim state"),
  );
  if (claim.claimSha256 !== declaredClaim || claim.recordSha256 !== declaredRecord)
    failGovernanceDoctorRepairV1("repair claim identity does not match its content");
  if (!canonicalGovernanceDoctorRepairClaimV1Bytes(claim).equals(bytes))
    failGovernanceDoctorRepairV1("repair claim bytes are not canonical");
  return claim;
}

/**
 * The one file name a claim may ever occupy: its authority identity and a fixed
 * suffix. The name is derived, never supplied, so no caller-influenced text has
 * any representation in the store's directory.
 */
export function governanceDoctorRepairClaimFileNameV1(claimSha256: unknown): string {
  return `${assertSha256V1(claimSha256, "repair claim identity")}.json`;
}
