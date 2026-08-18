import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import type { Posture } from "../config/posture.js";
import {
  canonicalStrictJsonBytesV1,
  deepFreezeStrictJsonV1,
  parseStrictJsonObjectV1,
} from "../contract/strict-json-v1.js";
import { AihError } from "../errors.js";
import { readRegularFile } from "../internals/fsxn.js";
import { defaultRunner, type Runner } from "../internals/proc.js";
import { findOnPath } from "../live/runner.js";
import {
  type AdminCatalogBootstrapProvenanceV1,
  type AdminCatalogBootstrapV1,
  adminCatalogAttestationRepositoryV1,
  adminCatalogCacheSlotPathV1,
  enterpriseAdminCatalogRootV1,
  resolveAdminCatalogBootstrapV1,
} from "./admin-catalog-bootstrap-v1.js";
import {
  parseAdminCatalogCacheRecordV1Json,
  resolveAdminCatalogFetchV1,
} from "./admin-catalog-fetch-v1.js";
import {
  canonicalAdminSeatDistributionV1Bytes,
  parseAdminSeatDistributionV1Json,
} from "./catalog-binding-v1.js";

/**
 * Operational administrator-only catalog consumption for
 * `aih policy generate <admin-root>`.
 *
 * Everything effectful happens HERE and completes BEFORE the shipped pure
 * foundation runs: the canonical bootstrap is read, the exact HTTPS locators are
 * acquired under byte/time bounds, and every acquired artifact is verified by an
 * exact `gh attestation verify` invocation whose result is memoized. Only then
 * are synchronous, allowlist-backed callbacks handed to
 * `resolveAdminCatalogFetchV1`, so the foundation never awaits a thenable and
 * never verifies lazily.
 *
 * The administrator workstation holds no key material. Signing is impossible
 * here by construction: the `signCanonicalPae` adapter returns the signature an
 * external organization-admin OIDC workflow already published, and only when the
 * requested canonical PAE bytes are byte-identical to the pre-signed ones.
 */

const MAX_ARTIFACT_BYTES = 64 * 1024;
const MAX_ATTESTATION_BYTES = 16 * 1024;
const MAX_CACHE_BYTES = 96 * 1024;
const MAX_DISTRIBUTION_BYTES = 96 * 1024;
const HTTPS_TIMEOUT_MS = 10_000;
const GH_TIMEOUT_MS = 30_000;
const GH_MAX_OUTPUT_BYTES = 256 * 1024;
const GITHUB_PROVENANCE_PREDICATE_TYPE = "https://slsa.dev/provenance/v1";
const UTC_SECOND = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
/**
 * The only foundation/codec diagnostics allowed to surface. Every entry is a
 * fixed vocabulary emitted by our own modules, so a rejection reason can never
 * carry attacker-chosen bytes, a locator, or a filesystem path.
 */
const SAFE_REASON =
  /^(?:ADMIN_CATALOG_FETCH_V1|invalid (?:CatalogHeadV1|ResolvedCatalogBindingV1|AdminSeatDistributionV1)): [a-z0-9 -]{1,64}$/;

export type AdminCatalogHttpsResponseV1 =
  | { readonly kind: "available"; readonly bytes: Buffer }
  | { readonly kind: "unavailable" };

export type AdminCatalogHttpsFetchV1 = (request: {
  readonly url: string;
  readonly maxBytes: number;
  readonly timeoutMs: number;
}) => Promise<AdminCatalogHttpsResponseV1>;

/**
 * The visible Workbench line renders only verified tier, source, channel,
 * resolved time, download age, and bootstrap provenance. The larger closed safe
 * embedded model also carries sequence, digests, posture, member count, and
 * verification time. No locator, filesystem path, token, signature, raw
 * attestation, signer identity, root digest, or machine detail is representable
 * in this shape.
 */
export type AdminCatalogProvenanceV1 = Readonly<{
  ageSeconds: number | null;
  bootstrapProvenance: AdminCatalogBootstrapProvenanceV1;
  catalogSha256: string;
  channel: string;
  headDigestSha256: string;
  memberCount: number;
  posture: Posture;
  resolvedAt: string;
  sequence: number;
  sourceId: string;
  tier: "fresh" | "cached-verified" | "packaged";
  verifiedAt: string;
}>;

