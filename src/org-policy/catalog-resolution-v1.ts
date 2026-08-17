import { createHash } from "node:crypto";
import { codeUnitCompare } from "../capability/package-graph/canonical.js";
import {
  assertStrictJsonValueV1,
  canonicalStrictJsonBytesV1,
  deepFreezeStrictJsonV1,
  parseStrictJsonObjectV1,
} from "../contract/strict-json-v1.js";

const SHA256 = /^[a-f0-9]{64}$/;
const envelopeBytes = new WeakMap<object, Buffer>();
const snapshotBytes = new WeakMap<object, Buffer>();
const verifiedMaterials = new WeakSet<object>();
const VERIFICATION_FIELDS = [
  "envelope",
  "expectedCatalogSignerIdentity",
  "expectedEnvironment",
  "expectedIssuer",
  "expectedRef",
  "expectedRepository",
  "expectedSignerRootSha256",
  "expectedWorkflowIdentity",
  "now",
  "verifyCanonicalPae",
] as const;
const RESOLUTION_FIELDS = [
  "adminSignerRootSha256",
  "cachedVerified",
  "expectedCatalogSha256",
  "expectedCatalogSignerIdentity",
  "expectedEnvironment",
  "expectedIssuer",
  "expectedPackageRootSha256",
  "expectedPackageSha256",
  "expectedPromotionDecisionSha256",
  "expectedRef",
  "expectedRepository",
  "expectedWorkflowIdentity",
  "fresh",
  "headSignerRootSha256",
  "lastGood",
  "now",
  "packaged",
  "verifyCanonicalPae",
] as const;

type Json = Record<string, unknown>;
type SnapshotMember = Readonly<{
  candidateIdentitySha256: string;
  candidateSha256: string;
  componentId: string;
  evidenceSha256: string;
  gitCommitSha256: string;
  pinSha256: string;
  policyRevisionSha256: string;
  profileSha256: string;
  promotionDecisionSha256: string;
  qualificationBundleSha256: string;
  recipeSha256: string;
  repository: string;
  sourceId: string;
  sourceSha256: string;
}>;
export type CatalogSnapshotV1 = Readonly<{
  protocol: "CatalogSnapshotV1";
  members: readonly SnapshotMember[];
}>;
export type VerifiedCatalogMaterialV1 = Readonly<{
  kind: "resolved";
  catalogHeadSha256: string;
  catalogSha256: string;
  compatibleEffectVersion: string;
  compatibleSchemaVersion: string;
  members: readonly SnapshotMember[];
  sequence: number;
  tier: "fresh" | "cached-verified" | "packaged";
}>;
type VerifiedEnvelope = Readonly<{
  envelope: Readonly<{
    payload: string;
    payloadType: string;
    signatures: readonly Readonly<Json>[];
  }>;
  statementBytes: Buffer;
  statement: Readonly<Json>;
}>;

function fail(label: string): never {
  throw new TypeError(`invalid CatalogHeadV1: ${label}`);
}

function hash(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function exact(value: Json, fields: readonly string[], label: string): void {
  const actual = Object.keys(value).sort(codeUnitCompare);
  const expected = [...fields].sort(codeUnitCompare);
  if (actual.length !== expected.length || actual.some((item, index) => item !== expected[index]))
    fail(label);
}

function record(value: unknown, label: string): Json {
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

function text(value: unknown, label: string, max = 256): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) fail(label);
  return value;
}

function digest(value: unknown, label: string): string {
  const result = text(value, label, 64);
  if (!SHA256.test(result)) fail(label);
  return result;
}

function decode(value: unknown, label: string): string {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array)
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  fail(label);
}

function timestamp(value: unknown, label: string): string {
  const result = text(value, label, 32);
  const parts = result.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/);
  if (parts === null) fail(label);
  const numbers = parts.slice(1).map(Number);
  const [year, month, day, hour, minute, second] = numbers;
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

function canonicalJsonBytes(value: unknown, label: string): Buffer {
  assertStrictJsonValueV1(value, label);
  return canonicalStrictJsonBytesV1(value);
}

