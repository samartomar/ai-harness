import { createHash } from "node:crypto";
import { codeUnitCompare } from "../capability/package-graph/canonical.js";
import {
  assertStrictJsonValueV1,
  canonicalStrictJsonBytesV1,
  deepFreezeStrictJsonV1,
  parseStrictJsonObjectV1,
} from "../contract/strict-json-v1.js";

const SHA256 = /^[a-f0-9]{64}$/;
const MAX_MEMBERS = 4096;
const bindingBytes = new WeakMap<object, Buffer>();
const distributions = new WeakSet<object>();
const distributionBytes = new WeakMap<object, Buffer>();

type Json = Record<string, unknown>;

export interface ResolvedCatalogBindingV1 {
  readonly protocol: "ResolvedCatalogBindingV1";
  readonly catalogHeadSha256: string;
  readonly catalogSha256: string;
  readonly sequence: number;
  readonly tier: "fresh" | "cached-verified" | "packaged";
  readonly resolvedAt: string;
  readonly headSignerRootSha256: string;
  readonly adminSignerRootSha256: string;
  readonly compatibleSchemaVersion: string;
  readonly compatibleEffectVersion: string;
  readonly members: readonly Readonly<{
    componentId: string;
    sourceSha256: string;
    [key: string]: unknown;
  }>[];
  readonly resolvedCatalogBindingSha256: string;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function fail(label: string): never {
  throw new TypeError(`invalid ResolvedCatalogBindingV1: ${label}`);
}

function exactKeys(value: Json, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort(codeUnitCompare);
  const expected = [...keys].sort(codeUnitCompare);
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index]))
    fail(label);
}

function asRecord(value: unknown, label: string): Json {
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

function string(value: unknown, label: string, max = 256): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) fail(label);
  return value;
}

function digest(value: unknown, label: string): string {
  const result = string(value, label, 64);
  if (!SHA256.test(result)) fail(label);
  return result;
}

function timestamp(value: unknown, label: string): string {
  const result = string(value, label, 32);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(result)) fail(label);
  const [year, month, day, hour, minute, second] = result.match(/\d+/g)?.map(Number) ?? [];
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

function member(value: unknown): Json {
  const result = asRecord(value, "member");
  exactKeys(
    result,
    [
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
    ],
    "member fields",
  );
  const componentId = string(result.componentId, "component ID");
  const sourceId = string(result.sourceId, "source ID");
  const repository = string(result.repository, "repository");
  if (!/^[a-z][a-z0-9-]*:[a-z0-9][a-z0-9.-]*$/.test(componentId)) fail("component ID");
  if (!/^[a-z0-9][a-z0-9./-]*$/.test(sourceId) || /(^|\/)\.\.?($|\/)|:|https?/.test(sourceId))
    fail("source ID");
  if (!/^github\.com\/[a-z0-9][a-z0-9.-]*\/[a-z0-9][a-z0-9.-]*$/.test(repository))
    fail("repository");
  return {
    candidateIdentitySha256: digest(result.candidateIdentitySha256, "candidate identity"),
    candidateSha256: digest(result.candidateSha256, "candidate"),
    componentId,
    evidenceSha256: digest(result.evidenceSha256, "evidence"),
    gitCommitSha256: digest(result.gitCommitSha256, "git commit"),
    pinSha256: digest(result.pinSha256, "pin"),
    policyRevisionSha256: digest(result.policyRevisionSha256, "policy"),
    profileSha256: digest(result.profileSha256, "profile"),
    promotionDecisionSha256: digest(result.promotionDecisionSha256, "promotion"),
    qualificationBundleSha256: digest(result.qualificationBundleSha256, "qualification"),
    recipeSha256: digest(result.recipeSha256, "recipe"),
    repository,
    sourceId,
    sourceSha256: digest(result.sourceSha256, "source"),
  };
}