export interface ResolveOperationalAdminCatalogV1Input {
  readonly adminRoot: string;
  /**
   * Wall clock, UTC second precision — validates CatalogHead validity and cache
   * age. The separate bindingResolvedAt is reserved for signed binding
   * reproduction inside the pre-signed distribution.
   */
  readonly now: string;
  readonly posture: Posture;
  readonly fetchHttps?: AdminCatalogHttpsFetchV1;
  /** Process environment used only to resolve an external, absolute `gh` executable. */
  readonly env?: NodeJS.ProcessEnv;
  /** Defaults to the fixed platform constant; never an environment value. */
  readonly platformAdminRoot?: string;
  readonly run?: Runner;
  readonly tempRoot?: string;
}

function fail(label: string): never {
  throw new AihError(`admin catalog: ${label}`, "AIH_ADMIN_CATALOG");
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function decodeUtf8(bytes: Buffer): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function epochSeconds(value: string, label: string): number {
  if (typeof value !== "string" || !UTC_SECOND.test(value)) fail(label);
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== `${value.slice(0, -1)}.000Z`)
    fail(label);
  return Math.floor(date.getTime() / 1000);
}

/** DSSE pre-authentication encoding — the exact bytes the foundation signs over. */
function pae(payloadType: string, payload: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(
      `DSSEv1 ${String(Buffer.byteLength(payloadType))} ${payloadType} ${String(payload.length)} `,
      "utf8",
    ),
    payload,
  ]);
}

interface BoundedResponseV1 {
  readonly statusCode?: number | undefined;
  on: (event: string, listener: (chunk: Buffer) => void) => unknown;
  resume: () => unknown;
}

/**
 * Collect at most `maxBytes` from one response. A non-200 status, a transport
 * error, an empty body, or the first byte past the bound aborts the request and
 * yields the literal `unavailable`; a truncated body is never returned as
 * partial material.
 */
export function collectBoundedAdminCatalogResponseV1(
  response: BoundedResponseV1,
  maxBytes: number,
  abort: () => void,
): Promise<AdminCatalogHttpsResponseV1> {
  return new Promise<AdminCatalogHttpsResponseV1>((settle) => {
    let done = false;
    const finish = (value: AdminCatalogHttpsResponseV1): void => {
      if (done) return;
      done = true;
      settle(value);
    };
    if (response.statusCode !== 200) {
      response.resume();
      finish({ kind: "unavailable" });
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    response.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        abort();
        finish({ kind: "unavailable" });
        return;
      }
      chunks.push(chunk);
    });
    response.on("error", () => finish({ kind: "unavailable" }));
    response.on("end", () =>
      finish(
        size === 0 ? { kind: "unavailable" } : { kind: "available", bytes: Buffer.concat(chunks) },
      ),
    );
  });
}

/**
 * Bounded HTTPS GET with no redirect following, no credentials, and no retry.
 * Every acquisition failure — locator, connection, status, timeout, or size —
 * resolves to the literal `unavailable` the foundation requires for a tier
 * fall-through; nothing that fails here can become trusted material.
 */
export const defaultAdminCatalogHttpsFetchV1: AdminCatalogHttpsFetchV1 = (input) =>
  new Promise<AdminCatalogHttpsResponseV1>((settle) => {
    let done = false;
    const finish = (response: AdminCatalogHttpsResponseV1): void => {
      if (done) return;
      done = true;
      settle(response);
    };
    let target: URL;
    try {
      target = new URL(input.url);
    } catch {
      finish({ kind: "unavailable" });
      return;
    }
    if (target.protocol !== "https:") {
      finish({ kind: "unavailable" });
      return;
    }
    const call = httpsRequest(
      target,
      {
        method: "GET",
        headers: { accept: "application/octet-stream", "user-agent": "aih-admin-catalog" },
        timeout: input.timeoutMs,
      },
      (response) => {
        void collectBoundedAdminCatalogResponseV1(response, input.maxBytes, () =>
          call.destroy(),
        ).then(finish);
      },
    );
    call.on("error", () => finish({ kind: "unavailable" }));
    call.on("timeout", () => {
      call.destroy();
      finish({ kind: "unavailable" });
    });
    call.end();
  });

async function acquire(
  fetchHttps: AdminCatalogHttpsFetchV1,
  url: string,
  maxBytes: number,
): Promise<Buffer | undefined> {
  let response: AdminCatalogHttpsResponseV1;
  try {
    response = await fetchHttps({ maxBytes, timeoutMs: HTTPS_TIMEOUT_MS, url });
  } catch {
    return undefined;
  }
  if (
    typeof response !== "object" ||
    response === null ||
    response.kind !== "available" ||
    !Buffer.isBuffer(response.bytes) ||
    response.bytes.length === 0 ||
    response.bytes.length > maxBytes
  )
    return undefined;
  return Buffer.from(response.bytes);
}

