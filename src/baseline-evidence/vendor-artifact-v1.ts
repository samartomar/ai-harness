import { createHash } from "node:crypto";
import { codeUnitCompare } from "../capability/package-graph/canonical.js";
import { canonicalStrictJsonBytesV1, parseStrictJsonObjectV1 } from "../contract/strict-json-v1.js";
import { type EvidenceBundle, EvidenceBundleSchema } from "../evidence/manifest.js";
import {
  BASELINE_EVIDENCE_SCHEMA_VERSION,
  type BaselineEvidenceLock,
  parseBaselineEvidenceLock,
} from "./schema.js";

export const BASELINE_EVIDENCE_ARTIFACT_FILE_V1 = "artifact.json";
export const BASELINE_EVIDENCE_ARTIFACT_LOCK_PATH_V1 = ".aih/baseline-reports/vendor-lock.json";
export const BASELINE_EVIDENCE_ARTIFACT_SUMS_PATH_V1 = "SHA256SUMS";

const ARTIFACT_PROTOCOL = "VendorBaselineEvidenceArtifactV1";
const ARTIFACT_SCHEMA_VERSION = 1;
const MANIFEST_PATH = "manifest.json";
const EVIDENCE_PATH = "evidence.json";
const SHA256 = /^[a-f0-9]{64}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const WORKFLOW =
  /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/.github\/workflows\/[A-Za-z0-9][A-Za-z0-9._-]*\.ya?ml$/;
const REF = /^refs\/(?:heads|tags)\/[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const ISSUER = /^https:\/\/[A-Za-z0-9][A-Za-z0-9.-]*(?:\/[A-Za-z0-9._~!$&'()*+,;=:@%-]+)*$/;

export interface VendorBaselineEvidenceArtifactFileV1 {
  readonly path: string;
  readonly bytes: Buffer;
}

export interface VendorBaselineEvidenceArtifactV1 {
  readonly files: readonly VendorBaselineEvidenceArtifactFileV1[];
  readonly subject: {
    readonly bytes: Buffer;
    readonly path: typeof BASELINE_EVIDENCE_ARTIFACT_SUMS_PATH_V1;
    readonly sha256: string;
  };
}

export interface BaselineEvidenceArtifactPublisherV1 {
  readonly environment: string;
  readonly repository: string;
}

export interface BaselineEvidenceArtifactSourceV1 {
  readonly id: string;
  readonly owner: string;
  readonly pinnedSha: string;
  readonly repo: string;
}

export interface BaselineEvidenceArtifactAttestationPolicyV1
  extends BaselineEvidenceArtifactPublisherV1 {
  readonly issuer: string;
  readonly ref: string;
  readonly workflow: string;
}

export interface VerifiedBaselineEvidenceArtifactAttestationV1
  extends BaselineEvidenceArtifactAttestationPolicyV1 {
  readonly subjectSha256: string;
  readonly verified: true;
}

export interface VerifyVendorBaselineEvidenceArtifactV1Input {
  readonly artifact: VendorBaselineEvidenceArtifactV1;
  readonly policy: BaselineEvidenceArtifactAttestationPolicyV1 & {
    readonly sources: readonly BaselineEvidenceArtifactSourceV1[];
  };
  /**
   * The caller owns cryptographic verification (for example, exact GitHub
   * provenance verification) and returns only its verified claim. This module
   * then binds that claim to the deterministic subject and artifact identity.
   */
  readonly verifyGithubAttestation: (request: {
    readonly policy: BaselineEvidenceArtifactAttestationPolicyV1;
    readonly subjectBytes: Buffer;
    readonly subjectSha256: string;
  }) => VerifiedBaselineEvidenceArtifactAttestationV1;
}

interface ArtifactMetadataV1 {
  readonly environment: string;
  readonly lock: {
    readonly path: string;
    readonly schemaVersion: number;
    readonly sha256: string;
  };
  readonly protocol: typeof ARTIFACT_PROTOCOL;
  readonly publisherRepository: string;
  readonly schemaVersion: typeof ARTIFACT_SCHEMA_VERSION;
  readonly sources: readonly BaselineEvidenceArtifactSourceV1[];
}

function fail(label: string): never {
  throw new TypeError(`BASELINE_EVIDENCE_ARTIFACT_V1: ${label}`);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function text(value: unknown, label: string, max = 512): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) fail(label);
  return value;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    fail(label);
  }
}

function sha(value: unknown, label: string): string {
  const result = text(value, label, 64);
  if (!SHA256.test(result)) fail(label);
  return result;
}

function source(value: unknown, label: string): BaselineEvidenceArtifactSourceV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(label);
  const record = value as Record<string, unknown>;
  exactKeys(record, ["id", "owner", "pinnedSha", "repo"], label);
  const id = text(record.id, label, 128);
  const owner = text(record.owner, label, 128);
  const repo = text(record.repo, label, 128);
  const pinnedSha = text(record.pinnedSha, label, 40);
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(id)) fail(label);
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) fail(label);
  if (!/^[a-f0-9]{40}$/.test(pinnedSha)) fail(label);
  return { id, owner, pinnedSha, repo };
}

