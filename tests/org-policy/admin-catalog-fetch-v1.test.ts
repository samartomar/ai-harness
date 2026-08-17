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
const MAX_ARTIFACT_BYTES = 64 * 1024;
const MAX_ATTESTATION_BYTES = 16 * 1024;
const MAX_CACHE_BYTES = 96 * 1024;
const EXPECTED_AUTHORITY_CACHE_KEY =
  "ef3a0c9a1dc785be98a0a1d559e373bd9f75a0775fca89d3ab837939643fd0db";

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

function persistedState(
  kind: "CachedCatalogStateV1" | "PackagedCatalogStateV1" = "CachedCatalogStateV1",
) {
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
    catalogHeadBytes: catalogHeadBytes.toString("base64"),
    catalogHeadEnvelopeBytes: catalogHeadEnvelopeBytes.toString("base64"),
    catalogHeadEnvelopeSha256: sha(catalogHeadEnvelopeBytes),
    catalogHeadSha256: sha(catalogHeadBytes),
    catalogSnapshotBytes: snapshotBytes.toString("base64"),
    catalogSnapshotSha256: sha(snapshotBytes),
    ...(kind === "PackagedCatalogStateV1" ? { packageRootSha256, packageSha256 } : {}),
    protocol: kind,
    signerRootSha256: headRoot,
    verifiedAt: downloadedAt,
  };
}

function expectedCatalogSha256(): string {
  return persistedState().catalogSnapshotSha256;
}

function authorityCacheKey(overrides: Record<string, unknown> = {}): string {
  const value = {
    catalogSignerIdentity,
    channel,
    expectedCatalogSha256: expectedCatalogSha256(),
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
    headSignerRootSha256: headRoot,
    sourceId,
    ...overrides,
  };
  return sha(
    canonicalStrictJsonBytesV1({
      domain: "aih.admin-catalog-fetch-cache-key-v1",
      value,
    }),
  );
}

