import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { canonicalStrictJsonBytesV1 } from "../../src/contract/strict-json-v1.js";
import {
  canonicalAdminCatalogArtifactV1Bytes,
  canonicalAdminCatalogCacheRecordV1Bytes,
  parseAdminCatalogArtifactV1Json,
  parseAdminCatalogCacheRecordV1Json,
  resolveAdminCatalogFetchV1,
} from "../../src/org-policy/admin-catalog-fetch-v1.js";

const sha = (value: Buffer | string): string => createHash("sha256").update(value).digest("hex");
const headRoot = sha("catalog head root");
const adminRoot = sha("admin root");
const packageSha256 = sha("supported catalog package");
const packageRootSha256 = sha("supported catalog package root");
const sourceId = "supported-catalog";
const channel = "stable";
const repository = "github.com/aih/supported-catalog";
const workflowIdentity = "workflow:catalog-release-v1";
const issuer = "https://token.actions.githubusercontent.com";
const ref = "refs/heads/main";
const environment = "catalog-release";
const catalogSignerIdentity = "signer:catalog-head-v1";
const adminSignerIdentity = "signer:admin-seat-v1";
const now = "2026-08-17T12:00:00Z";
const downloadedAt = "2026-08-17T11:59:30Z";

function member(overrides: Record<string, unknown> = {}) {
  return {
    candidateIdentitySha256: sha("candidate identity"),
    candidateSha256: sha("candidate"),
    componentId: "skill:catalog-example",
    evidenceSha256: sha("evidence"),
    gitCommitSha256: sha("commit"),
    pinSha256: sha("pin"),
    policyRevisionSha256: sha("policy"),
    profileSha256: sha("profile"),
    promotionDecisionSha256: sha("promotion"),
    qualificationBundleSha256: sha("qualification"),
    recipeSha256: sha("recipe"),
    repository,
    sourceId,
    sourceSha256: sha("source"),
    ...overrides,
  };
}

function state(kind: "CachedCatalogStateV1" | "PackagedCatalogStateV1" = "CachedCatalogStateV1") {
  const snapshotBytes = canonicalStrictJsonBytesV1({
    members: [member()],
    protocol: "CatalogSnapshotV1",
  });
  const head = {
    catalogSha256: sha(snapshotBytes),
    compatibleEffectVersions: ["1"],
    compatibleSchemaVersions: ["1"],
    previousCatalogHeadSha256: sha("previous head"),
    promotionDecisionSha256: sha("promotion"),
    protocol: "CatalogHeadV1",
    sequence: 42,
    signerIdentity: catalogSignerIdentity,
    validFrom: "2026-08-17T00:00:00Z",
    validUntil: "2026-08-18T00:00:00Z",
  };
  const catalogHeadBytes = canonicalStrictJsonBytesV1(head);
  const statementBytes = canonicalStrictJsonBytesV1({
    _type: "https://in-toto.io/Statement/v1",
    predicate: {
      environment,
      issuer,
      protocol: "CatalogHeadEnvelopeV1",
      recordType: "CatalogHeadV1",
      repository,
      signerIdentity: catalogSignerIdentity,
      workflowIdentity,
    },
    predicateType: "https://aih.dev/CatalogHeadV1",
    subject: [{ digest: { sha256: sha(catalogHeadBytes) }, name: "aih/CatalogHeadV1" }],
  });
  const catalogHeadEnvelopeBytes = canonicalStrictJsonBytesV1({
    payload: statementBytes.toString("base64"),
    payloadType: "application/vnd.in-toto+json",
    signatures: [{ keyid: "head-key-1", sig: "aGVhZC1zaWc=" }],
  });
  return {
    catalogHeadBytes,
    catalogHeadEnvelopeBytes,
    catalogHeadEnvelopeSha256: sha(catalogHeadEnvelopeBytes),
    catalogHeadSha256: sha(catalogHeadBytes),
    catalogSnapshotBytes: snapshotBytes,
    catalogSnapshotSha256: sha(snapshotBytes),
    ...(kind === "PackagedCatalogStateV1" ? { packageRootSha256, packageSha256 } : {}),
    protocol: kind,
    signerRootSha256: headRoot,
    verifiedAt: downloadedAt,
  };
}

function authorityCacheKey(): string {
  return sha(
    canonicalStrictJsonBytesV1({
      domain: "aih.admin-catalog-fetch-cache-key-v1",
      value: {
        catalogSignerIdentity,
        channel,
        environment,
        issuer,
        packageRootSha256,
        packageSha256,
        ref,
        repository,
        sourceId,
        workflowIdentity,
      },
    }),
  );
}