function parseHead(bytes: Buffer): Json {
  const raw = parseStrictJsonObjectV1(decode(bytes, "head bytes"), "catalog head");
  exact(
    raw,
    [
      "catalogSha256",
      "compatibleEffectVersions",
      "compatibleSchemaVersions",
      "previousCatalogHeadSha256",
      "promotionDecisionSha256",
      "protocol",
      "sequence",
      "signerIdentity",
      "validFrom",
      "validUntil",
    ],
    "head fields",
  );
  if (
    raw.protocol !== "CatalogHeadV1" ||
    !Number.isSafeInteger(raw.sequence) ||
    (raw.sequence as number) < 1
  )
    fail("head");
  for (const field of ["catalogSha256", "previousCatalogHeadSha256", "promotionDecisionSha256"])
    digest(raw[field], field);
  for (const field of ["compatibleEffectVersions", "compatibleSchemaVersions"]) {
    const values = raw[field];
    if (
      !Array.isArray(values) ||
      values.length === 0 ||
      values.length > 128 ||
      values.some((item) => typeof item !== "string")
    )
      fail(field);
    const sorted = [...values].sort(codeUnitCompare);
    if (
      sorted.some((item, index) => item !== values[index]) ||
      new Set(values).size !== values.length
    )
      fail(field);
  }
  text(raw.signerIdentity, "signer identity");
  const from = timestamp(raw.validFrom, "valid from");
  const until = timestamp(raw.validUntil, "valid until");
  if (from >= until) fail("validity");
  if (canonicalJsonBytes(raw, "catalog head").compare(bytes) !== 0) fail("noncanonical head bytes");
  return deepFreezeStrictJsonV1(structuredClone(raw));
}

const SNAPSHOT_MEMBER_FIELDS = [
  "candidateIdentitySha256",
  "candidateSha256",
  "componentId",
  "evidenceSha256",
  "gitCommitSha256",
  "pinSha256",
  "policyRevisionSha256",
  "profileSha256",
  "promotionDecisionSha256",
  "qualificationBundleSha256",
  "recipeSha256",
  "repository",
  "sourceId",
  "sourceSha256",
] as const;

function snapshotMember(value: unknown): SnapshotMember {
  const item = record(value, "snapshot member");
  exact(item, SNAPSHOT_MEMBER_FIELDS, "snapshot member fields");
  const componentId = text(item.componentId, "component ID");
  const sourceId = text(item.sourceId, "source ID");
  const repository = text(item.repository, "repository");
  if (!/^[a-z][a-z0-9-]*:[a-z0-9][a-z0-9.-]*$/.test(componentId)) fail("component ID");
  if (!/^[a-z0-9][a-z0-9./-]*$/.test(sourceId) || /(^|\/)\.\.?($|\/)|:|https?/.test(sourceId))
    fail("source ID");
  if (!/^github\.com\/[a-z0-9][a-z0-9.-]*\/[a-z0-9][a-z0-9.-]*$/.test(repository))
    fail("repository");
  return {
    candidateIdentitySha256: digest(item.candidateIdentitySha256, "candidate identity"),
    candidateSha256: digest(item.candidateSha256, "candidate"),
    componentId,
    evidenceSha256: digest(item.evidenceSha256, "evidence"),
    gitCommitSha256: digest(item.gitCommitSha256, "git commit"),
    pinSha256: digest(item.pinSha256, "pin"),
    policyRevisionSha256: digest(item.policyRevisionSha256, "policy"),
    profileSha256: digest(item.profileSha256, "profile"),
    promotionDecisionSha256: digest(item.promotionDecisionSha256, "promotion"),
    qualificationBundleSha256: digest(item.qualificationBundleSha256, "qualification"),
    recipeSha256: digest(item.recipeSha256, "recipe"),
    repository,
    sourceId,
    sourceSha256: digest(item.sourceSha256, "source"),
  };
}

function snapshotFromObject(value: unknown): CatalogSnapshotV1 {
  const item = record(value, "catalog snapshot");
  exact(item, ["members", "protocol"], "catalog snapshot fields");
  if (item.protocol !== "CatalogSnapshotV1" || !Array.isArray(item.members))
    fail("catalog snapshot");
  const rawMembers = item.members;
  if (rawMembers.length === 0 || rawMembers.length > 4096) fail("snapshot members");
  const members = rawMembers
    .map(snapshotMember)
    .sort((left, right) => codeUnitCompare(left.componentId, right.componentId));
  if (
    members.some((member, index) => member.componentId !== (rawMembers[index] as Json).componentId)
  )
    fail("snapshot member order");
  if (new Set(members.map((member) => member.componentId)).size !== members.length)
    fail("snapshot members");
  return deepFreezeStrictJsonV1({ members, protocol: "CatalogSnapshotV1" }) as CatalogSnapshotV1;
}

