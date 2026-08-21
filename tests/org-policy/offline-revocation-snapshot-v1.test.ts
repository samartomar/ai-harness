import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  canonicalOfflineRevocationSnapshotV1Bytes,
  claimOfflineRevocationStateV1,
  createOfflineRevocationSnapshotV1,
  parseOfflineRevocationSnapshotV1Json,
  resolveOfflineRevocationAuthorityV1,
  transitionOfflineRevocationStateV1,
} from "../../src/org-policy/offline-revocation-snapshot-v1.js";

const DIGEST = "a".repeat(64);

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    issuer: "platform-security",
    issuedAt: "2026-08-10T12:00:00Z",
    protocol: "OfflineRevocationSnapshotV1",
    revokedDecisionIds: ["decision-revoked"],
    sequence: 7,
    validUntil: "2026-08-11T12:00:00Z",
    ...overrides,
  };
}

function signed(overrides: Record<string, unknown> = {}) {
  return createOfflineRevocationSnapshotV1({
    signerIdentity: "signer:org-admin",
    signatures: [{ keyid: "admin-key", sig: Buffer.from("admin-key").toString("base64") }],
    snapshot: snapshot(),
    ...overrides,
  });
}

function stateFor(value: ReturnType<typeof signed>) {
  return {
    digestSha256: createHash("sha256")
      .update(canonicalOfflineRevocationSnapshotV1Bytes(value))
      .digest("hex"),
    issuer: value.snapshot.issuer,
    sequence: value.snapshot.sequence,
  };
}

function trust(overrides: Record<string, unknown> = {}) {
  return {
    expectedAdminSignerIdentity: "signer:org-admin",
    expectedAdminSignerRootSha256: DIGEST,
    expectedIssuer: "platform-security",
    verifyCanonicalPae: vi.fn(() => true),
    ...overrides,
  };
}

function resolve(overrides: Record<string, unknown> = {}) {
  const signedSnapshot =
    (overrides.signedSnapshot as ReturnType<typeof signed> | undefined) ?? signed();
  return resolveOfflineRevocationAuthorityV1({
    decision: {
      expiresAt: "2026-08-12T12:00:00Z",
      id: "decision-live",
      issuedAt: "2026-08-10T11:59:59Z",
      notBefore: "2026-08-10T11:59:59Z",
      reviewBy: "2026-08-12T12:00:00Z",
    },
    durableState: stateFor(signedSnapshot),
    now: "2026-08-10T12:00:01Z",
    receiptExpiresAt: "2026-08-12T12:00:00Z",
    signedSnapshot,
    ...trust(),
    ...overrides,
  });
}