function sourceKey(value: BaselineEvidenceArtifactSourceV1): string {
  return `${value.id}\u0000${value.owner}\u0000${value.repo}\u0000${value.pinnedSha}`;
}

function sourcesFromLock(lock: BaselineEvidenceLock): readonly BaselineEvidenceArtifactSourceV1[] {
  return lock.sources
    .map(({ id, owner, pinnedSha, repo }) => ({ id, owner, pinnedSha, repo }))
    .sort((left, right) => codeUnitCompare(sourceKey(left), sourceKey(right)));
}

function canonicalLock(lockBytes: Buffer): BaselineEvidenceLock {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(lockBytes));
  } catch {
    fail("lock bytes");
  }
  const lock = parseBaselineEvidenceLock(parsed);
  if (lock.schemaVersion !== BASELINE_EVIDENCE_SCHEMA_VERSION) fail("lock schema");
  const canonical = Buffer.from(`${JSON.stringify(lock, null, 2)}\n`, "utf8");
  if (canonical.compare(lockBytes) !== 0) fail("noncanonical lock bytes");
  return lock;
}

function metadata(
  lockBytes: Buffer,
  lock: BaselineEvidenceLock,
  publisher: BaselineEvidenceArtifactPublisherV1,
): ArtifactMetadataV1 {
  const repository = text(publisher.repository, "publisher repository", 256);
  const environment = text(publisher.environment, "environment", 128);
  if (!REPOSITORY.test(repository) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(environment)) {
    fail("publisher identity");
  }
  return {
    environment,
    lock: {
      path: BASELINE_EVIDENCE_ARTIFACT_LOCK_PATH_V1,
      schemaVersion: lock.schemaVersion,
      sha256: sha256(lockBytes),
    },
    protocol: ARTIFACT_PROTOCOL,
    publisherRepository: repository,
    schemaVersion: ARTIFACT_SCHEMA_VERSION,
    sources: sourcesFromLock(lock),
  };
}

function canonical(value: unknown): Buffer {
  return canonicalStrictJsonBytesV1(value);
}

function sums(files: readonly VendorBaselineEvidenceArtifactFileV1[]): Buffer {
  return Buffer.from(
    `${files
      .slice()
      .sort((left, right) => codeUnitCompare(left.path, right.path))
      .map((file) => `${sha256(file.bytes)}  ${file.path}`)
      .join("\n")}\n`,
    "utf8",
  );
}