function artifact(overrides: Record<string, unknown> = {}) {
  const catalogStateBytes = canonicalStrictJsonBytesV1(state());
  return {
    authorityCacheKeySha256: authorityCacheKey(),
    catalogStateBytes: catalogStateBytes.toString("base64"),
    catalogStateSha256: sha(catalogStateBytes),
    channel,
    packageRootSha256,
    packageSha256,
    protocol: "AdminCatalogArtifactV1",
    sourceId,
    ...overrides,
  };
}

function artifactBytes(overrides: Record<string, unknown> = {}): Buffer {
  return canonicalStrictJsonBytesV1(artifact(overrides));
}

function cacheRecord(overrides: Record<string, unknown> = {}) {
  const bytes = artifactBytes();
  const attestationBytes = Buffer.from("canonical-test-attestation", "utf8");
  return {
    artifactBytes: bytes.toString("base64"),
    artifactSha256: sha(bytes),
    attestationBytes: attestationBytes.toString("base64"),
    authorityCacheKeySha256: authorityCacheKey(),
    downloadedAt,
    protocol: "AdminCatalogCacheRecordV1",
    ...overrides,
  };
}

function cacheRecordBytes(overrides: Record<string, unknown> = {}): Buffer {
  return canonicalStrictJsonBytesV1(cacheRecord(overrides));
}

function input(overrides: Record<string, unknown> = {}) {
  const bytes = artifactBytes();
  const attestationBytes = Buffer.from("canonical-test-attestation", "utf8");
  return {
    adminSignerRootSha256: adminRoot,
    authorityCacheKeySha256: authorityCacheKey(),
    cachedVerified: { kind: "unavailable" },
    channel,
    expectedAdminSignerIdentity: adminSignerIdentity,
    expectedCatalogSha256: state().catalogSnapshotSha256 as string,
    expectedCatalogSignerIdentity: catalogSignerIdentity,
    expectedEffectVersion: "1",
    expectedEnvironment: environment,
    expectedIssuer: issuer,
    expectedPackageRootSha256: packageRootSha256,
    expectedPackageSha256: packageSha256,
    expectedPromotionDecisionSha256: sha("promotion"),
    expectedRef: ref,
    expectedRepository: repository,
    expectedSchemaVersion: "1",
    expectedWorkflowIdentity: workflowIdentity,
    fetchFresh: vi.fn(() => ({
      artifactBytes: bytes,
      attestationBytes,
      claimedArtifactSha256: sha(bytes),
      kind: "available",
    })),
    headSignerRootSha256: headRoot,
    lastGood: state(),
    maxArtifactBytes: 64 * 1024,
    maxAttestationBytes: 16 * 1024,
    now,
    packaged: state("PackagedCatalogStateV1"),
    readVerifiedCache: vi.fn(() => ({ kind: "unavailable" })),
    signCanonicalPae: vi.fn(() => ({ keyid: "admin-key-1", sig: "YWRtaW4tc2ln" })),
    sourceId,
    timeoutMs: 5_000,
    verifyArtifactAttestation: vi.fn(() => true),
    verifyCatalogHeadPae: vi.fn(() => true),
    verifyCanonicalPae: vi.fn(() => true),
    commitVerifiedCache: vi.fn(() => true),
    ...overrides,
  };
}

function reject(value: unknown): void {
  expect(() => parseAdminCatalogArtifactV1Json(value)).toThrow();
}