describe("OfflineRevocationSnapshotV1", () => {
  it("canonicalizes a separately signed, complete exact revocation set deterministically", () => {
    const first = signed();
    const bytes = canonicalOfflineRevocationSnapshotV1Bytes(first);
    expect(parseOfflineRevocationSnapshotV1Json(bytes)).toEqual(first);
    expect(bytes).toEqual(canonicalOfflineRevocationSnapshotV1Bytes(signed()));
    expect(() =>
      signed({ snapshot: snapshot({ revokedDecisionIds: ["decision-z", "decision-a"] }) }),
    ).toThrow();
  });

  it("reverifies caller-supplied administrator trust on every resolution and binds DSSE context", () => {
    const verify = vi.fn((request: unknown) => {
      const item = request as { expectedAdminSignerIdentity: string; paeBytes: Buffer };
      return item.expectedAdminSignerIdentity === "signer:org-admin" && item.paeBytes.length > 0;
    });
    expect(resolve({ verifyCanonicalPae: verify })).toMatchObject({
      kind: "current",
      revoked: false,
    });
    expect(resolve({ verifyCanonicalPae: verify })).toMatchObject({
      kind: "current",
      revoked: false,
    });
    expect(verify).toHaveBeenCalledTimes(2);
    expect(
      resolve({ expectedAdminSignerIdentity: "signer:other", verifyCanonicalPae: () => true }),
    ).toMatchObject({
      kind: "invalid-authority",
    });
  });

  it("returns a distinct frozen stale-authority no-effect result when coverage is absent or expired", () => {
    const missing = resolve({
      signedSnapshot: signed({ snapshot: snapshot({ issuedAt: "2026-08-10T11:00:00Z" }) }),
    });
    const expired = resolve({ now: "2026-08-11T12:00:00Z" });
    for (const result of [missing, expired]) {
      expect(result).toEqual({
        effective: false,
        kind: "stale-authority",
        materializable: false,
        revoked: false,
      });
      expect(Object.isFrozen(result)).toBe(true);
    }
  });

  it("honors exact revocation only after all decision and receipt coverage bounds hold", () => {
    expect(
      resolve({
        decision: {
          expiresAt: "2026-08-12T12:00:00Z",
          id: "decision-revoked",
          issuedAt: "2026-08-10T11:59:59Z",
          notBefore: "2026-08-10T11:59:59Z",
          reviewBy: "2026-08-12T12:00:00Z",
        },
      }),
    ).toEqual({
      effective: true,
      kind: "current",
      materializable: false,
      revoked: true,
    });
    expect(
      resolve({
        signedSnapshot: signed({ snapshot: snapshot({ issuedAt: "2026-08-10T11:59:58Z" }) }),
      }),
    ).toMatchObject({ kind: "stale-authority" });
    for (const snapshotOverride of [{ validUntil: "2026-08-12T12:00:01Z" }])
      expect(
        resolve({ signedSnapshot: signed({ snapshot: snapshot(snapshotOverride) }) }),
      ).toMatchObject({
        kind: "invalid-authority",
      });
  });

  it("fails closed on malformed, future, unknown-version, and out-of-range signed material", () => {
    for (const value of [
      Buffer.from("{}"),
      canonicalOfflineRevocationSnapshotV1Bytes(signed()).subarray(0, 32),
    ])
      expect(() => parseOfflineRevocationSnapshotV1Json(value)).toThrow();
    for (const override of [
      { protocol: "OfflineRevocationSnapshotV2" },
      { validUntil: "2026-08-10T12:00:59Z" },
      { validUntil: "2026-11-08T12:00:02Z" },
    ])
      expect(() => signed({ snapshot: snapshot(override) })).toThrow();
    for (const signerIdentity of ["e\u0301", "signer\u0000admin"])
      expect(() => signed({ signerIdentity })).toThrow();
    expect(
      resolve({
        signedSnapshot: signed({ snapshot: snapshot({ issuedAt: "2026-08-10T12:00:02Z" }) }),
      }),
    ).toMatchObject({ kind: "invalid-authority" });
    expect(resolve({ now: "2026-08-10T11:59:59Z" })).toMatchObject({ kind: "invalid-authority" });
  });

  it("rejects rollback and equal-sequence substitution while producing a deterministic next durable state", () => {
    const current = { digestSha256: "b".repeat(64), issuer: "platform-security", sequence: 7 };
    expect(transitionOfflineRevocationStateV1({ current, next: signed(), ...trust() })).toEqual({
      kind: "conflict",
      state: current,
    });
    expect(
      transitionOfflineRevocationStateV1({
        current: { ...current, sequence: 8 },
        next: signed(),
        ...trust(),
      }),
    ).toEqual({
      kind: "rollback",
      state: { ...current, sequence: 8 },
    });
    expect(
      transitionOfflineRevocationStateV1({
        current,
        next: signed({ snapshot: snapshot({ sequence: 8 }) }),
        ...trust(),
      }),
    ).toMatchObject({
      kind: "advance",
      state: { issuer: "platform-security", sequence: 8 },
    });
  });

  it("claims before writing and then live-reobserves durable issuer state, refusing a race", () => {
    let durable: unknown;
    const next = signed({ snapshot: snapshot({ sequence: 8 }) });
    const claim = vi.fn((expected: unknown, replacement: unknown) => {
      if (JSON.stringify(expected) !== JSON.stringify(durable)) return false;
      durable = replacement;
      return true;
    });
    expect(
      claimOfflineRevocationStateV1({
        claim: (_issuer: string, expected: unknown, replacement: unknown) =>
          claim(expected, replacement),
        next,
        observe: (_issuer: string) => durable,
        ...trust(),
      }),
    ).toMatchObject({
      kind: "advanced",
      state: { sequence: 8 },
    });
    expect(claim).toHaveBeenCalledOnce();

    durable = undefined;
    expect(
      claimOfflineRevocationStateV1({
        claim: (_expected: unknown, _replacement: unknown) => {
          durable = { digestSha256: "c".repeat(64), issuer: "platform-security", sequence: 9 };
          return false;
        },
        next,
        observe: (_issuer: string) => durable,
        ...trust(),
      }),
    ).toEqual({ kind: "contended" });

    expect(() =>
      claimOfflineRevocationStateV1({
        claim: (_issuer: string, _expected: unknown, _replacement: unknown) => true,
        next,
        observe: (_issuer: string) => {
          throw new Error("hostile storage error");
        },
        ...trust(),
      }),
    ).toThrow("offline revocation state custody");

    let asyncObservations = 0;
    expect(
      claimOfflineRevocationStateV1({
        claim: (_issuer: string, _expected: unknown, _replacement: unknown) => true,
        next,
        observe: (_issuer: string) => {
          asyncObservations += 1;
          return asyncObservations === 1 ? undefined : Promise.resolve(undefined);
        },
        ...trust(),
      }),
    ).toEqual({ kind: "contended" });

    expect(
      claimOfflineRevocationStateV1({
        claim: (_issuer: string, _expected: unknown, _replacement: unknown) => {
          throw new Error("hostile claim error");
        },
        next,
        observe: (_issuer: string) => undefined,
        ...trust(),
      }),
    ).toEqual({ kind: "contended" });

    let observations = 0;
    durable = undefined;
    expect(
      claimOfflineRevocationStateV1({
        claim: (_issuer: string, _expected: unknown, replacement: unknown) => {
          durable = replacement;
          return true;
        },
        next,
        observe: (_issuer: string) => {
          observations += 1;
          return observations === 1
            ? undefined
            : { digestSha256: "d".repeat(64), issuer: "platform-security", sequence: 9 };
        },
        ...trust(),
      }),
    ).toEqual({ kind: "contended" });
  });

  it("cannot poison high-water state with a structurally valid parsed forged signature", () => {
    const forged = parseOfflineRevocationSnapshotV1Json(
      canonicalOfflineRevocationSnapshotV1Bytes(
        signed({ snapshot: snapshot({ sequence: 9_999_999 }) }),
      ),
    );
    const current = stateFor(signed());
    for (const verifyCanonicalPae of [
      vi.fn(() => false),
      vi.fn(() => {
        throw new Error("hostile verifier message");
      }),
    ]) {
      expect(
        transitionOfflineRevocationStateV1({
          current,
          next: forged,
          ...trust({ verifyCanonicalPae }),
        }),
      ).toEqual({ kind: "invalid-authority" });
      const claim = vi.fn(() => true);
      expect(
        claimOfflineRevocationStateV1({
          claim,
          next: forged,
          observe: (_issuer: string) => current,
          ...trust({ verifyCanonicalPae }),
        }),
      ).toEqual({ kind: "invalid-authority" });
      expect(claim).not.toHaveBeenCalled();
    }
  });

  it("binds current authority to exact durable state and rejects verifier, issuer, noncanonical, and async substitutions", () => {
    const next = signed();
    expect(resolve({ durableState: undefined, signedSnapshot: next })).toMatchObject({
      kind: "stale-authority",
    });
    expect(
      resolve({ durableState: { ...stateFor(next), sequence: 8 }, signedSnapshot: next }),
    ).toMatchObject({ kind: "stale-authority" });
    expect(
      resolve({
        durableState: { ...stateFor(next), digestSha256: "b".repeat(64) },
        signedSnapshot: next,
      }),
    ).toMatchObject({ kind: "invalid-authority" });
    expect(
      resolve({
        durableState: { ...stateFor(next), issuer: "other-issuer" },
        signedSnapshot: next,
      }),
    ).toMatchObject({ kind: "invalid-authority" });
    expect(
      resolve({ durableState: { ...stateFor(next), sequence: 0 }, signedSnapshot: next }),
    ).toMatchObject({ kind: "invalid-authority" });
    expect(() => resolve({ now: "2026-13-10T12:00:01Z", signedSnapshot: next })).toThrow();
    for (const verifyCanonicalPae of [
      () => false,
      () => {
        throw new Error("hostile verifier message");
      },
    ])
      expect(resolve({ verifyCanonicalPae, signedSnapshot: next })).toMatchObject({
        kind: "invalid-authority",
      });
    expect(
      transitionOfflineRevocationStateV1({
        current: undefined,
        next,
        ...trust({ expectedIssuer: "other-issuer" }),
      }),
    ).toEqual({ kind: "invalid-authority" });
    const noncanonical = JSON.stringify(
      JSON.parse(canonicalOfflineRevocationSnapshotV1Bytes(next).toString("utf8")),
      null,
      2,
    );
    expect(() => parseOfflineRevocationSnapshotV1Json(noncanonical)).toThrow();
    const wrongEnvelopeType = JSON.parse(
      canonicalOfflineRevocationSnapshotV1Bytes(next).toString("utf8"),
    );
    wrongEnvelopeType.envelope.payloadType = "application/not-in-toto";
    expect(() => parseOfflineRevocationSnapshotV1Json(JSON.stringify(wrongEnvelopeType))).toThrow();
    expect(() =>
      resolve({
        decision: {
          expiresAt: "2026-08-10T11:59:58Z",
          id: "decision-live",
          issuedAt: "2026-08-10T11:59:59Z",
          notBefore: "2026-08-10T11:59:59Z",
          reviewBy: "2026-08-10T11:59:58Z",
        },
        signedSnapshot: next,
      }),
    ).toThrow("decision bounds");
    expect(
      claimOfflineRevocationStateV1({
        claim: (_issuer: string, _expected: unknown, _replacement: unknown) =>
          Promise.resolve(true),
        next,
        observe: (_issuer: string) => undefined,
        ...trust(),
      }),
    ).toEqual({ kind: "contended" });
    expect(
      claimOfflineRevocationStateV1({
        claim: async () => true,
        next,
        observe: async () => undefined,
        ...trust(),
      }),
    ).toEqual({ kind: "contended" });
    expect(() =>
      claimOfflineRevocationStateV1({
        claim: null,
        next,
        observe: (_issuer: string) => undefined,
        ...trust(),
      }),
    ).toThrow("offline revocation state custody");
  });

  it("has no filesystem, network, process, mutation, or materialization route", () => {
    expect(resolve()).not.toHaveProperty("stop");
    expect(resolve()).not.toHaveProperty("delete");
    expect(resolve()).not.toHaveProperty("subtract");
    const source = readFileSync(
      resolvePath("src/org-policy/offline-revocation-snapshot-v1.ts"),
      "utf8",
    );
    for (const forbidden of [
      "node:child_process",
      "node:fs",
      "node:http",
      "node:https",
      "node:net",
      "node:tls",
      "writeFileSync(",
      "readFileSync(",
      "spawn(",
      "fetch(",
    ])
      expect(source).not.toContain(forbidden);
  });
});