/** Builds bytes only; it has no signing, process, network, or candidate-code path. */
export function buildVendorBaselineEvidenceArtifactV1(input: {
  readonly lockBytes: Buffer;
  readonly publisher: BaselineEvidenceArtifactPublisherV1;
}): VendorBaselineEvidenceArtifactV1 {
  if (!Buffer.isBuffer(input.lockBytes) || input.lockBytes.length === 0) fail("lock bytes");
  const lockBytes = Buffer.from(input.lockBytes);
  const lock = canonicalLock(lockBytes);
  const artifactBytes = canonical(metadata(lockBytes, lock, input.publisher));
  const manifestBytes = canonical({
    files: [
      {
        bytes: artifactBytes.length,
        path: BASELINE_EVIDENCE_ARTIFACT_FILE_V1,
        sha256: sha256(artifactBytes),
      },
      {
        bytes: lockBytes.length,
        path: BASELINE_EVIDENCE_ARTIFACT_LOCK_PATH_V1,
        sha256: sha256(lockBytes),
      },
    ],
    schemaVersion: 1,
  });
  const evidence: EvidenceBundle = {
    artifacts: [
      {
        kind: "baseline-evidence",
        path: BASELINE_EVIDENCE_ARTIFACT_LOCK_PATH_V1,
        schemaVersion: lock.schemaVersion,
        sha256: sha256(lockBytes),
      },
    ],
    schemaVersion: 1,
  };
  const evidenceBytes = canonical(evidence);
  const checked = [
    { bytes: artifactBytes, path: BASELINE_EVIDENCE_ARTIFACT_FILE_V1 },
    { bytes: evidenceBytes, path: EVIDENCE_PATH },
    { bytes: lockBytes, path: `files/${BASELINE_EVIDENCE_ARTIFACT_LOCK_PATH_V1}` },
    { bytes: manifestBytes, path: MANIFEST_PATH },
  ] as const;
  const subjectBytes = sums(checked);
  const files = [
    ...checked,
    { bytes: subjectBytes, path: BASELINE_EVIDENCE_ARTIFACT_SUMS_PATH_V1 },
  ];
  return {
    files: files.map((file) => ({ bytes: Buffer.from(file.bytes), path: file.path })),
    subject: {
      bytes: Buffer.from(subjectBytes),
      path: BASELINE_EVIDENCE_ARTIFACT_SUMS_PATH_V1,
      sha256: sha256(subjectBytes),
    },
  };
}

function artifactFiles(value: VendorBaselineEvidenceArtifactV1): Map<string, Buffer> {
  if (typeof value !== "object" || value === null || !Array.isArray(value.files)) fail("artifact");
  const files = new Map<string, Buffer>();
  for (const file of value.files) {
    if (typeof file !== "object" || file === null) fail("artifact file");
    const path = text((file as { path?: unknown }).path, "artifact path", 256);
    const bytes = (file as { bytes?: unknown }).bytes;
    if (
      !Buffer.isBuffer(bytes) ||
      path.includes("\\") ||
      path.startsWith("/") ||
      path.split("/").some((part) => part === "" || part === "." || part === "..")
    )
      fail("artifact file");
    if (files.has(path)) fail("duplicate artifact path");
    files.set(path, Buffer.from(bytes));
  }
  const expected = [
    BASELINE_EVIDENCE_ARTIFACT_FILE_V1,
    EVIDENCE_PATH,
    `files/${BASELINE_EVIDENCE_ARTIFACT_LOCK_PATH_V1}`,
    MANIFEST_PATH,
    BASELINE_EVIDENCE_ARTIFACT_SUMS_PATH_V1,
  ];
  if (files.size !== expected.length || expected.some((path) => !files.has(path)))
    fail("artifact layout");
  return files;
}

function parseMetadata(bytes: Buffer): ArtifactMetadataV1 {
  let record: Record<string, unknown>;
  try {
    record = parseStrictJsonObjectV1(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      "artifact",
    );
  } catch {
    fail("artifact metadata");
  }
  exactKeys(
    record,
    ["environment", "lock", "protocol", "publisherRepository", "schemaVersion", "sources"],
    "artifact metadata",
  );
  if (record.protocol !== ARTIFACT_PROTOCOL || record.schemaVersion !== ARTIFACT_SCHEMA_VERSION)
    fail("artifact metadata");
  const publisherRepository = text(record.publisherRepository, "publisher repository", 256);
  const environment = text(record.environment, "environment", 128);
  if (!REPOSITORY.test(publisherRepository) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(environment))
    fail("artifact metadata");
  if (typeof record.lock !== "object" || record.lock === null || Array.isArray(record.lock))
    fail("artifact metadata");
  const lock = record.lock as Record<string, unknown>;
  exactKeys(lock, ["path", "schemaVersion", "sha256"], "artifact lock");
  if (
    lock.path !== BASELINE_EVIDENCE_ARTIFACT_LOCK_PATH_V1 ||
    lock.schemaVersion !== BASELINE_EVIDENCE_SCHEMA_VERSION
  )
    fail("artifact lock");
  const sources = Array.isArray(record.sources)
    ? record.sources.map((item) => source(item, "artifact source"))
    : fail("artifact sources");
  if (sources.length === 0 || new Set(sources.map(sourceKey)).size !== sources.length)
    fail("artifact sources");
  const result: ArtifactMetadataV1 = {
    environment,
    lock: {
      path: BASELINE_EVIDENCE_ARTIFACT_LOCK_PATH_V1,
      schemaVersion: BASELINE_EVIDENCE_SCHEMA_VERSION,
      sha256: sha(lock.sha256, "artifact lock"),
    },
    protocol: ARTIFACT_PROTOCOL,
    publisherRepository,
    schemaVersion: ARTIFACT_SCHEMA_VERSION,
    sources,
  };
  if (canonical(result).compare(bytes) !== 0) fail("noncanonical artifact metadata");
  return result;
}