/**
 * The exact async attestation adapter. It stages the acquired bytes in an
 * owner-only temporary directory, runs `gh attestation verify` bound to the
 * repository derived from the pinned catalog repository, and treats ANY
 * non-clean outcome — spawn failure, non-zero exit, signal, or truncated
 * output — as unverified. The subprocess output is never surfaced.
 */
async function verifyAttestationExactly(
  run: Runner,
  tempRoot: string,
  policy: {
    readonly gh: string;
    readonly issuer: string;
    readonly repository: string;
    readonly signerWorkflow: string;
    readonly sourceRef: string;
  },
  artifact: Buffer,
  attestation?: Buffer,
): Promise<boolean> {
  let staging: string;
  let verified = false;
  try {
    staging = mkdtempSync(join(tempRoot, "aih-admin-catalog-"));
  } catch {
    return false;
  }
  try {
    const artifactPath = join(staging, "artifact.json");
    writeFileSync(artifactPath, artifact, { flag: "wx", mode: 0o600 });
    const argv = [
      policy.gh,
      "attestation",
      "verify",
      artifactPath,
      "--repo",
      policy.repository,
      "--signer-workflow",
      policy.signerWorkflow,
      "--cert-oidc-issuer",
      policy.issuer,
      "--source-ref",
      policy.sourceRef,
      "--predicate-type",
      GITHUB_PROVENANCE_PREDICATE_TYPE,
    ];
    if (attestation !== undefined) {
      const bundlePath = join(staging, "attestation.jsonl");
      writeFileSync(bundlePath, attestation, { flag: "wx", mode: 0o600 });
      argv.push("--bundle", bundlePath);
    }
    const result = await run(argv, {
      cwd: staging,
      maxBufferBytes: GH_MAX_OUTPUT_BYTES,
      timeoutMs: GH_TIMEOUT_MS,
    });
    verified = result.spawnError !== true && result.truncated !== true && result.code === 0;
  } catch {
    verified = false;
  } finally {
    try {
      rmSync(staging, { force: true, recursive: true });
    } catch {
      verified = false;
    }
  }
  return verified;
}

function dsseEvidenceKey(paeBytes: Buffer, signatures: unknown): string | undefined {
  try {
    return `${paeBytes.toString("base64")}:${canonicalStrictJsonBytesV1(signatures).toString("base64")}`;
  } catch {
    return undefined;
  }
}

/** The canonical head PAE and signatures carried by one persisted catalog state. */
function headEvidenceOf(stateBytes: Buffer): string | undefined {
  try {
    const state = parseStrictJsonObjectV1(decodeUtf8(stateBytes), "catalog state");
    const envelope = parseStrictJsonObjectV1(
      decodeUtf8(Buffer.from(state.catalogHeadEnvelopeBytes as string, "base64")),
      "catalog head envelope",
    );
    const payload = Buffer.from(envelope.payload as string, "base64");
    if (payload.length === 0) return undefined;
    return dsseEvidenceKey(pae(envelope.payloadType as string, payload), envelope.signatures);
  } catch {
    return undefined;
  }
}

interface PresignedMaterial {
  readonly bytes: Buffer;
  readonly paeBytes: Buffer;
  readonly resolvedAt: string;
  readonly signature: { readonly keyid: string; readonly sig: string };
  readonly signaturesBytes: Buffer;
}

/**
 * Parse the material an external organization-admin OIDC workflow published and
 * bind it to the bootstrap. This recovers a signature and the instant that
 * workflow resolved at — never authority: nothing here is trusted until the
 * locally composed binding reproduces these exact PAE bytes.
 */
