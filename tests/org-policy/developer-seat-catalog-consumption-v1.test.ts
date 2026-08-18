import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  canonicalAdminSeatDistributionV1Bytes,
  canonicalResolvedCatalogBindingV1Bytes,
  createAdminSeatDistributionV1,
  createResolvedCatalogBindingV1,
} from "../../src/org-policy/catalog-binding-v1.js";
import { resolveDeveloperSeatCatalogConsumptionV1 } from "../../src/org-policy/developer-seat-catalog-consumption-v1.js";

const sha = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
const headRoot = sha("developer-seat head signer root");
const adminRoot = sha("developer-seat admin signer root");
const identity = "signer:developer-seat-admin-v1";

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
    repository: "github.com/example/catalog-example",
    sourceId: "catalog-example",
    sourceSha256: sha("source"),
    ...overrides,
  };
}

function bindingInput(overrides: Record<string, unknown> = {}) {
  return {
    adminSignerRootSha256: adminRoot,
    catalogHeadSha256: sha("catalog head"),
    catalogSha256: sha("catalog snapshot"),
    compatibleEffectVersion: "1",
    compatibleSchemaVersion: "1",
    headSignerRootSha256: headRoot,
    members: [member()],
    protocol: "ResolvedCatalogBindingV1" as const,
    resolvedAt: "2026-08-17T12:00:00Z",
    sequence: 42,
    tier: "fresh" as const,
    ...overrides,
  };
}

function distribution(overrides: Record<string, unknown> = {}, keyid = "seat-key-1") {
  const binding = createResolvedCatalogBindingV1(bindingInput(overrides));
  return createAdminSeatDistributionV1({
    binding,
    signatures: [{ keyid, sig: Buffer.from(keyid, "utf8").toString("base64") }],
    signerIdentity: identity,
  });
}

function distributionBytes(overrides: Record<string, unknown> = {}, keyid = "seat-key-1"): Buffer {
  return canonicalAdminSeatDistributionV1Bytes(distribution(overrides, keyid));
}

function consumptionInput(overrides: Record<string, unknown> = {}) {
  return {
    current: distributionBytes(),
    expectedAdminSignerIdentity: identity,
    expectedAdminSignerRootSha256: adminRoot,
    expectedEffectVersion: "1",
    expectedHeadSignerRootSha256: headRoot,
    expectedSchemaVersion: "1",
    lastGood: { kind: "unavailable" as const },
    maxAgeSeconds: 3600,
    now: "2026-08-17T12:00:00Z",
    verifyCanonicalPae: () => true,
    ...overrides,
  };
}

function signatureKeyid(request: unknown): string {
  const signatures = (request as { signatures: readonly { keyid: string }[] }).signatures;
  const first = signatures[0];
  if (first === undefined) throw new Error("expected at least one signature");
  return first.keyid;
}

/** Independently reproduces the DSSE PAE bytes the production `pae()` helper computes. */
function pae(payloadType: string, payload: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(
      `DSSEv1 ${String(Buffer.byteLength(payloadType))} ${payloadType} ${String(payload.length)} `,
      "utf8",
    ),
    payload,
  ]);
}

function fillerMember(index: number) {
  const tag = `filler-${String(index).padStart(4, "0")}`;
  return {
    candidateIdentitySha256: sha(`${tag} candidate identity`),
    candidateSha256: sha(`${tag} candidate`),
    componentId: `skill:${tag}`,
    evidenceSha256: sha(`${tag} evidence`),
    gitCommitSha256: sha(`${tag} commit`),
    pinSha256: sha(`${tag} pin`),
    policyRevisionSha256: sha(`${tag} policy`),
    profileSha256: sha(`${tag} profile`),
    promotionDecisionSha256: sha(`${tag} promotion`),
    qualificationBundleSha256: sha(`${tag} qualification`),
    recipeSha256: sha(`${tag} recipe`),
    repository: `github.com/example/${tag}`,
    sourceId: `catalog-${tag}`,
    sourceSha256: sha(`${tag} source`),
  };
}

function padSourceId(memberValue: Record<string, unknown>, extra: number): Record<string, unknown> {
  return { ...memberValue, sourceId: `${memberValue.sourceId as string}${"a".repeat(extra)}` };
}

/**
 * Grows a real, fully valid distribution's member list (plus targeted source-ID
 * padding) until its canonical byte length is exactly `targetLength`, so the
 * 96 KiB transport ceiling can be tested at its precise boundary rather than
 * only against synthetic oversize buffers.
 */
