import { createHash } from "node:crypto";
import { isProxy } from "node:util/types";
import { codeUnitCompare } from "../capability/package-graph/canonical.js";
import {
  assertStrictJsonValueV1,
  assertWellFormedNfcV1,
  canonicalStrictJsonBytesV1,
  deepFreezeStrictJsonV1,
  parseStrictJsonObjectV1,
} from "../contract/strict-json-v1.js";

const ID = /^[a-z][a-z0-9-]{0,63}$/;
const DECISION_ID = /^decision-[a-z0-9-]{1,54}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const UTC_SECOND = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/;
const MIN_VALIDITY_MS = 60_000;
const MAX_VALIDITY_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_REVOKED_DECISIONS = 4096;
const MAX_SIGNATURE_BYTES = 8192;

type Json = Record<string, unknown>;
const snapshotBytes = new WeakMap<object, Buffer>();
const signedBytes = new WeakMap<object, Buffer>();
const signedSnapshots = new WeakSet<object>();

export interface OfflineRevocationSnapshotV1 {
  readonly issuer: string;
  readonly issuedAt: string;
  readonly protocol: "OfflineRevocationSnapshotV1";
  readonly revokedDecisionIds: readonly string[];
  readonly sequence: number;
  readonly validUntil: string;
}

export interface SignedOfflineRevocationSnapshotV1 {
  readonly envelope: Readonly<Json>;
  readonly protocol: "SignedOfflineRevocationSnapshotV1";
  readonly snapshot: OfflineRevocationSnapshotV1;
  readonly snapshotSha256: string;
}

export interface OfflineRevocationStateV1 {
  readonly digestSha256: string;
  readonly issuer: string;
  readonly sequence: number;
}

export type OfflineRevocationAuthorityV1Result =
  | Readonly<{ effective: false; kind: "invalid-authority"; materializable: false; revoked: false }>
  | Readonly<{ effective: false; kind: "stale-authority"; materializable: false; revoked: false }>
  | Readonly<{ effective: true; kind: "current"; materializable: false; revoked: boolean }>;

type OfflineRevocationStateTransitionV1 =
  | Readonly<{ kind: "advance"; state: OfflineRevocationStateV1 }>
  | Readonly<{ kind: "conflict" | "rollback" | "unchanged"; state: OfflineRevocationStateV1 }>
  | Readonly<{ kind: "invalid-authority" }>;

interface Trust {
  readonly expectedAdminSignerIdentity: string;
  readonly expectedAdminSignerRootSha256: string;
  readonly expectedIssuer: string;
  readonly verifyCanonicalPae: (request: unknown) => unknown;
}

function fail(label: string): never {
  throw new TypeError(`OFFLINE_REVOCATION_SNAPSHOT_V1: ${label}`);
}

function record(value: unknown, label: string): Json {
  if (isProxy(value)) fail(label);
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(label);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(label);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") fail(label);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) fail(label);
  }
  return value as Json;
}

function exact(value: Json, fields: readonly string[], label: string): void {
  const actual = Object.keys(value).sort(codeUnitCompare);
  const expected = [...fields].sort(codeUnitCompare);
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index]))
    fail(label);
}

function text(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) fail(label);
  assertWellFormedNfcV1(value, label);
  if (value.trim() !== value || hasAsciiControl(value)) fail(label);
  return value;
}

function hasAsciiControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function stableId(value: unknown, label: string, matcher = ID): string {
  const result = text(value, label, 64);
  if (!matcher.test(result)) fail(label);
  return result;
}

function digest(value: unknown, label: string): string {
  const result = text(value, label, 64);
  if (!SHA256.test(result)) fail(label);
  return result;
}

