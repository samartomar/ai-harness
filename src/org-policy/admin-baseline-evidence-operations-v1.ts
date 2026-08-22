import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseBaselineEvidenceLock } from "../baseline-evidence/schema.js";
import { vendorBaselineLockBytes } from "../baseline-evidence/vendor.js";
import {
  BASELINE_EVIDENCE_ARTIFACT_SUMS_PATH_V1,
  type VendorBaselineEvidenceArtifactV1,
  type VerifiedBaselineEvidenceArtifactAttestationV1,
  verifyVendorBaselineEvidenceArtifactV1,
} from "../baseline-evidence/vendor-artifact-v1.js";
import { codeUnitCompare } from "../capability/package-graph/canonical.js";
import type { Posture } from "../config/posture.js";
import { AihError } from "../errors.js";
import { defaultRunner, type Runner } from "../internals/proc.js";
import { findOnPath } from "../live/runner.js";
import {
  type AdminBaselineEvidenceBootstrapV1,
  enterpriseAdminBaselineEvidenceRootV1,
  resolveAdminBaselineEvidenceBootstrapV1,
} from "./admin-baseline-evidence-bootstrap-v1.js";
import {
  ADMIN_BASELINE_EVIDENCE_ARTIFACT_FILES_V1,
  adminBaselineEvidenceTimestampEpochV1,
  commitAdminBaselineEvidenceCacheV1,
  type DownloadedEvidenceV1,
  readAdminBaselineEvidenceCacheV1,
} from "./admin-baseline-evidence-cache-v1.js";

const ATTESTATION_LIMIT = 256 * 1024;
const ARTIFACT_FILE_LIMIT = 1024 * 1024;
const TOTAL_ARTIFACT_LIMIT = 1280 * 1024;

export type { DownloadedEvidenceV1 } from "./admin-baseline-evidence-cache-v1.js";
export { ADMIN_BASELINE_EVIDENCE_ARTIFACT_FILES_V1 } from "./admin-baseline-evidence-cache-v1.js";
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
  readonly commitLastDownloaded: (evidence: DownloadedEvidenceV1) => unknown;
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
  }) => Promise<VerifiedBaselineEvidenceArtifactAttestationV1>;
}

export interface ResolvedAdminBaselineEvidenceV1 {
  readonly provenance: AdminBaselineEvidenceProvenanceV1;
}

export interface ResolveOperationalAdminBaselineEvidenceV1Input {
  readonly adminRoot: string;
  readonly now: string;
  readonly posture: Posture;
  readonly env?: NodeJS.ProcessEnv;
  readonly fetchHttps?: AdminBaselineEvidenceHttpsFetchV1;
  readonly platformAdminRoot?: string;
  readonly run?: Runner;
  readonly tempRoot?: string;
}

type BoundedHttpsResponseV1 = {
  readonly statusCode?: number;
  on(event: string, listener: (...values: unknown[]) => void): unknown;
};

type AdminBaselineEvidenceHttpsRequestV1 = (
  target: URL,
  options: {
    readonly headers: { readonly accept: string; readonly "user-agent": string };
    readonly method: "GET";
    readonly timeout: number;
  },
  onResponse: (response: BoundedHttpsResponseV1) => void,
) => {
  destroy(): unknown;
  end(): unknown;
  on(event: "error" | "timeout", listener: () => void): unknown;
};

/**
 * Classifies one HTTPS response without creating a fallback authority: only a
 * deliberately absent first artifact (404 or 410) is the exact unavailable
 * sentinel. Every malformed or interrupted response rejects the acquisition.
 */
export function collectBoundedAdminBaselineEvidenceResponseV1(
  response: BoundedHttpsResponseV1,
  maxBytes: number,
  abort: () => void,
): Promise<
  { readonly kind: "available"; readonly bytes: Buffer } | { readonly kind: "unavailable" }
