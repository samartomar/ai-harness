import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  canonicalCatalogHeadEnvelopeV1Bytes,
  parseCatalogHeadEnvelopeV1,
  resolveAdminCatalogV1,
  verifyCatalogHeadEnvelopeV1,
} from "../../src/org-policy/catalog-resolution-v1.js";

const sha = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
const headRoot = sha("head root");
const adminRoot = sha("admin root");
const snapshot = Buffer.from('{"catalogVersion":"1","members":[]}', "utf8");
// Literal externally-derived wire vectors. Expected bytes, hashes, payload and PAE
// deliberately do not call constructors or canonical helpers under test.
const literalSnapshotBytes = Buffer.from(
  '{"members":[{"candidateIdentitySha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","candidateSha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","componentId":"skill:catalog-example","evidenceSha256":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","gitCommitSha256":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","pinSha256":"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee","policyRevisionSha256":"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff","profileSha256":"0000000000000000000000000000000000000000000000000000000000000000","promotionDecisionSha256":"1111111111111111111111111111111111111111111111111111111111111111","qualificationBundleSha256":"2222222222222222222222222222222222222222222222222222222222222222","recipeSha256":"3333333333333333333333333333333333333333333333333333333333333333","repository":"github.com/example/catalog-example","sourceId":"catalog-example","sourceSha256":"4444444444444444444444444444444444444444444444444444444444444444"}],"protocol":"CatalogSnapshotV1"}',
  "utf8",
);
const literalSnapshotSha256 = "ecad3085f3e2526eea43deacab7e67faeb25060439fa30922cf8935020e41eb7";
const literalHeadBytes = Buffer.from(
  '{"catalogSha256":"7777777777777777777777777777777777777777777777777777777777777777","compatibleEffectVersions":["1"],"compatibleSchemaVersions":["1"],"previousCatalogHeadSha256":"9999999999999999999999999999999999999999999999999999999999999999","promotionDecisionSha256":"1111111111111111111111111111111111111111111111111111111111111111","protocol":"CatalogHeadV1","sequence":42,"signerIdentity":"signer:catalog-head-v1","validFrom":"2026-08-17T00:00:00Z","validUntil":"2026-08-18T00:00:00Z"}',
  "utf8",
);
const literalHeadSha256 = "0459977e5e0c78656207b78c325b75bdf655819956bc94f5fd7486791e5ef2f9";
const literalHeadPayloadBase64 =
  "eyJfdHlwZSI6Imh0dHBzOi8vaW4tdG90by5pby9TdGF0ZW1lbnQvdjEiLCJwcmVkaWNhdGUiOnsiZW52aXJvbm1lbnQiOiJjYXRhbG9nLXJlbGVhc2UiLCJpc3N1ZXIiOiJodHRwczovL3Rva2VuLmFjdGlvbnMuZ2l0aHVidXNlcmNvbnRlbnQuY29tIiwicHJvdG9jb2wiOiJDYXRhbG9nSGVhZEVudmVsb3BlVjEiLCJyZWNvcmRUeXBlIjoiQ2F0YWxvZ0hlYWRWMSIsInJlcG9zaXRvcnkiOiJnaXRodWIuY29tL2FpaC9zdXBwb3J0ZWQtY2F0YWxvZyIsInNpZ25lcklkZW50aXR5Ijoic2lnbmVyOmNhdGFsb2ctaGVhZC12MSIsIndvcmtmbG93SWRlbnRpdHkiOiJ3b3JrZmxvdzpjYXRhbG9nLXJlbGVhc2UtdjEifSwicHJlZGljYXRlVHlwZSI6Imh0dHBzOi8vYWloLmRldi9DYXRhbG9nSGVhZFYxIiwic3ViamVjdCI6W3siZGlnZXN0Ijp7InNoYTI1NiI6IjA0NTk5NzdlNWUwYzc4NjU2MjA3Yjc4YzMyNWI3NWJkZjY1NTgxOTk1NmJjOTRmNWZkNzQ4Njc5MWU1ZWYyZjkifSwibmFtZSI6ImFpaC9DYXRhbG9nSGVhZFYxIn1dfQ==";