function rawBinding(input: unknown): Json {
  assertStrictJsonValueV1(input, "resolved catalog binding");
  const value = asRecord(input, "binding");
  exactKeys(
    value,
    [
      "adminSignerRootSha256",
      "catalogHeadSha256",
      "catalogSha256",
      "compatibleEffectVersion",
      "compatibleSchemaVersion",
      "headSignerRootSha256",
      "members",
      "protocol",
      "resolvedAt",
      "sequence",
      "tier",
    ],
    "binding fields",
  );
  if (value.protocol !== "ResolvedCatalogBindingV1") fail("protocol");
  if (!Number.isSafeInteger(value.sequence) || (value.sequence as number) < 1) fail("sequence");
  if (value.tier !== "fresh" && value.tier !== "cached-verified" && value.tier !== "packaged")
    fail("tier");
  const membersValue = value.members;
  if (
    !Array.isArray(membersValue) ||
    membersValue.length === 0 ||
    membersValue.length > MAX_MEMBERS
  )
    fail("members");
  const members = membersValue
    .map(member)
    .sort((left, right) =>
      codeUnitCompare(left.componentId as string, right.componentId as string),
    );
  if (new Set(members.map((item) => item.componentId)).size !== members.length) fail("members");
  for (const item of members) {
    if (
      item.sourceSha256 === item.pinSha256 ||
      item.candidateIdentitySha256 === item.candidateSha256
    )
      fail("member cross-binding");
  }
  const headRoot = digest(value.headSignerRootSha256, "head signer root");
  const adminRoot = digest(value.adminSignerRootSha256, "admin signer root");
  if (headRoot === adminRoot) fail("signer roots");
  return {
    adminSignerRootSha256: adminRoot,
    catalogHeadSha256: digest(value.catalogHeadSha256, "catalog head"),
    catalogSha256: digest(value.catalogSha256, "catalog"),
    compatibleEffectVersion: string(value.compatibleEffectVersion, "effect version", 64),
    compatibleSchemaVersion: string(value.compatibleSchemaVersion, "schema version", 64),
    headSignerRootSha256: headRoot,
    members,
    protocol: "ResolvedCatalogBindingV1" as const,
    resolvedAt: timestamp(value.resolvedAt, "resolved at"),
    sequence: value.sequence as number,
    tier: value.tier as "fresh" | "cached-verified" | "packaged",
  };
}

function create(raw: Json): ResolvedCatalogBindingV1 {
  const bytes = canonicalStrictJsonBytesV1(raw);
  const result = deepFreezeStrictJsonV1({
    ...raw,
    resolvedCatalogBindingSha256: sha256(bytes),
  }) as ResolvedCatalogBindingV1;
  bindingBytes.set(result, bytes);
  return result;
}

export function createResolvedCatalogBindingV1(input: unknown): ResolvedCatalogBindingV1 {
  return create(rawBinding(input));
}

function decode(value: unknown, label: string): string {
  if (typeof value === "string") return value;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array)
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  fail(label);
}

export function parseResolvedCatalogBindingV1Json(value: unknown): ResolvedCatalogBindingV1 {
  const text = decode(value, "binding bytes");
  const parsed = parseStrictJsonObjectV1(text, "resolved catalog binding");
  const result = create(rawBinding(parsed));
  if (canonicalResolvedCatalogBindingV1Bytes(result).toString("utf8") !== text)
    fail("noncanonical bytes");
  return result;
}

export function canonicalResolvedCatalogBindingV1Bytes(value: ResolvedCatalogBindingV1): Buffer {
  const bytes = typeof value === "object" && value !== null ? bindingBytes.get(value) : undefined;
  if (bytes === undefined)
    throw new TypeError("resolved catalog binding requires a validated brand");
  return Buffer.from(bytes);
}

export function canonicalResolvedCatalogBindingV1Sha256(value: ResolvedCatalogBindingV1): string {
  return sha256(canonicalResolvedCatalogBindingV1Bytes(value));
}

