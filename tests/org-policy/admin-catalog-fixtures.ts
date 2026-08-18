import { createHash } from "node:crypto";
import { canonicalStrictJsonBytesV1 } from "../../src/contract/strict-json-v1.js";
import { composeAdminSeatDistributionV1 } from "../../src/org-policy/admin-distribution-v1.js";
import { canonicalAdminSeatDistributionV1Bytes } from "../../src/org-policy/catalog-binding-v1.js";

/**
 * Shared fixture material for the admin catalog bootstrap and integration
 * suites. It builds exactly the canonical bytes the shipped foundation accepts,
 * so an integration assertion exercises the real contracts rather than a mock of
 * them. The pre-signed distribution is produced by the REAL composer with a stub
 * signer, which is how an external organization-admin OIDC workflow mints it;
 * the admin seat never signs.
 */

export const sha = (value: Buffer | string): string =>
  createHash("sha256").update(value).digest("hex");

export const headRoot = sha("catalog head root");
export const adminRoot = sha("admin root");
export const packageSha256 = sha("supported catalog package");
export const packageRootSha256 = sha("supported catalog package root");
export const promotionSha256 = sha("promotion");
export const sourceId = "supported-catalog";
export const channel = "stable";
export const repository = "github.com/aih/supported-catalog";
export const attestationRepository = "aih/supported-catalog";
export const workflowIdentity = "aih/supported-catalog/.github/workflows/catalog-release.yml";
export const adminWorkflowIdentity =
  "aih/supported-catalog/.github/workflows/admin-distribution.yml";
export const issuer = "https://token.actions.githubusercontent.com";
export const ref = "refs/heads/main";
export const environment = "catalog-release";
export const catalogSignerIdentity = "signer:catalog-head-v1";
export const adminSignerIdentity = "signer:admin-seat-v1";
export const resolvedAt = "2026-08-17T12:00:00Z";
export const downloadedAt = "2026-08-17T11:59:30Z";
export const catalogArtifactUrl = "https://catalog.aih.dev/stable/supported-catalog/artifact.json";
export const catalogAttestationUrl =
  "https://catalog.aih.dev/stable/supported-catalog/artifact.intoto.jsonl";
export const signedDistributionUrl =
  "https://catalog.aih.dev/stable/supported-catalog/distribution.json";
export const signedDistributionAttestationUrl =
  "https://catalog.aih.dev/stable/supported-catalog/distribution.intoto.jsonl";
export const attestationBytes = Buffer.from("canonical-test-attestation", "utf8");
export const distributionAttestationBytes = Buffer.from(
  "canonical-test-distribution-attestation",
  "utf8",
);
export const adminKeyId = "admin-key-1";
export const adminSignature = "YWRtaW4tc2ln";

type Json = Record<string, unknown>;

export function member(overrides: Json = {}): Json {
  return {
    candidateIdentitySha256: sha("candidate identity"),
    candidateSha256: sha("candidate"),
    componentId: "skill:catalog-example",
    evidenceSha256: sha("evidence"),
    gitCommitSha256: sha("commit"),
    pinSha256: sha("pin"),
    policyRevisionSha256: sha("policy"),
    profileSha256: sha("profile"),
    promotionDecisionSha256: promotionSha256,
    qualificationBundleSha256: sha("qualification"),
    recipeSha256: sha("recipe"),
    repository,
    sourceId,
    sourceSha256: sha("source"),
    ...overrides,
  };
}