function artifact(overrides: Record<string, unknown> = {}) {
  const catalogStateBytes = canonicalStrictJsonBytesV1(persistedState());
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
    channel,
    expectedAdminSignerIdentity: adminSignerIdentity,
    expectedCatalogSha256: expectedCatalogSha256(),
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
    lastGoodCatalogStateBytes: canonicalStrictJsonBytesV1(persistedState()),
    now,
    packagedCatalogStateBytes: canonicalStrictJsonBytesV1(persistedState("PackagedCatalogStateV1")),
    readVerifiedCache: vi.fn(() => ({ kind: "unavailable" })),
    signCanonicalPae: vi.fn(() => ({ keyid: "admin-key-1", sig: "YWRtaW4tc2ln" })),
    sourceId,
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
  it("derives the catalog-side authority/cache key from every trusted catalog field, not admin identity", () => {
    expect(authorityCacheKey()).toBe(EXPECTED_AUTHORITY_CACHE_KEY);
    for (const changed of [
      { sourceId: "changed-source" },
      { channel: "preview" },
      { expectedRepository: "github.com/aih/other-catalog" },
      { expectedWorkflowIdentity: "workflow:other-v1" },
      { expectedIssuer: "https://issuer.example" },
      { expectedRef: "refs/heads/release" },
      { expectedEnvironment: "other-environment" },
      { catalogSignerIdentity: "signer:other-v1" },
      { headSignerRootSha256: sha("other root") },
      { expectedCatalogSha256: sha("other catalog") },
      { expectedPromotionDecisionSha256: sha("other promotion") },
      { expectedPackageSha256: sha("other package") },
      { expectedPackageRootSha256: sha("other package root") },
      { expectedSchemaVersion: "2" },
      { expectedEffectVersion: "2" },
    ])
      expect(authorityCacheKey(changed)).not.toBe(EXPECTED_AUTHORITY_CACHE_KEY);

    const changedAdmin = input({
      adminSignerRootSha256: sha("other admin root"),
      expectedAdminSignerIdentity: "signer:other-admin-v1",
    });
    expect(authorityCacheKey()).toBe(EXPECTED_AUTHORITY_CACHE_KEY);
    expect(changedAdmin.adminSignerRootSha256).not.toBe(adminRoot);
    expect(changedAdmin.expectedAdminSignerIdentity).not.toBe(adminSignerIdentity);
  });

  it("passes the derived authority key to the fresh seam for every trusted catalog input", async () => {
    const mutations: Array<{
      input: Record<string, unknown>;
      key: Record<string, unknown>;
    }> = [
      { input: { sourceId: "changed-source" }, key: { sourceId: "changed-source" } },
      { input: { channel: "preview" }, key: { channel: "preview" } },
      {
        input: { expectedRepository: "github.com/aih/other-catalog" },
        key: { expectedRepository: "github.com/aih/other-catalog" },
      },
      {
        input: { expectedWorkflowIdentity: "workflow:other-v1" },
        key: { expectedWorkflowIdentity: "workflow:other-v1" },
      },
      {
        input: { expectedIssuer: "https://issuer.example" },
        key: { expectedIssuer: "https://issuer.example" },
      },
      { input: { expectedRef: "refs/heads/release" }, key: { expectedRef: "refs/heads/release" } },
      {
        input: { expectedEnvironment: "other-environment" },
        key: { expectedEnvironment: "other-environment" },
      },
      {
        input: { expectedCatalogSignerIdentity: "signer:other-v1" },
        key: { catalogSignerIdentity: "signer:other-v1" },
      },
      {
        input: { headSignerRootSha256: sha("other root") },
        key: { headSignerRootSha256: sha("other root") },
      },
      {
        input: { expectedCatalogSha256: sha("other catalog") },
        key: { expectedCatalogSha256: sha("other catalog") },
      },
      {
        input: { expectedPromotionDecisionSha256: sha("other promotion") },
        key: { expectedPromotionDecisionSha256: sha("other promotion") },
      },
      {
        input: { expectedPackageSha256: sha("other package") },
        key: { expectedPackageSha256: sha("other package") },
      },
      {
        input: { expectedPackageRootSha256: sha("other package root") },
        key: { expectedPackageRootSha256: sha("other package root") },
      },
      { input: { expectedSchemaVersion: "2" }, key: { expectedSchemaVersion: "2" } },
      { input: { expectedEffectVersion: "2" }, key: { expectedEffectVersion: "2" } },
    ];
    for (const mutation of mutations) {
      const values = input({
        ...mutation.input,
        fetchFresh: vi.fn((request: Record<string, unknown>) => {
          expect(request.authorityCacheKeySha256).toBe(authorityCacheKey(mutation.key));
          return { kind: "unavailable" };
        }),
      });
      await expect(resolveAdminCatalogFetchV1(values)).rejects.toThrow();
      expect(values.fetchFresh).toHaveBeenCalledOnce();
    }

    for (const changedAdmin of [
      { adminSignerRootSha256: sha("other admin root") },
      { expectedAdminSignerIdentity: "signer:other-admin-v1" },
    ]) {
      const values = input({
        ...changedAdmin,
        fetchFresh: vi.fn((request: Record<string, unknown>) => {
          expect(request.authorityCacheKeySha256).toBe(EXPECTED_AUTHORITY_CACHE_KEY);
          return { kind: "unavailable" };
        }),
      });
      await expect(resolveAdminCatalogFetchV1(values)).rejects.toThrow();
      expect(values.fetchFresh).toHaveBeenCalledOnce();
    }
  });

  it("accepts only canonical branded artifact and cache-record bytes", () => {
    const bytes = artifactBytes();
    const parsed = parseAdminCatalogArtifactV1Json(bytes);
    expect(canonicalAdminCatalogArtifactV1Bytes(parsed)).toEqual(bytes);
    expect(parseAdminCatalogArtifactV1Json(new Uint8Array(bytes))).toEqual(parsed);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(() => canonicalAdminCatalogArtifactV1Bytes({ ...parsed })).toThrow();

    const parsedSnapshot = Buffer.from(bytes);
    parsedSnapshot.fill(0x61);
    expect(canonicalAdminCatalogArtifactV1Bytes(parsed)).toEqual(bytes);

    const cacheBytes = cacheRecordBytes();
    const cache = parseAdminCatalogCacheRecordV1Json(cacheBytes);
    expect(canonicalAdminCatalogCacheRecordV1Bytes(cache)).toEqual(cacheBytes);
    expect(() => canonicalAdminCatalogCacheRecordV1Bytes({ ...cache })).toThrow();
    expect(Object.isFrozen(cache)).toBe(true);

    const parsedCache = Buffer.from(cacheBytes);
    parsedCache.fill(0x61);
    expect(canonicalAdminCatalogCacheRecordV1Bytes(cache)).toEqual(cacheBytes);

    const changed = Buffer.from(bytes);
    const first = changed[0];
    if (first === undefined) throw new Error("expected nonempty artifact bytes");
    changed[0] = first ^ 1;
    expect(() => parseAdminCatalogArtifactV1Json(changed)).toThrow();
  });

  it("rejects noncanonical, hostile, oversized, and cross-bound artifact/cache records", () => {
    const bytes = artifactBytes();
    const { protocol, ...rest } = artifact();
    const reordered = Buffer.from(JSON.stringify({ protocol, ...rest }), "utf8");
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
      artifactBytes({ catalogStateBytes: "YQ" }),
      artifactBytes({ unexpected: true }),
      Buffer.alloc(MAX_ARTIFACT_BYTES + 1, 0x61),
    ];
    for (const bad of badArtifacts) reject(bad);
    const persisted = persistedState();
    for (const field of [
      "catalogHeadBytes",
      "catalogHeadEnvelopeBytes",
      "catalogSnapshotBytes",
    ] as const) {
      const changed = { ...persisted, [field]: "YQ" };
      expect(() =>
        parseAdminCatalogArtifactV1Json(
          artifactBytes({
            catalogStateBytes: canonicalStrictJsonBytesV1(changed).toString("base64"),
          }),
        ),
      ).toThrow();
    }
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
    const deliveredArtifact = artifactBytes();
    const deliveredAttestation = Buffer.from("canonical-test-attestation", "utf8");
    let attestationRequest: Record<string, unknown> | undefined;
    const values = input({
      fetchFresh: vi.fn(() => ({
        artifactBytes: deliveredArtifact,
        attestationBytes: deliveredAttestation,
        claimedArtifactSha256: sha(deliveredArtifact),
        kind: "available",
      })),
      commitVerifiedCache: vi.fn((request: Record<string, unknown>) => {
        calls.push("commit");
        expect(request.authorityCacheKeySha256).toBe(authorityCacheKey());
        expect(request.cacheRecordBytes).toEqual(cacheRecordBytes({ downloadedAt: now }));
        return true;
      }),
      signCanonicalPae: vi.fn(() => {
        calls.push("sign");
        return { keyid: "admin-key-1", sig: "YWRtaW4tc2ln" };
      }),
      verifyArtifactAttestation: vi.fn((request: Record<string, unknown>) => {
        calls.push("attest");
        attestationRequest = request;
        expect(Object.keys(request).sort()).toEqual([
          "artifactSha256",
          "attestationBytes",
          "authorityCacheKeySha256",
          "expectedCatalogSignerIdentity",
          "expectedEnvironment",
          "expectedIssuer",
          "expectedRef",
          "expectedRepository",
          "expectedWorkflowIdentity",
          "headSignerRootSha256",
          "channel",
          "sourceId",
        ]);
        expect(request.artifactSha256).toBe(sha(artifactBytes()));
        expect(request.authorityCacheKeySha256).toBe(authorityCacheKey());
        expect(request.sourceId).toBe(sourceId);
        expect(request.channel).toBe(channel);
        return true;
      }),
      verifyCatalogHeadPae: vi.fn(() => {
        calls.push("head");
        return true;
      }),
      verifyCanonicalPae: vi.fn(() => {
        calls.push("admin-verify");
        return true;
      }),
    });

    const result = await resolveAdminCatalogFetchV1(values);

    expect(calls[0]).toBe("attest");
    const firstHead = calls.indexOf("head");
    const commit = calls.indexOf("commit");
    const sign = calls.indexOf("sign");
    expect(firstHead).toBeGreaterThan(0);
    expect(firstHead).toBeLessThan(commit);
    expect(commit).toBeLessThan(sign);
    expect(calls.at(-1)).toBe("admin-verify");
    expect(calls.filter((item) => item === "head").length).toBeGreaterThanOrEqual(1);
    expect(calls.filter((item) => item === "head").length).toBeLessThanOrEqual(2);
    expect(values.fetchFresh).toHaveBeenCalledOnce();
    expect(values.fetchFresh).toHaveBeenCalledWith({
      authorityCacheKeySha256: authorityCacheKey(),
      maxArtifactBytes: MAX_ARTIFACT_BYTES,
      maxAttestationBytes: MAX_ATTESTATION_BYTES,
      timeoutMs: 5_000,
    });
    expect(result).toMatchObject({
      ageSeconds: 0,
      catalogSha256: persistedState().catalogSnapshotSha256,
      downloadedAt: now,
      headDigestSha256: persistedState().catalogHeadSha256,
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
    deliveredArtifact.fill(0x61);
    deliveredAttestation.fill(0x61);
    expect(attestationRequest?.artifactSha256).toBe(sha(artifactBytes()));
    expect(attestationRequest?.attestationBytes).toEqual(
      Buffer.from("canonical-test-attestation", "utf8"),
    );
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
    expect(cached.readVerifiedCache).toHaveBeenCalledWith({
      authorityCacheKeySha256: EXPECTED_AUTHORITY_CACHE_KEY,
      maxCacheBytes: MAX_CACHE_BYTES,
    });
    expect(cached.verifyArtifactAttestation).toHaveBeenCalledOnce();
    expect(cached.verifyCatalogHeadPae).toHaveBeenCalledOnce();

    const packaged = input({
      fetchFresh: vi.fn(() => ({ kind: "unavailable" })),
      readVerifiedCache: vi.fn(() => ({ kind: "unavailable" })),
    });
    const fromPackage = await resolveAdminCatalogFetchV1(packaged);
    expect(fromPackage).toMatchObject({ tier: "packaged", downloadedAt: null, ageSeconds: null });
    expect(packaged.verifyArtifactAttestation).not.toHaveBeenCalled();
    expect(packaged.verifyCatalogHeadPae).toHaveBeenCalledOnce();
    expect(packaged.commitVerifiedCache).not.toHaveBeenCalled();
  });

  it("accepts cache bytes only and rejects typed, oversized, accessor, proxy, and unavailable-like cache seam values", async () => {
    const parsed = parseAdminCatalogCacheRecordV1Json(cacheRecordBytes());
    let getterCalls = 0;
    let proxyCalls = 0;
    const accessor = Object.create(null, {
      protocol: {
        enumerable: true,
        get: () => {
          getterCalls += 1;
          return "AdminCatalogCacheRecordV1";
        },
      },
    });
    const proxy = new Proxy(
      {},
      {
        get: () => {
          proxyCalls += 1;
          return undefined;
        },
      },
    );
    for (const returned of [
      parsed,
      { ...cacheRecord() },
      Buffer.alloc(MAX_CACHE_BYTES + 1, 0x61),
      accessor,
      proxy,
      { kind: "unavailable", extra: true },
    ]) {
      const values = input({
        fetchFresh: () => ({ kind: "unavailable" }),
        readVerifiedCache: () => returned,
      });
      await expect(resolveAdminCatalogFetchV1(values)).rejects.toThrow();
      expect(values.signCanonicalPae).not.toHaveBeenCalled();
      expect(values.verifyCanonicalPae).not.toHaveBeenCalled();
      expect(values.verifyArtifactAttestation).not.toHaveBeenCalled();
    }
    expect(getterCalls).toBe(0);
    expect(proxyCalls).toBe(0);
  });

  it("keeps catalog cache identity reusable across admin identities while changing the signed distribution binding", async () => {
    const observedKeys: string[] = [];
    const available = () => {
      const bytes = artifactBytes();
      return {
        artifactBytes: bytes,
        attestationBytes: Buffer.from("canonical-test-attestation", "utf8"),
        claimedArtifactSha256: sha(bytes),
        kind: "available" as const,
      };
    };
    const base = await resolveAdminCatalogFetchV1(
      input({
        fetchFresh: vi.fn((request: Record<string, unknown>) => {
          observedKeys.push(String(request.authorityCacheKeySha256));
          return available();
        }),
      }),
    );
    const changed = await resolveAdminCatalogFetchV1(
      input({
        adminSignerRootSha256: sha("separate admin root"),
        expectedAdminSignerIdentity: "signer:separate-admin-v1",
        fetchFresh: vi.fn((request: Record<string, unknown>) => {
          observedKeys.push(String(request.authorityCacheKeySha256));
          return available();
        }),
      }),
    );
    expect(observedKeys).toEqual([EXPECTED_AUTHORITY_CACHE_KEY, EXPECTED_AUTHORITY_CACHE_KEY]);
    expect(authorityCacheKey()).toBe(EXPECTED_AUTHORITY_CACHE_KEY);
    expect(changed.distribution.binding.adminSignerRootSha256).not.toBe(
      base.distribution.binding.adminSignerRootSha256,
    );
    expect(changed.distribution.binding.resolvedCatalogBindingSha256).not.toBe(
      base.distribution.binding.resolvedCatalogBindingSha256,
    );
  });

  it("validates closed trusted input and expected catalog/promotion pins before any provider or cache callback", async () => {
    for (const changed of [
      { expectedCatalogSha256: "x" },
      { expectedPromotionDecisionSha256: "x" },
      { expectedCatalogSha256: undefined },
      { authorityCacheKeySha256: authorityCacheKey() },
      { cachedVerified: { kind: "unavailable" } },
    ]) {
      const values = input(changed);
      await expect(resolveAdminCatalogFetchV1(values)).rejects.toThrow();
      expect(values.fetchFresh).not.toHaveBeenCalled();
      expect(values.readVerifiedCache).not.toHaveBeenCalled();
    }
  });

  it("passes the full trusted catalog context to attestation and rejects every wrong context without lower-tier access", async () => {
    const contexts = [
      "expectedRepository",
      "expectedWorkflowIdentity",
      "expectedIssuer",
      "expectedRef",
      "expectedEnvironment",
      "expectedCatalogSignerIdentity",
      "headSignerRootSha256",
    ] as const;
    for (const field of contexts) {
      let values: ReturnType<typeof input>;
      values = input({
        verifyArtifactAttestation: vi.fn((request: Record<string, unknown>) => {
          expect(request[field]).toBe(values[field]);
          return false;
        }),
      });
      await expect(resolveAdminCatalogFetchV1(values)).rejects.toThrow(
        "ADMIN_CATALOG_FETCH_V1: artifact attestation rejected",
      );
      expect(values.readVerifiedCache).not.toHaveBeenCalled();
      expect(values.signCanonicalPae).not.toHaveBeenCalled();
    }
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
        readVerifiedCache: vi.fn(() => cacheRecordBytes()),
      });
      await expect(resolveAdminCatalogFetchV1(values)).rejects.toThrow();
      expect(values.readVerifiedCache).not.toHaveBeenCalled();
      expect(values.signCanonicalPae).not.toHaveBeenCalled();
      expect(values.verifyCanonicalPae).not.toHaveBeenCalled();
    }
  });

  it("treats cache-commit failure as terminal after head verification and before signing", async () => {
    const calls: string[] = [];
    const values = input({
      commitVerifiedCache: vi.fn(() => {
        calls.push("commit");
        return false;
      }),
      readVerifiedCache: vi.fn(() => {
        calls.push("cache-read");
        return cacheRecordBytes();
      }),
      signCanonicalPae: vi.fn(() => {
        calls.push("sign");
        return { keyid: "admin-key-1", sig: "YWRtaW4tc2ln" };
      }),
      verifyCatalogHeadPae: vi.fn(() => {
        calls.push("head");
        return true;
      }),
      verifyCanonicalPae: vi.fn(() => {
        calls.push("admin-verify");
        return true;
      }),
    });
    await expect(resolveAdminCatalogFetchV1(values)).rejects.toThrow(
      "ADMIN_CATALOG_FETCH_V1: cache commit failed",
    );
    expect(calls).toContain("head");
    expect(calls).toContain("commit");
    expect(calls.indexOf("head")).toBeLessThan(calls.indexOf("commit"));
    expect(calls).not.toContain("cache-read");
    expect(calls).not.toContain("sign");
    expect(calls).not.toContain("admin-verify");
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

  it("emits only fixed safe diagnostics when provider, cache, attestation, or commit seams throw hostile text", async () => {
    const hostile = "Bearer secret-token?token=leak C:\\absolute\\private\u0000\n";
    const cases = [
      {
        changed: {
          fetchFresh: () => {
            throw new Error(hostile);
          },
        },
        message: "ADMIN_CATALOG_FETCH_V1: fresh acquisition failed",
      },
      {
        changed: {
          verifyArtifactAttestation: () => {
            throw new Error(hostile);
          },
        },
        message: "ADMIN_CATALOG_FETCH_V1: artifact attestation rejected",
      },
      {
        changed: {
          commitVerifiedCache: () => {
            throw new Error(hostile);
          },
        },
        message: "ADMIN_CATALOG_FETCH_V1: cache commit failed",
      },
      {
        changed: {
          fetchFresh: () => ({ kind: "unavailable" }),
          readVerifiedCache: () => {
            throw new Error(hostile);
          },
        },
        message: "ADMIN_CATALOG_FETCH_V1: verified cache rejected",
      },
    ];
    for (const fixture of cases) {
      try {
        await resolveAdminCatalogFetchV1(input(fixture.changed));
        throw new Error("expected rejection");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        expect(message).toBe(fixture.message);
        expect(message).not.toContain("secret-token");
        expect(message).not.toContain("absolute");
        expect([...message].some((character) => (character.codePointAt(0) ?? 0) < 0x20)).toBe(
          false,
        );
      }
    }
  });

  it("remains an internal capability-free foundation with no transport locator or seat/runtime route", () => {
    const path = resolve("src/org-policy/admin-catalog-fetch-v1.ts");
    expect(existsSync(path)).toBe(true);
    const source = readFileSync(path, "utf8");
    expect(source).not.toMatch(
      /from\s+["'][^"']*(?:index|commands|generate|studio-model|studio-template|runtime|seat)[^"']*["']/i,
    );
    expect(source).not.toMatch(
      /node:(?:fs|path|os|https|http|net|tls|child_process|dgram)|\b(?:fetch|spawn|exec|fork|process\.env|URL|writeFile|readFile)\b/i,
    );
  });
});
