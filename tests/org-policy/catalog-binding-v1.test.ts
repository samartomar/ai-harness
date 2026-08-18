import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  canonicalAdminSeatDistributionV1Bytes,
  canonicalResolvedCatalogBindingV1Bytes,
  canonicalResolvedCatalogBindingV1Sha256,
  createAdminSeatDistributionV1,
  createResolvedCatalogBindingV1,
  parseAdminSeatDistributionV1Json,
  parseResolvedCatalogBindingV1Json,
  verifyAdminSeatDistributionV1,
} from "../../src/org-policy/catalog-binding-v1.js";

const sha = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
const digest = /^[a-f0-9]{64}$/;
const headRoot = sha("head signer root");
const adminRoot = sha("admin signer root");

// Independently precomputed canonical JSON and SHA-256 vector.  It is intentionally
// literal: production constructors/canonicalizers must not generate its expectation.
const literalBindingBytes = Buffer.from(
  '{"adminSignerRootSha256":"5555555555555555555555555555555555555555555555555555555555555555","catalogHeadSha256":"22c42939543f69989545e2d93644de8e3d984311daf49c8dd5dd8240ca9591b0","catalogSha256":"ecad3085f3e2526eea43deacab7e67faeb25060439fa30922cf8935020e41eb7","compatibleEffectVersion":"1","compatibleSchemaVersion":"1","headSignerRootSha256":"8888888888888888888888888888888888888888888888888888888888888888","members":[{"candidateIdentitySha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","candidateSha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","componentId":"skill:catalog-example","evidenceSha256":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","gitCommitSha256":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","pinSha256":"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee","policyRevisionSha256":"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff","profileSha256":"0000000000000000000000000000000000000000000000000000000000000000","promotionDecisionSha256":"1111111111111111111111111111111111111111111111111111111111111111","qualificationBundleSha256":"2222222222222222222222222222222222222222222222222222222222222222","recipeSha256":"3333333333333333333333333333333333333333333333333333333333333333","repository":"github.com/example/catalog-example","sourceId":"catalog-example","sourceSha256":"4444444444444444444444444444444444444444444444444444444444444444"}],"protocol":"ResolvedCatalogBindingV1","resolvedAt":"2026-08-17T12:00:00Z","sequence":42,"tier":"fresh"}',
  "utf8",
);
const literalBindingSha256 = "8b9044d9e510bfaa65800290b0b168fbdce2759976755e6d6b8cd25b003ad056";
const literalCatalogHeadSha256 = "22c42939543f69989545e2d93644de8e3d984311daf49c8dd5dd8240ca9591b0";
const literalCatalogSnapshotSha256 =
  "ecad3085f3e2526eea43deacab7e67faeb25060439fa30922cf8935020e41eb7";
const literalAdminEnvelopeBytes = Buffer.from(
  '{"payload":"eyJfdHlwZSI6Imh0dHBzOi8vaW4tdG90by5pby9TdGF0ZW1lbnQvdjEiLCJwcmVkaWNhdGUiOnsicHJvdG9jb2wiOiJBZG1pblNlYXREaXN0cmlidXRpb25WMSIsInJlY29yZFR5cGUiOiJSZXNvbHZlZENhdGFsb2dCaW5kaW5nVjEiLCJzaWduZXJJZGVudGl0eSI6InNpZ25lcjphZG1pbi1zZWF0LXYxIn0sInByZWRpY2F0ZVR5cGUiOiJodHRwczovL2FpaC5kZXYvQWRtaW5TZWF0RGlzdHJpYnV0aW9uVjEiLCJzdWJqZWN0IjpbeyJkaWdlc3QiOnsic2hhMjU2IjoiOGI5MDQ0ZDllNTEwYmZhYTY1ODAwMjkwYjBiMTY4ZmJkY2UyNzU5OTc2NzU1ZTZkNmI4Y2QyNWIwMDNhZDA1NiJ9LCJuYW1lIjoiYWloL1Jlc29sdmVkQ2F0YWxvZ0JpbmRpbmdWMSJ9XX0=","payloadType":"application/vnd.in-toto+json","signatures":[{"keyid":"admin-key-1","sig":"YWRtaW4tc2ln"}]}',
  "utf8",
);
const literalAdminEnvelopeSha256 =
  "ee0ca93ef592bf5b0f3cac0ed53345cfdcecdb27f2ea5554a78fa105f00365c8";