> {
  return new Promise((resolve, reject) => {
    let done = false;
    let aborted = false;
    const abortOnce = (): void => {
      if (aborted) return;
      aborted = true;
      try {
        abort();
      } catch {
        // Cleanup failure cannot change the acquisition's settled trust result.
      }
    };
    const unavailable = (): void => {
      if (done) return;
      done = true;
      resolve({ kind: "unavailable" });
    };
    const failed = (): void => {
      if (done) return;
      done = true;
      reject(
        new AihError("admin baseline evidence: fresh transport", "AIH_ADMIN_BASELINE_EVIDENCE"),
      );
    };
    const terminalFailure = (): void => {
      if (done) return;
      abortOnce();
      failed();
    };
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      failed();
      return;
    }
    if (response.statusCode === 404 || response.statusCode === 410) {
      abortOnce();
      unavailable();
      return;
    }
    if (response.statusCode !== 200) {
      terminalFailure();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    response.on("data", (...values) => {
      if (done) return;
      const chunk = values[0];
      if (!Buffer.isBuffer(chunk)) {
        terminalFailure();
        return;
      }
      size += chunk.length;
      if (size > maxBytes) {
        terminalFailure();
        return;
      }
      chunks.push(chunk);
    });
    response.on("error", terminalFailure);
    response.on("aborted", terminalFailure);
    response.on("close", terminalFailure);
    response.on("end", () => {
      if (done) return;
      if (size === 0) {
        terminalFailure();
        return;
      }
      done = true;
      resolve({ kind: "available", bytes: Buffer.concat(chunks) });
    });
  });
}

/** Bounded HTTPS acquisition with no redirect, credential, retry, or fallback behavior. */
export function createAdminBaselineEvidenceHttpsFetchV1(
  request: AdminBaselineEvidenceHttpsRequestV1,
): AdminBaselineEvidenceHttpsFetchV1 {
  return (input) =>
    new Promise((resolve, reject) => {
      let done = false;
      let deadline: NodeJS.Timeout | undefined;
      const clearDeadline = (): void => {
        if (deadline === undefined) return;
        clearTimeout(deadline);
        deadline = undefined;
      };
      const finish = (
        result:
          | { readonly kind: "available"; readonly bytes: Buffer }
          | { readonly kind: "unavailable" },
      ): void => {
        if (done) return;
        done = true;
        clearDeadline();
        resolve(result);
      };
      const failed = (): void => {
        if (done) return;
        done = true;
        clearDeadline();
        reject(
          new AihError("admin baseline evidence: fresh transport", "AIH_ADMIN_BASELINE_EVIDENCE"),
        );
      };
      let target: URL;
      try {
        if (
          typeof input.url !== "string" ||
          !Number.isSafeInteger(input.maxBytes) ||
          input.maxBytes <= 0 ||
          !Number.isSafeInteger(input.timeoutMs) ||
          input.timeoutMs <= 0
        ) {
          failed();
          return;
        }
        target = new URL(input.url);
      } catch {
        failed();
        return;
      }
      if (target.protocol !== "https:" || target.username !== "" || target.password !== "") {
        failed();
        return;
      }
      try {
        let call: ReturnType<AdminBaselineEvidenceHttpsRequestV1> | undefined;
        deadline = setTimeout(() => {
          try {
            call?.destroy();
          } catch {
            // The deadline failure remains terminal if socket teardown throws.
          }
          failed();
        }, input.timeoutMs);
        call = request(
          target,
          {
            headers: {
              accept: "application/octet-stream",
              "user-agent": "aih-admin-baseline-evidence",
            },
            method: "GET",
            timeout: input.timeoutMs,
          },
          (response) => {
            void collectBoundedAdminBaselineEvidenceResponseV1(response, input.maxBytes, () =>
              call?.destroy(),
            ).then(finish, failed);
          },
        );
        call.on("error", failed);
        call.on("timeout", () => {
          try {
            call.destroy();
          } catch {
            // Idle teardown failure cannot change the terminal acquisition result.
          }
          failed();
        });
        call.end();
      } catch {
        failed();
      }
    });
}