function presignedMaterial(bytes: Buffer, bootstrap: AdminCatalogBootstrapV1): PresignedMaterial {
  const distribution = parseAdminSeatDistributionV1Json(bytes);
  const envelope = distribution.envelope as Record<string, unknown>;
  const payload = Buffer.from(envelope.payload as string, "base64");
  const statement = parseStrictJsonObjectV1(decodeUtf8(payload), "admin statement");
  const predicate = statement.predicate as Record<string, unknown>;
  const binding = distribution.binding;
  if (
    predicate.signerIdentity !== bootstrap.expectedAdminSignerIdentity ||
    binding.adminSignerRootSha256 !== bootstrap.adminSignerRootSha256 ||
    binding.headSignerRootSha256 !== bootstrap.headSignerRootSha256 ||
    binding.catalogSha256 !== bootstrap.expectedCatalogSha256 ||
    binding.compatibleSchemaVersion !== bootstrap.expectedSchemaVersion ||
    binding.compatibleEffectVersion !== bootstrap.expectedEffectVersion
  )
    fail("pre-signed administrator material is not bound to this bootstrap");
  const signatures = envelope.signatures;
  if (!Array.isArray(signatures) || signatures.length !== 1) fail("pre-signed material");
  const signature = signatures[0] as { keyid: string; sig: string };
  return {
    bytes,
    paeBytes: pae(envelope.payloadType as string, payload),
    resolvedAt: binding.resolvedAt,
    signature: { keyid: signature.keyid, sig: signature.sig },
    signaturesBytes: canonicalStrictJsonBytesV1(signatures),
  };
}

function safeCacheDirectory(
  catalogRoot: string,
  directory: string,
  createMissing: boolean,
): boolean {
  const relativeDirectory = relative(catalogRoot, directory);
  if (
    relativeDirectory.length === 0 ||
    relativeDirectory.startsWith("..") ||
    isAbsolute(relativeDirectory) ||
    relativeDirectory.split(sep).includes("..")
  )
    return false;
  const segments = relativeDirectory.split(sep);
  let current = catalogRoot;
  try {
    const root = lstatSync(current);
    if (root.isSymbolicLink() || !root.isDirectory()) return false;
    for (const segment of segments) {
      if (segment.length === 0 || segment === ".") return false;
      current = join(current, segment);
      try {
        const info = lstatSync(current);
        if (info.isSymbolicLink() || !info.isDirectory()) return false;
      } catch {
        if (!createMissing) return true;
        mkdirSync(current, { mode: 0o700 });
        const created = lstatSync(current);
        if (created.isSymbolicLink() || !created.isDirectory()) return false;
      }
      if (process.platform !== "win32") chmodSync(current, 0o700);
    }
    return true;
  } catch {
    return false;
  }
}

interface DirectoryIdentity {
  readonly dev: number;
  readonly ino: number;
}

function directoryIdentity(path: string): DirectoryIdentity | undefined {
  try {
    const info = lstatSync(path);
    return info.isSymbolicLink() || !info.isDirectory()
      ? undefined
      : { dev: info.dev, ino: info.ino };
  } catch {
    return undefined;
  }
}

function sameDirectory(path: string, expected: DirectoryIdentity): boolean {
  const current = directoryIdentity(path);
  return current !== undefined && current.dev === expected.dev && current.ino === expected.ino;
}

function commitCacheSlot(catalogRoot: string, slot: string, bytes: Buffer): boolean {
  let temporary: string | undefined;
  try {
    const directory = dirname(slot);
    if (!safeCacheDirectory(catalogRoot, directory, true)) return false;
    const rootIdentity = directoryIdentity(catalogRoot);
    const cacheIdentity = directoryIdentity(directory);
    if (rootIdentity === undefined || cacheIdentity === undefined) return false;
    try {
      const existing = lstatSync(slot);
      if (existing.isSymbolicLink() || !existing.isFile()) return false;
    } catch {
      // The cache slot is absent; the owner-only temporary file is created below.
    }
    temporary = join(directory, `.${randomBytes(12).toString("hex")}.tmp`);
    writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 });
    chmodSync(temporary, 0o600);
    // Do not rename through a directory that has been replaced between the
    // containment check and write. lstat (not stat) keeps links non-traversable.
    if (
      !safeCacheDirectory(catalogRoot, directory, false) ||
      !sameDirectory(catalogRoot, rootIdentity) ||
      !sameDirectory(directory, cacheIdentity)
    )
      return false;
    renameSync(temporary, slot);
    return true;
  } catch {
    return false;
  } finally {
    if (temporary !== undefined) {
      try {
        rmSync(temporary, { force: true });
      } catch {
        // A scratch-file cleanup failure still leaves the cache commit failed above.
      }
    }
  }
}

function equals(value: unknown, expected: string): boolean {
  return typeof value === "string" && value === expected;
}

function environmentWithPath(env: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  return env === undefined ? process.env : env;
}