const literalHeadPaeBase64 =
  "RFNTRXYxIDI0IGFwcGxpY2F0aW9uL3ZuZC5pbi10b3RvK2pzb24gNTIzIHsiX3R5cGUiOiJodHRwczovL2luLXRvdG8uaW8vU3RhdGVtZW50L3YxIiwicHJlZGljYXRlIjp7ImVudmlyb25tZW50IjoiY2F0YWxvZy1yZWxlYXNlIiwiaXNzdWVyIjoiaHR0cHM6Ly90b2tlbi5hY3Rpb25zLmdpdGh1YnVzZXJjb250ZW50LmNvbSIsInByb3RvY29sIjoiQ2F0YWxvZ0hlYWRFbnZlbG9wZVYxIiwicmVjb3JkVHlwZSI6IkNhdGFsb2dIZWFkVjEiLCJyZXBvc2l0b3J5IjoiZ2l0aHViLmNvbS9haWgvc3VwcG9ydGVkLWNhdGFsb2ciLCJzaWduZXJJZGVudGl0eSI6InNpZ25lcjpjYXRhbG9nLWhlYWQtdjEiLCJ3b3JrZmxvd0lkZW50aXR5Ijoid29ya2Zsb3c6Y2F0YWxvZy1yZWxlYXNlLXYxIn0sInByZWRpY2F0ZVR5cGUiOiJodHRwczovL2FpaC5kZXYvQ2F0YWxvZ0hlYWRWMSIsInN1YmplY3QiOlt7ImRpZ2VzdCI6eyJzaGEyNTYiOiIwNDU5OTc3ZTVlMGM3ODY1NjIwN2I3OGMzMjViNzViZGY2NTU4MTk5NTZiYzk0ZjVmZDc0ODY3OTFlNWVmMmY5In0sIm5hbWUiOiJhaWgvQ2F0YWxvZ0hlYWRWMSJ9XX0=";
const literalHeadEnvelopeBytes = Buffer.from(
  '{"payload":"eyJfdHlwZSI6Imh0dHBzOi8vaW4tdG90by5pby9TdGF0ZW1lbnQvdjEiLCJwcmVkaWNhdGUiOnsiZW52aXJvbm1lbnQiOiJjYXRhbG9nLXJlbGVhc2UiLCJpc3N1ZXIiOiJodHRwczovL3Rva2VuLmFjdGlvbnMuZ2l0aHVidXNlcmNvbnRlbnQuY29tIiwicHJvdG9jb2wiOiJDYXRhbG9nSGVhZEVudmVsb3BlVjEiLCJyZWNvcmRUeXBlIjoiQ2F0YWxvZ0hlYWRWMSIsInJlcG9zaXRvcnkiOiJnaXRodWIuY29tL2FpaC9zdXBwb3J0ZWQtY2F0YWxvZyIsInNpZ25lcklkZW50aXR5Ijoic2lnbmVyOmNhdGFsb2ctaGVhZC12MSIsIndvcmtmbG93SWRlbnRpdHkiOiJ3b3JrZmxvdzpjYXRhbG9nLXJlbGVhc2UtdjEifSwicHJlZGljYXRlVHlwZSI6Imh0dHBzOi8vYWloLmRldi9DYXRhbG9nSGVhZFYxIiwic3ViamVjdCI6W3siZGlnZXN0Ijp7InNoYTI1NiI6IjA0NTk5NzdlNWUwYzc4NjU2MjA3Yjc4YzMyNWI3NWJkZjY1NTgxOTk1NmJjOTRmNWZkNzQ4Njc5MWU1ZWYyZjkifSwibmFtZSI6ImFpaC9DYXRhbG9nSGVhZFYxIn1dfQ==","payloadType":"application/vnd.in-toto+json","signatures":[{"keyid":"head-key-1","sig":"aGVhZC1zaWc="}]}',
  "utf8",
);
const literalHeadEnvelopeSha256 =
  "a0e5a94c231e85bae60c000d1ce20754135e81bf269ad679cebbf9cd96144a65";
const head = {
  protocol: "CatalogHeadV1" as const,
  sequence: 7,
  catalogSha256: sha(snapshot.toString("utf8")),
  previousCatalogHeadSha256: sha("previous head"),
  compatibleSchemaVersions: ["1"],
  compatibleEffectVersions: ["1"],
  signerIdentity: "signer:catalog-head-v1",
  validFrom: "2026-08-17T00:00:00Z",
  validUntil: "2026-08-18T00:00:00Z",
};