export const defaultAdminBaselineEvidenceHttpsFetchV1 = createAdminBaselineEvidenceHttpsFetchV1(
  httpsRequest as unknown as AdminBaselineEvidenceHttpsRequestV1,
);

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
  let results: unknown[];
  try {
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!Array.isArray(parsed) || parsed.length !== 1) fail("attestation claim");
    results = parsed;
  } catch {
    fail("attestation claim");
  }
  const record = (value: unknown): Record<string, unknown> => {
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    )
      fail("attestation claim");
    return value as Record<string, unknown>;
  };
  const result = record(results[0]);
  if (!Object.hasOwn(result, "attestation") || !Object.hasOwn(result, "verificationResult"))
    fail("attestation claim");
  const verification = record(result.verificationResult);
  if (verification.mediaType !== "application/vnd.dev.sigstore.verificationresult+json;version=0.1")
    fail("attestation claim");
  const signature = record(verification.signature);
  const certificate = record(signature.certificate);
  const workflowUri = `https://github.com/${expected.expectedWorkflow}@${expected.expectedRef}`;
  if (
    certificate.subjectAlternativeName !== workflowUri ||
    certificate.buildSignerURI !== workflowUri ||
    certificate.buildConfigURI !== workflowUri ||
    certificate.issuer !== expected.expectedIssuer ||
    certificate.sourceRepositoryURI !== `https://github.com/${expected.expectedRepository}` ||
    certificate.sourceRepositoryRef !== expected.expectedRef ||
    certificate.runnerEnvironment !== "github-hosted"
  )
    fail("attestation certificate");
  const statement = record(verification.statement);
  if (
    statement._type !== "https://in-toto.io/Statement/v1" ||
    statement.predicateType !== "https://slsa.dev/provenance/v1"
  )
    fail("attestation claim");
  if (!Array.isArray(statement.subject) || statement.subject.length !== 1)
    fail("attestation subject");
  const subject = record(statement.subject[0]);
  const digest = record(subject.digest);
  if (
    Object.keys(digest).length !== 1 ||
    !/^[a-f0-9]{64}$/.test(String(digest.sha256)) ||
    digest.sha256 !== expected.subjectSha256
  )
    fail("attestation subject");
  if (
    !Array.isArray(verification.verifiedTimestamps) ||
    verification.verifiedTimestamps.length === 0 ||
    verification.verifiedTimestamps.length > 16
  )
    fail("attestation timestamp");
  const now = epoch(expected.now, "clock");
  const observed = new Set<string>();
  const moments = verification.verifiedTimestamps.map((entry) => {
    const timestamp = record(entry);
    if (
      Object.keys(timestamp).sort().join("\0") !== ["timestamp", "type", "uri"].join("\0") ||
      typeof timestamp.type !== "string" ||
      typeof timestamp.uri !== "string" ||
      typeof timestamp.timestamp !== "string" ||
      !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:Z|[+-]\d\d:\d\d)$/.test(timestamp.timestamp)
    )
      fail("attestation timestamp");
    const value = adminBaselineEvidenceTimestampEpochV1(timestamp.timestamp, true);
    if (value === undefined || value > now || now - value > expected.cacheMaxAgeSeconds * 1000)
      fail("attestation timestamp");
    const key = `${timestamp.type}\0${timestamp.uri}\0${timestamp.timestamp}`;
    if (observed.has(key)) fail("attestation timestamp");
    observed.add(key);
    return value;
  });
  const earliest = Math.min(...moments);
  const signedAt = `${new Date(earliest).toISOString().slice(0, 19)}Z`;
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