const literalAdminPaeBase64 =
  "RFNTRXYxIDI4IGFwcGxpY2F0aW9uL3ZuZC5pbi10b3RvK2pzb24gMzcxIHsiX3R5cGUiOiJodHRwczovL2luLXRvdG8uaW8vU3RhdGVtZW50L3YxIiwicHJlZGljYXRlIjp7InByb3RvY29sIjoiQWRtaW5TZWF0RGlzdHJpYnV0aW9uVjEiLCJyZWNvcmRUeXBlIjoiUmVzb2x2ZWRDYXRhbG9nQmluZGluZ1YxIiwic2lnbmVySWRlbnRpdHkiOiJzaWduZXI6YWRtaW4tc2VhdC12MSJ9LCJwcmVkaWNhdGVUeXBlIjoiaHR0cHM6Ly9haWguZGV2L0FkbWluU2VhdERpc3RyaWJ1dGlvblYxIiwic3ViamVjdCI6W3siZGlnZXN0Ijp7InNoYTI1NiI6IjhiOTA0NGQ5ZTUxMGJmYWE2NTgwMDI5MGIwYjE2OGZiZGNlMjc1OTk3Njc1NWU2ZDZiOGNkMjViMDAzYWQwNTYifSwibmFtZSI6ImFpaC9SZXNvbHZlZENhdGFsb2dCaW5kaW5nVjEifV19";

const bindingInput = () => ({
  protocol: "ResolvedCatalogBindingV1" as const,
  catalogHeadSha256: sha("catalog head"),
  catalogSha256: sha("catalog snapshot"),
  sequence: 42,
  tier: "fresh" as const,
  resolvedAt: "2026-08-17T12:00:00Z",
  headSignerRootSha256: headRoot,
  adminSignerRootSha256: adminRoot,
  compatibleSchemaVersion: "1",
  compatibleEffectVersion: "1",
  members: [
    {
      componentId: "skill:catalog-example",
      sourceId: "github/example/catalog-example",
      repository: "github.com/example/catalog-example",
      sourceSha256: sha("source"),
      gitCommitSha256: sha("commit"),
      pinSha256: sha("pin"),
      candidateIdentitySha256: sha("candidate identity"),
      candidateSha256: sha("candidate"),
      profileSha256: sha("profile"),
      recipeSha256: sha("recipe"),
      policyRevisionSha256: sha("policy"),
      promotionDecisionSha256: sha("promotion"),
      qualificationBundleSha256: sha("qualification"),
      evidenceSha256: sha("evidence"),
    },
  ],
});

function memberInput() {
  const member = bindingInput().members[0];
  if (member === undefined) throw new Error("expected binding member fixture");
  return member;
}

function exactKeys(value: object, expected: readonly string[]): void {
  expect(Object.keys(value).sort()).toEqual([...expected].sort());
}

