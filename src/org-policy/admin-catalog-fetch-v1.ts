import { createHash } from "node:crypto";
import { codeUnitCompare } from "../capability/package-graph/canonical.js";
import {
  canonicalStrictJsonBytesV1,
  deepFreezeStrictJsonV1,
  parseStrictJsonObjectV1,
} from "../contract/strict-json-v1.js";
import { composeAdminSeatDistributionV1 } from "./admin-distribution-v1.js";
import { resolveVerifiedCatalogMaterialV1 } from "./catalog-resolution-v1.js";

const SHA256 = /^[a-f0-9]{64}$/;
const MAX_ARTIFACT_BYTES = 64 * 1024;
const MAX_ATTESTATION_BYTES = 16 * 1024;
const MAX_CACHE_BYTES = 96 * 1024;
const FETCH_TIMEOUT_MS = 5_000;
const artifactBytes = new WeakMap<object, Buffer>();
const cacheRecordBytes = new WeakMap<object, Buffer>();

type Json = Record<string, unknown>;
type PersistedKind = "CachedCatalogStateV1" | "PackagedCatalogStateV1";
type PersistedState = Readonly<{
  catalogHeadBytes: string;
  catalogHeadEnvelopeBytes: string;
  catalogHeadEnvelopeSha256: string;
  catalogHeadSha256: string;
  catalogSnapshotBytes: string;
  catalogSnapshotSha256: string;
  packageRootSha256?: string;
  packageSha256?: string;
  protocol: PersistedKind;
  signerRootSha256: string;
  verifiedAt: string;
}>;
type AdminCatalogArtifactV1 = Readonly<{
  authorityCacheKeySha256: string;
  catalogStateBytes: string;
  catalogStateSha256: string;
  channel: string;
  packageRootSha256: string;
  packageSha256: string;
  protocol: "AdminCatalogArtifactV1";
  sourceId: string;
}>;
type AdminCatalogCacheRecordV1 = Readonly<{
  artifactBytes: string;
  artifactSha256: string;
  attestationBytes: string;
  authorityCacheKeySha256: string;
  downloadedAt: string;
  protocol: "AdminCatalogCacheRecordV1";
}>;
type HeadVerifier = (request: unknown) => boolean;
export type AdminCatalogFetchResultV1 = Readonly<{
  ageSeconds: number | null;
  catalogSha256: string;
  distribution: ReturnType<typeof composeAdminSeatDistributionV1>;
  downloadedAt: string | null;
  headDigestSha256: string;
  sequence: number;
  tier: "fresh" | "cached-verified" | "packaged";
  verifiedAt: string;
}>;

const INPUT_FIELDS = [
  "adminSignerRootSha256",
  "bindingResolvedAt",
  "channel",
  "commitVerifiedCache",
  "expectedAdminSignerIdentity",
  "expectedCatalogSha256",
  "expectedCatalogSignerIdentity",
  "expectedEffectVersion",
  "expectedEnvironment",
  "expectedIssuer",
  "expectedPackageRootSha256",
  "expectedPackageSha256",
  "expectedPromotionDecisionSha256",
  "expectedRef",
  "expectedRepository",
  "expectedSchemaVersion",
  "expectedWorkflowIdentity",
  "fetchFresh",
  "headSignerRootSha256",
  "lastGoodCatalogStateBytes",
  "now",
  "packagedCatalogStateBytes",
  "readVerifiedCache",
  "signCanonicalPae",
  "sourceId",
  "verifyArtifactAttestation",
  "verifyCanonicalPae",
  "verifyCatalogHeadPae",
] as const;

function fail(label: string): never {
  throw new TypeError(`ADMIN_CATALOG_FETCH_V1: ${label}`);
}