export async function verifyGithubBaselineEvidenceAttestationLiveV1(input: {
  readonly bootstrap: AdminBaselineEvidenceBootstrapV1;
  readonly subjectBytes: Buffer;
  readonly subjectSha256: string;
  readonly attestationBytes: Buffer;
  readonly gh: string;
  readonly tempRoot: string;
  readonly run: Runner;
  readonly now: string;
}): Promise<VerifiedBaselineEvidenceArtifactAttestationV1 & { readonly signedAt: string }> {
  if (
    !Buffer.isBuffer(input.subjectBytes) ||
    input.subjectBytes.length === 0 ||
    !Buffer.isBuffer(input.attestationBytes) ||
    input.attestationBytes.length === 0 ||
    input.attestationBytes.length > ATTESTATION_LIMIT
  )
    fail("attestation");
  let staging: string | undefined;
  try {
    const root = lstatSync(input.tempRoot);
    if (root.isSymbolicLink() || !root.isDirectory()) fail("attestation custody");
    staging = mkdtempSync(join(input.tempRoot, "aih-baseline-evidence-"));
    if (lstatSync(staging).isSymbolicLink() || !lstatSync(staging).isDirectory())
      fail("attestation custody");
    const subject = join(staging, "SHA256SUMS");
    const bundle = join(staging, "attestation.jsonl");
    writeFileSync(subject, input.subjectBytes, { flag: "wx", mode: 0o600 });
    writeFileSync(bundle, input.attestationBytes, { flag: "wx", mode: 0o600 });
    chmodSync(subject, 0o600);
    chmodSync(bundle, 0o600);
    const san = `https://github.com/${input.bootstrap.expectedWorkflow}@${input.bootstrap.expectedRef}`;
    const result = await input.run(
      [
        input.gh,
        "attestation",
        "verify",
        subject,
        "--bundle",
        bundle,
        "--format",
        "json",
        "--repo",
        input.bootstrap.expectedRepository,
        "--predicate-type",
        "https://slsa.dev/provenance/v1",
        "--cert-identity",
        san,
        "--cert-oidc-issuer",
        input.bootstrap.expectedIssuer,
        "--source-ref",
        input.bootstrap.expectedRef,
        "--deny-self-hosted-runners",
      ],
      { cwd: staging, maxBufferBytes: ATTESTATION_LIMIT, timeoutMs: 30_000 },
    );
    if (
      result.code !== 0 ||
      result.spawnError === true ||
      result.truncated === true ||
      typeof result.stdout !== "string" ||
      Buffer.byteLength(result.stdout) > ATTESTATION_LIMIT
    )
      fail("attestation rejected");
    return parseGithubBaselineEvidenceAttestationV1(Buffer.from(result.stdout, "utf8"), {
      ...input.bootstrap,
      now: input.now,
      subjectSha256: input.subjectSha256,
    });
  } catch (error) {
    if (error instanceof AihError) throw error;
    fail("attestation rejected");
  } finally {
    if (staging !== undefined) {
      try {
        rmSync(staging, { recursive: true, force: true });
      } catch {
        fail("attestation custody");
      }
    }
  }
  fail("attestation rejected");
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
    fail("fresh locator");
  }
  if (base.protocol !== "https:" || !base.pathname.endsWith("/")) fail("fresh locator");
  const files: { path: string; bytes: Buffer }[] = [];
  let total = 0;
  let available = false;
  for (const path of ADMIN_BASELINE_EVIDENCE_ARTIFACT_FILES_V1) {
    let response: Awaited<ReturnType<AdminBaselineEvidenceHttpsFetchV1>>;
    try {
      response = await input.fetchHttps({
        url: new URL(path, base).href,
        maxBytes: ARTIFACT_FILE_LIMIT,
        timeoutMs: 10_000,
      });
    } catch {
      fail("fresh transport");
    }
    if (typeof response !== "object" || response === null) fail("fresh response");
    if (isExactUnavailable(response)) {
      if (!available) return { kind: "unavailable" };
      fail("fresh incomplete");
    }
    if (
      !hasOwnDataKind(response, "available") ||
      !Buffer.isBuffer(response.bytes) ||
      response.bytes.length === 0 ||
      response.bytes.length > ARTIFACT_FILE_LIMIT
    )
      fail("fresh response");
    available = true;
    total += response.bytes.length;
    if (total > TOTAL_ARTIFACT_LIMIT) fail("fresh bounds");
    files.push({ path, bytes: Buffer.from(response.bytes) });
  }
  let attestation: Awaited<ReturnType<AdminBaselineEvidenceHttpsFetchV1>>;
  try {
    attestation = await input.fetchHttps({
      url: input.attestationUrl,
      maxBytes: ATTESTATION_LIMIT,
      timeoutMs: 10_000,
    });
  } catch {
    fail("fresh transport");
  }
  if (
    !hasOwnDataKind(attestation, "available") ||
    !Buffer.isBuffer(attestation.bytes) ||
    attestation.bytes.length === 0 ||
    attestation.bytes.length > ATTESTATION_LIMIT
  )
    fail("fresh incomplete");
  const subject = files.at(-1);
  if (subject === undefined) fail("fresh layout");
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