export function parseCatalogSnapshotV1Json(value: unknown): CatalogSnapshotV1 {
  const bytes = Buffer.from(decode(value, "snapshot bytes"), "utf8");
  const result = snapshotFromObject(
    parseStrictJsonObjectV1(bytes.toString("utf8"), "catalog snapshot"),
  );
  const canonical = canonicalStrictJsonBytesV1(result);
  if (canonical.compare(bytes) !== 0) fail("noncanonical snapshot bytes");
  snapshotBytes.set(result, canonical);
  return result;
}

export function canonicalCatalogSnapshotV1Bytes(value: CatalogSnapshotV1): Buffer {
  const bytes = typeof value === "object" && value !== null ? snapshotBytes.get(value) : undefined;
  if (bytes === undefined) fail("unbranded snapshot");
  return Buffer.from(bytes);
}

function canonicalPae(payloadType: string, payload: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(
      `DSSEv1 ${String(Buffer.byteLength(payloadType))} ${payloadType} ${String(payload.length)} `,
      "utf8",
    ),
    payload,
  ]);
}

function parseEnvelopeObject(value: Json): VerifiedEnvelope {
  exact(value, ["payload", "payloadType", "signatures"], "envelope fields");
  if (value.payloadType !== "application/vnd.in-toto+json") fail("payload type");
  const payloadText = text(value.payload, "payload", 16384);
  const statementBytes = Buffer.from(payloadText, "base64");
  if (statementBytes.toString("base64") !== payloadText) fail("payload base64");
  const statement = parseStrictJsonObjectV1(
    decode(statementBytes, "statement bytes"),
    "in-toto statement",
  );
  exact(statement, ["_type", "predicate", "predicateType", "subject"], "statement fields");
  if (
    statement._type !== "https://in-toto.io/Statement/v1" ||
    statement.predicateType !== "https://aih.dev/CatalogHeadV1"
  )
    fail("statement");
  const predicate = record(statement.predicate, "predicate");
  exact(
    predicate,
    [
      "environment",
      "issuer",
      "protocol",
      "recordType",
      "repository",
      "signerIdentity",
      "workflowIdentity",
    ],
    "predicate fields",
  );
  if (predicate.protocol !== "CatalogHeadEnvelopeV1" || predicate.recordType !== "CatalogHeadV1")
    fail("predicate");
  for (const field of ["environment", "issuer", "repository", "signerIdentity", "workflowIdentity"])
    text(predicate[field], field);
  const subject = statement.subject;
  if (!Array.isArray(subject) || subject.length !== 1) fail("subject");
  const subject0 = record(subject[0], "subject");
  exact(subject0, ["digest", "name"], "subject fields");
  if (subject0.name !== "aih/CatalogHeadV1") fail("subject name");
  const subjectDigest = record(subject0.digest, "subject digest");
  exact(subjectDigest, ["sha256"], "subject digest fields");
  digest(subjectDigest.sha256, "subject digest");
  if (
    !Array.isArray(value.signatures) ||
    value.signatures.length === 0 ||
    value.signatures.length > 64
  )
    fail("signatures");
  const keys = new Set<string>();
  for (const signatureValue of value.signatures) {
    const signature = record(signatureValue, "signature");
    exact(signature, ["keyid", "sig"], "signature fields");
    const keyid = text(signature.keyid, "key ID");
    const sig = text(signature.sig, "signature", 8192);
    if (keys.has(keyid) || Buffer.from(sig, "base64").toString("base64") !== sig)
      fail("signatures");
    keys.add(keyid);
  }
  if (canonicalJsonBytes(statement, "statement").compare(statementBytes) !== 0)
    fail("noncanonical statement");
  const immutable = deepFreezeStrictJsonV1({
    envelope: structuredClone(value),
    statement,
  }) as { envelope: VerifiedEnvelope["envelope"]; statement: Readonly<Json> };
  return Object.freeze({
    envelope: immutable.envelope,
    statement: immutable.statement,
    statementBytes: Buffer.from(statementBytes),
  });
}