function timestamp(value: unknown, label: string): string {
  const result = text(value, label, 32);
  const match = UTC_SECOND.exec(result);
  if (match === null) fail(label);
  const parts = match.slice(1).map(Number);
  const [year, month, day, hour, minute, second] = parts;
  const date = new Date(
    Date.UTC(year ?? -1, (month ?? 0) - 1, day ?? -1, hour ?? -1, minute ?? -1, second ?? -1),
  );
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== (month ?? 1) - 1 ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== second
  )
    fail(label);
  return result;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function rawSnapshot(value: unknown): OfflineRevocationSnapshotV1 {
  assertStrictJsonValueV1(value, "offline revocation snapshot");
  const item = record(value, "snapshot");
  exact(
    item,
    ["issuer", "issuedAt", "protocol", "revokedDecisionIds", "sequence", "validUntil"],
    "snapshot fields",
  );
  if (item.protocol !== "OfflineRevocationSnapshotV1") fail("snapshot protocol");
  if (!Number.isSafeInteger(item.sequence) || (item.sequence as number) < 1)
    fail("snapshot sequence");
  if (
    !Array.isArray(item.revokedDecisionIds) ||
    item.revokedDecisionIds.length > MAX_REVOKED_DECISIONS
  )
    fail("revoked decisions");
  const revokedDecisionIds = item.revokedDecisionIds.map((id) =>
    stableId(id, "revoked decision", DECISION_ID),
  );
  if (
    revokedDecisionIds.some(
      (id, index) => index > 0 && codeUnitCompare(revokedDecisionIds[index - 1] ?? "", id) >= 0,
    )
  )
    fail("revoked decisions");
  const issuedAt = timestamp(item.issuedAt, "snapshot issued at");
  const validUntil = timestamp(item.validUntil, "snapshot valid until");
  const duration = Date.parse(validUntil) - Date.parse(issuedAt);
  if (duration < MIN_VALIDITY_MS || duration > MAX_VALIDITY_MS) fail("snapshot validity");
  return deepFreezeStrictJsonV1({
    issuer: stableId(item.issuer, "snapshot issuer"),
    issuedAt,
    protocol: "OfflineRevocationSnapshotV1" as const,
    revokedDecisionIds,
    sequence: item.sequence as number,
    validUntil,
  });
}

function canonicalSnapshot(snapshot: OfflineRevocationSnapshotV1): Buffer {
  const known = snapshotBytes.get(snapshot);
  if (known !== undefined) return Buffer.from(known);
  const bytes = canonicalStrictJsonBytesV1(snapshot);
  snapshotBytes.set(snapshot, bytes);
  return Buffer.from(bytes);
}

function signature(value: unknown): Json {
  const item = record(value, "signature");
  exact(item, ["keyid", "sig"], "signature fields");
  const keyid = text(item.keyid, "signature key id", 256);
  const sig = text(item.sig, "signature", MAX_SIGNATURE_BYTES);
  if (Buffer.from(sig, "base64").toString("base64") !== sig) fail("signature");
  return { keyid, sig };
}

function pae(payloadType: string, payload: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(
      `DSSEv1 ${String(Buffer.byteLength(payloadType))} ${payloadType} ${String(payload.length)} `,
      "utf8",
    ),
    payload,
  ]);
}

function envelopeFor(
  snapshot: OfflineRevocationSnapshotV1,
  signerIdentity: string,
  signatures: Json[],
): Json {
  const statement = canonicalStrictJsonBytesV1({
    _type: "https://in-toto.io/Statement/v1",
    predicate: {
      protocol: "SignedOfflineRevocationSnapshotV1",
      recordType: "OfflineRevocationSnapshotV1",
      signerIdentity,
    },
    predicateType: "https://aih.dev/OfflineRevocationSnapshotV1",
    subject: [
      {
        digest: { sha256: sha256(canonicalSnapshot(snapshot)) },
        name: "aih/OfflineRevocationSnapshotV1",
      },
    ],
  });
  return {
    payload: statement.toString("base64"),
    payloadType: "application/vnd.in-toto+json",
    signatures: signatures.map((item) => ({ ...item })),
  };
}