describe("admin catalog fetch foundation V1", () => {
  it("accepts only canonical branded artifact and cache-record bytes", () => {
    const bytes = artifactBytes();
    const parsed = parseAdminCatalogArtifactV1Json(bytes);
    expect(canonicalAdminCatalogArtifactV1Bytes(parsed)).toEqual(bytes);
    expect(parseAdminCatalogArtifactV1Json(new Uint8Array(bytes))).toEqual(parsed);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(() => canonicalAdminCatalogArtifactV1Bytes({ ...parsed })).toThrow();

    const cacheBytes = cacheRecordBytes();
    const cache = parseAdminCatalogCacheRecordV1Json(cacheBytes);
    expect(canonicalAdminCatalogCacheRecordV1Bytes(cache)).toEqual(cacheBytes);
    expect(() => canonicalAdminCatalogCacheRecordV1Bytes({ ...cache })).toThrow();
    expect(Object.isFrozen(cache)).toBe(true);

    const changed = Buffer.from(bytes);
    const first = changed[0];
    if (first === undefined) throw new Error("expected nonempty artifact bytes");
    changed[0] = first ^ 1;
    expect(() => parseAdminCatalogArtifactV1Json(changed)).toThrow();
  });

  it("rejects noncanonical, hostile, oversized, and cross-bound artifact/cache records", () => {
    const bytes = artifactBytes();
    const reordered = Buffer.from(
      bytes.toString("utf8").replace('{"authority', '{"channel":"stable","authority'),
    );
    const alternateEscape = Buffer.from(bytes.toString("utf8").replace("stable", "st\\u0061ble"));
    const badArtifacts: unknown[] = [
      reordered,
      alternateEscape,
      Buffer.from(
        '{"protocol":"AdminCatalogArtifactV1","protocol":"AdminCatalogArtifactV1"}',
        "utf8",
      ),
      Buffer.from([0xff, 0xfe]),
      artifactBytes({ authorityCacheKeySha256: "A".repeat(64) }),
      artifactBytes({ channel: "STABLE" }),
      artifactBytes({ sourceId: "source/../alias" }),
      artifactBytes({ packageSha256: `sha256:${packageSha256}` }),
      artifactBytes({ unexpected: true }),
      Buffer.alloc(64 * 1024 + 1, 0x61),
    ];
    for (const bad of badArtifacts) reject(bad);
    for (const bad of [
      cacheRecordBytes({ authorityCacheKeySha256: sha("other cache") }),
      cacheRecordBytes({ artifactSha256: sha("wrong artifact") }),
      cacheRecordBytes({ downloadedAt: "2026-02-30T00:00:00Z" }),
      canonicalStrictJsonBytesV1({ protocol: "AdminCatalogCacheRecordV1" }),
    ])
      expect(() => parseAdminCatalogCacheRecordV1Json(bad)).toThrow();

    const accessor = Object.create(null, {
      protocol: { enumerable: true, get: () => "AdminCatalogArtifactV1" },
    });
    expect(() => parseAdminCatalogArtifactV1Json(accessor)).toThrow();
    const cyclic: Record<string, unknown> = { protocol: "AdminCatalogArtifactV1" };
    cyclic.self = cyclic;
    expect(() => parseAdminCatalogArtifactV1Json(cyclic)).toThrow();
  });

  it("recomputes the fetched digest, verifies exact authority/cache binding, commits before signing, and returns closed fresh provenance", async () => {
    const calls: string[] = [];
    const values = input({
      commitVerifiedCache: vi.fn((request: Record<string, unknown>) => {
        calls.push("commit");
        expect(request.authorityCacheKeySha256).toBe(authorityCacheKey());
        expect(request.cacheRecordBytes).toEqual(cacheRecordBytes());
        return true;
      }),
      signCanonicalPae: vi.fn(() => {
        calls.push("sign");
        return { keyid: "admin-key-1", sig: "YWRtaW4tc2ln" };
      }),
      verifyArtifactAttestation: vi.fn((request: Record<string, unknown>) => {
        calls.push("attest");
        expect(Object.keys(request).sort()).toEqual([
          "artifactSha256",
          "attestationBytes",
          "authorityCacheKeySha256",
          "channel",
          "sourceId",
        ]);
        expect(request.artifactSha256).toBe(sha(artifactBytes()));
        expect(request.authorityCacheKeySha256).toBe(authorityCacheKey());
        expect(request.sourceId).toBe(sourceId);
        expect(request.channel).toBe(channel);
        return true;
      }),
    });

    const result = await resolveAdminCatalogFetchV1(values);

    expect(calls).toEqual(["attest", "commit", "sign"]);
    expect(values.fetchFresh).toHaveBeenCalledOnce();
    expect(values.fetchFresh).toHaveBeenCalledWith({
      authorityCacheKeySha256: authorityCacheKey(),
      maxArtifactBytes: 64 * 1024,
      maxAttestationBytes: 16 * 1024,
      timeoutMs: 5_000,
    });
    expect(result).toMatchObject({
      ageSeconds: 30,
      catalogSha256: state().catalogSnapshotSha256,
      downloadedAt,
      headDigestSha256: state().catalogHeadSha256,
      sequence: 42,
      tier: "fresh",
      verifiedAt: downloadedAt,
    });
    expect(Object.keys(result).sort()).toEqual([
      "ageSeconds",
      "catalogSha256",
      "distribution",
      "downloadedAt",
      "headDigestSha256",
      "sequence",
      "tier",
      "verifiedAt",
    ]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.distribution)).toBe(true);
  });

  it("uses only literal unavailable for the verified-cache then packaged fallthrough", async () => {
    const cache = cacheRecordBytes();
    const cached = input({
      fetchFresh: vi.fn(() => ({ kind: "unavailable" })),
      readVerifiedCache: vi.fn(() => cache),
    });
    const fromCache = await resolveAdminCatalogFetchV1(cached);
    expect(fromCache).toMatchObject({ tier: "cached-verified", downloadedAt, ageSeconds: 30 });
    expect(cached.commitVerifiedCache).not.toHaveBeenCalled();

    const packaged = input({
      fetchFresh: vi.fn(() => ({ kind: "unavailable" })),
      readVerifiedCache: vi.fn(() => ({ kind: "unavailable" })),
    });
    const fromPackage = await resolveAdminCatalogFetchV1(packaged);
    expect(fromPackage).toMatchObject({ tier: "packaged", downloadedAt: null, ageSeconds: null });
    expect(packaged.verifyArtifactAttestation).not.toHaveBeenCalled();
  });

  it("fails terminally before lower tiers or signing for malformed, unavailable-like, expired, skewed, swapped, or uncommitted fresh data", async () => {
    const cases: Array<Record<string, unknown>> = [
      { fetchFresh: () => ({ kind: "Unavailable" }) },
      { fetchFresh: () => ({ kind: "unavailable", extra: true }) },
      {
        fetchFresh: () => ({
          kind: "available",
          artifactBytes: artifactBytes(),
          attestationBytes: Buffer.from("x"),
          claimedArtifactSha256: sha("wrong"),
        }),
      },
      { verifyArtifactAttestation: () => false },
      { commitVerifiedCache: () => false },
      {
        commitVerifiedCache: () => {
          throw new Error("cache write failed");
        },
      },
      {
        fetchFresh: () => {
          throw new Error("provider failure");
        },
      },
      {
        fetchFresh: () => ({
          kind: "available",
          artifactBytes: artifactBytes({ channel: "other" }),
          attestationBytes: Buffer.from("x"),
          claimedArtifactSha256: sha(artifactBytes({ channel: "other" })),
        }),
      },
      {
        fetchFresh: () => ({
          kind: "available",
          artifactBytes: artifactBytes(),
          attestationBytes: Buffer.alloc(16 * 1024 + 1),
          claimedArtifactSha256: sha(artifactBytes()),
        }),
      },
      { now: "2026-08-18T00:00:00Z" },
    ];
    for (const changed of cases) {
      const values = input({
        ...changed,
        cachedVerified: cacheRecordBytes(),
        readVerifiedCache: vi.fn(() => cacheRecordBytes()),
      });
      await expect(resolveAdminCatalogFetchV1(values)).rejects.toThrow();
      expect(values.readVerifiedCache).not.toHaveBeenCalled();
      expect(values.signCanonicalPae).not.toHaveBeenCalled();
      expect(values.verifyCanonicalPae).not.toHaveBeenCalled();
    }
  });

  it("treats cache mutation, wrong attestation key, future age, and trusted-input accessors as fatal without callback leakage", async () => {
    for (const changed of [
      { authorityCacheKeySha256: sha("wrong key") },
      { artifactSha256: sha("substituted") },
      { downloadedAt: "2026-08-17T12:00:01Z" },
      { attestationBytes: Buffer.from("substituted attestation").toString("base64") },
    ]) {
      const values = input({
        fetchFresh: () => ({ kind: "unavailable" }),
        readVerifiedCache: () => cacheRecordBytes(changed),
      });
      await expect(resolveAdminCatalogFetchV1(values)).rejects.toThrow();
      expect(values.signCanonicalPae).not.toHaveBeenCalled();
    }
    let getterCalls = 0;
    const hostile = Object.create(null, {
      sourceId: {
        enumerable: true,
        get: () => {
          getterCalls += 1;
          return sourceId;
        },
      },
    });
    await expect(resolveAdminCatalogFetchV1(hostile)).rejects.toThrow();
    expect(getterCalls).toBe(0);
  });

  it("remains an internal capability-free foundation with no transport locator or seat/runtime route", () => {
    const path = resolve("src/org-policy/admin-catalog-fetch-v1.ts");
    expect(existsSync(path)).toBe(true);
    const source = readFileSync(path, "utf8");
    expect(source).not.toMatch(
      /from\s+["'][^"']*(?:index|commands|generate|studio-model|studio-template|admin-distribution|runtime|seat)[^"']*["']/i,
    );
    expect(source).not.toMatch(
      /node:(?:fs|path|os|https|http|net|tls|child_process|dgram)|\b(?:fetch|spawn|exec|fork|process\.env|URL|writeFile|readFile)\b/i,
    );
  });
});