export function parseCatalogHeadEnvelopeV1(value: unknown): VerifiedEnvelope {
  if (typeof value === "string" || Buffer.isBuffer(value) || value instanceof Uint8Array) {
    const bytes = Buffer.from(decode(value, "envelope bytes"), "utf8");
    const result = parseEnvelopeObject(
      parseStrictJsonObjectV1(bytes.toString("utf8"), "catalog envelope"),
    );
    envelopeBytes.set(result, canonicalStrictJsonBytesV1(result.envelope));
    if (canonicalCatalogHeadEnvelopeV1Bytes(result).compare(bytes) !== 0)
      fail("noncanonical envelope bytes");
    return result;
  }
  assertStrictJsonValueV1(value, "catalog envelope");
  const result = parseEnvelopeObject(value as Json);
  envelopeBytes.set(result, canonicalStrictJsonBytesV1(result.envelope));
  return result;
}

export function canonicalCatalogHeadEnvelopeV1Bytes(value: VerifiedEnvelope): Buffer {
  const output = value as unknown as object;
  const cached = envelopeBytes.get(output);
  if (cached === undefined) fail("unbranded envelope");
  return Buffer.from(cached);
}

export function verifyCatalogHeadEnvelopeV1(input: unknown): VerifiedEnvelope {
  const value = record(input, "verification");
  exact(value, VERIFICATION_FIELDS, "verification fields");
  const envelope = value.envelope as VerifiedEnvelope;
  if (
    typeof envelope !== "object" ||
    envelope === null ||
    envelopeBytes.get(envelope as unknown as object) === undefined
  )
    fail("envelope");
  const root = digest(value.expectedSignerRootSha256, "signer root");
  const now = timestamp(value.now, "now");
  const repository = text(value.expectedRepository, "repository");
  const workflow = text(value.expectedWorkflowIdentity, "workflow");
  const issuer = text(value.expectedIssuer, "issuer");
  const ref = text(value.expectedRef, "ref");
  const environment = text(value.expectedEnvironment, "environment");
  const signerIdentity = text(value.expectedCatalogSignerIdentity, "catalog signer identity");
  const predicate = record(envelope.statement.predicate, "predicate");
  if (
    predicate.repository !== repository ||
    predicate.workflowIdentity !== workflow ||
    predicate.issuer !== issuer ||
    predicate.environment !== environment ||
    predicate.signerIdentity !== signerIdentity ||
    ref !== "refs/heads/main"
  )
    fail("trust context");
  const verify = value.verifyCanonicalPae;
  if (
    typeof verify !== "function" ||
    verify({
      paeBytes: canonicalPae(envelope.envelope.payloadType as string, envelope.statementBytes),
      signatures: envelope.envelope.signatures,
      expectedSignerRootSha256: root,
      signerRootSha256: root,
      repository,
      workflowIdentity: workflow,
      issuer,
      ref,
      environment,
      expectedCatalogSignerIdentity: signerIdentity,
    }) !== true
  )
    fail("signature");
  if (now.length === 0) fail("now");
  return envelope;
}