function verifySums(files: Map<string, Buffer>): void {
  const raw = files.get(BASELINE_EVIDENCE_ARTIFACT_SUMS_PATH_V1);
  if (raw === undefined) fail("checksum subject");
  const lines = raw.toString("utf8").split("\n");
  if (lines.at(-1) !== "") fail("checksum subject");
  const expectedPaths = [...files.keys()]
    .filter((path) => path !== BASELINE_EVIDENCE_ARTIFACT_SUMS_PATH_V1)
    .sort();
  const seen = new Set<string>();
  if (lines.length !== expectedPaths.length + 1) fail("checksum subject");
  for (const [index, path] of expectedPaths.entries()) {
    const match = /^([a-f0-9]{64}) {2}(.+)$/.exec(lines[index] ?? "");
    if (match?.[1] === undefined || match[2] !== path || seen.has(path)) fail("checksum subject");
    seen.add(path);
    const bytes = files.get(path);
    if (bytes === undefined || sha256(bytes) !== match[1]) fail("checksum mismatch");
  }
}

function verifyManifest(
  files: Map<string, Buffer>,
  lockBytes: Buffer,
  artifactBytes: Buffer,
): void {
  const raw = files.get(MANIFEST_PATH);
  if (raw === undefined) fail("manifest");
  let manifest: Record<string, unknown>;
  try {
    manifest = parseStrictJsonObjectV1(
      new TextDecoder("utf-8", { fatal: true }).decode(raw),
      "manifest",
    );
  } catch {
    fail("manifest");
  }
  const expected = {
    files: [
      {
        bytes: artifactBytes.length,
        path: BASELINE_EVIDENCE_ARTIFACT_FILE_V1,
        sha256: sha256(artifactBytes),
      },
      {
        bytes: lockBytes.length,
        path: BASELINE_EVIDENCE_ARTIFACT_LOCK_PATH_V1,
        sha256: sha256(lockBytes),
      },
    ],
    schemaVersion: 1,
  };
  if (
    canonical(manifest).compare(canonical(expected)) !== 0 ||
    canonical(manifest).compare(raw) !== 0
  )
    fail("manifest");
}

function verifyEvidenceIndex(files: Map<string, Buffer>, lockBytes: Buffer): void {
  const raw = files.get(EVIDENCE_PATH);
  if (raw === undefined) fail("evidence index");
  let index: EvidenceBundle;
  try {
    index = EvidenceBundleSchema.parse(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)),
    );
  } catch {
    fail("evidence index");
  }
  const expected: EvidenceBundle = {
    artifacts: [
      {
        kind: "baseline-evidence",
        path: BASELINE_EVIDENCE_ARTIFACT_LOCK_PATH_V1,
        schemaVersion: BASELINE_EVIDENCE_SCHEMA_VERSION,
        sha256: sha256(lockBytes),
      },
    ],
    schemaVersion: 1,
  };
  if (canonical(index).compare(canonical(expected)) !== 0 || canonical(index).compare(raw) !== 0)
    fail("evidence index");
}