function createSigned(
  snapshot: OfflineRevocationSnapshotV1,
  signerIdentity: string,
  signatures: Json[],
): SignedOfflineRevocationSnapshotV1 {
  const envelope = envelopeFor(snapshot, signerIdentity, signatures);
  const result = deepFreezeStrictJsonV1({
    envelope,
    protocol: "SignedOfflineRevocationSnapshotV1" as const,
    snapshot,
    snapshotSha256: sha256(canonicalSnapshot(snapshot)),
  }) as SignedOfflineRevocationSnapshotV1;
  signedSnapshots.add(result);
  signedBytes.set(
    result,
    canonicalStrictJsonBytesV1({
      envelope,
      protocol: "SignedOfflineRevocationSnapshotV1",
      snapshot: JSON.parse(canonicalSnapshot(snapshot).toString("utf8")),
      snapshotSha256: result.snapshotSha256,
    }),
  );
  return result;
}

export function createOfflineRevocationSnapshotV1(
  value: unknown,
): SignedOfflineRevocationSnapshotV1 {
  const item = record(value, "signed snapshot");
  exact(item, ["signatures", "signerIdentity", "snapshot"], "signed snapshot fields");
  if (!Array.isArray(item.signatures) || item.signatures.length !== 1) fail("signatures");
  return createSigned(
    rawSnapshot(item.snapshot),
    text(item.signerIdentity, "signer identity", 256),
    [signature(item.signatures[0])],
  );
}

export function canonicalOfflineRevocationSnapshotV1Bytes(
  value: SignedOfflineRevocationSnapshotV1,
): Buffer {
  const bytes = typeof value === "object" && value !== null ? signedBytes.get(value) : undefined;
  if (bytes === undefined) fail("signed snapshot brand");
  return Buffer.from(bytes);
}

export function parseOfflineRevocationSnapshotV1Json(
  value: unknown,
): SignedOfflineRevocationSnapshotV1 {
  const textValue =
    typeof value === "string"
      ? value
      : Buffer.isBuffer(value) || value instanceof Uint8Array
        ? new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(value)
        : fail("signed snapshot bytes");
  const original = Buffer.from(textValue, "utf8");
  const item = parseStrictJsonObjectV1(textValue, "signed offline revocation snapshot");
  exact(item, ["envelope", "protocol", "snapshot", "snapshotSha256"], "signed snapshot fields");
  if (item.protocol !== "SignedOfflineRevocationSnapshotV1") fail("signed snapshot protocol");
  const snapshot = rawSnapshot(item.snapshot);
  if (digest(item.snapshotSha256, "snapshot digest") !== sha256(canonicalSnapshot(snapshot)))
    fail("snapshot digest");
  const envelope = record(item.envelope, "envelope");
  exact(envelope, ["payload", "payloadType", "signatures"], "envelope fields");
  if (
    envelope.payloadType !== "application/vnd.in-toto+json" ||
    !Array.isArray(envelope.signatures)
  )
    fail("envelope");
  if (envelope.signatures.length !== 1) fail("envelope signatures");
  const signatures = [signature(envelope.signatures[0])];
  const payloadText = text(envelope.payload, "envelope payload", 16384);
  const payload = Buffer.from(payloadText, "base64");
  if (payload.toString("base64") !== payloadText) fail("envelope payload");
  const statement = parseStrictJsonObjectV1(
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(payload),
    "offline revocation statement",
  );
  exact(statement, ["_type", "predicate", "predicateType", "subject"], "statement fields");
  const predicate = record(statement.predicate, "statement predicate");
  exact(predicate, ["protocol", "recordType", "signerIdentity"], "statement predicate fields");
  const signerIdentity = text(predicate.signerIdentity, "signer identity", 256);
  const subject =
    Array.isArray(statement.subject) && statement.subject.length === 1
      ? record(statement.subject[0], "statement subject")
      : fail("statement subject");
  exact(subject, ["digest", "name"], "statement subject fields");
  const subjectDigest = record(subject.digest, "statement subject digest");
  exact(subjectDigest, ["sha256"], "statement subject digest fields");
  if (
    statement._type !== "https://in-toto.io/Statement/v1" ||
    statement.predicateType !== "https://aih.dev/OfflineRevocationSnapshotV1" ||
    predicate.protocol !== "SignedOfflineRevocationSnapshotV1" ||
    predicate.recordType !== "OfflineRevocationSnapshotV1" ||
    subject.name !== "aih/OfflineRevocationSnapshotV1" ||
    digest(subjectDigest.sha256, "statement subject digest") !==
      sha256(canonicalSnapshot(snapshot)) ||
    canonicalStrictJsonBytesV1(statement).compare(payload) !== 0
  )
    fail("statement");
  const result = createSigned(snapshot, signerIdentity, signatures);
  if (canonicalOfflineRevocationSnapshotV1Bytes(result).compare(original) !== 0)
    fail("noncanonical signed snapshot");
  return result;
}

