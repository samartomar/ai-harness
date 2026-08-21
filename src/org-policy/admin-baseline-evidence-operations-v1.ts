import { createHash } from "node:crypto";
import { parseBaselineEvidenceLock } from "../baseline-evidence/schema.js";
import { vendorBaselineLockBytes } from "../baseline-evidence/vendor.js";
import {
  BASELINE_EVIDENCE_ARTIFACT_FILE_V1,
  BASELINE_EVIDENCE_ARTIFACT_LOCK_PATH_V1,
  BASELINE_EVIDENCE_ARTIFACT_SUMS_PATH_V1,
  type VendorBaselineEvidenceArtifactV1,
  type VerifiedBaselineEvidenceArtifactAttestationV1,
  verifyVendorBaselineEvidenceArtifactV1,
} from "../baseline-evidence/vendor-artifact-v1.js";
import { AihError } from "../errors.js";
import type { AdminBaselineEvidenceBootstrapV1 } from "./admin-baseline-evidence-bootstrap-v1.js";

const ATTESTATION_LIMIT = 256 * 1024;
const ARTIFACT_FILE_LIMIT = 1024 * 1024;
const TOTAL_ARTIFACT_LIMIT = 1280 * 1024;
export const ADMIN_BASELINE_EVIDENCE_ARTIFACT_FILES_V1 = [
  BASELINE_EVIDENCE_ARTIFACT_FILE_V1,
  "evidence.json",
  `files/${BASELINE_EVIDENCE_ARTIFACT_LOCK_PATH_V1}`,
  "manifest.json",
  BASELINE_EVIDENCE_ARTIFACT_SUMS_PATH_V1,
] as const;
export type AdminBaselineEvidenceHttpsFetchV1 = (request: {
  readonly url: string;
  readonly maxBytes: number;
  readonly timeoutMs: number;
}) => Promise<
  { readonly kind: "available"; readonly bytes: Buffer } | { readonly kind: "unavailable" }
>;

export interface AdminBaselineEvidenceProvenanceV1 {
  readonly ageSeconds: number | null;
  readonly digest: string;
  readonly resolvedAt: string;
  readonly schemaVersion: number;
  readonly sourceIds: readonly string[];
  readonly tier: "fresh" | "last-downloaded" | "packaged";
}

interface DownloadedEvidenceV1 {
  readonly artifact: VendorBaselineEvidenceArtifactV1;
  readonly attestationBytes: Buffer;
  readonly downloadedAt: string;
}

export interface ResolveAdminBaselineEvidenceV1Input {
  readonly bootstrap: AdminBaselineEvidenceBootstrapV1;
  readonly now: string;
  readonly fetchFresh: () => Promise<
    | { readonly kind: "unavailable" }
    | {
        readonly kind: "available";
        readonly artifact: VendorBaselineEvidenceArtifactV1;
        readonly attestationBytes: Buffer;
      }
  >;
  readonly readLastDownloaded: () => DownloadedEvidenceV1 | undefined;
  /** Claim-before-effect boundary. Implementations must atomically claim their contained cache slot. */
  readonly commitLastDownloaded: (evidence: DownloadedEvidenceV1) => true;
  readonly verifyGithubAttestation: (request: {
    readonly policy: {
      readonly environment: string;
      readonly issuer: string;
      readonly ref: string;
      readonly repository: string;
      readonly workflow: string;
    };
    readonly subjectBytes: Buffer;
    readonly subjectSha256: string;
    readonly attestationBytes?: Buffer;
  }) => VerifiedBaselineEvidenceArtifactAttestationV1;
}

export interface ResolvedAdminBaselineEvidenceV1 {
  readonly provenance: AdminBaselineEvidenceProvenanceV1;
}

/**
 * Closed projection of `gh attestation verify --format json` after the exact
 * command has pinned repo, workflow, issuer, ref and SLSA predicate. The JSON
 * is still treated as hostile: it proves the claim rather than reflecting the
 * caller's policy back to it.
 */
