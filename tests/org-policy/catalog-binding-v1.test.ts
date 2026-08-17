import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  canonicalResolvedCatalogBindingV1Bytes,
  canonicalResolvedCatalogBindingV1Sha256,
  createAdminSeatDistributionV1,
  createResolvedCatalogBindingV1,
  parseResolvedCatalogBindingV1Json,
  verifyAdminSeatDistributionV1,
} from "../../src/org-policy/catalog-binding-v1.js";

const sha = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
const digest = /^[a-f0-9]{64}$/;
const headRoot = sha("head signer root");
const adminRoot = sha("admin signer root");

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
      sourceSha256: sha("source"),
      gitCommitSha256: sha("commit"),
      pinSha256: sha("pin"),
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
    expect(parseResolvedCatalogBindingV1Json(bytes.toString("utf8"))).toEqual(binding);
    for (const text of [
      `${bytes.toString("utf8")} `,
      JSON.stringify(
        Object.fromEntries(Object.entries(JSON.parse(bytes.toString("utf8"))).reverse()),
      ),
      bytes
        .toString("utf8")
        .replace("ResolvedCatalogBindingV1", "ResolvedCatalogBinding\\u0056\u0031"),
    ])
      expect(() => parseResolvedCatalogBindingV1Json(text)).toThrow();
  });

  it("has a literal independent canonical binding vector and rejects cross-bound security-field swaps", () => {
    const literal = Buffer.from('{"a":"\\ud83d\\ude00","z":1}', "utf8");
    expect(sha(literal.toString("utf8"))).toBe(
      "8df4222417819a8f429e398cd1a5b0d3606e0bcd28dd4b9f91083b9d428dbdd6",
    );
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
    ] as const)
      expect(
        createResolvedCatalogBindingV1({
          ...bindingInput(),
          [field]: field.endsWith("Sha256") ? sha(`changed:${field}`) : `changed-${field}`,
        }).resolvedCatalogBindingSha256,
      ).not.toBe(baseline.resolvedCatalogBindingSha256);
    for (const changed of [
      { ...bindingInput(), headSignerRootSha256: adminRoot },
      { ...bindingInput(), adminSignerRootSha256: headRoot },
      {
        ...bindingInput(),
        members: [{ ...memberInput(), sourceSha256: memberInput().pinSha256 }],
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
    const binding = createResolvedCatalogBindingV1(bindingInput());
    const seat = createAdminSeatDistributionV1({
      binding,
      signerIdentity: "signer:admin-seat-v1",
      signatures: [{ keyid: "admin-key-1", sig: "YWRtaW4tc2ln" }],
    });
    exactKeys(seat, ["binding", "envelope", "protocol"]);
    expect(seat.envelope.payloadType).toBe("application/vnd.in-toto+json");
    expect(seat.envelope.signatures).toHaveLength(1);
    expect(
      verifyAdminSeatDistributionV1({
        distribution: seat,
        expectedAdminSignerRootSha256: adminRoot,
        expectedHeadSignerRootSha256: headRoot,
        verifyCanonicalPae: () => true,
      }),
    ).toEqual(seat);
    for (const changed of [
      { ...seat, envelope: { ...seat.envelope, signatures: [] } },
      { ...seat, binding: { ...binding } },
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
              verifyCanonicalPae: () => true,
            }),
      ).toThrow();
  });
});