export function persistedState(
  kind: "CachedCatalogStateV1" | "PackagedCatalogStateV1" = "CachedCatalogStateV1",
): Json {
  const snapshotBytes = canonicalStrictJsonBytesV1({
    members: [member()],
    protocol: "CatalogSnapshotV1",
  });
  const catalogHeadBytes = canonicalStrictJsonBytesV1({
    catalogSha256: sha(snapshotBytes),
    compatibleEffectVersions: ["1"],
    compatibleSchemaVersions: ["1"],
    previousCatalogHeadSha256: sha("previous head"),
    promotionDecisionSha256: promotionSha256,
    protocol: "CatalogHeadV1",
    sequence: 42,
    signerIdentity: catalogSignerIdentity,
    validFrom: "2026-08-17T00:00:00Z",
    validUntil: "2026-08-18T00:00:00Z",
  });
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

export function persistedStateBytes(
  kind: "CachedCatalogStateV1" | "PackagedCatalogStateV1" = "CachedCatalogStateV1",
): Buffer {
  return canonicalStrictJsonBytesV1(persistedState(kind));
}

export function expectedCatalogSha256(): string {
  return persistedState().catalogSnapshotSha256 as string;
}

/** The shape `resolveAdminCatalogFetchV1` hands the resolver for one tier. */
export function resolverState(state: Json): Json {
  return {
    catalogHeadBytes: Buffer.from(state.catalogHeadBytes as string, "base64"),
    catalogHeadEnvelopeBytes: Buffer.from(state.catalogHeadEnvelopeBytes as string, "base64"),
    catalogHeadEnvelopeSha256: state.catalogHeadEnvelopeSha256,
    catalogHeadSha256: state.catalogHeadSha256,
    catalogSnapshotBytes: Buffer.from(state.catalogSnapshotBytes as string, "base64"),
    catalogSnapshotSha256: state.catalogSnapshotSha256,
    ...(state.protocol === "PackagedCatalogStateV1"
      ? { packageRootSha256: state.packageRootSha256, packageSha256: state.packageSha256 }
      : {}),
    protocol: state.protocol,
    signerRootSha256: state.signerRootSha256,
    verifiedAt: state.verifiedAt,
  };
}

export function authorityCacheKeySha256(overrides: Json = {}): string {
  return sha(
    canonicalStrictJsonBytesV1({
      domain: "aih.admin-catalog-fetch-cache-key-v1",
      value: {
        catalogSignerIdentity,
        channel,
        expectedCatalogSha256: expectedCatalogSha256(),
        expectedEffectVersion: "1",
        expectedEnvironment: environment,
        expectedIssuer: issuer,
        expectedPackageRootSha256: packageRootSha256,
        expectedPackageSha256: packageSha256,
        expectedPromotionDecisionSha256: promotionSha256,
        expectedRef: ref,
        expectedRepository: repository,
        expectedSchemaVersion: "1",
        expectedWorkflowIdentity: workflowIdentity,
        headSignerRootSha256: headRoot,
        sourceId,
        ...overrides,
      },
    }),
  );
}

export function artifactBytes(overrides: Json = {}): Buffer {
  const catalogStateBytes = persistedStateBytes();
  return canonicalStrictJsonBytesV1({
    authorityCacheKeySha256: authorityCacheKeySha256(),
    catalogStateBytes: catalogStateBytes.toString("base64"),
    catalogStateSha256: sha(catalogStateBytes),
    channel,
    packageRootSha256,
    packageSha256,
    protocol: "AdminCatalogArtifactV1",
    sourceId,
    ...overrides,
  });
}

export function cacheRecordBytes(overrides: Json = {}): Buffer {
  const bytes = artifactBytes();
  return canonicalStrictJsonBytesV1({
    artifactBytes: bytes.toString("base64"),
    artifactSha256: sha(bytes),
    attestationBytes: attestationBytes.toString("base64"),
    authorityCacheKeySha256: authorityCacheKeySha256(),
    downloadedAt,
    protocol: "AdminCatalogCacheRecordV1",
    ...overrides,
  });
}

export function bootstrapRecord(overrides: Json = {}): Json {
  return {
    adminSignerRootSha256: adminRoot,
    cacheMaxAgeSeconds: 86_400,
    catalogArtifactUrl,
    catalogAttestationUrl,
    channel,
    expectedAdminSignerIdentity: adminSignerIdentity,
    expectedAdminWorkflowIdentity: adminWorkflowIdentity,
    expectedCatalogSha256: expectedCatalogSha256(),
    expectedCatalogSignerIdentity: catalogSignerIdentity,
    expectedEffectVersion: "1",
    expectedEnvironment: environment,
    expectedIssuer: issuer,
    expectedPackageRootSha256: packageRootSha256,
    expectedPackageSha256: packageSha256,
    expectedPromotionDecisionSha256: promotionSha256,
    expectedRef: ref,
    expectedRepository: repository,
    expectedSchemaVersion: "1",
    expectedWorkflowIdentity: workflowIdentity,
    headSignerRootSha256: headRoot,
    lastGoodCatalogStateBytes: persistedStateBytes().toString("base64"),
    packagedCatalogStateBytes: persistedStateBytes("PackagedCatalogStateV1").toString("base64"),
    protocol: "AdminCatalogBootstrapV1",
    signedDistributionUrl,
    signedDistributionAttestationUrl,
    sourceId,
    ...overrides,
  };
}

export function bootstrapBytes(overrides: Json = {}): Buffer {
  return canonicalStrictJsonBytesV1(bootstrapRecord(overrides));
}

/**
 * The exact bytes an external organization-admin OIDC workflow publishes. Built
 * with the REAL composer so the integration suite's byte-equality assertion
 * proves reproduction rather than comparing a hand-copied literal.
 */
export function presignedDistributionBytes(
  options: { tier?: "fresh" | "cached-verified" | "packaged"; now?: string } = {},
): Buffer {
  const tier = options.tier ?? "fresh";
  const unavailable = { kind: "unavailable" };
  const state =
    tier === "packaged"
      ? resolverState(persistedState("PackagedCatalogStateV1"))
      : resolverState(persistedState());
  return canonicalAdminSeatDistributionV1Bytes(
    composeAdminSeatDistributionV1({
      adminSignerRootSha256: adminRoot,
      cachedVerified: tier === "cached-verified" ? state : unavailable,
      expectedAdminSignerIdentity: adminSignerIdentity,
      expectedCatalogSha256: expectedCatalogSha256(),
      expectedCatalogSignerIdentity: catalogSignerIdentity,
      expectedEnvironment: environment,
      expectedIssuer: issuer,
      expectedPackageRootSha256: packageRootSha256,
      expectedPackageSha256: packageSha256,
      expectedPromotionDecisionSha256: promotionSha256,
      expectedRef: ref,
      expectedRepository: repository,
      expectedWorkflowIdentity: workflowIdentity,
      fresh: tier === "fresh" ? state : unavailable,
      headSignerRootSha256: headRoot,
      lastGood: resolverState(persistedState()),
      bindingResolvedAt: options.now ?? resolvedAt,
      now: options.now ?? resolvedAt,
      packaged: tier === "packaged" ? state : unavailable,
      signCanonicalPae: () => ({ keyid: adminKeyId, sig: adminSignature }),
      verifyCanonicalPae: () => true,
      verifyCatalogHeadPae: () => true,
    }),
  );
}