function signerWorkflowFor(workflow: string, repository: string, label: string): string {
  const prefix = `${repository}/.github/workflows/`;
  const filename = workflow.startsWith(prefix) ? workflow.slice(prefix.length) : "";
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.ya?ml$/.test(filename))
    fail(`${label} workflow identity cannot bind the GitHub signer workflow`);
  return workflow;
}

export async function resolveOperationalAdminCatalogV1(
  input: ResolveOperationalAdminCatalogV1Input,
): Promise<AdminCatalogProvenanceV1> {
  if (input.posture !== "vibe" && input.posture !== "enterprise") fail("posture");
  const wallClock = epochSeconds(input.now, "clock");
  const fetchHttps = input.fetchHttps ?? defaultAdminCatalogHttpsFetchV1;
  const run = input.run ?? defaultRunner;
  const tempRoot = input.tempRoot ?? tmpdir();

  const resolved = resolveAdminCatalogBootstrapV1({
    adminRoot: input.adminRoot,
    platformAdminRoot: input.platformAdminRoot ?? enterpriseAdminCatalogRootV1(process.platform),
    posture: input.posture,
  });
  const bootstrap = resolved.bootstrap;
  const attestationRepository = adminCatalogAttestationRepositoryV1(bootstrap);
  const signerWorkflow = signerWorkflowFor(
    bootstrap.expectedWorkflowIdentity,
    attestationRepository,
    "catalog",
  );
  const adminSignerWorkflow = signerWorkflowFor(
    bootstrap.expectedAdminWorkflowIdentity,
    attestationRepository,
    "admin",
  );
  const gh = findOnPath("gh", environmentWithPath(input.env), process.platform, {
    excludeRoot: input.posture === "enterprise" ? resolved.catalogRoot : input.adminRoot,
    windowsExeOnly: true,
  });
  if (gh === undefined) fail("GitHub attestation verifier is unavailable on absolute PATH");
  const attestationPolicy = {
    gh,
    issuer: bootstrap.expectedIssuer,
    repository: attestationRepository,
    signerWorkflow,
    sourceRef: bootstrap.expectedRef,
  };
  const adminAttestationPolicy = { ...attestationPolicy, signerWorkflow: adminSignerWorkflow };

  // 1. The pre-signed administrator material. It is REQUIRED: it is not a
  //    catalog tier, so its absence is fatal rather than a fall-through.
  const distributionBytes = await acquire(
    fetchHttps,
    bootstrap.signedDistributionUrl,
    MAX_DISTRIBUTION_BYTES,
  );
  if (distributionBytes === undefined) fail("pre-signed administrator material is unavailable");
  const distributionAttestation = await acquire(
    fetchHttps,
    bootstrap.signedDistributionAttestationUrl,
    MAX_ATTESTATION_BYTES,
  );
  if (distributionAttestation === undefined)
    fail("pre-signed administrator material attestation is unavailable");
  let presigned: PresignedMaterial;
  try {
    presigned = presignedMaterial(distributionBytes, bootstrap);
  } catch (error) {
    if (error instanceof AihError) throw error;
    fail("pre-signed administrator material is malformed");
  }
  if (
    !(await verifyAttestationExactly(
      run,
      tempRoot,
      adminAttestationPolicy,
      distributionBytes,
      distributionAttestation,
    ))
  )
    fail("pre-signed administrator material attestation rejected");
  const resolvedAt = epochSeconds(presigned.resolvedAt, "resolved at");
  if (resolvedAt > wallClock) fail("pre-signed administrator material is future dated");
  if (wallClock - resolvedAt > bootstrap.cacheMaxAgeSeconds)
    fail("pre-signed administrator material is stale for the pinned cache policy");

  // 2. Fresh acquisition, then the verified cache only when fresh is literally
  //    unavailable — the same order the foundation itself walks.
  const freshArtifact = await acquire(fetchHttps, bootstrap.catalogArtifactUrl, MAX_ARTIFACT_BYTES);
  const freshAttestation =
    freshArtifact === undefined
      ? undefined
      : await acquire(fetchHttps, bootstrap.catalogAttestationUrl, MAX_ATTESTATION_BYTES);
  const cacheSlot = adminCatalogCacheSlotPathV1(resolved.catalogRoot, bootstrap);
  const cachedBytes =
    (freshArtifact !== undefined && freshAttestation !== undefined) ||
    !safeCacheDirectory(resolved.catalogRoot, dirname(cacheSlot), false)
      ? undefined
      : readRegularFile(cacheSlot, { maxBytes: MAX_CACHE_BYTES });

  // 3. Complete every attestation verification BEFORE any synchronous callback
  //    is handed to the foundation. CatalogHead DSSE evidence is deliberately
  //    pinned only from bootstrap-carried state: outer artifact provenance
  //    cannot authorize a replacement inner head signature.
  const attestations = new Map<string, boolean>();
  const headEvidence = new Set<string>();
  for (const trusted of [
    bootstrap.lastGoodCatalogStateBytes,
    bootstrap.packagedCatalogStateBytes,
  ]) {
    const evidence = headEvidenceOf(Buffer.from(trusted, "base64"));
    if (evidence !== undefined) headEvidence.add(evidence);
  }
  const candidates: { artifact: Buffer; attestation: Buffer }[] = [];
  if (freshArtifact !== undefined && freshAttestation !== undefined)
    candidates.push({ artifact: freshArtifact, attestation: freshAttestation });
  if (cachedBytes !== undefined) {
    try {
      const cache = parseAdminCatalogCacheRecordV1Json(cachedBytes);
      candidates.push({
        artifact: Buffer.from(cache.artifactBytes, "base64"),
        attestation: Buffer.from(cache.attestationBytes, "base64"),
      });
    } catch {
      // A cache record that will not parse stays fatal inside the foundation.
    }
  }
  for (const candidate of candidates) {
    const key = `${sha256(candidate.artifact)}:${sha256(candidate.attestation)}`;
    if (attestations.has(key)) continue;
    const verified = await verifyAttestationExactly(
      run,
      tempRoot,
      attestationPolicy,
      candidate.artifact,
      candidate.attestation,
    );
    attestations.set(key, verified);
  }

  // 4. Synchronous, allowlist-backed seams only.
  const fresh =
    freshArtifact !== undefined && freshAttestation !== undefined
      ? {
          artifactBytes: freshArtifact,
          attestationBytes: freshAttestation,
          claimedArtifactSha256: sha256(freshArtifact),
          kind: "available" as const,
        }
      : { kind: "unavailable" as const };

  let result: Awaited<ReturnType<typeof resolveAdminCatalogFetchV1>>;
  try {
    result = await resolveAdminCatalogFetchV1({
      adminSignerRootSha256: bootstrap.adminSignerRootSha256,
      channel: bootstrap.channel,
      commitVerifiedCache: (value: unknown) => {
        const item = value as { cacheRecordBytes?: unknown };
        return Buffer.isBuffer(item.cacheRecordBytes)
          ? commitCacheSlot(resolved.catalogRoot, cacheSlot, item.cacheRecordBytes)
          : false;
      },
      expectedAdminSignerIdentity: bootstrap.expectedAdminSignerIdentity,
      expectedCatalogSha256: bootstrap.expectedCatalogSha256,
      expectedCatalogSignerIdentity: bootstrap.expectedCatalogSignerIdentity,
      expectedEffectVersion: bootstrap.expectedEffectVersion,
      expectedEnvironment: bootstrap.expectedEnvironment,
      expectedIssuer: bootstrap.expectedIssuer,
      expectedPackageRootSha256: bootstrap.expectedPackageRootSha256,
      expectedPackageSha256: bootstrap.expectedPackageSha256,
      expectedPromotionDecisionSha256: bootstrap.expectedPromotionDecisionSha256,
      expectedRef: bootstrap.expectedRef,
      expectedRepository: bootstrap.expectedRepository,
      expectedSchemaVersion: bootstrap.expectedSchemaVersion,
      expectedWorkflowIdentity: bootstrap.expectedWorkflowIdentity,
      fetchFresh: () => fresh,
      headSignerRootSha256: bootstrap.headSignerRootSha256,
      lastGoodCatalogStateBytes: Buffer.from(bootstrap.lastGoodCatalogStateBytes, "base64"),
      // `now` remains the workstation wall clock for head validity and cache
      // age. The distinct pre-signed instant reproduces only the signed binding.
      bindingResolvedAt: presigned.resolvedAt,
      now: input.now,
      packagedCatalogStateBytes: Buffer.from(bootstrap.packagedCatalogStateBytes, "base64"),
      readVerifiedCache: () =>
        cachedBytes === undefined ? { kind: "unavailable" } : Buffer.from(cachedBytes),
      // Never signs. Returns the external signature only on exact PAE equality.
      signCanonicalPae: (value: unknown) => {
        const item = value as Record<string, unknown>;
        if (
          !equals(item.protocol, "AdminSeatDistributionV1") ||
          !equals(item.expectedAdminSignerIdentity, bootstrap.expectedAdminSignerIdentity) ||
          !equals(item.expectedAdminSignerRootSha256, bootstrap.adminSignerRootSha256) ||
          !Buffer.isBuffer(item.paeBytes) ||
          item.paeBytes.compare(presigned.paeBytes) !== 0
        )
          fail("pre-signed administrator material does not cover the composed binding");
        return { keyid: presigned.signature.keyid, sig: presigned.signature.sig };
      },
      sourceId: bootstrap.sourceId,
      verifyArtifactAttestation: (value: unknown) => {
        const item = value as Record<string, unknown>;
        if (
          !equals(item.channel, bootstrap.channel) ||
          !equals(item.sourceId, bootstrap.sourceId) ||
          !equals(item.expectedCatalogSignerIdentity, bootstrap.expectedCatalogSignerIdentity) ||
          !equals(item.expectedEnvironment, bootstrap.expectedEnvironment) ||
          !equals(item.expectedIssuer, bootstrap.expectedIssuer) ||
          !equals(item.expectedRef, bootstrap.expectedRef) ||
          !equals(item.expectedRepository, bootstrap.expectedRepository) ||
          !equals(item.expectedWorkflowIdentity, bootstrap.expectedWorkflowIdentity) ||
          !equals(item.headSignerRootSha256, bootstrap.headSignerRootSha256) ||
          typeof item.artifactSha256 !== "string" ||
          !Buffer.isBuffer(item.attestationBytes)
        )
          return false;
        return attestations.get(`${item.artifactSha256}:${sha256(item.attestationBytes)}`) === true;
      },
      verifyCanonicalPae: (value: unknown) => {
        const item = value as Record<string, unknown>;
        return (
          equals(item.expectedAdminSignerIdentity, bootstrap.expectedAdminSignerIdentity) &&
          equals(item.expectedAdminSignerRootSha256, bootstrap.adminSignerRootSha256) &&
          Buffer.isBuffer(item.paeBytes) &&
          item.paeBytes.compare(presigned.paeBytes) === 0 &&
          canonicalStrictJsonBytesV1(item.signatures).compare(presigned.signaturesBytes) === 0
        );
      },
      verifyCatalogHeadPae: (value: unknown) => {
        const item = value as Record<string, unknown>;
        return (
          equals(item.repository, bootstrap.expectedRepository) &&
          equals(item.workflowIdentity, bootstrap.expectedWorkflowIdentity) &&
          equals(item.issuer, bootstrap.expectedIssuer) &&
          equals(item.ref, bootstrap.expectedRef) &&
          equals(item.environment, bootstrap.expectedEnvironment) &&
          equals(item.expectedCatalogSignerIdentity, bootstrap.expectedCatalogSignerIdentity) &&
          equals(item.expectedSignerRootSha256, bootstrap.headSignerRootSha256) &&
          Buffer.isBuffer(item.paeBytes) &&
          (() => {
            const key = dsseEvidenceKey(item.paeBytes as Buffer, item.signatures);
            return key !== undefined && headEvidence.has(key);
          })()
        );
      },
    });
  } catch (error) {
    if (error instanceof AihError) throw error;
    const message = error instanceof Error ? error.message : "";
    fail(SAFE_REASON.test(message) ? message : "verified catalog resolution failed");
  }

  // 5. The composed binding must reproduce the externally signed bytes exactly.
  if (canonicalAdminSeatDistributionV1Bytes(result.distribution).compare(presigned.bytes) !== 0)
    fail("composed distribution does not reproduce the pre-signed material");
  return deepFreezeStrictJsonV1({
    ageSeconds: result.ageSeconds,
    bootstrapProvenance: resolved.provenance,
    catalogSha256: result.catalogSha256,
    channel: bootstrap.channel,
    headDigestSha256: result.headDigestSha256,
    memberCount: result.distribution.binding.members.length,
    posture: input.posture,
    resolvedAt: presigned.resolvedAt,
    sequence: result.sequence,
    sourceId: bootstrap.sourceId,
    tier: result.tier,
    verifiedAt: result.verifiedAt,
  }) as AdminCatalogProvenanceV1;
}