function envelopeInput(overrides: Record<string, unknown> = {}) {
  return {
    head,
    signerRootSha256: headRoot,
    signatures: [{ keyid: "head-key-1", sig: "aGVhZC1zaWc=" }],
    ...overrides,
  };
}

function cachedCatalogState(overrides: Record<string, unknown> = {}) {
  return {
    protocol: "CachedCatalogStateV1" as const,
    catalogHeadEnvelopeBytes: literalHeadEnvelopeBytes,
    catalogHeadEnvelopeSha256: literalHeadEnvelopeSha256,
    catalogSnapshotBytes: literalSnapshotBytes,
    catalogSnapshotSha256: literalSnapshotSha256,
    signerRootSha256: headRoot,
    verifiedAt: "2026-08-17T11:00:00Z",
    ...overrides,
  };
}

function packagedCatalogState(overrides: Record<string, unknown> = {}) {
  return {
    ...cachedCatalogState(),
    protocol: "PackagedCatalogStateV1" as const,
    packageSha256: sha("supported catalog package"),
    packageRootSha256: sha("supported catalog package root"),
    ...overrides,
  };
}

const resolutionContext = {
  now: "2026-08-17T12:00:00Z",
  headSignerRootSha256: headRoot,
  adminSignerRootSha256: adminRoot,
  expectedRepository: "github.com/aih/supported-catalog",
  expectedWorkflowIdentity: "workflow:catalog-release-v1",
  expectedIssuer: "https://token.actions.githubusercontent.com",
  expectedRef: "refs/heads/main",
  expectedEnvironment: "catalog-release",
  expectedCatalogSha256: literalSnapshotSha256,
  expectedPromotionDecisionSha256:
    "1111111111111111111111111111111111111111111111111111111111111111",
};