function state(
  value: unknown,
  kind: "CachedCatalogStateV1" | "PackagedCatalogStateV1",
  context: Json,
  verifyExpectedMaterial = true,
): { head: Json; state: Json; envelope: VerifiedEnvelope; snapshot: CatalogSnapshotV1 } {
  const item = record(value, "catalog state");
  const fields = [
    "catalogHeadBytes",
    "catalogHeadEnvelopeBytes",
    "catalogHeadEnvelopeSha256",
    "catalogHeadSha256",
    "catalogSnapshotBytes",
    "catalogSnapshotSha256",
    "protocol",
    "signerRootSha256",
    "verifiedAt",
  ];
  if (kind === "PackagedCatalogStateV1") fields.push("packageRootSha256", "packageSha256");
  exact(item, fields, "catalog state fields");
  if (item.protocol !== kind) fail("catalog state protocol");
  const headBytes = Buffer.from(decode(item.catalogHeadBytes, "head bytes"), "utf8");
  const snapshotBytes = Buffer.from(decode(item.catalogSnapshotBytes, "snapshot bytes"), "utf8");
  const envelopeBytesValue = Buffer.from(
    decode(item.catalogHeadEnvelopeBytes, "envelope bytes"),
    "utf8",
  );
  if (
    hash(headBytes) !== digest(item.catalogHeadSha256, "head hash") ||
    hash(snapshotBytes) !== digest(item.catalogSnapshotSha256, "snapshot hash") ||
    hash(envelopeBytesValue) !== digest(item.catalogHeadEnvelopeSha256, "envelope hash")
  )
    fail("state hash");
  if (
    digest(item.signerRootSha256, "state root") !==
    digest(context.headSignerRootSha256, "expected root")
  )
    fail("state root");
  timestamp(item.verifiedAt, "verified at");
  if (kind === "PackagedCatalogStateV1") {
    if (
      digest(item.packageSha256, "package hash") !==
        digest(context.expectedPackageSha256, "expected package hash") ||
      digest(item.packageRootSha256, "package root") !==
        digest(context.expectedPackageRootSha256, "expected package root")
    )
      fail("package trust");
  }
  const head = parseHead(headBytes);
  const snapshot = parseCatalogSnapshotV1Json(snapshotBytes);
  const resolutionNow = timestamp(context.now, "now");
  if (resolutionNow < (head.validFrom as string) || resolutionNow >= (head.validUntil as string))
    fail("head validity");
  if (verifyExpectedMaterial) {
    if (head.catalogSha256 !== digest(context.expectedCatalogSha256, "expected catalog"))
      fail("expected catalog");
    if (
      head.promotionDecisionSha256 !==
      digest(context.expectedPromotionDecisionSha256, "expected promotion decision")
    )
      fail("expected promotion decision");
  }
  if (
    head.signerIdentity !== text(context.expectedCatalogSignerIdentity, "catalog signer identity")
  )
    fail("catalog signer identity");
  if (head.catalogSha256 !== item.catalogSnapshotSha256) fail("head catalog");
  const envelope = parseCatalogHeadEnvelopeV1(envelopeBytesValue);
  const subject = record((envelope.statement.subject as unknown[])[0], "subject");
  if (record(subject.digest, "subject digest").sha256 !== item.catalogHeadSha256)
    fail("envelope head");
  verifyCatalogHeadEnvelopeV1({
    envelope,
    expectedSignerRootSha256: context.headSignerRootSha256,
    expectedCatalogSignerIdentity: context.expectedCatalogSignerIdentity,
    now: context.now,
    expectedRepository: context.expectedRepository,
    expectedWorkflowIdentity: context.expectedWorkflowIdentity,
    expectedIssuer: context.expectedIssuer,
    expectedRef: context.expectedRef,
    expectedEnvironment: context.expectedEnvironment,
    verifyCanonicalPae: context.verifyCanonicalPae,
  });
  return { envelope, head, snapshot, state: item };
}

function unavailable(value: unknown): boolean {
  const item = record(value, "tier");
  if (!Object.hasOwn(item, "kind")) return false;
  exact(item, ["kind"], "unavailable tier");
  if (item.kind !== "unavailable") fail("unavailable tier");
  return true;
}

function lastGoodForFailure(value: unknown): unknown {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, "lastGood");
    if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) return undefined;
    return descriptor.value;
  } catch {
    return undefined;
  }
}

export function resolveAdminCatalogV1(input: unknown): Json {
  const fallbackLastGood = lastGoodForFailure(input);
  try {
    const value = record(input, "resolution");
    exact(value, RESOLUTION_FIELDS, "resolution fields");
    const lastGood = value.lastGood as Json;
    digest(value.expectedPackageSha256, "expected package hash");
    digest(value.expectedPackageRootSha256, "expected package root");
    const base = { ...value };
    const tiers: Array<
      [
        "fresh" | "cached-verified" | "packaged",
        unknown,
        "CachedCatalogStateV1" | "PackagedCatalogStateV1",
      ]
    > = [
      ["fresh", value.fresh, "CachedCatalogStateV1"],
      ["cached-verified", value.cachedVerified, "CachedCatalogStateV1"],
      ["packaged", value.packaged, "PackagedCatalogStateV1"],
    ];
    for (const [tier, candidate, kind] of tiers) {
      try {
        if (unavailable(candidate)) continue;
        const next = state(candidate, kind, base);
        const current = state(lastGood, "CachedCatalogStateV1", base, false);
        if (
          (next.head.sequence as number) < (current.head.sequence as number) ||
          ((next.head.sequence as number) === (current.head.sequence as number) &&
            next.state.catalogHeadSha256 !== current.state.catalogHeadSha256) ||
          ((next.head.sequence as number) > (current.head.sequence as number) &&
            next.head.previousCatalogHeadSha256 !== current.state.catalogHeadSha256)
        )
          return { kind: "fatal", lastGood };
        const candidateState = candidate as Json;
        const schema = next.head.compatibleSchemaVersions as string[];
        const effect = next.head.compatibleEffectVersions as string[];
        if (!schema.includes("1") || !effect.includes("1")) {
          return {
            kind: "compatibility-required",
            headDigestSha256: candidateState.catalogHeadSha256,
            materializable: false,
          };
        }
        return {
          kind: "resolved",
          tier,
          headDigestSha256: candidateState.catalogHeadSha256,
          verifiedAt: candidateState.verifiedAt,
        };
      } catch {
        return { kind: "fatal", lastGood };
      }
    }
    return { kind: "fatal", lastGood };
  } catch {
    return { kind: "fatal", lastGood: fallbackLastGood };
  }
}

