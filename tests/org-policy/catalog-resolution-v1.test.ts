import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { canonicalStrictJsonBytesV1 } from "../../src/contract/strict-json-v1.js";
import {
  canonicalCatalogHeadEnvelopeV1Bytes,
  canonicalCatalogSnapshotV1Bytes,
  parseCatalogHeadEnvelopeV1,
  parseCatalogSnapshotV1Json,
  resolveAdminCatalogV1,
  resolveVerifiedCatalogMaterialV1,
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
  '{"catalogSha256":"ecad3085f3e2526eea43deacab7e67faeb25060439fa30922cf8935020e41eb7","compatibleEffectVersions":["1"],"compatibleSchemaVersions":["1"],"previousCatalogHeadSha256":"9999999999999999999999999999999999999999999999999999999999999999","promotionDecisionSha256":"1111111111111111111111111111111111111111111111111111111111111111","protocol":"CatalogHeadV1","sequence":42,"signerIdentity":"signer:catalog-head-v1","validFrom":"2026-08-17T00:00:00Z","validUntil":"2026-08-18T00:00:00Z"}',
  "utf8",
);
const literalHeadSha256 = "22c42939543f69989545e2d93644de8e3d984311daf49c8dd5dd8240ca9591b0";
const literalHeadPayloadBase64 =
  "eyJfdHlwZSI6Imh0dHBzOi8vaW4tdG90by5pby9TdGF0ZW1lbnQvdjEiLCJwcmVkaWNhdGUiOnsiZW52aXJvbm1lbnQiOiJjYXRhbG9nLXJlbGVhc2UiLCJpc3N1ZXIiOiJodHRwczovL3Rva2VuLmFjdGlvbnMuZ2l0aHVidXNlcmNvbnRlbnQuY29tIiwicHJvdG9jb2wiOiJDYXRhbG9nSGVhZEVudmVsb3BlVjEiLCJyZWNvcmRUeXBlIjoiQ2F0YWxvZ0hlYWRWMSIsInJlcG9zaXRvcnkiOiJnaXRodWIuY29tL2FpaC9zdXBwb3J0ZWQtY2F0YWxvZyIsInNpZ25lcklkZW50aXR5Ijoic2lnbmVyOmNhdGFsb2ctaGVhZC12MSIsIndvcmtmbG93SWRlbnRpdHkiOiJ3b3JrZmxvdzpjYXRhbG9nLXJlbGVhc2UtdjEifSwicHJlZGljYXRlVHlwZSI6Imh0dHBzOi8vYWloLmRldi9DYXRhbG9nSGVhZFYxIiwic3ViamVjdCI6W3siZGlnZXN0Ijp7InNoYTI1NiI6IjIyYzQyOTM5NTQzZjY5OTg5NTQ1ZTJkOTM2NDRkZThlM2Q5ODQzMTFkYWY0OWM4ZGQ1ZGQ4MjQwY2E5NTkxYjAifSwibmFtZSI6ImFpaC9DYXRhbG9nSGVhZFYxIn1dfQ==";