describe("signed catalog-head parsing and verification", () => {
  it("accepts bytes only through strict canonical DSSE/head/snapshot verification with literal vectors", () => {
    const envelope = parseCatalogHeadEnvelopeV1(literalHeadEnvelopeBytes);
    const bytes = canonicalCatalogHeadEnvelopeV1Bytes(envelope);
    expect(bytes).toEqual(literalHeadEnvelopeBytes);
    expect(sha(bytes.toString("utf8"))).toBe(literalHeadEnvelopeSha256);
    expect(sha(literalHeadBytes.toString("utf8"))).toBe(literalHeadSha256);
    expect(sha(literalSnapshotBytes.toString("utf8"))).toBe(literalSnapshotSha256);
    expect(parseCatalogHeadEnvelopeV1(bytes)).toEqual(envelope);
    expect(parseCatalogHeadEnvelopeV1(new Uint8Array(bytes))).toEqual(envelope);
    expect(envelope.envelope.payload).toBe(literalHeadPayloadBase64);
    expect(Buffer.from(envelope.envelope.payload, "base64")).toEqual(envelope.statementBytes);
    const verifyCanonicalPae = vi.fn(() => true);
    expect(
      verifyCatalogHeadEnvelopeV1({
        envelope,
        ...resolutionContext,
        expectedSignerRootSha256: headRoot,
        verifyCanonicalPae,
      }),
    ).toEqual(envelope);
    expect(verifyCanonicalPae).toHaveBeenCalledOnce();
    expect(verifyCanonicalPae).toHaveBeenCalledWith(
      expect.objectContaining({
        paeBytes: Buffer.from(literalHeadPaeBase64, "base64"),
        repository: resolutionContext.expectedRepository,
        workflowIdentity: resolutionContext.expectedWorkflowIdentity,
        issuer: resolutionContext.expectedIssuer,
        ref: resolutionContext.expectedRef,
        environment: resolutionContext.expectedEnvironment,
        signerRootSha256: headRoot,
      }),
    );
    for (const mismatch of [
      { expectedRepository: "github.com/aih/other-catalog" },
      { expectedWorkflowIdentity: "workflow:other-v1" },
      { expectedIssuer: "https://issuer.example.invalid" },
      { expectedRef: "refs/heads/release" },
      { expectedEnvironment: "other-environment" },
      { expectedSignerRootSha256: adminRoot },
    ])
      expect(() =>
        verifyCatalogHeadEnvelopeV1({
          envelope,
          ...resolutionContext,
          expectedSignerRootSha256: headRoot,
          ...mismatch,
          verifyCanonicalPae: () => true,
        }),
      ).toThrow();
  });

  it("fails closed on hostile bytes, typed trust mismatches, replay, rollback, and incompatible versions", () => {
    const valid = parseCatalogHeadEnvelopeV1(literalHeadEnvelopeBytes);
    for (const changed of [
      Buffer.from('{"a":1,"\\u0061":2}', "utf8"),
      Buffer.from('{"head":true,}', "utf8"),
      Buffer.from('{"value":"\ud800"}', "utf8"),
      new Uint8Array([0xc3, 0x28]),
      { ...envelopeInput(), signerRootSha256: adminRoot },
      { ...envelopeInput(), head: { ...head, sequence: 6 } },
      { ...envelopeInput(), head: { ...head, validUntil: "2026-02-30T00:00:00Z" } },
      { ...envelopeInput(), signatures: [{ keyid: "head-key-1", sig: "" }] },
      {
        ...envelopeInput(),
        signatures: [
          { keyid: "head-key-1", sig: "aA==" },
          { keyid: "head-key-1", sig: "YQ==" },
        ],
      },
    ])
      expect(() => parseCatalogHeadEnvelopeV1(changed)).toThrow();
    // Future schema/effect versions are syntactically valid signed heads. Resolution,
    // rather than parsing, returns compatibility-required/non-materializable.
    expect(() =>
      parseCatalogHeadEnvelopeV1(
        envelopeInput({ head: { ...head, compatibleSchemaVersions: ["999"] } }),
      ),
    ).not.toThrow();
    expect(() =>
      parseCatalogHeadEnvelopeV1(
        envelopeInput({ head: { ...head, compatibleEffectVersions: ["999"] } }),
      ),
    ).not.toThrow();
    expect(() =>
      verifyCatalogHeadEnvelopeV1({ envelope: { ...valid }, expectedSignerRootSha256: headRoot }),
    ).toThrow();
    const oversizedSignatures = Array.from({ length: 65 }, (_, index) => ({
      keyid: `head-key-${String(index)}`,
      sig: "YQ==",
    }));
    for (const changed of [
      { ...envelopeInput(), signatures: oversizedSignatures },
      { ...envelopeInput(), head: { ...head, compatibleSchemaVersions: Array(129).fill("1") } },
      { ...envelopeInput(), head: { ...head, compatibleEffectVersions: Array(129).fill("1") } },
      Buffer.alloc(1_048_577, 0x20),
    ])
      expect(() => parseCatalogHeadEnvelopeV1(changed)).toThrow();
  });
});

