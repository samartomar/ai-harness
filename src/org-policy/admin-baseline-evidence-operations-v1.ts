import { createHash } from "node:crypto";
import { parseBaselineEvidenceLock } from "../baseline-evidence/schema.js";
import { readVendorBaselineLock, vendorBaselineLockBytes } from "../baseline-evidence/vendor.js";
import {
  type VendorBaselineEvidenceArtifactV1,
  type VerifiedBaselineEvidenceArtifactAttestationV1,
  verifyVendorBaselineEvidenceArtifactV1,
} from "../baseline-evidence/vendor-artifact-v1.js";
import { AihError } from "../errors.js";
import type { AdminBaselineEvidenceBootstrapV1 } from "./admin-baseline-evidence-bootstrap-v1.js";

const ATTESTATION_LIMIT = 256 * 1024;

export interface AdminBaselineEvidenceProvenanceV1 {
  readonly ageSeconds: number | null;
  readonly digest: string;
  readonly resolvedAt: string;
  readonly schemaVersion: number;
  readonly sourceId: string;
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
  readonly commitLastDownloaded: (evidence: DownloadedEvidenceV1) => void;
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
  const matches = lock.sources.filter(
    (entry) =>
      entry.id === bootstrap.source.id &&
      entry.owner === bootstrap.source.owner &&
      entry.repo === bootstrap.source.repo &&
      entry.pinnedSha === bootstrap.source.pinnedSha,
  );
  if (matches.length !== 1) fail("source pin");
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
        sources: readVendorBaselineLock().sources.map(({ id, owner, repo, pinnedSha }) => ({
          id,
          owner,
          repo,
          pinnedSha,
        })),
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
    input.commitLastDownloaded(downloaded);
    return {
      provenance: {
        tier: "fresh",
        ageSeconds: 0,
        resolvedAt: input.now,
        sourceId: input.bootstrap.source.id,
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
        sourceId: input.bootstrap.source.id,
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
      sourceId: input.bootstrap.source.id,
      ...info,
    },
  };
}