const literalHeadPaeBase64 =
  "RFNTRXYxIDI4IGFwcGxpY2F0aW9uL3ZuZC5pbi10b3RvK2pzb24gNTIzIHsiX3R5cGUiOiJodHRwczovL2luLXRvdG8uaW8vU3RhdGVtZW50L3YxIiwicHJlZGljYXRlIjp7ImVudmlyb25tZW50IjoiY2F0YWxvZy1yZWxlYXNlIiwiaXNzdWVyIjoiaHR0cHM6Ly90b2tlbi5hY3Rpb25zLmdpdGh1YnVzZXJjb250ZW50LmNvbSIsInByb3RvY29sIjoiQ2F0YWxvZ0hlYWRFbnZlbG9wZVYxIiwicmVjb3JkVHlwZSI6IkNhdGFsb2dIZWFkVjEiLCJyZXBvc2l0b3J5IjoiZ2l0aHViLmNvbS9haWgvc3VwcG9ydGVkLWNhdGFsb2ciLCJzaWduZXJJZGVudGl0eSI6InNpZ25lcjpjYXRhbG9nLWhlYWQtdjEiLCJ3b3JrZmxvd0lkZW50aXR5Ijoid29ya2Zsb3c6Y2F0YWxvZy1yZWxlYXNlLXYxIn0sInByZWRpY2F0ZVR5cGUiOiJodHRwczovL2FpaC5kZXYvQ2F0YWxvZ0hlYWRWMSIsInN1YmplY3QiOlt7ImRpZ2VzdCI6eyJzaGEyNTYiOiIyMmM0MjkzOTU0M2Y2OTk4OTU0NWUyZDkzNjQ0ZGU4ZTNkOTg0MzExZGFmNDljOGRkNWRkODI0MGNhOTU5MWIwIn0sIm5hbWUiOiJhaWgvQ2F0YWxvZ0hlYWRWMSJ9XX0=";
const literalHeadEnvelopeBytes = Buffer.from(
  '{"payload":"eyJfdHlwZSI6Imh0dHBzOi8vaW4tdG90by5pby9TdGF0ZW1lbnQvdjEiLCJwcmVkaWNhdGUiOnsiZW52aXJvbm1lbnQiOiJjYXRhbG9nLXJlbGVhc2UiLCJpc3N1ZXIiOiJodHRwczovL3Rva2VuLmFjdGlvbnMuZ2l0aHVidXNlcmNvbnRlbnQuY29tIiwicHJvdG9jb2wiOiJDYXRhbG9nSGVhZEVudmVsb3BlVjEiLCJyZWNvcmRUeXBlIjoiQ2F0YWxvZ0hlYWRWMSIsInJlcG9zaXRvcnkiOiJnaXRodWIuY29tL2FpaC9zdXBwb3J0ZWQtY2F0YWxvZyIsInNpZ25lcklkZW50aXR5Ijoic2lnbmVyOmNhdGFsb2ctaGVhZC12MSIsIndvcmtmbG93SWRlbnRpdHkiOiJ3b3JrZmxvdzpjYXRhbG9nLXJlbGVhc2UtdjEifSwicHJlZGljYXRlVHlwZSI6Imh0dHBzOi8vYWloLmRldi9DYXRhbG9nSGVhZFYxIiwic3ViamVjdCI6W3siZGlnZXN0Ijp7InNoYTI1NiI6IjIyYzQyOTM5NTQzZjY5OTg5NTQ1ZTJkOTM2NDRkZThlM2Q5ODQzMTFkYWY0OWM4ZGQ1ZGQ4MjQwY2E5NTkxYjAifSwibmFtZSI6ImFpaC9DYXRhbG9nSGVhZFYxIn1dfQ==","payloadType":"application/vnd.in-toto+json","signatures":[{"keyid":"head-key-1","sig":"aGVhZC1zaWc="}]}',
  "utf8",
);
const literalHeadEnvelopeSha256 =
  "da7ae1e9bd58e139408190a0fe02d929c41afeef710a86f14f05131004c1309f";
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
    catalogHeadBytes: literalHeadBytes,
    catalogHeadSha256: literalHeadSha256,
    catalogHeadEnvelopeBytes: literalHeadEnvelopeBytes,
    catalogHeadEnvelopeSha256: literalHeadEnvelopeSha256,
    catalogSnapshotBytes: literalSnapshotBytes,
    catalogSnapshotSha256: literalSnapshotSha256,
    signerRootSha256: headRoot,
    verifiedAt: "2026-08-17T11:00:00Z",
    ...overrides,
  };
}