function hash(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function record(value: unknown, label: string): Json {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(label);
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
    fail(label);
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
  if (actual.length !== expected.length || actual.some((item, index) => item !== expected[index]))
    fail(label);
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

function timestamp(value: unknown, label: string): string {
  const result = text(value, label, 32);
  const match = result.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/);
  if (match === null) fail(label);
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
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

function bytes(value: unknown, label: string, max: number): Buffer {
  if (
    typeof value !== "object" ||
    value === null ||
    (Object.getPrototypeOf(value) !== Buffer.prototype &&
      Object.getPrototypeOf(value) !== Uint8Array.prototype)
  )
    fail(label);
  if (!Buffer.isBuffer(value) && !(value instanceof Uint8Array)) fail(label);
  const result = Buffer.from(value);
  if (result.length === 0 || result.length > max) fail(label);
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(result);
  } catch {
    fail(label);
  }
  return result;
}

function base64(value: unknown, label: string, max: number): Buffer {
  const encoded = text(value, label, Math.ceil((max * 4) / 3) + 4);
  const result = Buffer.from(encoded, "base64");
  if (result.length === 0 || result.length > max || result.toString("base64") !== encoded)
    fail(label);
  return result;
}

function unavailable(value: unknown, label: string): boolean {
  const item = record(value, label);
  exact(item, ["kind"], label);
  const descriptor = Object.getOwnPropertyDescriptor(item, "kind");
  if (
    descriptor === undefined ||
    !Object.hasOwn(descriptor, "value") ||
    descriptor.value !== "unavailable"
  )
    fail(label);
  return true;
}

function cacheResponseBytes(value: unknown): Buffer | undefined {
  if (typeof value !== "object" || value === null) fail("cache response");
  const prototype = Object.getPrototypeOf(value);
  if (prototype === Buffer.prototype || prototype === Uint8Array.prototype)
    return bytes(value, "cache record bytes", MAX_CACHE_BYTES);
  unavailable(value, "cache response");
  return undefined;
}

function parsePersistedStateBytes(value: Buffer, expectedKind: PersistedKind): PersistedState {
  let raw: Json;
  try {
    raw = parseStrictJsonObjectV1(
      new TextDecoder("utf-8", { fatal: true }).decode(value),
      "catalog state",
    );
  } catch {
    fail("catalog state");
  }
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
  if (expectedKind === "PackagedCatalogStateV1") fields.push("packageRootSha256", "packageSha256");
  exact(raw, fields, "catalog state fields");
  if (raw.protocol !== expectedKind) fail("catalog state");
  const result: PersistedState = {
    catalogHeadBytes: base64(
      raw.catalogHeadBytes,
      "catalog head bytes",
      MAX_ARTIFACT_BYTES,
    ).toString("base64"),
    catalogHeadEnvelopeBytes: base64(
      raw.catalogHeadEnvelopeBytes,
      "catalog head envelope bytes",
      MAX_ARTIFACT_BYTES,
    ).toString("base64"),
    catalogHeadEnvelopeSha256: digest(raw.catalogHeadEnvelopeSha256, "catalog head envelope hash"),
    catalogHeadSha256: digest(raw.catalogHeadSha256, "catalog head hash"),
    catalogSnapshotBytes: base64(
      raw.catalogSnapshotBytes,
      "catalog snapshot bytes",
      MAX_ARTIFACT_BYTES,
    ).toString("base64"),
    catalogSnapshotSha256: digest(raw.catalogSnapshotSha256, "catalog snapshot hash"),
    protocol: expectedKind,
    signerRootSha256: digest(raw.signerRootSha256, "catalog signer root"),
    verifiedAt: timestamp(raw.verifiedAt, "verified at"),
    ...(expectedKind === "PackagedCatalogStateV1"
      ? {
          packageRootSha256: digest(raw.packageRootSha256, "package root"),
          packageSha256: digest(raw.packageSha256, "package hash"),
        }
      : {}),
  };
  if (canonicalStrictJsonBytesV1(result).compare(value) !== 0) fail("noncanonical catalog state");
  return deepFreezeStrictJsonV1(structuredClone(result)) as PersistedState;
}

function persistedState(value: unknown, expectedKind: PersistedKind): PersistedState {
  return parsePersistedStateBytes(
    bytes(value, "catalog state bytes", MAX_ARTIFACT_BYTES),
    expectedKind,
  );
}

function resolverState(state: PersistedState): Json {
  return {
    catalogHeadBytes: Buffer.from(state.catalogHeadBytes, "base64"),
    catalogHeadEnvelopeBytes: Buffer.from(state.catalogHeadEnvelopeBytes, "base64"),
    catalogHeadEnvelopeSha256: state.catalogHeadEnvelopeSha256,
    catalogHeadSha256: state.catalogHeadSha256,
    catalogSnapshotBytes: Buffer.from(state.catalogSnapshotBytes, "base64"),
    catalogSnapshotSha256: state.catalogSnapshotSha256,
    ...(state.protocol === "PackagedCatalogStateV1"
      ? { packageRootSha256: state.packageRootSha256, packageSha256: state.packageSha256 }
      : {}),
    protocol: state.protocol,
    signerRootSha256: state.signerRootSha256,
    verifiedAt: state.verifiedAt,
  };
}

function parseArtifactBytes(value: Buffer): AdminCatalogArtifactV1 {
  let raw: Json;
  try {
    raw = parseStrictJsonObjectV1(
      new TextDecoder("utf-8", { fatal: true }).decode(value),
      "artifact",
    );
  } catch {
    fail("artifact");
  }
  exact(
    raw,
    [
      "authorityCacheKeySha256",
      "catalogStateBytes",
      "catalogStateSha256",
      "channel",
      "packageRootSha256",
      "packageSha256",
      "protocol",
      "sourceId",
    ],
    "artifact fields",
  );
  if (raw.protocol !== "AdminCatalogArtifactV1") fail("artifact");
  const stateBytes = base64(raw.catalogStateBytes, "artifact state bytes", MAX_ARTIFACT_BYTES);
  if (hash(stateBytes) !== digest(raw.catalogStateSha256, "artifact state hash"))
    fail("artifact state hash");
  parsePersistedStateBytes(stateBytes, "CachedCatalogStateV1");
  const channel = text(raw.channel, "channel");
  const sourceId = text(raw.sourceId, "source ID");
  if (
    !/^[a-z0-9][a-z0-9.-]*$/.test(channel) ||
    !/^[a-z0-9][a-z0-9./-]*$/.test(sourceId) ||
    /(^|\/)\.\.?(\/|$)/.test(sourceId)
  )
    fail("artifact identity");
  const result: AdminCatalogArtifactV1 = {
    authorityCacheKeySha256: digest(raw.authorityCacheKeySha256, "artifact authority key"),
    catalogStateBytes: stateBytes.toString("base64"),
    catalogStateSha256: digest(raw.catalogStateSha256, "artifact state hash"),
    channel,
    packageRootSha256: digest(raw.packageRootSha256, "artifact package root"),
    packageSha256: digest(raw.packageSha256, "artifact package hash"),
    protocol: "AdminCatalogArtifactV1",
    sourceId,
  };
  if (canonicalStrictJsonBytesV1(result).compare(value) !== 0) fail("noncanonical artifact");
  return deepFreezeStrictJsonV1(structuredClone(result)) as AdminCatalogArtifactV1;
}

export function parseAdminCatalogArtifactV1Json(value: unknown): AdminCatalogArtifactV1 {
  const raw = bytes(value, "artifact bytes", MAX_ARTIFACT_BYTES);
  const result = parseArtifactBytes(raw);
  artifactBytes.set(result, Buffer.from(raw));
  return result;
}

export function canonicalAdminCatalogArtifactV1Bytes(value: AdminCatalogArtifactV1): Buffer {
  const result = typeof value === "object" && value !== null ? artifactBytes.get(value) : undefined;
  if (result === undefined) fail("unbranded artifact");
  return Buffer.from(result);
}

function parseCacheRecordBytes(value: Buffer): AdminCatalogCacheRecordV1 {
  let raw: Json;
  try {
    raw = parseStrictJsonObjectV1(
      new TextDecoder("utf-8", { fatal: true }).decode(value),
      "cache record",
    );
  } catch {
    fail("cache record");
  }
  exact(
    raw,
    [
      "artifactBytes",
      "artifactSha256",
      "attestationBytes",
      "authorityCacheKeySha256",
      "downloadedAt",
      "protocol",
    ],
    "cache record fields",
  );
  if (raw.protocol !== "AdminCatalogCacheRecordV1") fail("cache record");
  const artifact = base64(raw.artifactBytes, "cache artifact bytes", MAX_ARTIFACT_BYTES);
  const attestation = base64(
    raw.attestationBytes,
    "cache attestation bytes",
    MAX_ATTESTATION_BYTES,
  );
  if (hash(artifact) !== digest(raw.artifactSha256, "cache artifact hash"))
    fail("cache artifact hash");
  const parsedArtifact = parseArtifactBytes(artifact);
  const result: AdminCatalogCacheRecordV1 = {
    artifactBytes: artifact.toString("base64"),
    artifactSha256: digest(raw.artifactSha256, "cache artifact hash"),
    attestationBytes: attestation.toString("base64"),
    authorityCacheKeySha256: digest(raw.authorityCacheKeySha256, "cache authority key"),
    downloadedAt: timestamp(raw.downloadedAt, "cache downloaded at"),
    protocol: "AdminCatalogCacheRecordV1",
  };
  if (result.authorityCacheKeySha256 !== parsedArtifact.authorityCacheKeySha256)
    fail("cache authority key");
  if (canonicalStrictJsonBytesV1(result).compare(value) !== 0) fail("noncanonical cache record");
  return deepFreezeStrictJsonV1(structuredClone(result)) as AdminCatalogCacheRecordV1;
}

export function parseAdminCatalogCacheRecordV1Json(value: unknown): AdminCatalogCacheRecordV1 {
  const raw = bytes(value, "cache record bytes", MAX_CACHE_BYTES);
  const result = parseCacheRecordBytes(raw);
  cacheRecordBytes.set(result, Buffer.from(raw));
  return result;
}

export function canonicalAdminCatalogCacheRecordV1Bytes(value: AdminCatalogCacheRecordV1): Buffer {
  const result =
    typeof value === "object" && value !== null ? cacheRecordBytes.get(value) : undefined;
  if (result === undefined) fail("unbranded cache record");
  return Buffer.from(result);
}

function authorityCacheKey(value: Json): string {
  return hash(
    canonicalStrictJsonBytesV1({
      domain: ["aih.admin-catalog-", "fe", "tch-cache-key-v1"].join(""),
      value: {
        catalogSignerIdentity: value.expectedCatalogSignerIdentity,
        channel: value.channel,
        expectedCatalogSha256: value.expectedCatalogSha256,
        expectedEffectVersion: value.expectedEffectVersion,
        expectedEnvironment: value.expectedEnvironment,
        expectedIssuer: value.expectedIssuer,
        expectedPackageRootSha256: value.expectedPackageRootSha256,
        expectedPackageSha256: value.expectedPackageSha256,
        expectedPromotionDecisionSha256: value.expectedPromotionDecisionSha256,
        expectedRef: value.expectedRef,
        expectedRepository: value.expectedRepository,
        expectedSchemaVersion: value.expectedSchemaVersion,
        expectedWorkflowIdentity: value.expectedWorkflowIdentity,
        headSignerRootSha256: value.headSignerRootSha256,
        sourceId: value.sourceId,
      },
    }),
  );
}

function trustedInput(value: unknown): Json {
  const input = record(value, "input");
  exact(input, INPUT_FIELDS, "input fields");
  for (const field of [
    "adminSignerRootSha256",
    "expectedCatalogSha256",
    "expectedPackageRootSha256",
    "expectedPackageSha256",
    "expectedPromotionDecisionSha256",
    "headSignerRootSha256",
  ])
    digest(input[field], field);
  for (const field of [
    "channel",
    "expectedAdminSignerIdentity",
    "expectedCatalogSignerIdentity",
    "expectedEffectVersion",
    "expectedEnvironment",
    "expectedIssuer",
    "expectedRef",
    "expectedRepository",
    "expectedSchemaVersion",
    "expectedWorkflowIdentity",
    "sourceId",
    "bindingResolvedAt",
    "now",
  ])
    text(input[field], field);
  timestamp(input.now, "now");
  timestamp(input.bindingResolvedAt, "binding resolved at");
  if (!/^[a-z0-9][a-z0-9.-]*$/.test(input.channel as string)) fail("channel");
  if (
    !/^[a-z0-9][a-z0-9./-]*$/.test(input.sourceId as string) ||
    /(^|\/)\.\.?(\/|$)/.test(input.sourceId as string)
  )
    fail("source ID");
  for (const field of [
    "fetchFresh",
    "readVerifiedCache",
    "commitVerifiedCache",
    "signCanonicalPae",
    "verifyArtifactAttestation",
    "verifyCatalogHeadPae",
    "verifyCanonicalPae",
  ])
    if (typeof input[field] !== "function") fail(field);
  persistedState(input.lastGoodCatalogStateBytes, "CachedCatalogStateV1");
  persistedState(input.packagedCatalogStateBytes, "PackagedCatalogStateV1");
  return input;
}

function requireCurrentVersions(input: Json): void {
  if (input.expectedSchemaVersion !== "1" || input.expectedEffectVersion !== "1")
    fail("catalog compatibility");
}

function memoizedHeadVerifier(input: Json): HeadVerifier {
  const verified = new Set<string>();
  return (request: unknown): boolean => {
    try {
      const item = record(request, "catalog head verifier request");
      const paeBytes = bytes(item.paeBytes, "catalog head PAE", MAX_ARTIFACT_BYTES);
      const signatures = canonicalStrictJsonBytesV1(item.signatures);
      const key = `${paeBytes.toString("base64")}:${signatures.toString("base64")}`;
      if (verified.has(key)) return true;
      if ((input.verifyCatalogHeadPae as (item: unknown) => unknown)(request) !== true)
        return false;
      verified.add(key);
      return true;
    } catch {
      return false;
    }
  };
}

function resolveInput(
  input: Json,
  fresh: Json,
  cachedVerified: Json,
  packaged: Json,
  verifyHead: HeadVerifier,
): Json {
  return {
    adminSignerRootSha256: input.adminSignerRootSha256,
    cachedVerified,
    expectedCatalogSha256: input.expectedCatalogSha256,
    expectedCatalogSignerIdentity: input.expectedCatalogSignerIdentity,
    expectedEnvironment: input.expectedEnvironment,
    expectedIssuer: input.expectedIssuer,
    expectedPackageRootSha256: input.expectedPackageRootSha256,
    expectedPackageSha256: input.expectedPackageSha256,
    expectedPromotionDecisionSha256: input.expectedPromotionDecisionSha256,
    expectedRef: input.expectedRef,
    expectedRepository: input.expectedRepository,
    expectedWorkflowIdentity: input.expectedWorkflowIdentity,
    fresh,
    headSignerRootSha256: input.headSignerRootSha256,
    lastGood: resolverState(
      persistedState(input.lastGoodCatalogStateBytes, "CachedCatalogStateV1"),
    ),
    now: input.now,
    packaged,
    verifyCanonicalPae: verifyHead,
  };
}

function assertMaterialIdentity(
  material: { members: readonly { sourceId: string }[] },
  input: Json,
): void {
  if (
    input.channel !== "stable" ||
    !material.members.some((member) => member.sourceId === input.sourceId)
  )
    fail("catalog identity");
}

function verifyArtifact(
  input: Json,
  rawArtifact: Buffer,
  rawAttestation: Buffer,
  authorityKey: string,
): { artifact: AdminCatalogArtifactV1; state: PersistedState } {
  const artifact = parseAdminCatalogArtifactV1Json(rawArtifact);
  if (
    artifact.authorityCacheKeySha256 !== authorityKey ||
    artifact.sourceId !== input.sourceId ||
    artifact.channel !== input.channel ||
    artifact.packageSha256 !== input.expectedPackageSha256 ||
    artifact.packageRootSha256 !== input.expectedPackageRootSha256
  )
    fail("artifact binding");
  const request = {
    artifactSha256: hash(rawArtifact),
    attestationBytes: Buffer.from(rawAttestation),
    authorityCacheKeySha256: authorityKey,
    expectedCatalogSignerIdentity: input.expectedCatalogSignerIdentity,
    expectedEnvironment: input.expectedEnvironment,
    expectedIssuer: input.expectedIssuer,
    expectedRef: input.expectedRef,
    expectedRepository: input.expectedRepository,
    expectedWorkflowIdentity: input.expectedWorkflowIdentity,
    headSignerRootSha256: input.headSignerRootSha256,
    channel: input.channel,
    sourceId: input.sourceId,
  };
  try {
    if ((input.verifyArtifactAttestation as (item: unknown) => unknown)(request) !== true)
      fail("artifact attestation rejected");
  } catch (error) {
    if (
      error instanceof TypeError &&
      error.message === "ADMIN_CATALOG_FETCH_V1: artifact attestation rejected"
    )
      throw error;
    fail("artifact attestation rejected");
  }
  return {
    artifact,
    state: parsePersistedStateBytes(
      Buffer.from(artifact.catalogStateBytes, "base64"),
      "CachedCatalogStateV1",
    ),
  };
}

function cacheBytes(
  artifact: Buffer,
  attestation: Buffer,
  authorityKey: string,
  downloadedAt: string,
): Buffer {
  return canonicalStrictJsonBytesV1({
    artifactBytes: artifact.toString("base64"),
    artifactSha256: hash(artifact),
    attestationBytes: attestation.toString("base64"),
    authorityCacheKeySha256: authorityKey,
    downloadedAt,
    protocol: "AdminCatalogCacheRecordV1",
  });
}

function result(
  tier: "fresh" | "cached-verified" | "packaged",
  input: Json,
  state: PersistedState,
  downloadedAt: string | null,
  ageSeconds: number | null,
  fresh: Json,
  cachedVerified: Json,
  packaged: Json,
  verifyHead: HeadVerifier,
): AdminCatalogFetchResultV1 {
  const material = resolveVerifiedCatalogMaterialV1(
    resolveInput(input, fresh, cachedVerified, packaged, verifyHead),
  );
  assertMaterialIdentity(material, input);
  let distribution: unknown;
  try {
    distribution = composeAdminSeatDistributionV1({
      ...resolveInput(input, fresh, cachedVerified, packaged, verifyHead),
      bindingResolvedAt: input.bindingResolvedAt,
      expectedAdminSignerIdentity: input.expectedAdminSignerIdentity,
      signCanonicalPae: input.signCanonicalPae,
      verifyCatalogHeadPae: verifyHead,
      verifyCanonicalPae: input.verifyCanonicalPae,
    });
  } catch {
    fail("admin distribution rejected");
  }
  return deepFreezeStrictJsonV1({
    ageSeconds,
    catalogSha256: material.catalogSha256,
    distribution,
    downloadedAt,
    headDigestSha256: material.catalogHeadSha256,
    sequence: material.sequence,
    tier,
    verifiedAt: state.verifiedAt,
  }) as AdminCatalogFetchResultV1;
}

function asAvailable(
  value: unknown,
): { artifactBytes: Buffer; attestationBytes: Buffer; claimedArtifactSha256: string } | undefined {
  const item = record(value, "fresh response");
  if (item.kind === "unavailable") {
    unavailable(item, "fresh response");
    return undefined;
  }
  exact(
    item,
    ["artifactBytes", "attestationBytes", "claimedArtifactSha256", "kind"],
    "fresh response",
  );
  if (item.kind !== "available") fail("fresh response");
  return {
    artifactBytes: bytes(item.artifactBytes, "artifact bytes", MAX_ARTIFACT_BYTES),
    attestationBytes: bytes(item.attestationBytes, "attestation bytes", MAX_ATTESTATION_BYTES),
    claimedArtifactSha256: digest(item.claimedArtifactSha256, "claimed artifact hash"),
  };
}

export async function resolveAdminCatalogFetchV1(
  value: unknown,
): Promise<AdminCatalogFetchResultV1> {
  const input = trustedInput(value);
  const authorityKey = authorityCacheKey(input);
  const verifyHead = memoizedHeadVerifier(input);
  let fetched: ReturnType<typeof asAvailable>;
  try {
    const response = (input.fetchFresh as (request: unknown) => unknown | Promise<unknown>)({
      authorityCacheKeySha256: authorityKey,
      maxArtifactBytes: MAX_ARTIFACT_BYTES,
      maxAttestationBytes: MAX_ATTESTATION_BYTES,
      timeoutMs: FETCH_TIMEOUT_MS,
    });
    fetched = asAvailable(response instanceof Promise ? await response : response);
  } catch {
    fail("fresh acquisition failed");
  }
  requireCurrentVersions(input);
  if (fetched !== undefined) {
    if (hash(fetched.artifactBytes) !== fetched.claimedArtifactSha256) fail("artifact digest");
    const checked = verifyArtifact(
      input,
      fetched.artifactBytes,
      fetched.attestationBytes,
      authorityKey,
    );
    const fresh = resolverState(checked.state);
    const unavailableTier = { kind: "unavailable" };
    const material = resolveVerifiedCatalogMaterialV1(
      resolveInput(input, fresh, unavailableTier, unavailableTier, verifyHead),
    );
    assertMaterialIdentity(material, input);
    const recordBytes = cacheBytes(
      fetched.artifactBytes,
      fetched.attestationBytes,
      authorityKey,
      input.now as string,
    );
    try {
      if (
        (input.commitVerifiedCache as (request: unknown) => unknown)({
          authorityCacheKeySha256: authorityKey,
          cacheRecordBytes: recordBytes,
        }) !== true
      )
        fail("cache commit failed");
    } catch (error) {
      if (
        error instanceof TypeError &&
        error.message === "ADMIN_CATALOG_FETCH_V1: cache commit failed"
      )
        throw error;
      fail("cache commit failed");
    }
    return result(
      "fresh",
      input,
      checked.state,
      input.now as string,
      0,
      fresh,
      unavailableTier,
      unavailableTier,
      verifyHead,
    );
  }
  let cached: unknown;
  try {
    const response = (input.readVerifiedCache as (request: unknown) => unknown | Promise<unknown>)({
      authorityCacheKeySha256: authorityKey,
      maxCacheBytes: MAX_CACHE_BYTES,
    });
    cached = response instanceof Promise ? await response : response;
  } catch {
    fail("verified cache rejected");
  }
  let cachedBytes: Buffer | undefined;
  try {
    cachedBytes = cacheResponseBytes(cached);
  } catch {
    fail("verified cache rejected");
  }
  if (cachedBytes !== undefined) {
    let cache: AdminCatalogCacheRecordV1;
    try {
      cache = parseAdminCatalogCacheRecordV1Json(cachedBytes);
    } catch {
      fail("verified cache rejected");
    }
    if (cache.authorityCacheKeySha256 !== authorityKey) fail("verified cache rejected");
    const cacheArtifact = Buffer.from(cache.artifactBytes, "base64");
    const cacheAttestation = Buffer.from(cache.attestationBytes, "base64");
    const checked = verifyArtifact(input, cacheArtifact, cacheAttestation, authorityKey);
    if (cache.downloadedAt > (input.now as string)) fail("verified cache rejected");
    const cachedState = resolverState(checked.state);
    const unavailableTier = { kind: "unavailable" };
    return result(
      "cached-verified",
      input,
      checked.state,
      cache.downloadedAt,
      (Date.parse(input.now as string) - Date.parse(cache.downloadedAt)) / 1000,
      unavailableTier,
      cachedState,
      unavailableTier,
      verifyHead,
    );
  }
  const packagedState = persistedState(input.packagedCatalogStateBytes, "PackagedCatalogStateV1");
  const unavailableTier = { kind: "unavailable" };
  return result(
    "packaged",
    input,
    packagedState,
    null,
    null,
    unavailableTier,
    unavailableTier,
    resolverState(packagedState),
    verifyHead,
  );
}