function invalid(): OfflineRevocationAuthorityV1Result {
  return deepFreezeStrictJsonV1({
    effective: false,
    kind: "invalid-authority" as const,
    materializable: false,
    revoked: false,
  });
}

function stale(): OfflineRevocationAuthorityV1Result {
  return deepFreezeStrictJsonV1({
    effective: false,
    kind: "stale-authority" as const,
    materializable: false,
    revoked: false,
  });
}

function invalidTransition(): OfflineRevocationStateTransitionV1 {
  return deepFreezeStrictJsonV1({ kind: "invalid-authority" as const });
}

function trust(value: Json): Trust {
  const verifier = value.verifyCanonicalPae;
  if (isProxy(verifier) || typeof verifier !== "function") fail("verifier");
  return {
    expectedAdminSignerIdentity: text(
      value.expectedAdminSignerIdentity,
      "expected signer identity",
      256,
    ),
    expectedAdminSignerRootSha256: digest(
      value.expectedAdminSignerRootSha256,
      "expected signer root",
    ),
    expectedIssuer: stableId(value.expectedIssuer, "expected issuer"),
    verifyCanonicalPae: verifier as (request: unknown) => unknown,
  };
}

/** Reverify the exact DSSE bytes every time; brands only prove local parsing. */
function reverify(value: unknown, expected: Trust): SignedOfflineRevocationSnapshotV1 | undefined {
  if (typeof value !== "object" || value === null || !signedSnapshots.has(value)) return undefined;
  const signed = value as SignedOfflineRevocationSnapshotV1;
  try {
    const envelope = signed.envelope as Json;
    const payload = Buffer.from(envelope.payload as string, "base64");
    const statement = parseStrictJsonObjectV1(
      new TextDecoder("utf-8", { fatal: true }).decode(payload),
      "offline revocation statement",
    );
    const predicate = record(statement.predicate, "statement predicate");
    if (
      signed.snapshot.issuer !== expected.expectedIssuer ||
      predicate.signerIdentity !== expected.expectedAdminSignerIdentity ||
      expected.verifyCanonicalPae({
        expectedAdminSignerIdentity: expected.expectedAdminSignerIdentity,
        expectedAdminSignerRootSha256: expected.expectedAdminSignerRootSha256,
        paeBytes: pae(envelope.payloadType as string, payload),
        signatures: envelope.signatures,
      }) !== true
    )
      return undefined;
  } catch {
    return undefined;
  }
  return signed;
}

function decision(value: unknown): {
  id: string;
  issuedAt: string;
  notBefore: string;
  expiresAt: string;
  reviewBy: string;
} {
  const item = record(value, "decision");
  exact(item, ["expiresAt", "id", "issuedAt", "notBefore", "reviewBy"], "decision fields");
  const issuedAt = timestamp(item.issuedAt, "decision issued at");
  const notBefore = timestamp(item.notBefore, "decision not before");
  const expiresAt = timestamp(item.expiresAt, "decision expires at");
  const reviewBy = timestamp(item.reviewBy, "decision review by");
  if (
    Date.parse(notBefore) < Date.parse(issuedAt) ||
    Date.parse(expiresAt) < Date.parse(notBefore) ||
    Date.parse(reviewBy) < Date.parse(notBefore)
  )
    fail("decision bounds");
  return {
    expiresAt,
    id: stableId(item.id, "decision id", DECISION_ID),
    issuedAt,
    notBefore,
    reviewBy,
  };
}