function stateForHead(
  nextHead: Record<string, unknown>,
  nextSnapshotBytes: Buffer = literalSnapshotBytes,
  overrides: Record<string, unknown> = {},
) {
  const catalogHeadBytes = Buffer.from(JSON.stringify(nextHead), "utf8");
  const catalogHeadSha256 = sha(catalogHeadBytes.toString("utf8"));
  const statementBytes = Buffer.from(
    JSON.stringify({
      _type: "https://in-toto.io/Statement/v1",
      predicate: {
        environment: resolutionContext.expectedEnvironment,
        issuer: resolutionContext.expectedIssuer,
        protocol: "CatalogHeadEnvelopeV1",
        recordType: "CatalogHeadV1",
        repository: resolutionContext.expectedRepository,
        signerIdentity: "signer:catalog-head-v1",
        workflowIdentity: resolutionContext.expectedWorkflowIdentity,
      },
      predicateType: "https://aih.dev/CatalogHeadV1",
      subject: [{ digest: { sha256: catalogHeadSha256 }, name: "aih/CatalogHeadV1" }],
    }),
    "utf8",
  );
  const catalogHeadEnvelopeBytes = Buffer.from(
    JSON.stringify({
      payload: statementBytes.toString("base64"),
      payloadType: "application/vnd.in-toto+json",
      signatures: [{ keyid: "head-key-1", sig: "aGVhZC1zaWc=" }],
    }),
    "utf8",
  );
  return cachedCatalogState({
    catalogHeadBytes,
    catalogHeadEnvelopeBytes,
    catalogHeadEnvelopeSha256: sha(catalogHeadEnvelopeBytes.toString("utf8")),
    catalogHeadSha256,
    catalogSnapshotBytes: nextSnapshotBytes,
    catalogSnapshotSha256: sha(nextSnapshotBytes.toString("utf8")),
    ...overrides,
  });
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
  expectedCatalogSignerIdentity: "signer:catalog-head-v1",
  expectedRepository: "github.com/aih/supported-catalog",
  expectedWorkflowIdentity: "workflow:catalog-release-v1",
  expectedIssuer: "https://token.actions.githubusercontent.com",
  expectedRef: "refs/heads/main",
  expectedEnvironment: "catalog-release",
  expectedCatalogSha256: literalSnapshotSha256,
  expectedPromotionDecisionSha256:
    "1111111111111111111111111111111111111111111111111111111111111111",
  expectedPackageSha256: sha("supported catalog package"),
  expectedPackageRootSha256: sha("supported catalog package root"),
};

function headVerificationInput(envelope: unknown, overrides: Record<string, unknown> = {}) {
  return {
    envelope,
    expectedSignerRootSha256: headRoot,
    expectedCatalogSignerIdentity: resolutionContext.expectedCatalogSignerIdentity,
    now: resolutionContext.now,
    expectedRepository: resolutionContext.expectedRepository,
    expectedWorkflowIdentity: resolutionContext.expectedWorkflowIdentity,
    expectedIssuer: resolutionContext.expectedIssuer,
    expectedRef: resolutionContext.expectedRef,
    expectedEnvironment: resolutionContext.expectedEnvironment,
    verifyCanonicalPae: () => true,
    ...overrides,
  };
}

function standardEnvelopeForHead(nextHead: Record<string, unknown>) {
  const headBytes = Buffer.from(JSON.stringify(nextHead), "utf8");
  const statementBytes = Buffer.from(
    JSON.stringify({
      _type: "https://in-toto.io/Statement/v1",
      predicate: {
        environment: resolutionContext.expectedEnvironment,
        issuer: resolutionContext.expectedIssuer,
        protocol: "CatalogHeadEnvelopeV1",
        recordType: "CatalogHeadV1",
        repository: resolutionContext.expectedRepository,
        signerIdentity:
          typeof nextHead.signerIdentity === "string"
            ? nextHead.signerIdentity
            : "signer:catalog-head-v1",
        workflowIdentity: resolutionContext.expectedWorkflowIdentity,
      },
      predicateType: "https://aih.dev/CatalogHeadV1",
      subject: [{ digest: { sha256: sha(headBytes.toString("utf8")) }, name: "aih/CatalogHeadV1" }],
    }),
    "utf8",
  );
  return {
    payload: statementBytes.toString("base64"),
    payloadType: "application/vnd.in-toto+json",
    signatures: [{ keyid: "head-key-1", sig: "aGVhZC1zaWc=" }],
  };
}