describe("ResolvedCatalogBindingV1", () => {
  it("binds exact signed catalog material into an immutable, canonically parseable Core-only binding", () => {
    const binding = createResolvedCatalogBindingV1(bindingInput());
    exactKeys(binding, [
      "adminSignerRootSha256",
      "catalogHeadSha256",
      "catalogSha256",
      "compatibleEffectVersion",
      "compatibleSchemaVersion",
      "headSignerRootSha256",
      "members",
      "protocol",
      "resolvedAt",
      "resolvedCatalogBindingSha256",
      "sequence",
      "tier",
    ]);
    expect(binding.resolvedCatalogBindingSha256).toMatch(digest);
    expect(binding.members.map((member: { componentId: string }) => member.componentId)).toEqual([
      "skill:catalog-example",
    ]);
    expect(Object.isFrozen(binding)).toBe(true);
    expect(Object.isFrozen(binding.members)).toBe(true);
    expect(() => {
      (binding.members[0] as { sourceSha256: string }).sourceSha256 = sha("forged");
    }).toThrow();

    const bytes = canonicalResolvedCatalogBindingV1Bytes(binding);
    expect(bytes).toEqual(canonicalResolvedCatalogBindingV1Bytes(binding));
    expect(canonicalResolvedCatalogBindingV1Sha256(binding)).toBe(sha(bytes.toString("utf8")));
    expect(parseResolvedCatalogBindingV1Json(bytes)).toEqual(binding);
    expect(parseResolvedCatalogBindingV1Json(new Uint8Array(bytes))).toEqual(binding);
    for (const text of [
      `${bytes.toString("utf8")} `,
      JSON.stringify(
        Object.fromEntries(Object.entries(JSON.parse(bytes.toString("utf8"))).reverse()),
      ),
      bytes
        .toString("utf8")
        .replace("ResolvedCatalogBindingV1", "ResolvedCatalogBinding\\u0056\u0031"),
    ])
      expect(() => parseResolvedCatalogBindingV1Json(Buffer.from(text, "utf8"))).toThrow();
    expect(() => parseResolvedCatalogBindingV1Json(new Uint8Array([0xc3, 0x28]))).toThrow();
  });

  it("has a literal independent canonical binding vector and rejects cross-bound security-field swaps", () => {
    expect(sha(literalBindingBytes.toString("utf8"))).toBe(literalBindingSha256);
    expect(parseResolvedCatalogBindingV1Json(literalBindingBytes)).toMatchObject({
      catalogHeadSha256: literalCatalogHeadSha256,
      catalogSha256: literalCatalogSnapshotSha256,
      protocol: "ResolvedCatalogBindingV1",
      resolvedCatalogBindingSha256: literalBindingSha256,
    });
    const baseline = createResolvedCatalogBindingV1(bindingInput());
    for (const field of [
      "catalogHeadSha256",
      "catalogSha256",
      "headSignerRootSha256",
      "adminSignerRootSha256",
      "compatibleSchemaVersion",
      "compatibleEffectVersion",
      "tier",
      "resolvedAt",
      "sequence",
    ] as const)
      expect(
        createResolvedCatalogBindingV1({
          ...bindingInput(),
          [field]: field.endsWith("Sha256")
            ? sha(`changed:${field}`)
            : field === "tier"
              ? "cached-verified"
              : field === "sequence"
                ? 43
                : field === "resolvedAt"
                  ? "2026-08-17T12:00:01Z"
                  : "2",
        }).resolvedCatalogBindingSha256,
      ).not.toBe(baseline.resolvedCatalogBindingSha256);
    for (const field of [
      "sourceId",
      "repository",
      "pinSha256",
      "sourceSha256",
      "candidateIdentitySha256",
      "candidateSha256",
      "profileSha256",
      "recipeSha256",
      "policyRevisionSha256",
      "promotionDecisionSha256",
      "qualificationBundleSha256",
      "evidenceSha256",
    ] as const)
      expect(
        createResolvedCatalogBindingV1({
          ...bindingInput(),
          members: [
            {
              ...memberInput(),
              [field]: field.endsWith("Sha256")
                ? sha(`changed:${field}`)
                : field === "sourceId"
                  ? "changed-source-id"
                  : "github.com/changed/repository",
            },
          ],
        }).resolvedCatalogBindingSha256,
      ).not.toBe(baseline.resolvedCatalogBindingSha256);
    for (const changed of [
      {
        ...bindingInput(),
        members: [{ ...memberInput(), sourceSha256: memberInput().pinSha256 }],
      },
      {
        ...bindingInput(),
        members: [{ ...memberInput(), candidateIdentitySha256: memberInput().candidateSha256 }],
      },
      {
        ...bindingInput(),
        members: [{ ...memberInput() }, { ...memberInput() }],
      },
      {
        ...bindingInput(),
        members: [{ ...memberInput(), componentId: "skill:catalog-Example" }],
      },
      { ...bindingInput(), sequence: 0 },
      { ...bindingInput(), resolvedAt: "2026-02-30T00:00:00Z" },
      { ...bindingInput(), rollbackOf: sha("forbidden") },
    ])
      expect(() => createResolvedCatalogBindingV1(changed)).toThrow();
  });

  it("rejects hostile JSON/data boundaries, aliases, bounds, and forged brands", () => {
    const oversized = Array.from({ length: 4097 }, (_, index) => ({
      ...bindingInput().members[0],
      componentId: `skill:catalog-${String(index)}`,
    }));
    const accessor: Record<string, unknown> = { ...bindingInput() };
    Object.defineProperty(accessor, "catalogSha256", {
      enumerable: true,
      get: () => sha("getter"),
    });
    const cycle: Record<string, unknown> = { ...bindingInput() };
    cycle.self = cycle;
    for (const changed of [
      accessor,
      cycle,
      { ...bindingInput(), members: oversized },
      { ...bindingInput(), resolvedAt: "x".repeat(4097) },
      { ...bindingInput(), compatibleSchemaVersion: "x".repeat(257) },
      { ...bindingInput(), catalogSha256: `sha256:${sha("prefixed")}` },
      { ...bindingInput(), catalogSha256: sha("upper").toUpperCase() },
      {
        ...bindingInput(),
        members: [{ ...bindingInput().members[0], sourceId: "https://github.com/example" }],
      },
      {
        ...bindingInput(),
        members: [{ ...bindingInput().members[0], sourceId: "github/example/../catalog" }],
      },
      {
        ...bindingInput(),
        members: [{ ...bindingInput().members[0], sourceId: "github/example/re\u0300gle" }],
      },
    ])
      expect(() => createResolvedCatalogBindingV1(changed)).toThrow();
    const binding = createResolvedCatalogBindingV1(bindingInput());
    expect(() => canonicalResolvedCatalogBindingV1Bytes({ ...binding })).toThrow();
  });
});