export function parseGithubBaselineEvidenceAttestationV1(
  bytes: Buffer,
  expected: AdminBaselineEvidenceBootstrapV1 & {
    readonly now: string;
    readonly subjectSha256: string;
  },
): VerifiedBaselineEvidenceArtifactAttestationV1 & { readonly signedAt: string } {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > ATTESTATION_LIMIT)
    fail("attestation");
  let claim: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      Object.getPrototypeOf(parsed) !== Object.prototype
    )
      fail("attestation claim");
    claim = parsed as Record<string, unknown>;
  } catch {
    fail("attestation claim");
  }
  const fields = [
    "issuer",
    "predicateType",
    "ref",
    "repository",
    "signedAt",
    "subjectSha256",
    "workflow",
  ];
  if (Object.keys(claim).sort().join("\0") !== fields.sort().join("\0")) fail("attestation claim");
  const signedAt = typeof claim.signedAt === "string" ? claim.signedAt : "";
  const signed = epoch(signedAt, "attestation timestamp");
  const now = epoch(expected.now, "clock");
  if (signed > now || (now - signed) / 1000 > expected.cacheMaxAgeSeconds)
    fail("attestation timestamp");
  if (
    claim.predicateType !== "https://slsa.dev/provenance/v1" ||
    claim.subjectSha256 !== expected.subjectSha256 ||
    claim.repository !== expected.expectedRepository ||
    claim.workflow !== expected.expectedWorkflow ||
    claim.issuer !== expected.expectedIssuer ||
    claim.ref !== expected.expectedRef
  )
    fail("attestation claim");
  return {
    environment: expected.expectedEnvironment,
    issuer: expected.expectedIssuer,
    ref: expected.expectedRef,
    repository: expected.expectedRepository,
    workflow: expected.expectedWorkflow,
    subjectSha256: expected.subjectSha256,
    verified: true,
    signedAt,
  };
}

/** Acquires precisely the #815 subject layout; a mirror base never supplies a path authority. */
export async function fetchAdminBaselineEvidenceArtifactV1(input: {
  readonly artifactUrl: string;
  readonly attestationUrl: string;
  readonly fetchHttps: AdminBaselineEvidenceHttpsFetchV1;
}): Promise<
  | { readonly kind: "unavailable" }
  | {
      readonly kind: "available";
      readonly artifact: VendorBaselineEvidenceArtifactV1;
      readonly attestationBytes: Buffer;
    }
> {
  let base: URL;
  try {
    base = new URL(input.artifactUrl);
  } catch {
    return { kind: "unavailable" };
  }
  if (base.protocol !== "https:" || !base.pathname.endsWith("/")) return { kind: "unavailable" };
  const files: { path: string; bytes: Buffer }[] = [];
  let total = 0;
  for (const path of ADMIN_BASELINE_EVIDENCE_ARTIFACT_FILES_V1) {
    const response = await input.fetchHttps({
      url: new URL(path, base).href,
      maxBytes: ARTIFACT_FILE_LIMIT,
      timeoutMs: 10_000,
    });
    if (
      response.kind !== "available" ||
      !Buffer.isBuffer(response.bytes) ||
      response.bytes.length === 0 ||
      response.bytes.length > ARTIFACT_FILE_LIMIT
    )
      return { kind: "unavailable" };
    total += response.bytes.length;
    if (total > TOTAL_ARTIFACT_LIMIT) return { kind: "unavailable" };
    files.push({ path, bytes: Buffer.from(response.bytes) });
  }
  const attestation = await input.fetchHttps({
    url: input.attestationUrl,
    maxBytes: ATTESTATION_LIMIT,
    timeoutMs: 10_000,
  });
  if (
    attestation.kind !== "available" ||
    !Buffer.isBuffer(attestation.bytes) ||
    attestation.bytes.length === 0 ||
    attestation.bytes.length > ATTESTATION_LIMIT
  )
    return { kind: "unavailable" };
  const subject = files.find((file) => file.path === BASELINE_EVIDENCE_ARTIFACT_SUMS_PATH_V1);
  if (subject === undefined) return { kind: "unavailable" };
  return {
    kind: "available",
    artifact: {
      files,
      subject: {
        bytes: Buffer.from(subject.bytes),
        path: BASELINE_EVIDENCE_ARTIFACT_SUMS_PATH_V1,
        sha256: sha256(subject.bytes),
      },
    },
    attestationBytes: Buffer.from(attestation.bytes),
  };
}

