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

describe("signed catalog-head parsing and verification", () => {
  it("accepts bytes only through strict canonical DSSE/head/snapshot verification with literal vectors", () => {
    const envelope = parseCatalogHeadEnvelopeV1(envelopeInput());
    const bytes = canonicalCatalogHeadEnvelopeV1Bytes(envelope);
    expect(bytes).toEqual(canonicalCatalogHeadEnvelopeV1Bytes(envelope));
    expect(sha(bytes.toString("utf8"))).toMatch(/^[a-f0-9]{64}$/);
    expect(parseCatalogHeadEnvelopeV1(bytes)).toEqual(envelope);
    expect(parseCatalogHeadEnvelopeV1(new Uint8Array(bytes))).toEqual(envelope);
    expect(Buffer.from(envelope.envelope.payload, "base64")).toEqual(envelope.statementBytes);
    const verifyCanonicalPae = vi.fn(() => true);
    expect(
      verifyCatalogHeadEnvelopeV1({
        envelope,
        expectedSignerRootSha256: headRoot,
        expectedRepository: "github.com/aih/supported-catalog",
        expectedWorkflowIdentity: "workflow:catalog-release-v1",
        expectedIssuer: "https://token.actions.githubusercontent.com",
        expectedRef: "refs/heads/main",
        expectedEnvironment: "catalog-release",
        now: "2026-08-17T12:00:00Z",
        verifyCanonicalPae,
      }),
    ).toEqual(envelope);
    expect(verifyCanonicalPae).toHaveBeenCalledOnce();
  });

  it("fails closed on hostile bytes, typed trust mismatches, replay, rollback, and incompatible versions", () => {
    const valid = parseCatalogHeadEnvelopeV1(envelopeInput());
    for (const changed of [
      Buffer.from('{"a":1,"\\u0061":2}', "utf8"),
      Buffer.from('{"head":true,}', "utf8"),
      Buffer.from('{"value":"\ud800"}', "utf8"),
      new Uint8Array([0xc3, 0x28]),
      { ...envelopeInput(), signerRootSha256: adminRoot },
      {
        ...envelopeInput(),
        head: { ...head, sequence: 7, catalogSha256: sha("same-sequence-different") },
      },
      { ...envelopeInput(), head: { ...head, sequence: 6 } },
      { ...envelopeInput(), head: { ...head, compatibleSchemaVersions: ["999"] } },
      { ...envelopeInput(), head: { ...head, compatibleEffectVersions: ["999"] } },
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
    expect(() =>
      verifyCatalogHeadEnvelopeV1({ envelope: { ...valid }, expectedSignerRootSha256: headRoot }),
    ).toThrow();
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
    const fresh = parseCatalogHeadEnvelopeV1(envelopeInput());
    const cached = parseCatalogHeadEnvelopeV1({
      ...envelopeInput(),
      head: { ...head, sequence: 6 },
    });
    const packaged = parseCatalogHeadEnvelopeV1({
      ...envelopeInput(),
      head: { ...head, sequence: 5 },
    });
    const result = resolveAdminCatalogV1({
      now: "2026-08-17T12:00:00Z",
      headSignerRootSha256: headRoot,
      adminSignerRootSha256: adminRoot,
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
        now: "2026-08-17T12:00:00Z",
        headSignerRootSha256: headRoot,
        adminSignerRootSha256: adminRoot,
        lastGood: cached,
        fresh,
        cachedVerified: { kind: "unavailable" },
        packaged,
        verifyCanonicalPae: () => false,
      }),
    ).toEqual({ kind: "fatal", lastGood: cached });
  });

  it("reports compatibility-required without materializing and treats corrupt cache or invalid higher tiers as terminal", () => {
    const incompatible = parseCatalogHeadEnvelopeV1({
      ...envelopeInput(),
      head: { ...head, compatibleSchemaVersions: ["2"] },
    });
    const cached = parseCatalogHeadEnvelopeV1(envelopeInput());
    expect(
      resolveAdminCatalogV1({
        now: "2026-08-17T12:00:00Z",
        headSignerRootSha256: headRoot,
        adminSignerRootSha256: adminRoot,
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
      { ...cached, cacheSha256: sha("corrupt cache") },
      { ...cached, signerRootSha256: adminRoot },
    ])
      expect(
        resolveAdminCatalogV1({
          now: "2026-08-17T12:00:00Z",
          headSignerRootSha256: headRoot,
          adminSignerRootSha256: adminRoot,
          lastGood: cached,
          fresh: corrupt,
          cachedVerified: { kind: "unavailable" },
          packaged: { kind: "unavailable" },
          verifyCanonicalPae: () => true,
        }),
      ).toEqual({ kind: "fatal", lastGood: cached });
  });
});