export function resolveOfflineRevocationAuthorityV1(
  value: unknown,
): OfflineRevocationAuthorityV1Result {
  const item = record(value, "authority resolution");
  exact(
    item,
    [
      "decision",
      "durableState",
      "expectedAdminSignerIdentity",
      "expectedAdminSignerRootSha256",
      "expectedIssuer",
      "now",
      "receiptExpiresAt",
      "signedSnapshot",
      "verifyCanonicalPae",
    ],
    "authority resolution fields",
  );
  const expected = trust(item);
  const now = timestamp(item.now, "now");
  const receiptExpiresAt = timestamp(item.receiptExpiresAt, "receipt expires at");
  const resolvedDecision = decision(item.decision);
  const signed = reverify(item.signedSnapshot, expected);
  if (signed === undefined) return invalid();
  const snapshot = signed.snapshot;
  if (Date.parse(snapshot.issuedAt) > Date.parse(now)) return invalid();
  if (
    Date.parse(snapshot.validUntil) <= Date.parse(now) ||
    Date.parse(snapshot.issuedAt) < Date.parse(resolvedDecision.issuedAt) ||
    Date.parse(snapshot.issuedAt) < Date.parse(resolvedDecision.notBefore)
  )
    return stale();
  if (
    Date.parse(snapshot.validUntil) > Date.parse(resolvedDecision.expiresAt) ||
    Date.parse(snapshot.validUntil) > Date.parse(resolvedDecision.reviewBy) ||
    Date.parse(snapshot.validUntil) > Date.parse(receiptExpiresAt)
  )
    return invalid();
  if (item.durableState === undefined) return stale();
  let durable: OfflineRevocationStateV1;
  try {
    durable = state(item.durableState);
  } catch {
    return invalid();
  }
  const snapshotState = snapshotStateFor(signed);
  if (durable.issuer !== snapshotState.issuer) return invalid();
  if (snapshotState.sequence < durable.sequence) return stale();
  if (snapshotState.sequence > durable.sequence) return stale();
  if (snapshotState.digestSha256 !== durable.digestSha256) return invalid();
  return deepFreezeStrictJsonV1({
    effective: true,
    kind: "current" as const,
    materializable: false,
    revoked: snapshot.revokedDecisionIds.includes(resolvedDecision.id),
  });
}

function state(value: unknown): OfflineRevocationStateV1 {
  const item = record(value, "offline revocation state");
  exact(item, ["digestSha256", "issuer", "sequence"], "offline revocation state fields");
  if (!Number.isSafeInteger(item.sequence) || (item.sequence as number) < 1)
    fail("offline revocation state sequence");
  return deepFreezeStrictJsonV1({
    digestSha256: digest(item.digestSha256, "offline revocation state digest"),
    issuer: stableId(item.issuer, "offline revocation state issuer"),
    sequence: item.sequence as number,
  });
}

function snapshotStateFor(value: SignedOfflineRevocationSnapshotV1): OfflineRevocationStateV1 {
  return deepFreezeStrictJsonV1({
    digestSha256: sha256(canonicalOfflineRevocationSnapshotV1Bytes(value)),
    issuer: value.snapshot.issuer,
    sequence: value.snapshot.sequence,
  });
}

export function transitionOfflineRevocationStateV1(
  value: unknown,
): OfflineRevocationStateTransitionV1 {
  const item = record(value, "offline revocation state transition");
  exact(
    item,
    [
      "current",
      "expectedAdminSignerIdentity",
      "expectedAdminSignerRootSha256",
      "expectedIssuer",
      "next",
      "verifyCanonicalPae",
    ],
    "offline revocation state transition fields",
  );
  const next = reverify(item.next, trust(item));
  if (next === undefined) return invalidTransition();
  const nextState = snapshotStateFor(next);
  if (item.current === undefined)
    return deepFreezeStrictJsonV1({ kind: "advance" as const, state: nextState });
  const current = state(item.current);
  if (current.issuer !== nextState.issuer) fail("offline revocation state issuer");
  if (nextState.sequence < current.sequence)
    return deepFreezeStrictJsonV1({ kind: "rollback" as const, state: current });
  if (nextState.sequence === current.sequence)
    return deepFreezeStrictJsonV1({
      kind:
        current.digestSha256 === nextState.digestSha256
          ? ("unchanged" as const)
          : ("conflict" as const),
      state: current,
    });
  return deepFreezeStrictJsonV1({ kind: "advance" as const, state: nextState });
}