function sizedDistributionBytes(targetLength: number, keyid: string): Buffer {
  const members: Record<string, unknown>[] = [member()];
  let bytes = distributionBytes({ members }, keyid);
  if (bytes.length > targetLength) throw new Error("target length below base distribution size");
  const withOneFiller = distributionBytes({ members: [...members, fillerMember(0)] }, keyid);
  const unitCost = withOneFiller.length - bytes.length;
  let index = 0;
  while (bytes.length + unitCost <= targetLength) {
    members.push(fillerMember(index));
    index += 1;
    bytes = distributionBytes({ members }, keyid);
  }
  let remainder = targetLength - bytes.length;
  if (remainder > 0) {
    if (members.length <= 1) throw new Error("insufficient filler members to reach target length");
    for (let position = 1; position < members.length && remainder > 0; position += 1) {
      const current = members[position] as Record<string, unknown>;
      const room = 256 - (current.sourceId as string).length;
      const take = Math.min(room, remainder);
      if (take <= 0) continue;
      members[position] = padSourceId(current, take);
      remainder -= take;
    }
    bytes = distributionBytes({ members }, keyid);
  }
  if (bytes.length !== targetLength)
    throw new Error(`failed to size distribution to ${targetLength} bytes, got ${bytes.length}`);
  return bytes;
}