function fail(label: string): never {
  throw new AihError(`admin baseline evidence: ${label}`, "AIH_ADMIN_BASELINE_EVIDENCE");
}
function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function epoch(value: string, label: string): number {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(value)) fail(label);
  const time = Date.parse(value);
  if (!Number.isSafeInteger(time)) fail(label);
  return time;
}
function lockInfo(
  lockBytes: Buffer,
  bootstrap: AdminBaselineEvidenceBootstrapV1,
): { digest: string; schemaVersion: number } {
  let lock: ReturnType<typeof parseBaselineEvidenceLock>;
  try {
    lock = parseBaselineEvidenceLock(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(lockBytes)),
    );
  } catch {
    fail("lock");
  }
  if (
    lock.schemaVersion < bootstrap.minSchemaVersion ||
    lock.schemaVersion > bootstrap.maxSchemaVersion
  )
    fail("schema");
  const expected = bootstrap.sources;
  if (
    lock.sources.length !== expected.length ||
    lock.sources.some(
      (entry, index) =>
        entry.id !== expected[index]?.id ||
        entry.owner !== expected[index]?.owner ||
        entry.repo !== expected[index]?.repo ||
        entry.pinnedSha !== expected[index]?.pinnedSha,
    )
  )
    fail("source pin");
  return { digest: sha256(lockBytes), schemaVersion: lock.schemaVersion };
}
function verify(
  downloaded: DownloadedEvidenceV1,
  bootstrap: AdminBaselineEvidenceBootstrapV1,
  verifyAttestation: ResolveAdminBaselineEvidenceV1Input["verifyGithubAttestation"],
): { digest: string; schemaVersion: number } {
  if (
    !Buffer.isBuffer(downloaded.attestationBytes) ||
    downloaded.attestationBytes.length === 0 ||
    downloaded.attestationBytes.length > ATTESTATION_LIMIT
  )
    fail("attestation");
  try {
    const checked = verifyVendorBaselineEvidenceArtifactV1({
      artifact: downloaded.artifact,
      policy: {
        environment: bootstrap.expectedEnvironment,
        issuer: bootstrap.expectedIssuer,
        ref: bootstrap.expectedRef,
        repository: bootstrap.expectedRepository,
        workflow: bootstrap.expectedWorkflow,
        sources: bootstrap.sources,
      },
      verifyGithubAttestation: (request) => {
        // The strict V1 verifier owns bytes/subject binding; this adapter gives the caller
        // attestation bytes only after local artifact checks have completed.
        return verifyAttestation({ ...request, attestationBytes: downloaded.attestationBytes });
      },
    });
    return lockInfo(Buffer.from(`${JSON.stringify(checked.lock, null, 2)}\n`, "utf8"), bootstrap);
  } catch (error) {
    if (error instanceof AihError) throw error;
    fail("verification");
  }
}
export async function resolveAdminBaselineEvidenceV1(
  input: ResolveAdminBaselineEvidenceV1Input,
): Promise<ResolvedAdminBaselineEvidenceV1> {
  const now = epoch(input.now, "clock");
  const fresh = await input.fetchFresh();
  if (fresh.kind === "available") {
    const downloaded: DownloadedEvidenceV1 = { ...fresh, downloadedAt: input.now };
    const info = verify(downloaded, input.bootstrap, input.verifyGithubAttestation);
    if (input.commitLastDownloaded(downloaded) !== true) fail("cache commit failed");
    return {
      provenance: {
        tier: "fresh",
        ageSeconds: 0,
        resolvedAt: input.now,
        sourceIds: input.bootstrap.sources.map((source) => source.id),
        ...info,
      },
    };
  }
  if (fresh.kind !== "unavailable") fail("fresh response");
  const cached = input.readLastDownloaded();
  if (cached !== undefined) {
    const age = (now - epoch(cached.downloadedAt, "cache age")) / 1000;
    if (!Number.isSafeInteger(age) || age < 0 || age > input.bootstrap.cacheMaxAgeSeconds)
      fail("cache age");
    const info = verify(cached, input.bootstrap, input.verifyGithubAttestation);
    return {
      provenance: {
        tier: "last-downloaded",
        ageSeconds: age,
        resolvedAt: input.now,
        sourceIds: input.bootstrap.sources.map((source) => source.id),
        ...info,
      },
    };
  }
  const lockBytes = vendorBaselineLockBytes();
  const info = lockInfo(lockBytes, input.bootstrap);
  return {
    provenance: {
      tier: "packaged",
      ageSeconds: null,
      resolvedAt: input.now,
      sourceIds: input.bootstrap.sources.map((source) => source.id),
      ...info,
    },
  };
}