function validatePolicy(policy: VerifyVendorBaselineEvidenceArtifactV1Input["policy"]): void {
  if (
    !REPOSITORY.test(policy.repository) ||
    !WORKFLOW.test(policy.workflow) ||
    !ISSUER.test(policy.issuer) ||
    !REF.test(policy.ref) ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(policy.environment)
  )
    fail("attestation policy");
  if (!policy.workflow.startsWith(`${policy.repository}/.github/workflows/`))
    fail("attestation policy");
  if (!Array.isArray(policy.sources) || policy.sources.length === 0) fail("source policy");
  const sources = policy.sources.map((item) => source(item, "source policy"));
  if (new Set(sources.map(sourceKey)).size !== sources.length) fail("source policy");
}

function samePolicy(
  left: BaselineEvidenceArtifactAttestationPolicyV1,
  right: BaselineEvidenceArtifactAttestationPolicyV1,
): boolean {
  return (
    left.environment === right.environment &&
    left.issuer === right.issuer &&
    left.ref === right.ref &&
    left.repository === right.repository &&
    left.workflow === right.workflow
  );
}

/**
 * Verifies only a complete downloaded subject. Callers supply their own exact
 * repository/workflow/issuer/ref/environment policy and cryptographic claim;
 * this boundary never chooses a locator, cache, signing key, or analyzer.
 */
export function verifyVendorBaselineEvidenceArtifactV1(
  input: VerifyVendorBaselineEvidenceArtifactV1Input,
): {
  readonly lock: BaselineEvidenceLock;
  readonly sources: readonly BaselineEvidenceArtifactSourceV1[];
} {
  validatePolicy(input.policy);
  const files = artifactFiles(input.artifact);
  verifySums(files);
  const lockBytes = files.get(`files/${BASELINE_EVIDENCE_ARTIFACT_LOCK_PATH_V1}`);
  const metadataBytes = files.get(BASELINE_EVIDENCE_ARTIFACT_FILE_V1);
  const subjectBytes = files.get(BASELINE_EVIDENCE_ARTIFACT_SUMS_PATH_V1);
  if (lockBytes === undefined || metadataBytes === undefined || subjectBytes === undefined)
    fail("artifact layout");
  const lock = canonicalLock(lockBytes);
  const metadata = parseMetadata(metadataBytes);
  verifyManifest(files, lockBytes, metadataBytes);
  verifyEvidenceIndex(files, lockBytes);
  const expectedSources = input.policy.sources
    .map((item) => source(item, "source policy"))
    .sort((left, right) => codeUnitCompare(sourceKey(left), sourceKey(right)));
  if (
    metadata.publisherRepository !== input.policy.repository ||
    metadata.environment !== input.policy.environment ||
    metadata.lock.sha256 !== sha256(lockBytes) ||
    JSON.stringify(metadata.sources) !== JSON.stringify(expectedSources) ||
    JSON.stringify(metadata.sources) !== JSON.stringify(sourcesFromLock(lock))
  )
    fail("artifact binding");
  if (
    input.artifact.subject.path !== BASELINE_EVIDENCE_ARTIFACT_SUMS_PATH_V1 ||
    !Buffer.isBuffer(input.artifact.subject.bytes) ||
    input.artifact.subject.bytes.compare(subjectBytes) !== 0 ||
    input.artifact.subject.sha256 !== sha256(subjectBytes)
  )
    fail("subject binding");
  let claims: VerifiedBaselineEvidenceArtifactAttestationV1;
  try {
    claims = input.verifyGithubAttestation({
      policy: {
        environment: input.policy.environment,
        issuer: input.policy.issuer,
        ref: input.policy.ref,
        repository: input.policy.repository,
        workflow: input.policy.workflow,
      },
      subjectBytes: Buffer.from(subjectBytes),
      subjectSha256: sha256(subjectBytes),
    });
  } catch {
    fail("attestation rejected");
  }
  if (
    claims?.verified !== true ||
    !samePolicy(claims, input.policy) ||
    claims.subjectSha256 !== sha256(subjectBytes)
  )
    fail("attestation rejected");
  return { lock: structuredClone(lock), sources: sourcesFromLock(lock) };
}