export function resolveVerifiedCatalogMaterialV1(input: unknown): VerifiedCatalogMaterialV1 {
  const value = record(input, "material resolution");
  exact(value, RESOLUTION_FIELDS, "resolution fields");
  const lastGood = value.lastGood as Json;
  const base = { ...value };
  const tiers: Array<
    [
      "fresh" | "cached-verified" | "packaged",
      unknown,
      "CachedCatalogStateV1" | "PackagedCatalogStateV1",
    ]
  > = [
    ["fresh", value.fresh, "CachedCatalogStateV1"],
    ["cached-verified", value.cachedVerified, "CachedCatalogStateV1"],
    ["packaged", value.packaged, "PackagedCatalogStateV1"],
  ];
  for (const [tier, candidate, kind] of tiers) {
    if (unavailable(candidate)) continue;
    const next = state(candidate, kind, base);
    const current = state(lastGood, "CachedCatalogStateV1", base, false);
    if (
      (next.head.sequence as number) < (current.head.sequence as number) ||
      ((next.head.sequence as number) === (current.head.sequence as number) &&
        next.state.catalogHeadSha256 !== current.state.catalogHeadSha256) ||
      ((next.head.sequence as number) > (current.head.sequence as number) &&
        next.head.previousCatalogHeadSha256 !== current.state.catalogHeadSha256)
    )
      fail("catalog continuity");
    const schema = next.head.compatibleSchemaVersions as string[];
    const effect = next.head.compatibleEffectVersions as string[];
    if (!schema.includes("1") || !effect.includes("1")) fail("catalog compatibility");
    const result = deepFreezeStrictJsonV1({
      catalogHeadSha256: next.state.catalogHeadSha256,
      catalogSha256: next.state.catalogSnapshotSha256,
      compatibleEffectVersion: "1",
      compatibleSchemaVersion: "1",
      kind: "resolved" as const,
      members: structuredClone(next.snapshot.members),
      sequence: next.head.sequence as number,
      tier,
    }) as VerifiedCatalogMaterialV1;
    verifiedMaterials.add(result);
    return result;
  }
  fail("catalog unavailable");
}

export function bindingInputFromVerifiedCatalogMaterialV1(
  value: VerifiedCatalogMaterialV1,
  input: { adminSignerRootSha256: string; headSignerRootSha256: string; resolvedAt: string },
): Json {
  if (typeof value !== "object" || value === null || !verifiedMaterials.has(value))
    fail("unbranded catalog material");
  const item = record(input, "binding material context");
  exact(item, ["adminSignerRootSha256", "headSignerRootSha256", "resolvedAt"], "binding context");
  return {
    adminSignerRootSha256: digest(item.adminSignerRootSha256, "admin signer root"),
    catalogHeadSha256: value.catalogHeadSha256,
    catalogSha256: value.catalogSha256,
    compatibleEffectVersion: value.compatibleEffectVersion,
    compatibleSchemaVersion: value.compatibleSchemaVersion,
    headSignerRootSha256: digest(item.headSignerRootSha256, "head signer root"),
    members: structuredClone(value.members),
    protocol: "ResolvedCatalogBindingV1",
    resolvedAt: timestamp(item.resolvedAt, "resolved at"),
    sequence: value.sequence,
    tier: value.tier,
  };
}