describe("admin-signed seat distributions", () => {
  it("requires a distinct admin-signed DSSE envelope and excludes acknowledgement authority", () => {
    const binding = parseResolvedCatalogBindingV1Json(literalBindingBytes);
    const seat = createAdminSeatDistributionV1({
      binding,
      signerIdentity: "signer:admin-seat-v1",
      signatures: [{ keyid: "admin-key-1", sig: "YWRtaW4tc2ln" }],
    });
    exactKeys(seat, ["binding", "envelope", "protocol"]);
    expect(seat.envelope.payloadType).toBe("application/vnd.in-toto+json");
    expect(seat.envelope.signatures).toHaveLength(1);
    expect(sha(literalAdminEnvelopeBytes.toString("utf8"))).toBe(literalAdminEnvelopeSha256);
    expect(Buffer.from(JSON.stringify(seat.envelope), "utf8")).toEqual(literalAdminEnvelopeBytes);
    const bytes = canonicalAdminSeatDistributionV1Bytes(seat);
    expect(parseAdminSeatDistributionV1Json(bytes)).toEqual(seat);
    expect(parseAdminSeatDistributionV1Json(new Uint8Array(bytes))).toEqual(seat);
    expect(() => canonicalAdminSeatDistributionV1Bytes({ ...seat })).toThrow();
    expect(
      verifyAdminSeatDistributionV1({
        distribution: seat,
        expectedAdminSignerRootSha256: "5".repeat(64),
        expectedHeadSignerRootSha256: "8".repeat(64),
        expectedAdminSignerIdentity: "signer:admin-seat-v1",
        verifyCanonicalPae: (request: {
          paeBytes: Buffer;
          expectedAdminSignerIdentity: string;
          signatures: unknown;
        }) => {
          expect(request.paeBytes).toEqual(Buffer.from(literalAdminPaeBase64, "base64"));
          expect(request.expectedAdminSignerIdentity).toBe("signer:admin-seat-v1");
          expect(request.signatures).toEqual([{ keyid: "admin-key-1", sig: "YWRtaW4tc2ln" }]);
          return true;
        },
      }),
    ).toEqual(seat);
    expect(() =>
      verifyAdminSeatDistributionV1({
        distribution: seat,
        expectedAdminSignerRootSha256: "8".repeat(64),
        expectedHeadSignerRootSha256: "5".repeat(64),
        expectedAdminSignerIdentity: "signer:admin-seat-v1",
        verifyCanonicalPae: () => true,
      }),
    ).toThrow();
    for (const changed of [
      { ...seat, envelope: { ...seat.envelope, signatures: [] } },
      { ...seat, envelope: { ...seat.envelope, signatures: [{ keyid: "admin-key-1", sig: "" }] } },
      { ...seat, binding: { ...binding } },
      binding,
      { ...seat, acknowledgement: { accepted: true } },
      { ...bindingInput(), adminSignerRootSha256: headRoot },
    ])
      expect(() =>
        "protocol" in changed && changed.protocol === "ResolvedCatalogBindingV1"
          ? createResolvedCatalogBindingV1(changed)
          : verifyAdminSeatDistributionV1({
              distribution: changed,
              expectedAdminSignerRootSha256: adminRoot,
              expectedHeadSignerRootSha256: headRoot,
              expectedAdminSignerIdentity: "signer:admin-seat-v1",
              verifyCanonicalPae: () => true,
            }),
      ).toThrow();
  });

  it("parses only an exact canonical distribution whose DSSE statement binds its branded binding", () => {
    const binding = parseResolvedCatalogBindingV1Json(literalBindingBytes);
    const distribution = createAdminSeatDistributionV1({
      binding,
      signerIdentity: "signer:admin-seat-v1",
      signatures: [{ keyid: "admin-key-1", sig: "YWRtaW4tc2ln" }],
    });
    const bytes = canonicalAdminSeatDistributionV1Bytes(distribution);
    const parsed = JSON.parse(bytes.toString("utf8")) as {
      binding: Record<string, unknown>;
      envelope: Record<string, unknown>;
      protocol: string;
    };
    const payload = JSON.parse(
      Buffer.from(parsed.envelope.payload as string, "base64").toString("utf8"),
    ) as Record<string, unknown>;
    expect(payload).toMatchObject({
      _type: "https://in-toto.io/Statement/v1",
      predicateType: "https://aih.dev/AdminSeatDistributionV1",
      subject: [{ digest: { sha256: literalBindingSha256 }, name: "aih/ResolvedCatalogBindingV1" }],
    });
    for (const changed of [
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes]),
      Buffer.from(`${bytes.toString("utf8")} `, "utf8"),
      Buffer.from(JSON.stringify({ ...parsed, unknown: true }), "utf8"),
      Buffer.from(
        JSON.stringify({
          ...parsed,
          binding: { ...parsed.binding, resolvedCatalogBindingSha256: sha("forged") },
        }),
        "utf8",
      ),
      Buffer.from(
        JSON.stringify({
          ...parsed,
          envelope: { ...parsed.envelope, payload: "eyJ4Ijp0cnVlfQ==" },
        }),
        "utf8",
      ),
    ])
      expect(() => parseAdminSeatDistributionV1Json(changed)).toThrow();
  });

  it("treats the expected admin signer identity as trusted verification context", () => {
    const binding = parseResolvedCatalogBindingV1Json(literalBindingBytes);
    const seat = createAdminSeatDistributionV1({
      binding,
      signerIdentity: "signer:admin-seat-v1",
      signatures: [{ keyid: "admin-key-1", sig: "YWRtaW4tc2ln" }],
    });
    expect(() =>
      verifyAdminSeatDistributionV1({
        distribution: seat,
        expectedAdminSignerRootSha256: "5".repeat(64),
        expectedHeadSignerRootSha256: "8".repeat(64),
        expectedAdminSignerIdentity: "signer:other-admin-v1",
        verifyCanonicalPae: () => true,
      }),
    ).toThrow();
  });
});
