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

function resolve(overrides: Record<string, unknown> = {}) {
  return resolveOfflineRevocationAuthorityV1({
    decision: {
      expiresAt: "2026-08-12T12:00:00Z",
      id: "decision-live",
      issuedAt: "2026-08-10T11:59:59Z",
      notBefore: "2026-08-10T11:59:59Z",
      reviewBy: "2026-08-12T12:00:00Z",
    },
    expectedAdminSignerIdentity: "signer:org-admin",
    expectedAdminSignerRootSha256: DIGEST,
    expectedIssuer: "platform-security",
    now: "2026-08-10T12:00:01Z",
    receiptExpiresAt: "2026-08-12T12:00:00Z",
    signedSnapshot: signed(),
    verifyCanonicalPae: vi.fn(() => true),
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
    expect(
      resolve({
        signedSnapshot: signed({ snapshot: snapshot({ issuedAt: "2026-08-10T12:00:02Z" }) }),
      }),
    ).toMatchObject({ kind: "invalid-authority" });
    expect(resolve({ now: "2026-08-10T11:59:59Z" })).toMatchObject({ kind: "invalid-authority" });
  });

  it("rejects rollback and equal-sequence substitution while producing a deterministic next durable state", () => {
    const current = { digestSha256: "b".repeat(64), issuer: "platform-security", sequence: 7 };
    expect(transitionOfflineRevocationStateV1({ current, next: signed() })).toEqual({
      kind: "conflict",
      state: current,
    });
    expect(
      transitionOfflineRevocationStateV1({ current: { ...current, sequence: 8 }, next: signed() }),
    ).toEqual({
      kind: "rollback",
      state: { ...current, sequence: 8 },
    });
    expect(
      transitionOfflineRevocationStateV1({
        current,
        next: signed({ snapshot: snapshot({ sequence: 8 }) }),
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
    expect(claimOfflineRevocationStateV1({ claim, next, observe: () => durable })).toMatchObject({
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
        observe: () => durable,
      }),
    ).toEqual({ kind: "contended" });
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