/** Only this inert sentinel may advance from fresh acquisition to fallback custody. */
function isExactUnavailable(value: unknown): value is { readonly kind: "unavailable" } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  try {
    if (Object.getPrototypeOf(value) !== Object.prototype) return false;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== 1 || keys[0] !== "kind") return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, "kind");
    return descriptor !== undefined && "value" in descriptor && descriptor.value === "unavailable";
  } catch {
    return false;
  }
}

function hasOwnDataKind(
  value: unknown,
  expected: "available",
): value is { readonly kind: "available" } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, "kind");
    return descriptor !== undefined && "value" in descriptor && descriptor.value === expected;
  } catch {
    return false;
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
function epoch(value: string, label: string): number {
  const time = adminBaselineEvidenceTimestampEpochV1(value, false);
  if (time === undefined) fail(label);
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
function preverifiedSubject(downloaded: DownloadedEvidenceV1): {
  readonly bytes: Buffer;
  readonly sha256: string;
} {
  try {
    const subject = (downloaded.artifact as { readonly subject?: unknown }).subject as {
      readonly bytes?: unknown;
    };
    if (!Buffer.isBuffer(subject?.bytes) || subject.bytes.length === 0) fail("artifact subject");
    const bytes = Buffer.from(subject.bytes);
    return { bytes, sha256: sha256(bytes) };
  } catch (error) {
    if (error instanceof AihError) throw error;
    fail("artifact subject");
  }
}

function sameAttestationRequest(
  value: unknown,
  policy: {
    readonly environment: string;
    readonly issuer: string;
    readonly ref: string;
    readonly repository: string;
    readonly workflow: string;
  },
  subject: { readonly bytes: Buffer; readonly sha256: string },
): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const request = value as Record<string, unknown>;
  const requestKeys = Object.keys(request).sort(codeUnitCompare);
  if (
    requestKeys.length !== 3 ||
    requestKeys.some((key, index) => key !== ["policy", "subjectBytes", "subjectSha256"][index])
  )
    return false;
  if (!Buffer.isBuffer(request.subjectBytes) || request.subjectBytes.compare(subject.bytes) !== 0)
    return false;
  if (request.subjectSha256 !== subject.sha256) return false;
  if (
    typeof request.policy !== "object" ||
    request.policy === null ||
    Array.isArray(request.policy)
  )
    return false;
  const actual = request.policy as Record<string, unknown>;
  const keys = Object.keys(actual).sort(codeUnitCompare);
  if (
    keys.length !== 5 ||
    keys.some(
      (key, index) => key !== ["environment", "issuer", "ref", "repository", "workflow"][index],
    )
  )
    return false;
  return (
    actual.environment === policy.environment &&
    actual.issuer === policy.issuer &&
    actual.ref === policy.ref &&
    actual.repository === policy.repository &&
    actual.workflow === policy.workflow
  );
}

async function verify(
  downloaded: DownloadedEvidenceV1,
  bootstrap: AdminBaselineEvidenceBootstrapV1,
  verifyAttestation: ResolveAdminBaselineEvidenceV1Input["verifyGithubAttestation"],
): Promise<{ digest: string; schemaVersion: number }> {
  if (
    !Buffer.isBuffer(downloaded.attestationBytes) ||
    downloaded.attestationBytes.length === 0 ||
    downloaded.attestationBytes.length > ATTESTATION_LIMIT
  )
    fail("attestation");
  try {
    const policy = {
      environment: bootstrap.expectedEnvironment,
      issuer: bootstrap.expectedIssuer,
      ref: bootstrap.expectedRef,
      repository: bootstrap.expectedRepository,
      workflow: bootstrap.expectedWorkflow,
    };
    const subject = preverifiedSubject(downloaded);
    // This async boundary is the only place a live verifier runs. The captured
    // projection stays in memory and is released to the synchronous foundation
    // only if its independently constructed request is byte-identical.
    const live = await verifyAttestation({
      attestationBytes: Buffer.from(downloaded.attestationBytes),
      policy,
      subjectBytes: Buffer.from(subject.bytes),
      subjectSha256: subject.sha256,
    });
    const claim: VerifiedBaselineEvidenceArtifactAttestationV1 = {
      environment: live.environment,
      issuer: live.issuer,
      ref: live.ref,
      repository: live.repository,
      subjectSha256: live.subjectSha256,
      verified: live.verified,
      workflow: live.workflow,
    };
    const checked = verifyVendorBaselineEvidenceArtifactV1({
      artifact: downloaded.artifact,
      policy: {
        ...policy,
        sources: bootstrap.sources,
      },
      verifyGithubAttestation: (request) => {
        if (!sameAttestationRequest(request, policy, subject)) fail("attestation request");
        return claim;
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
  if (!isExactUnavailable(fresh)) {
    if (!hasOwnDataKind(fresh, "available")) fail("fresh response");
    const downloaded: DownloadedEvidenceV1 = { ...fresh, downloadedAt: input.now };
    const info = await verify(downloaded, input.bootstrap, input.verifyGithubAttestation);
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
  const cached = input.readLastDownloaded();
  if (cached !== undefined) {
    const age = (now - epoch(cached.downloadedAt, "cache age")) / 1000;
    if (!Number.isSafeInteger(age) || age < 0 || age > input.bootstrap.cacheMaxAgeSeconds)
      fail("cache age");
    const info = await verify(cached, input.bootstrap, input.verifyGithubAttestation);
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

/**
 * Production administrator-only composition. Raw fresh/cache bytes cross the
 * effect boundary here; the pure resolver below it receives only a synchronous
 * captured-claim seam and never persists authentication results.
 */
export async function resolveOperationalAdminBaselineEvidenceV1(
  input: ResolveOperationalAdminBaselineEvidenceV1Input,
): Promise<ResolvedAdminBaselineEvidenceV1> {
  const resolved = resolveAdminBaselineEvidenceBootstrapV1({
    adminRoot: input.adminRoot,
    platformAdminRoot:
      input.platformAdminRoot ?? enterpriseAdminBaselineEvidenceRootV1(process.platform),
    posture: input.posture,
  });
  const fetchHttps = input.fetchHttps ?? defaultAdminBaselineEvidenceHttpsFetchV1;
  const run = input.run ?? defaultRunner;
  const tempRoot = input.tempRoot ?? tmpdir();
  const environment = input.env ?? process.env;
  return resolveAdminBaselineEvidenceV1({
    bootstrap: resolved.bootstrap,
    now: input.now,
    fetchFresh: () =>
      fetchAdminBaselineEvidenceArtifactV1({
        artifactUrl: resolved.bootstrap.artifactUrl,
        attestationUrl: resolved.bootstrap.attestationUrl,
        fetchHttps,
      }),
    readLastDownloaded: () => readAdminBaselineEvidenceCacheV1(resolved.root, resolved.bootstrap),
    commitLastDownloaded: (evidence) =>
      commitAdminBaselineEvidenceCacheV1(resolved.root, resolved.bootstrap, evidence),
    verifyGithubAttestation: async (request) => {
      const gh = findOnPath("gh", environment, process.platform, {
        excludeRoot: resolved.root,
        windowsExeOnly: true,
      });
      if (gh === undefined) fail("GitHub attestation verifier is unavailable on absolute PATH");
      return verifyGithubBaselineEvidenceAttestationLiveV1({
        attestationBytes: request.attestationBytes ?? fail("attestation"),
        bootstrap: resolved.bootstrap,
        gh,
        now: input.now,
        run,
        subjectBytes: request.subjectBytes,
        subjectSha256: request.subjectSha256,
        tempRoot,
      });
    },
  });
}