describe("catalog resolution internal boundary", () => {
  it("keeps seat-side resolution internal and free of runtime/provider execution routes", () => {
    const source = resolve("src/org-policy/catalog-resolution-v1.ts");
    expect(existsSync(source)).toBe(true);
    const text = readFileSync(source, "utf8");
    expect(text).not.toMatch(
      /node:(child_process|https|http|net|tls|dgram)|\b(fetch|spawn|exec|fork)\s*\(|provider\.(request|poll)|docker|scanner|runtime-policy/i,
    );
    expect(readFileSync(resolve("src/index.ts"), "utf8")).not.toContain("catalog-resolution-v1");
  });
});

describe("admin catalog resolution", () => {
  it("downgrades only explicit unavailable freshness tiers and preserves verified last-good", () => {
    const cached = cachedCatalogState();
    const packaged = packagedCatalogState();
    const result = resolveAdminCatalogV1({
      ...resolutionContext,
      lastGood: cached,
      fresh: { kind: "unavailable" },
      cachedVerified: cached,
      packaged,
      verifyCanonicalPae: () => true,
    });
    expect(result).toMatchObject({
      kind: "resolved",
      tier: "cached-verified",
      headDigestSha256: expect.any(String),
    });
    expect(
      resolveAdminCatalogV1({
        ...resolutionContext,
        lastGood: cached,
        fresh: { kind: "unavailable" },
        cachedVerified: { kind: "unavailable" },
        packaged,
        verifyCanonicalPae: () => false,
      }),
    ).toEqual({ kind: "fatal", lastGood: cached });
    expect(
      resolveAdminCatalogV1({
        ...resolutionContext,
        lastGood: cached,
        fresh: { kind: "unavailable" },
        cachedVerified: { kind: "unavailable" },
        packaged,
        verifyCanonicalPae: () => true,
      }),
    ).toMatchObject({ kind: "resolved", tier: "packaged" });
  });

  it("reports compatibility-required without materializing and treats corrupt cache or invalid higher tiers as terminal", () => {
    const incompatible = cachedCatalogState({
      catalogHeadEnvelopeBytes: Buffer.from(
        literalHeadEnvelopeBytes
          .toString("utf8")
          .replace('"compatibleSchemaVersions":["1"]', '"compatibleSchemaVersions":["2"]'),
        "utf8",
      ),
    });
    const cached = cachedCatalogState();
    expect(
      resolveAdminCatalogV1({
        ...resolutionContext,
        lastGood: cached,
        fresh: incompatible,
        cachedVerified: cached,
        packaged: { kind: "unavailable" },
        verifyCanonicalPae: () => true,
      }),
    ).toMatchObject({
      kind: "compatibility-required",
      headDigestSha256: expect.any(String),
      materializable: false,
    });
    for (const corrupt of [
      { ...cached, verifiedAt: "2026-02-30T00:00:00Z" },
      { ...cached, catalogHeadEnvelopeSha256: sha("corrupt cache") },
      { ...cached, signerRootSha256: adminRoot },
    ])
      expect(
        resolveAdminCatalogV1({
          ...resolutionContext,
          lastGood: cached,
          fresh: corrupt,
          cachedVerified: { kind: "unavailable" },
          packaged: { kind: "unavailable" },
          verifyCanonicalPae: () => true,
        }),
      ).toEqual({ kind: "fatal", lastGood: cached });
  });

  it("treats same/lower continuity, wrong typed state material, and verifier throws as fatal while a valid higher catalog advances", () => {
    const lastGood = cachedCatalogState();
    const higher = cachedCatalogState({
      catalogHeadEnvelopeBytes: Buffer.from(
        literalHeadEnvelopeBytes.toString("utf8").replace('"sequence":42', '"sequence":43'),
        "utf8",
      ),
      catalogHeadEnvelopeSha256: sha("higher envelope"),
      catalogSnapshotBytes: Buffer.from(
        '{"members":[],"protocol":"CatalogSnapshotV1","revision":2}',
        "utf8",
      ),
      catalogSnapshotSha256: sha('{"members":[],"protocol":"CatalogSnapshotV1","revision":2}'),
    });
    expect(
      resolveAdminCatalogV1({
        ...resolutionContext,
        expectedCatalogSha256: higher.catalogSnapshotSha256,
        lastGood,
        fresh: higher,
        cachedVerified: { kind: "unavailable" },
        packaged: { kind: "unavailable" },
        verifyCanonicalPae: () => true,
      }),
    ).toMatchObject({ kind: "resolved", tier: "fresh", headDigestSha256: expect.any(String) });
    for (const next of [
      cachedCatalogState({ catalogSnapshotSha256: sha("same sequence different catalog") }),
      cachedCatalogState({ catalogHeadEnvelopeSha256: sha("replayed head") }),
      cachedCatalogState({ catalogSnapshotBytes: Buffer.from("{}", "utf8") }),
      packagedCatalogState({ packageSha256: sha("wrong package") }),
      packagedCatalogState({ packageRootSha256: sha("wrong package root") }),
      cachedCatalogState({ verifiedAt: "2026-08-17T09:00:00Z" }),
      cachedCatalogState({ diagnostic: "x".repeat(4097) }),
    ])
      expect(
        resolveAdminCatalogV1({
          ...resolutionContext,
          lastGood,
          fresh: next,
          cachedVerified: { kind: "unavailable" },
          packaged: { kind: "unavailable" },
          verifyCanonicalPae: () => true,
        }),
      ).toEqual({ kind: "fatal", lastGood });
    expect(
      resolveAdminCatalogV1({
        ...resolutionContext,
        lastGood,
        fresh: { kind: "unavailable" },
        cachedVerified: { kind: "unavailable" },
        packaged: packagedCatalogState(),
        verifyCanonicalPae: () => {
          throw new Error("injected verifier failure");
        },
      }),
    ).toEqual({ kind: "fatal", lastGood });
  });
});