/**
 * A narrow durable per-issuer compare-and-swap seam. The caller owns the
 * storage implementation, partitioned by the exact `expectedIssuer`. Both
 * callbacks are synchronous: `observe(expectedIssuer)` supplies the live
 * state and `claim(expectedIssuer, expected, replacement)` must return the
 * literal boolean `true` only for an atomic compare-and-swap. A live observation
 * happens before the claim and another after it; neither a race nor a crash can
 * be reported as an accepted transition.
 */
export function claimOfflineRevocationStateV1(
  value: unknown,
):
  | Readonly<{ kind: "advanced"; state: OfflineRevocationStateV1 }>
  | Readonly<{ kind: "conflict" | "rollback" | "unchanged"; state: OfflineRevocationStateV1 }>
  | Readonly<{ kind: "invalid-authority" }>
  | Readonly<{ kind: "contended" }> {
  const item = record(value, "offline revocation state claim");
  exact(
    item,
    [
      "claim",
      "expectedAdminSignerIdentity",
      "expectedAdminSignerRootSha256",
      "expectedIssuer",
      "next",
      "observe",
      "verifyCanonicalPae",
    ],
    "offline revocation state claim fields",
  );
  const expected = trust(item);
  const observe = item.observe;
  const claim = item.claim;
  if (
    isProxy(observe) ||
    typeof observe !== "function" ||
    isProxy(claim) ||
    typeof claim !== "function"
  )
    fail("offline revocation state custody");
  // Do not even consult custody for unauthenticated material. The transition
  // below deliberately re-verifies again against the same live caller trust.
  if (reverify(item.next, expected) === undefined)
    return deepFreezeStrictJsonV1({ kind: "invalid-authority" as const });
  let current: unknown;
  try {
    current = observe(expected.expectedIssuer);
    if (isAsyncCallbackResult(current))
      return deepFreezeStrictJsonV1({ kind: "contended" as const });
  } catch {
    fail("offline revocation state custody");
  }
  const transition = transitionOfflineRevocationStateV1({
    current,
    expectedAdminSignerIdentity: expected.expectedAdminSignerIdentity,
    expectedAdminSignerRootSha256: expected.expectedAdminSignerRootSha256,
    expectedIssuer: expected.expectedIssuer,
    next: item.next,
    verifyCanonicalPae: expected.verifyCanonicalPae,
  });
  if (transition.kind === "invalid-authority") return transition;
  if (transition.kind !== "advance")
    return deepFreezeStrictJsonV1({ kind: transition.kind, state: transition.state });
  try {
    const claimed = claim(expected.expectedIssuer, current, transition.state);
    if (isAsyncCallbackResult(claimed) || claimed !== true)
      return deepFreezeStrictJsonV1({ kind: "contended" as const });
    const observedAfterClaim = observe(expected.expectedIssuer);
    if (isAsyncCallbackResult(observedAfterClaim))
      return deepFreezeStrictJsonV1({ kind: "contended" as const });
    const reobserved = state(observedAfterClaim);
    if (
      reobserved.issuer !== transition.state.issuer ||
      reobserved.sequence !== transition.state.sequence ||
      reobserved.digestSha256 !== transition.state.digestSha256
    )
      return deepFreezeStrictJsonV1({ kind: "contended" as const });
  } catch {
    return deepFreezeStrictJsonV1({ kind: "contended" as const });
  }
  return deepFreezeStrictJsonV1({ kind: "advanced" as const, state: transition.state });
}

/** Callbacks are synchronous by contract; promises are never awaited or adopted. */
function isAsyncCallbackResult(value: unknown): boolean {
  if (value instanceof Promise) return true;
  if (typeof value !== "object" || value === null || isProxy(value)) return false;
  const descriptor = Object.getOwnPropertyDescriptor(value, "then");
  return (
    descriptor !== undefined &&
    Object.hasOwn(descriptor, "value") &&
    typeof descriptor.value === "function"
  );
}