export interface AdminSeatDistributionV1 {
  readonly protocol: "AdminSeatDistributionV1";
  readonly binding: ResolvedCatalogBindingV1;
  readonly envelope: Readonly<Json>;
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

function signature(value: unknown): Json {
  const item = asRecord(value, "admin signature");
  exactKeys(item, ["keyid", "sig"], "admin signature fields");
  const keyid = string(item.keyid, "admin key ID");
  const sig = string(item.sig, "admin signature", 8192);
  if (Buffer.from(sig, "base64").toString("base64") !== sig) fail("admin signature");
  return { keyid, sig };
}

function statementFor(binding: ResolvedCatalogBindingV1, signerIdentity: string): Json {
  return {
    _type: "https://in-toto.io/Statement/v1",
    predicate: {
      protocol: "AdminSeatDistributionV1",
      recordType: "ResolvedCatalogBindingV1",
      signerIdentity,
    },
    predicateType: "https://aih.dev/AdminSeatDistributionV1",
    subject: [
      {
        digest: { sha256: canonicalResolvedCatalogBindingV1Sha256(binding) },
        name: "aih/ResolvedCatalogBindingV1",
      },
    ],
  };
}

function envelopeFor(
  binding: ResolvedCatalogBindingV1,
  signerIdentity: string,
  signatures: readonly Json[],
): Json {
  const statement = canonicalStrictJsonBytesV1(statementFor(binding, signerIdentity));
  return {
    payload: statement.toString("base64"),
    payloadType: "application/vnd.in-toto+json",
    signatures: signatures.map((item) => ({ ...item })),
  };
}

function serializeBinding(binding: ResolvedCatalogBindingV1): Json {
  const bytes = canonicalResolvedCatalogBindingV1Bytes(binding);
  return {
    ...JSON.parse(bytes.toString("utf8")),
    resolvedCatalogBindingSha256: canonicalResolvedCatalogBindingV1Sha256(binding),
  };
}

function createDistribution(
  binding: ResolvedCatalogBindingV1,
  signerIdentity: string,
  signatures: readonly Json[],
): AdminSeatDistributionV1 {
  const envelope = envelopeFor(binding, signerIdentity, signatures);
  const serialized = {
    binding: serializeBinding(binding),
    envelope,
    protocol: "AdminSeatDistributionV1" as const,
  };
  const result = deepFreezeStrictJsonV1({
    binding,
    envelope,
    protocol: "AdminSeatDistributionV1" as const,
  }) as AdminSeatDistributionV1;
  distributions.add(result);
  distributionBytes.set(result, canonicalStrictJsonBytesV1(serialized));
  return result;
}

export function createAdminSeatDistributionV1(input: unknown): AdminSeatDistributionV1 {
  assertStrictJsonValueV1(input, "admin seat distribution");
  const value = asRecord(input, "admin seat distribution");
  exactKeys(value, ["binding", "signatures", "signerIdentity"], "admin seat distribution fields");
  const binding = value.binding as ResolvedCatalogBindingV1;
  canonicalResolvedCatalogBindingV1Bytes(binding);
  const signerIdentity = string(value.signerIdentity, "admin signer identity");
  if (!Array.isArray(value.signatures) || value.signatures.length !== 1) fail("admin signatures");
  return createDistribution(binding, signerIdentity, [signature(value.signatures[0])]);
}

export function canonicalAdminSeatDistributionV1Bytes(value: AdminSeatDistributionV1): Buffer {
  const bytes =
    typeof value === "object" && value !== null ? distributionBytes.get(value) : undefined;
  if (bytes === undefined) fail("admin distribution brand");
  return Buffer.from(bytes);
}

function parseEmbeddedBinding(value: unknown): ResolvedCatalogBindingV1 {
  const item = asRecord(value, "distribution binding");
  const supplied = digest(item.resolvedCatalogBindingSha256, "binding digest");
  const { resolvedCatalogBindingSha256: _digest, ...raw } = item;
  const binding = parseResolvedCatalogBindingV1Json(canonicalStrictJsonBytesV1(raw));
  if (canonicalResolvedCatalogBindingV1Sha256(binding) !== supplied) fail("binding digest");
  return binding;
}

export function parseAdminSeatDistributionV1Json(value: unknown): AdminSeatDistributionV1 {
  const text = decode(value, "admin distribution bytes");
  const bytes = Buffer.from(text, "utf8");
  const parsed = parseStrictJsonObjectV1(text, "admin distribution");
  exactKeys(parsed, ["binding", "envelope", "protocol"], "admin distribution fields");
  if (parsed.protocol !== "AdminSeatDistributionV1") fail("admin distribution protocol");
  const binding = parseEmbeddedBinding(parsed.binding);
  const envelope = asRecord(parsed.envelope, "admin envelope");
  exactKeys(envelope, ["payload", "payloadType", "signatures"], "admin envelope");
  if (
    envelope.payloadType !== "application/vnd.in-toto+json" ||
    !Array.isArray(envelope.signatures) ||
    envelope.signatures.length !== 1
  )
    fail("admin envelope");
  const signatures = envelope.signatures.map(signature);
  const payloadText = string(envelope.payload, "admin payload", 16384);
  const payload = Buffer.from(payloadText, "base64");
  if (payload.toString("base64") !== payloadText) fail("admin payload");
  const statement = parseStrictJsonObjectV1(
    new TextDecoder("utf-8", { fatal: true }).decode(payload),
    "admin statement",
  );
  exactKeys(
    statement,
    ["_type", "predicate", "predicateType", "subject"],
    "admin statement fields",
  );
  const predicate = asRecord(statement.predicate, "admin predicate");
  exactKeys(predicate, ["protocol", "recordType", "signerIdentity"], "admin predicate fields");
  const signerIdentity = string(predicate.signerIdentity, "admin signer identity");
  if (
    statement._type !== "https://in-toto.io/Statement/v1" ||
    statement.predicateType !== "https://aih.dev/AdminSeatDistributionV1" ||
    predicate.protocol !== "AdminSeatDistributionV1" ||
    predicate.recordType !== "ResolvedCatalogBindingV1"
  )
    fail("admin statement");
  if (!Array.isArray(statement.subject) || statement.subject.length !== 1) fail("admin subject");
  const subject = asRecord(statement.subject[0], "admin subject");
  exactKeys(subject, ["digest", "name"], "admin subject fields");
  const subjectDigest = asRecord(subject.digest, "admin subject digest");
  exactKeys(subjectDigest, ["sha256"], "admin subject digest fields");
  if (
    subject.name !== "aih/ResolvedCatalogBindingV1" ||
    digest(subjectDigest.sha256, "admin subject digest") !==
      canonicalResolvedCatalogBindingV1Sha256(binding)
  )
    fail("admin subject");
  if (canonicalStrictJsonBytesV1(statement).compare(payload) !== 0)
    fail("noncanonical admin statement");
  const result = createDistribution(binding, signerIdentity, signatures);
  if (canonicalAdminSeatDistributionV1Bytes(result).compare(bytes) !== 0)
    fail("noncanonical admin distribution");
  return result;
}

export function verifyAdminSeatDistributionV1(input: unknown): AdminSeatDistributionV1 {
  const value = asRecord(input, "admin seat verification");
  exactKeys(
    value,
    [
      "distribution",
      "expectedAdminSignerIdentity",
      "expectedAdminSignerRootSha256",
      "expectedHeadSignerRootSha256",
      "verifyCanonicalPae",
    ],
    "admin verification fields",
  );
  const distribution = value.distribution as AdminSeatDistributionV1;
  if (!distributions.has(distribution)) fail("admin distribution brand");
  const adminRoot = digest(value.expectedAdminSignerRootSha256, "admin root");
  const headRoot = digest(value.expectedHeadSignerRootSha256, "head root");
  const signerIdentity = string(value.expectedAdminSignerIdentity, "admin signer identity");
  if (
    adminRoot === headRoot ||
    distribution.binding.adminSignerRootSha256 !== adminRoot ||
    distribution.binding.headSignerRootSha256 !== headRoot
  )
    fail("admin roots");
  const envelope = distribution.envelope as Json;
  const payload = Buffer.from(string(envelope.payload, "admin payload", 16384), "base64");
  if (payload.toString("base64") !== envelope.payload) fail("admin payload");
  const statement = parseStrictJsonObjectV1(
    new TextDecoder("utf-8", { fatal: true }).decode(payload),
    "admin statement",
  );
  const predicate = asRecord(statement.predicate, "admin predicate");
  if (predicate.signerIdentity !== signerIdentity) fail("admin signer identity");
  const verify = value.verifyCanonicalPae;
  if (
    typeof verify !== "function" ||
    verify({
      paeBytes: pae(envelope.payloadType as string, payload),
      signatures: envelope.signatures,
      expectedAdminSignerRootSha256: adminRoot,
      expectedAdminSignerIdentity: signerIdentity,
    }) !== true
  )
    fail("admin signature");
  return distribution;
}