describe("developer-seat catalog consumption", () => {
  it("verifies a transported distribution and returns a minimal, deeply immutable resolved fact", () => {
    const verifyCanonicalPae = vi.fn(() => true);
    const result = resolveDeveloperSeatCatalogConsumptionV1(
      consumptionInput({ verifyCanonicalPae }),
    ) as unknown as Record<string, unknown>;

    expect(Object.keys(result).sort()).toEqual(
      [
        "ageSeconds",
        "binding",
        "distribution",
        "kind",
        "protocol",
        "resolvedAt",
        "sequence",
        "source",
      ].sort(),
    );
    expect(result.kind).toBe("resolved");
    expect(result.protocol).toBe("DeveloperSeatCatalogConsumptionV1");
    expect(result.source).toBe("current");
    expect(result.sequence).toBe(42);
    expect(result.resolvedAt).toBe("2026-08-17T12:00:00Z");
    expect(result.ageSeconds).toBe(0);
    expect(result.binding).toBe((result.distribution as { binding: unknown }).binding);
    expect((result.binding as { members: unknown[] }).members).toEqual([member()]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.binding)).toBe(true);
    expect(Object.isFrozen((result.binding as { members: unknown[] }).members)).toBe(true);
    expect(() => {
      (result as { sequence: number }).sequence = 1;
    }).toThrow();
    expect(verifyCanonicalPae).toHaveBeenCalledOnce();

    expect(() => resolveDeveloperSeatCatalogConsumptionV1(consumptionInput())).not.toThrow();
  });

  it("does not project a VerifiedCatalogMaterialV1-style shape or expose a caller-controlled projection", () => {
    const result = resolveDeveloperSeatCatalogConsumptionV1(
      consumptionInput(),
    ) as unknown as Record<string, unknown>;
    expect(result).not.toHaveProperty("members");
    expect(result).not.toHaveProperty("catalogSha256");
    expect(result).not.toHaveProperty("catalogHeadSha256");
    expect(result).not.toHaveProperty("tier");
    expect(() =>
      resolveDeveloperSeatCatalogConsumptionV1({
        ...consumptionInput(),
        projection: (value: unknown) => value,
      }),
    ).toThrow();
  });

  it("rejects BOM-prefixed transport bytes rather than treating them as canonical distributions", () => {
    const canonical = distributionBytes();
    const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), canonical]);
    expect(() =>
      resolveDeveloperSeatCatalogConsumptionV1(consumptionInput({ current: withBom })),
    ).toThrow();
  });

  it("advances on a higher sequence, accepts idempotent equal-sequence replay, and rejects rollback or digest conflict", () => {
    const advancing = resolveDeveloperSeatCatalogConsumptionV1(
      consumptionInput({
        current: distributionBytes({ sequence: 42 }, "current-key-1"),
        lastGood: distributionBytes(
          { resolvedAt: "2026-08-17T10:00:00Z", sequence: 41 },
          "prior-key-1",
        ),
      }),
    );
    expect(advancing).toMatchObject({ kind: "resolved", sequence: 42, source: "current" });

    const replayBytes = distributionBytes({ sequence: 42 }, "seat-key-1");
    const idempotent = resolveDeveloperSeatCatalogConsumptionV1(
      consumptionInput({ current: replayBytes, lastGood: replayBytes }),
    );
    expect(idempotent).toMatchObject({ kind: "resolved", sequence: 42, source: "current" });

    // Same sequence + identical canonical binding digest must be accepted as continuity
    // evidence even when the enclosing distribution envelopes differ entirely in key ID
    // and signature bytes: continuity is decided on the binding digest, never on
    // whole-distribution byte equality.
    const differentEnvelopeVerify = vi.fn(() => true);
    const differentEnvelopeResult = resolveDeveloperSeatCatalogConsumptionV1(
      consumptionInput({
        current: distributionBytes({ sequence: 42 }, "differing-envelope-current"),
        lastGood: distributionBytes({ sequence: 42 }, "differing-envelope-prior"),
        verifyCanonicalPae: differentEnvelopeVerify,
      }),
    );
    expect(differentEnvelopeResult).toMatchObject({
      kind: "resolved",
      sequence: 42,
      source: "current",
    });
    expect(differentEnvelopeVerify).toHaveBeenCalledTimes(2);
    expect(differentEnvelopeVerify.mock.results.map((call) => call.value)).toEqual([true, true]);

    expect(() =>
      resolveDeveloperSeatCatalogConsumptionV1(
        consumptionInput({
          current: distributionBytes({ sequence: 42 }, "current-key-2"),
          lastGood: distributionBytes(
            { resolvedAt: "2026-08-17T10:00:00Z", sequence: 43 },
            "prior-key-2",
          ),
        }),
      ),
    ).toThrow();

    expect(() =>
      resolveDeveloperSeatCatalogConsumptionV1(
        consumptionInput({
          current: distributionBytes(
            { catalogSha256: sha("catalog-a"), sequence: 42 },
            "current-key-3",
          ),
          lastGood: distributionBytes(
            { catalogSha256: sha("catalog-b"), sequence: 42 },
            "prior-key-3",
          ),
        }),
      ),
    ).toThrow();
  });

  it("falls back to a fully verified prior only when current is explicitly unavailable, and never when both are absent", () => {
    const priorBytes = distributionBytes({ sequence: 7 }, "prior-key-4");
    const verifyCanonicalPae = vi.fn(() => true);
    const result = resolveDeveloperSeatCatalogConsumptionV1(
      consumptionInput({
        current: { kind: "unavailable" },
        lastGood: priorBytes,
        verifyCanonicalPae,
      }),
    );
    expect(result).toMatchObject({ kind: "resolved", sequence: 7, source: "last-good" });
    expect(verifyCanonicalPae).toHaveBeenCalledOnce();

    expect(() =>
      resolveDeveloperSeatCatalogConsumptionV1(
        consumptionInput({ current: { kind: "unavailable" }, lastGood: { kind: "unavailable" } }),
      ),
    ).toThrow();
  });

  it("never accepts unsigned binding bytes or a forged prior as continuity evidence, even when current verifies", () => {
    const unsignedBindingBytes = canonicalResolvedCatalogBindingV1Bytes(
      createResolvedCatalogBindingV1(bindingInput()),
    );
    expect(() =>
      resolveDeveloperSeatCatalogConsumptionV1(
        consumptionInput({ lastGood: unsignedBindingBytes }),
      ),
    ).toThrow();

    const currentBytes = distributionBytes({ sequence: 42 }, "current-key-4");
    const forgedPriorBytes = distributionBytes(
      { resolvedAt: "2026-08-17T10:00:00Z", sequence: 41 },
      "forged-prior-key",
    );
    const verifyCanonicalPae = (request: unknown) => signatureKeyid(request) !== "forged-prior-key";
    expect(
      resolveDeveloperSeatCatalogConsumptionV1(
        consumptionInput({ current: currentBytes, verifyCanonicalPae }),
      ),
    ).toMatchObject({ kind: "resolved" });
    expect(() =>
      resolveDeveloperSeatCatalogConsumptionV1(
        consumptionInput({
          current: currentBytes,
          lastGood: forgedPriorBytes,
          verifyCanonicalPae,
        }),
      ),
    ).toThrow();
  });

  it("returns closed compatibility-required for unknown schema/effect versions without exposing binding or member material, taking precedence over a compatible prior", () => {
    const incompatibleBinding = createResolvedCatalogBindingV1(
      bindingInput({ compatibleSchemaVersion: "2" }),
    );
    const current = canonicalAdminSeatDistributionV1Bytes(
      createAdminSeatDistributionV1({
        binding: incompatibleBinding,
        signatures: [
          { keyid: "current-key-5", sig: Buffer.from("current-key-5").toString("base64") },
        ],
        signerIdentity: identity,
      }),
    );
    const compatiblePrior = distributionBytes(
      { resolvedAt: "2026-08-17T10:00:00Z", sequence: 41 },
      "prior-key-5",
    );
    const result = resolveDeveloperSeatCatalogConsumptionV1(
      consumptionInput({ current, lastGood: compatiblePrior }),
    ) as unknown as Record<string, unknown>;
    expect(Object.keys(result).sort()).toEqual(
      ["kind", "materializable", "protocol", "resolvedCatalogBindingSha256"].sort(),
    );
    expect(result).toMatchObject({
      kind: "compatibility-required",
      materializable: false,
      protocol: "DeveloperSeatCatalogConsumptionV1",
      resolvedCatalogBindingSha256: incompatibleBinding.resolvedCatalogBindingSha256,
    });
    expect(result).not.toHaveProperty("binding");
    expect(result).not.toHaveProperty("distribution");
    expect(result).not.toHaveProperty("members");

    const effectMismatch = resolveDeveloperSeatCatalogConsumptionV1(
      consumptionInput({
        current: { kind: "unavailable" },
        lastGood: distributionBytes({ compatibleEffectVersion: "2" }, "prior-key-6"),
      }),
    ) as unknown as Record<string, unknown>;
    expect(effectMismatch.kind).toBe("compatibility-required");
  });

  it("enforces strict UTC-second time bounds: rejects a future resolvedAt and expiry beyond the bounded max age, accepting the exact boundary", () => {
    const bound = resolveDeveloperSeatCatalogConsumptionV1(
      consumptionInput({ maxAgeSeconds: 3600, now: "2026-08-17T13:00:00Z" }),
    );
    expect(bound).toMatchObject({ ageSeconds: 3600, kind: "resolved" });

    expect(() =>
      resolveDeveloperSeatCatalogConsumptionV1(
        consumptionInput({ maxAgeSeconds: 3600, now: "2026-08-17T13:00:01Z" }),
      ),
    ).toThrow();

    expect(() =>
      resolveDeveloperSeatCatalogConsumptionV1(consumptionInput({ now: "2026-08-17T11:59:59Z" })),
    ).toThrow();

    for (const now of [
      "2026-02-30T00:00:00Z",
      "2026-08-17T12:00:00",
      "2026-08-17T12:00:00.000Z",
      "not-a-timestamp",
    ])
      expect(() => resolveDeveloperSeatCatalogConsumptionV1(consumptionInput({ now }))).toThrow();

    for (const maxAgeSeconds of [0, -1, 3600.5, Number.MAX_SAFE_INTEGER, 59, 31536001])
      expect(() =>
        resolveDeveloperSeatCatalogConsumptionV1(consumptionInput({ maxAgeSeconds })),
      ).toThrow();
  });

  it("accepts maxAgeSeconds only as an integer within [60, 31536000], with both exact age boundaries resolving", () => {
    const minBound = resolveDeveloperSeatCatalogConsumptionV1(
      consumptionInput({ maxAgeSeconds: 60, now: "2026-08-17T12:01:00Z" }),
    );
    expect(minBound).toMatchObject({ ageSeconds: 60, kind: "resolved" });

    const maxBound = resolveDeveloperSeatCatalogConsumptionV1(
      consumptionInput({ maxAgeSeconds: 31536000, now: "2027-08-17T12:00:00Z" }),
    );
    expect(maxBound).toMatchObject({ ageSeconds: 31536000, kind: "resolved" });
  });

  it("passes fixed trusted roots and identity through to independent verification in a deterministic current-then-prior order", () => {
    const currentBytes = distributionBytes({ sequence: 42 }, "current-key-7");
    const priorBytes = distributionBytes(
      { resolvedAt: "2026-08-17T10:00:00Z", sequence: 41 },
      "prior-key-7",
    );
    const verifyCanonicalPae = vi.fn((request: unknown) => {
      expect(
        (request as { expectedAdminSignerRootSha256: string }).expectedAdminSignerRootSha256,
      ).toBe(adminRoot);
      expect((request as { expectedAdminSignerIdentity: string }).expectedAdminSignerIdentity).toBe(
        identity,
      );
      return true;
    });
    resolveDeveloperSeatCatalogConsumptionV1(
      consumptionInput({ current: currentBytes, lastGood: priorBytes, verifyCanonicalPae }),
    );
    expect(verifyCanonicalPae).toHaveBeenCalledTimes(2);
    expect(signatureKeyid(verifyCanonicalPae.mock.calls[0]?.[0])).toBe("current-key-7");
    expect(signatureKeyid(verifyCanonicalPae.mock.calls[1]?.[0])).toBe("prior-key-7");

    expect(() =>
      resolveDeveloperSeatCatalogConsumptionV1(
        consumptionInput({
          expectedAdminSignerRootSha256: headRoot,
          expectedHeadSignerRootSha256: headRoot,
        }),
      ),
    ).toThrow();
  });

  it("fails closed on hostile envelope input and malformed transport without silently downgrading to unavailable", () => {
    let getterCalls = 0;
    const accessor = Object.defineProperty({}, "kind", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "unavailable";
      },
    });
    const throwingProxy = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error("hostile prototype trap");
        },
      },
    );
    const cyclic: Record<string, unknown> = { ...consumptionInput() };
    cyclic.self = cyclic;

    for (const current of [
      null,
      undefined,
      42,
      "not canonical json at all",
      [],
      { kind: "unavailable", extra: true },
      { kind: "available" },
      Object.create({ kind: "unavailable" }),
      accessor,
      throwingProxy,
      new Uint8Array([0xc3, 0x28]),
    ])
      expect(() =>
        resolveDeveloperSeatCatalogConsumptionV1(consumptionInput({ current })),
      ).toThrow();
    expect(getterCalls).toBe(0);

    expect(() => resolveDeveloperSeatCatalogConsumptionV1(cyclic)).toThrow();
    expect(() =>
      resolveDeveloperSeatCatalogConsumptionV1({ ...consumptionInput(), unexpectedField: true }),
    ).toThrow();
    const missingNow: Record<string, unknown> = { ...consumptionInput() };
    delete missingNow.now;
    expect(() => resolveDeveloperSeatCatalogConsumptionV1(missingNow)).toThrow();
    expect(() => resolveDeveloperSeatCatalogConsumptionV1(null)).toThrow();
    expect(() => resolveDeveloperSeatCatalogConsumptionV1([])).toThrow();
  });

  it("copies transported bytes defensively rather than aliasing caller-owned buffers", () => {
    const source = Buffer.from(distributionBytes({ sequence: 42 }));
    const untouched = Buffer.from(source);
    const result = resolveDeveloperSeatCatalogConsumptionV1(
      consumptionInput({ current: source }),
    ) as { distribution: unknown };
    source.fill(0);
    expect(canonicalAdminSeatDistributionV1Bytes(result.distribution as never)).toEqual(untouched);
  });

  it("enforces an exact 96*1024-byte transport ceiling for both current and lastGood, rejecting one byte over before the verifier ever runs", () => {
    const MAX_TRANSPORT_BYTES = 96 * 1024;

    const atMaxCurrent = sizedDistributionBytes(MAX_TRANSPORT_BYTES, "at-max-current");
    const verifyCurrent = vi.fn(() => true);
    expect(
      resolveDeveloperSeatCatalogConsumptionV1(
        consumptionInput({ current: atMaxCurrent, verifyCanonicalPae: verifyCurrent }),
      ),
    ).toMatchObject({ kind: "resolved" });
    expect(verifyCurrent).toHaveBeenCalledOnce();

    const overMaxCurrent = Buffer.concat([atMaxCurrent, Buffer.from("a")]);
    expect(overMaxCurrent.length).toBe(MAX_TRANSPORT_BYTES + 1);
    const verifyOverCurrent = vi.fn(() => true);
    expect(() =>
      resolveDeveloperSeatCatalogConsumptionV1(
        consumptionInput({ current: overMaxCurrent, verifyCanonicalPae: verifyOverCurrent }),
      ),
    ).toThrow();
    expect(verifyOverCurrent).not.toHaveBeenCalled();

    const atMaxPrior = sizedDistributionBytes(MAX_TRANSPORT_BYTES, "at-max-prior");
    const verifyPrior = vi.fn(() => true);
    expect(
      resolveDeveloperSeatCatalogConsumptionV1(
        consumptionInput({
          current: { kind: "unavailable" },
          lastGood: atMaxPrior,
          verifyCanonicalPae: verifyPrior,
        }),
      ),
    ).toMatchObject({ kind: "resolved", source: "last-good" });
    expect(verifyPrior).toHaveBeenCalledOnce();

    const overMaxPrior = Buffer.concat([atMaxPrior, Buffer.from("a")]);
    expect(overMaxPrior.length).toBe(MAX_TRANSPORT_BYTES + 1);
    const verifyOverPrior = vi.fn(() => true);
    expect(() =>
      resolveDeveloperSeatCatalogConsumptionV1(
        consumptionInput({
          current: { kind: "unavailable" },
          lastGood: overMaxPrior,
          verifyCanonicalPae: verifyOverPrior,
        }),
      ),
    ).toThrow();
    expect(verifyOverPrior).not.toHaveBeenCalled();
  });

  it("treats an incompatible current as fatal — never compatibility-required — when its signature fails, it rolls back against a compatible prior, it is expired, or it is future dated", () => {
    const incompatibleCurrentBytes = (
      overrides: Record<string, unknown> = {},
      keyid = "incompatible-current",
    ): Buffer =>
      canonicalAdminSeatDistributionV1Bytes(
        createAdminSeatDistributionV1({
          binding: createResolvedCatalogBindingV1(
            bindingInput({ compatibleSchemaVersion: "2", ...overrides }),
          ),
          signatures: [{ keyid, sig: Buffer.from(keyid, "utf8").toString("base64") }],
          signerIdentity: identity,
        }),
      );

    // verifier=false on an otherwise-incompatible current must be fatal.
    expect(() =>
      resolveDeveloperSeatCatalogConsumptionV1(
        consumptionInput({
          current: incompatibleCurrentBytes({}, "incompatible-unsigned"),
          verifyCanonicalPae: () => false,
        }),
      ),
    ).toThrow();

    // Rollback against a higher-sequence, fully compatible prior must be fatal,
    // not a compatibility-required response for the (lower) incompatible current.
    expect(() =>
      resolveDeveloperSeatCatalogConsumptionV1(
        consumptionInput({
          current: incompatibleCurrentBytes({ sequence: 42 }, "incompatible-rollback-current"),
          lastGood: distributionBytes(
            { resolvedAt: "2026-08-17T11:00:00Z", sequence: 43 },
            "rollback-compatible-prior",
          ),
        }),
      ),
    ).toThrow();

    // Expired (age beyond maxAgeSeconds) incompatible current must be fatal.
    expect(() =>
      resolveDeveloperSeatCatalogConsumptionV1(
        consumptionInput({
          current: incompatibleCurrentBytes({}, "incompatible-expired-current"),
          maxAgeSeconds: 60,
          now: "2026-08-17T12:05:00Z",
        }),
      ),
    ).toThrow();

    // Future-dated incompatible current must be fatal.
    expect(() =>
      resolveDeveloperSeatCatalogConsumptionV1(
        consumptionInput({
          current: incompatibleCurrentBytes(
            { resolvedAt: "2026-08-17T12:00:01Z" },
            "incompatible-future-current",
          ),
        }),
      ),
    ).toThrow();
  });

  it("verifies signature and trust before granting compatibility-required to a lastGood consulted after current is unavailable, and treats a failing signature there as fatal", () => {
    const verifyCanonicalPae = vi.fn(() => true);
    const incompatiblePriorBytes = distributionBytes(
      { compatibleEffectVersion: "2" },
      "incompatible-prior-verified",
    );
    const result = resolveDeveloperSeatCatalogConsumptionV1(
      consumptionInput({
        current: { kind: "unavailable" },
        lastGood: incompatiblePriorBytes,
        verifyCanonicalPae,
      }),
    ) as unknown as Record<string, unknown>;
    expect(result.kind).toBe("compatibility-required");
    expect(verifyCanonicalPae).toHaveBeenCalledOnce();

    expect(() =>
      resolveDeveloperSeatCatalogConsumptionV1(
        consumptionInput({
          current: { kind: "unavailable" },
          lastGood: distributionBytes(
            { compatibleEffectVersion: "2" },
            "incompatible-prior-unverified",
          ),
          verifyCanonicalPae: () => false,
        }),
      ),
    ).toThrow();
  });

  it("treats a present-but-broken current as terminal — malformed bytes or a failing signature — even with a fully valid prior available, and never silently falls back to it", () => {
    const validPrior = distributionBytes(
      { resolvedAt: "2026-08-17T10:00:00Z", sequence: 41 },
      "valid-prior-terminal",
    );

    expect(() =>
      resolveDeveloperSeatCatalogConsumptionV1(
        consumptionInput({
          current: Buffer.from("not canonical json at all", "utf8"),
          lastGood: validPrior,
        }),
      ),
    ).toThrow();

    const brokenSignatureKeyid = "broken-signature-current";
    const brokenSignatureCurrent = distributionBytes({ sequence: 42 }, brokenSignatureKeyid);
    const verifyCanonicalPae = (request: unknown) =>
      signatureKeyid(request) !== brokenSignatureKeyid;
    expect(() =>
      resolveDeveloperSeatCatalogConsumptionV1(
        consumptionInput({
          current: brokenSignatureCurrent,
          lastGood: validPrior,
          verifyCanonicalPae,
        }),
      ),
    ).toThrow();
  });

  it("rejects transparent proxies at every hostile-input boundary before their observable traps can run", () => {
    const transparentInput = new Proxy(consumptionInput(), {});
    const transparentCurrent = new Proxy(new Uint8Array(distributionBytes()), {});
    const transparentLastGood = new Proxy({ kind: "unavailable" as const }, {});
    const transparentVerifier = new Proxy(() => true, {});

    for (const value of [
      transparentInput,
      consumptionInput({ current: transparentCurrent }),
      consumptionInput({ lastGood: transparentLastGood }),
      consumptionInput({ verifyCanonicalPae: transparentVerifier }),
    ])
      expect(() => resolveDeveloperSeatCatalogConsumptionV1(value)).toThrow(
        "DEVELOPER_SEAT_CATALOG_CONSUMPTION_V1",
      );

    const hostileProxy = <T extends object>(
      target: T,
    ): { readonly proxy: T; traps: () => number } => {
      let trapCalls = 0;
      const proxy = new Proxy(target, {
        apply() {
          trapCalls += 1;
          throw new Error("unexpected apply trap");
        },
        get() {
          trapCalls += 1;
          throw new Error("unexpected get trap");
        },
        getPrototypeOf() {
          trapCalls += 1;
          throw new Error("unexpected prototype trap");
        },
        ownKeys() {
          trapCalls += 1;
          throw new Error("unexpected ownKeys trap");
        },
      });
      return { proxy, traps: () => trapCalls };
    };

    const hostileInput = hostileProxy(consumptionInput());
    expect(() => resolveDeveloperSeatCatalogConsumptionV1(hostileInput.proxy)).toThrow(
      "DEVELOPER_SEAT_CATALOG_CONSUMPTION_V1",
    );
    expect(hostileInput.traps()).toBe(0);

    const hostileCurrent = hostileProxy(new Uint8Array(distributionBytes()));
    expect(() =>
      resolveDeveloperSeatCatalogConsumptionV1(consumptionInput({ current: hostileCurrent.proxy })),
    ).toThrow("DEVELOPER_SEAT_CATALOG_CONSUMPTION_V1");
    expect(hostileCurrent.traps()).toBe(0);

    const hostileLastGood = hostileProxy({ kind: "unavailable" as const });
    expect(() =>
      resolveDeveloperSeatCatalogConsumptionV1(
        consumptionInput({ lastGood: hostileLastGood.proxy }),
      ),
    ).toThrow("DEVELOPER_SEAT_CATALOG_CONSUMPTION_V1");
    expect(hostileLastGood.traps()).toBe(0);

    const hostileVerifier = hostileProxy(() => true);
    expect(() =>
      resolveDeveloperSeatCatalogConsumptionV1(
        consumptionInput({ verifyCanonicalPae: hostileVerifier.proxy }),
      ),
    ).toThrow("DEVELOPER_SEAT_CATALOG_CONSUMPTION_V1");
    expect(hostileVerifier.traps()).toBe(0);
  });

  it("rejects a broad negative matrix of malformed trust roots, signer identity, and schema/effect version IDs, plus a nonfunction verifier, and a top-level hostile input calls no getter", () => {
    const malformedDigest = "not-a-digest";
    for (const expectedAdminSignerRootSha256 of [
      malformedDigest,
      adminRoot.toUpperCase(),
      "",
      "a".repeat(63),
      "a".repeat(65),
    ])
      expect(() =>
        resolveDeveloperSeatCatalogConsumptionV1(
          consumptionInput({ expectedAdminSignerRootSha256 }),
        ),
      ).toThrow();

    for (const expectedHeadSignerRootSha256 of [
      malformedDigest,
      headRoot.toUpperCase(),
      "",
      "a".repeat(63),
      "a".repeat(65),
    ])
      expect(() =>
        resolveDeveloperSeatCatalogConsumptionV1(
          consumptionInput({ expectedHeadSignerRootSha256 }),
        ),
      ).toThrow();

    const nonNfc = "é";
    const loneSurrogate = "\uD800";
    for (const expectedAdminSignerIdentity of [
      "",
      "   ",
      "a".repeat(257),
      nonNfc,
      loneSurrogate,
      "signer\u0000identity",
      "signer\nidentity",
      "signer\u007fidentity",
      42,
      null,
      undefined,
      [],
      {},
    ])
      expect(() =>
        resolveDeveloperSeatCatalogConsumptionV1(consumptionInput({ expectedAdminSignerIdentity })),
      ).toThrow();

    for (const field of ["expectedSchemaVersion", "expectedEffectVersion"] as const)
      for (const value of [
        "",
        "   ",
        "a".repeat(65),
        nonNfc,
        loneSurrogate,
        "v\u0000one",
        "v\none",
        "v\u007fone",
        1,
        null,
        undefined,
        [],
        {},
      ])
        expect(() =>
          resolveDeveloperSeatCatalogConsumptionV1(consumptionInput({ [field]: value })),
        ).toThrow();

    for (const verifyCanonicalPae of [undefined, null, "not-a-function", 42, {}, []])
      expect(() =>
        resolveDeveloperSeatCatalogConsumptionV1(consumptionInput({ verifyCanonicalPae })),
      ).toThrow();

    let getterCalls = 0;
    const proto: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(consumptionInput()))
      Object.defineProperty(proto, key, {
        enumerable: true,
        get() {
          getterCalls += 1;
          return value;
        },
      });
    const inheritedInput = Object.create(proto);
    expect(() => resolveDeveloperSeatCatalogConsumptionV1(inheritedInput)).toThrow();

    const proxyInput = new Proxy(consumptionInput(), {
      getPrototypeOf() {
        throw new Error("hostile prototype trap");
      },
    });
    expect(() => resolveDeveloperSeatCatalogConsumptionV1(proxyInput)).toThrow();

    expect(getterCalls).toBe(0);
  });

  it("converts a verifier exception into one fixed safe error message regardless of what the exception says, never leaking its content", () => {
    const secretA = "sk-alpha-distinctive-secret-4f8c9d21";
    const secretB = "sk-beta-distinctive-secret-7a1e3b06";
    const messageFor = (secret: string): string => {
      try {
        resolveDeveloperSeatCatalogConsumptionV1(
          consumptionInput({
            verifyCanonicalPae: () => {
              throw new Error(`verification backend failed: ${secret}`);
            },
          }),
        );
      } catch (error) {
        return (error as Error).message;
      }
      throw new Error("expected the verifier exception to become fatal");
    };
    const messageA = messageFor(secretA);
    const messageB = messageFor(secretB);
    expect(messageA).not.toContain(secretA);
    expect(messageB).not.toContain(secretB);
    expect(messageA).toBe(messageB);
  });

  it("asserts exact, independently constructed DSSE PAE bytes and signatures are passed for the current call, then the prior call", () => {
    const currentDistribution = distribution({ sequence: 42 }, "pae-current-key");
    const priorDistribution = distribution(
      { resolvedAt: "2026-08-17T10:00:00Z", sequence: 41 },
      "pae-prior-key",
    );
    const currentBytes = canonicalAdminSeatDistributionV1Bytes(currentDistribution);
    const priorBytes = canonicalAdminSeatDistributionV1Bytes(priorDistribution);

    const currentEnvelope = currentDistribution.envelope as {
      payload: string;
      payloadType: string;
      signatures: readonly unknown[];
    };
    const priorEnvelope = priorDistribution.envelope as {
      payload: string;
      payloadType: string;
      signatures: readonly unknown[];
    };
    const expectedCurrentPae = pae(
      currentEnvelope.payloadType,
      Buffer.from(currentEnvelope.payload, "base64"),
    );
    const expectedPriorPae = pae(
      priorEnvelope.payloadType,
      Buffer.from(priorEnvelope.payload, "base64"),
    );

    const verifyCanonicalPae = vi.fn((_request: unknown) => true);
    resolveDeveloperSeatCatalogConsumptionV1(
      consumptionInput({ current: currentBytes, lastGood: priorBytes, verifyCanonicalPae }),
    );

    expect(verifyCanonicalPae).toHaveBeenCalledTimes(2);
    const firstRequest = verifyCanonicalPae.mock.calls[0]?.[0] as {
      paeBytes: Buffer;
      signatures: unknown;
    };
    const secondRequest = verifyCanonicalPae.mock.calls[1]?.[0] as {
      paeBytes: Buffer;
      signatures: unknown;
    };
    expect(Buffer.from(firstRequest.paeBytes).equals(expectedCurrentPae)).toBe(true);
    expect(firstRequest.signatures).toEqual(currentEnvelope.signatures);
    expect(Buffer.from(secondRequest.paeBytes).equals(expectedPriorPae)).toBe(true);
    expect(secondRequest.signatures).toEqual(priorEnvelope.signatures);
  });

  it("keeps the compatibility-required output closed and non-materializing: frozen, no method surface, and immune to post-hoc mutation", () => {
    const incompatibleBinding = createResolvedCatalogBindingV1(
      bindingInput({ compatibleEffectVersion: "2" }),
    );
    const current = canonicalAdminSeatDistributionV1Bytes(
      createAdminSeatDistributionV1({
        binding: incompatibleBinding,
        signatures: [{ keyid: "closed-key", sig: Buffer.from("closed-key").toString("base64") }],
        signerIdentity: identity,
      }),
    );
    const result = resolveDeveloperSeatCatalogConsumptionV1(
      consumptionInput({ current }),
    ) as unknown as Record<string, unknown>;
    expect(result.kind).toBe("compatibility-required");
    expect(Object.isFrozen(result)).toBe(true);
    expect(
      Object.getOwnPropertyNames(result).every((key) => typeof result[key] !== "function"),
    ).toBe(true);
    expect(() => {
      (result as { binding?: unknown }).binding = incompatibleBinding;
    }).toThrow();
    expect(() => {
      (result as { materializable: boolean }).materializable = true;
    }).toThrow();
    expect(() => {
      delete (result as { kind?: unknown }).kind;
    }).toThrow();
  });

  it("remains an internal pure consumer with no filesystem, network, provider, process, signer, CLI, Workbench, or runtime route, and introduces no cutover", () => {
    const source = resolve("src/org-policy/developer-seat-catalog-consumption-v1.ts");
    expect(existsSync(source)).toBe(true);
    const text = readFileSync(source, "utf8");
    expect(text).not.toMatch(
      /node:(child_process|fs|https|http|net|tls|dgram)|\b(fetch|spawn|exec|fork|writeFile|readFile|executePlan|writeText|plan)\s*\(|policyGenerate|Workbench|docker|scanner|provider\.(request|poll)|runtime-policy|signCanonicalPae/i,
    );
    expect(readFileSync(resolve("src/index.ts"), "utf8")).not.toContain(
      "developer-seat-catalog-consumption-v1",
    );
    expect(readFileSync(resolve("src/commands/index.ts"), "utf8")).not.toContain(
      "developer-seat-catalog-consumption-v1",
    );
  });
});