describe("signed catalog-head parsing and verification", () => {
  it("accepts bytes only through strict canonical DSSE/head/snapshot verification with literal vectors", () => {
    const envelope = parseCatalogHeadEnvelopeV1(literalHeadEnvelopeBytes);
    const bytes = canonicalCatalogHeadEnvelopeV1Bytes(envelope);
    expect(bytes).toEqual(literalHeadEnvelopeBytes);
    expect(sha(bytes.toString("utf8"))).toBe(literalHeadEnvelopeSha256);
    expect(sha(literalHeadBytes.toString("utf8"))).toBe(literalHeadSha256);
    expect(sha(literalSnapshotBytes.toString("utf8"))).toBe(literalSnapshotSha256);
    expect(JSON.parse(literalHeadBytes.toString("utf8"))).toMatchObject({
      catalogSha256: literalSnapshotSha256,
    });
    expect(
      JSON.parse(Buffer.from(literalHeadPayloadBase64, "base64").toString("utf8")),
    ).toMatchObject({
      subject: [{ digest: { sha256: literalHeadSha256 } }],
    });
    expect(parseCatalogHeadEnvelopeV1(bytes)).toEqual(envelope);
    expect(parseCatalogHeadEnvelopeV1(new Uint8Array(bytes))).toEqual(envelope);
    expect(envelope.envelope.payload).toBe(literalHeadPayloadBase64);
    expect(Buffer.from(envelope.envelope.payload, "base64")).toEqual(envelope.statementBytes);
    const verifyCanonicalPae = vi.fn(
      (request: { expectedSignerRootSha256: string }) =>
        request.expectedSignerRootSha256 === headRoot,
    );
    expect(
      verifyCatalogHeadEnvelopeV1(headVerificationInput(envelope, { verifyCanonicalPae })),
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
        expectedSignerRootSha256: headRoot,
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
      { expectedCatalogSignerIdentity: "signer:other-catalog-head-v1" },
    ])
      expect(() =>
        verifyCatalogHeadEnvelopeV1({
          ...headVerificationInput(envelope),
          ...mismatch,
          verifyCanonicalPae: (request: { expectedSignerRootSha256: string }) =>
            request.expectedSignerRootSha256 === headRoot,
        }),
      ).toThrow();
  });

  it("closes direct authority-bearing verification requests without reading hostile extras", () => {
    const envelope = parseCatalogHeadEnvelopeV1(literalHeadEnvelopeBytes);
    expect(() =>
      verifyCatalogHeadEnvelopeV1(headVerificationInput(envelope, { unexpected: true })),
    ).toThrow();
    let getterCalls = 0;
    const accessor = Object.defineProperty(headVerificationInput(envelope), "unexpected", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return true;
      },
    });
    expect(() => verifyCatalogHeadEnvelopeV1(accessor)).toThrow();
    const inherited = Object.assign(
      Object.create({ unexpected: true }),
      headVerificationInput(envelope),
    );
    expect(() => verifyCatalogHeadEnvelopeV1(inherited)).toThrow();
    expect(getterCalls).toBe(0);
  });

  it("fails closed on hostile bytes, typed trust mismatches, replay, rollback, and incompatible versions", () => {
    const valid = parseCatalogHeadEnvelopeV1(literalHeadEnvelopeBytes);
    for (const changed of [
      Buffer.from('{"a":1,"\\u0061":2}', "utf8"),
      Buffer.from('{"head":true,}', "utf8"),
      Buffer.from('{"value":"\ud800"}', "utf8"),
      new Uint8Array([0xc3, 0x28]),
      { ...envelopeInput(), signerRootSha256: adminRoot },
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
        standardEnvelopeForHead({ ...head, compatibleSchemaVersions: ["999"] }),
      ),
    ).not.toThrow();
    expect(() =>
      parseCatalogHeadEnvelopeV1(
        standardEnvelopeForHead({ ...head, compatibleEffectVersions: ["999"] }),
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

describe("CatalogSnapshotV1 strict material boundary", () => {
  it("parses only canonical bytes into an immutable, branded, component-sorted snapshot", () => {
    const parsed = parseCatalogSnapshotV1Json(literalSnapshotBytes);
    expect(canonicalCatalogSnapshotV1Bytes(parsed)).toEqual(literalSnapshotBytes);
    expect(parseCatalogSnapshotV1Json(new Uint8Array(literalSnapshotBytes))).toEqual(parsed);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.members)).toBe(true);
    expect(parsed.members.map((member: { componentId: string }) => member.componentId)).toEqual([
      "skill:catalog-example",
    ]);
    expect(() => canonicalCatalogSnapshotV1Bytes({ ...parsed })).toThrow();
    expect(() => {
      (parsed.members[0] as { pinSha256: string }).pinSha256 = sha("forged");
    }).toThrow();
  });

  it("accepts shared source, repository, and candidate identities across distinct components only", () => {
    const first = JSON.parse(literalSnapshotBytes.toString("utf8")).members[0] as Record<
      string,
      unknown
    >;
    const bytes = canonicalStrictJsonBytesV1({
      protocol: "CatalogSnapshotV1",
      members: [
        { ...first, componentId: "skill:catalog-a" },
        { ...first, componentId: "skill:catalog-b" },
      ],
    });
    expect(parseCatalogSnapshotV1Json(bytes).members).toHaveLength(2);
  });

  it("rejects byte aliases, malformed members, duplicate component IDs, and noncanonical schema ordering", () => {
    const base = JSON.parse(literalSnapshotBytes.toString("utf8")) as {
      members: Array<Record<string, unknown>>;
    };
    const first = base.members[0];
    if (first === undefined) throw new Error("expected literal snapshot member");
    const duplicate = canonicalStrictJsonBytesV1({
      protocol: "CatalogSnapshotV1",
      members: [first, { ...first }],
    });
    const reversed = canonicalStrictJsonBytesV1({
      protocol: "CatalogSnapshotV1",
      members: [
        { ...first, componentId: "skill:z" },
        { ...first, componentId: "skill:a" },
      ],
    });
    const missingMemberField = { ...first };
    delete missingMemberField.evidenceSha256;
    const oversizedMembers = Array.from({ length: 4097 }, (_, index) => ({
      ...first,
      componentId: `skill:catalog-${String(index)}`,
    }));
    const digestFields = [
      "candidateIdentitySha256",
      "candidateSha256",
      "evidenceSha256",
      "gitCommitSha256",
      "pinSha256",
      "policyRevisionSha256",
      "profileSha256",
      "promotionDecisionSha256",
      "qualificationBundleSha256",
      "recipeSha256",
      "sourceSha256",
    ] as const;
    for (const value of [
      Buffer.from(`${literalSnapshotBytes.toString("utf8")} `, "utf8"),
      Buffer.from('{"protocol":"CatalogSnapshotV1","members":[],"unknown":true}', "utf8"),
      Buffer.from(
        '{"protocol":"CatalogSnapshotV1","members":[{"componentId":"skill:a","componentId":"skill:a"}]}',
        "utf8",
      ),
      new Uint8Array([0xc3, 0x28]),
      duplicate,
      reversed,
      canonicalStrictJsonBytesV1({ protocol: "CatalogSnapshotV1", members: [] }),
      canonicalStrictJsonBytesV1({
        protocol: "CatalogSnapshotV1",
        members: [missingMemberField],
      }),
      canonicalStrictJsonBytesV1({
        protocol: "CatalogSnapshotV1",
        members: [{ ...first, unknown: true }],
      }),
      canonicalStrictJsonBytesV1({ protocol: "CatalogSnapshotV1", members: oversizedMembers }),
      canonicalStrictJsonBytesV1({
        protocol: "CatalogSnapshotV1",
        members: [{ ...first, sourceId: "x".repeat(257) }],
      }),
      canonicalStrictJsonBytesV1({
        protocol: "CatalogSnapshotV1",
        members: [{ ...first, repository: "github.com/Example/catalog-example" }],
      }),
      canonicalStrictJsonBytesV1({
        protocol: "CatalogSnapshotV1",
        members: [{ ...first, sourceId: "catalog/../example" }],
      }),
      canonicalStrictJsonBytesV1({
        protocol: "CatalogSnapshotV1",
        members: [{ ...first, sourceId: "https://example.invalid/catalog" }],
      }),
      Buffer.from(
        JSON.stringify({
          protocol: "CatalogSnapshotV1",
          members: [{ ...first, sourceId: "catalog\u0301" }],
        }),
        "utf8",
      ),
      Buffer.from(
        JSON.stringify({
          protocol: "CatalogSnapshotV1",
          members: [{ ...first, repository: "example/catalo\u0301g" }],
        }),
        "utf8",
      ),
      canonicalStrictJsonBytesV1({
        protocol: "CatalogSnapshotV1",
        members: [{ ...first, componentId: "skill:Catalog-example" }],
      }),
      Buffer.from(
        JSON.stringify({
          protocol: "CatalogSnapshotV1",
          members: [{ ...first, componentId: "skill:catalog\u0301-example" }],
        }),
        "utf8",
      ),
    ])
      expect(() => parseCatalogSnapshotV1Json(value)).toThrow();
    for (const field of digestFields)
      for (const invalid of [
        `sha256:${String(first[field])}`,
        "A".repeat(64),
        "a".repeat(63),
        "g".repeat(64),
      ])
        expect(() =>
          parseCatalogSnapshotV1Json(
            canonicalStrictJsonBytesV1({
              protocol: "CatalogSnapshotV1",
              members: [{ ...first, [field]: invalid }],
            }),
          ),
        ).toThrow();
  });
});

describe("hidden verified catalog material", () => {
  it("admits selected material only after the existing signed resolution path and never exposes caller-forged state", () => {
    const request = {
      ...resolutionContext,
      lastGood: cachedCatalogState(),
      fresh: cachedCatalogState(),
      cachedVerified: { kind: "unavailable" },
      packaged: { kind: "unavailable" },
      verifyCanonicalPae: () => true,
    };
    const material = resolveVerifiedCatalogMaterialV1(request);
    expect(material).toMatchObject({
      kind: "resolved",
      catalogHeadSha256: literalHeadSha256,
      catalogSha256: literalSnapshotSha256,
      sequence: 42,
      tier: "fresh",
    });
    expect(Object.isFrozen(material)).toBe(true);
    // A caller state is raw data: an equivalent closed copy is valid when its bytes,
    // hashes, DSSE, trust context, and continuity still verify.
    expect(
      resolveVerifiedCatalogMaterialV1({ ...request, fresh: { ...request.fresh } }),
    ).toMatchObject({
      kind: "resolved",
      catalogHeadSha256: literalHeadSha256,
    });
    for (const next of [
      {
        ...request,
        fresh: { kind: "unavailable" },
        cachedVerified: { kind: "unavailable" },
        packaged: { kind: "unavailable" },
      },
      { ...request, now: "2026-08-18T00:00:00Z" },
      { ...request, expectedCatalogSha256: sha("wrong catalog") },
    ])
      expect(() => resolveVerifiedCatalogMaterialV1(next)).toThrow();
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
  it("closes authority-bearing resolution requests without falling through or reading hostile extras", () => {
    const lastGood = cachedCatalogState();
    const request = {
      ...resolutionContext,
      lastGood,
      fresh: lastGood,
      cachedVerified: { kind: "unavailable" },
      packaged: { kind: "unavailable" },
      verifyCanonicalPae: () => true,
    };
    expect(resolveAdminCatalogV1({ ...request, unexpected: true })).toEqual({
      kind: "fatal",
      lastGood,
    });
    let getterCalls = 0;
    const accessor = Object.defineProperty({ ...request }, "unexpected", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return true;
      },
    });
    expect(resolveAdminCatalogV1(accessor)).toEqual({ kind: "fatal", lastGood });
    const inherited = Object.assign(Object.create({ unexpected: true }), request);
    expect(resolveAdminCatalogV1(inherited)).toEqual({ kind: "fatal", lastGood });
    expect(getterCalls).toBe(0);
  });

  it("requires an explicitly trusted catalog signer identity and context-bound catalog and promotion digests", () => {
    const cached = cachedCatalogState();
    const unavailable = { kind: "unavailable" };
    for (const mismatch of [
      { expectedCatalogSha256: sha("another catalog") },
      { expectedPromotionDecisionSha256: sha("another promotion") },
      { expectedCatalogSignerIdentity: "signer:other-catalog-head-v1" },
    ])
      expect(
        resolveAdminCatalogV1({
          ...resolutionContext,
          ...mismatch,
          lastGood: cached,
          fresh: cached,
          cachedVerified: unavailable,
          packaged: unavailable,
          verifyCanonicalPae: () => true,
        }),
      ).toEqual({ kind: "fatal", lastGood: cached });

    const literalHead = JSON.parse(literalHeadBytes.toString("utf8")) as Record<string, unknown>;
    const selfClaimed = stateForHead({ ...literalHead, signerIdentity: "signer:self-claimed-v1" });
    expect(
      resolveAdminCatalogV1({
        ...resolutionContext,
        lastGood: cached,
        fresh: selfClaimed,
        cachedVerified: unavailable,
        packaged: unavailable,
        verifyCanonicalPae: () => true,
      }),
    ).toEqual({ kind: "fatal", lastGood: cached });
  });

  it("treats head validity as [validFrom, validUntil) with explicit now and never falls back", () => {
    const cached = cachedCatalogState();
    const unavailable = { kind: "unavailable" };
    expect(
      resolveAdminCatalogV1({
        ...resolutionContext,
        now: "2026-08-17T00:00:00Z",
        lastGood: cached,
        fresh: cached,
        cachedVerified: unavailable,
        packaged: unavailable,
        verifyCanonicalPae: () => true,
      }),
    ).toMatchObject({ kind: "resolved", tier: "fresh" });
    for (const now of ["2026-08-16T23:59:59Z", "2026-08-18T00:00:00Z"])
      expect(
        resolveAdminCatalogV1({
          ...resolutionContext,
          now,
          lastGood: cached,
          fresh: cached,
          cachedVerified: cachedCatalogState(),
          packaged: packagedCatalogState(),
          verifyCanonicalPae: () => true,
        }),
      ).toEqual({ kind: "fatal", lastGood: cached });
  });

  it("fails closed before inspecting hostile resolution-tier candidates", () => {
    const cached = cachedCatalogState();
    let getterCalls = 0;
    const accessor = Object.defineProperty({}, "kind", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "unavailable";
      },
    });
    const proxy = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error("hostile prototype trap");
        },
      },
    );
    for (const fresh of [
      null,
      undefined,
      42,
      "unavailable",
      {},
      { kind: "unavailable", extra: true },
      { kind: "available" },
      Object.create({ kind: "unavailable" }),
      accessor,
      proxy,
    ])
      expect(
        resolveAdminCatalogV1({
          ...resolutionContext,
          lastGood: cached,
          fresh,
          cachedVerified: cachedCatalogState(),
          packaged: packagedCatalogState(),
          verifyCanonicalPae: vi.fn(() => true),
        }),
      ).toEqual({ kind: "fatal", lastGood: cached });
    expect(getterCalls).toBe(0);
  });

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

  it("requires trusted package digest/root only for a packaged tier and leaves verifiedAt visible rather than authoritative", () => {
    const lastGood = cachedCatalogState();
    const unavailable = { kind: "unavailable" };
    const packaged = packagedCatalogState();
    expect(
      resolveAdminCatalogV1({
        ...resolutionContext,
        lastGood,
        fresh: unavailable,
        cachedVerified: unavailable,
        packaged,
        verifyCanonicalPae: () => true,
      }),
    ).toMatchObject({ kind: "resolved", tier: "packaged" });
    for (const context of [
      { expectedPackageSha256: sha("wrong package") },
      { expectedPackageRootSha256: sha("wrong package root") },
      { expectedPackageSha256: "SHA256:bad" },
      { expectedPackageRootSha256: undefined },
    ])
      expect(
        resolveAdminCatalogV1({
          ...resolutionContext,
          ...context,
          lastGood,
          fresh: unavailable,
          cachedVerified: unavailable,
          packaged,
          verifyCanonicalPae: () => true,
        }),
      ).toEqual({ kind: "fatal", lastGood });

    const oldVerifiedAt = cachedCatalogState({ verifiedAt: "2020-01-01T00:00:00Z" });
    expect(
      resolveAdminCatalogV1({
        ...resolutionContext,
        lastGood,
        fresh: oldVerifiedAt,
        cachedVerified: unavailable,
        packaged: unavailable,
        verifyCanonicalPae: () => true,
      }),
    ).toMatchObject({
      kind: "resolved",
      tier: "fresh",
      verifiedAt: "2020-01-01T00:00:00Z",
    });
  });

  it("reports compatibility-required without materializing and treats corrupt cache or invalid higher tiers as terminal", () => {
    const literalHead = JSON.parse(literalHeadBytes.toString("utf8")) as Record<string, unknown>;
    const incompatible = stateForHead({
      ...literalHead,
      compatibleSchemaVersions: ["2"],
      previousCatalogHeadSha256: literalHeadSha256,
      sequence: 43,
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
    const equalSequenceIncompatible = stateForHead({
      ...literalHead,
      compatibleSchemaVersions: ["2"],
    });
    expect(
      resolveAdminCatalogV1({
        ...resolutionContext,
        lastGood: cached,
        fresh: equalSequenceIncompatible,
        cachedVerified: { kind: "unavailable" },
        packaged: { kind: "unavailable" },
        verifyCanonicalPae: () => true,
      }),
    ).toEqual({ kind: "fatal", lastGood: cached });
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
    const literalHead = JSON.parse(literalHeadBytes.toString("utf8")) as Record<string, unknown>;
    const higherSnapshot = Buffer.from(
      literalSnapshotBytes.toString("utf8").replace("catalog-example", "catalog-other"),
      "utf8",
    );
    const higher = stateForHead(
      {
        ...literalHead,
        catalogSha256: sha(higherSnapshot.toString("utf8")),
        previousCatalogHeadSha256: literalHeadSha256,
        sequence: 43,
      },
      higherSnapshot,
    );
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
      stateForHead({ ...literalHead, validUntil: "2026-08-18T00:00:01Z" }),
      stateForHead({ ...literalHead, sequence: 41 }),
      stateForHead({ ...literalHead, previousCatalogHeadSha256: sha("wrong previous") }),
      cachedCatalogState({ catalogHeadEnvelopeSha256: sha("replayed head") }),
      cachedCatalogState({ catalogSnapshotBytes: Buffer.from("{}", "utf8") }),
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
