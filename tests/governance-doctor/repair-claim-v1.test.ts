import { describe, expect, it } from "vitest";
import {
  canonicalGovernanceDoctorRepairClaimV1Bytes,
  createGovernanceDoctorRepairClaimV1,
  GOVERNANCE_DOCTOR_REPAIR_CLAIM_V1_LIMITS,
  governanceDoctorRepairClaimFileNameV1,
  governanceDoctorRepairClaimScopeSha256V1,
  governanceDoctorRepairClaimSha256V1,
  parseGovernanceDoctorRepairClaimV1,
} from "../../src/governance-doctor/repair-claim-v1.js";

/**
 * The pure half of the durable claim contract.
 *
 * Nothing here touches a filesystem, a clock, or an environment, and that is half
 * of what this suite is for: the schema and the digests have to be safe to run
 * over a record some other process wrote, without that parse ever being a route to
 * a capability.
 */
const CONSENT = "1c".repeat(32);
const PLAN = "2b".repeat(32);
const SCOPE = "3d".repeat(32);
const AT = 1_777_000_120_000;

const REFUSAL = /^GOVERNANCE_DOCTOR(?:_REPAIR)?_V1: /;

function claimRequest(): Record<string, unknown> {
  return {
    claimedAtEpochMs: AT,
    consentSha256: CONSENT,
    planSha256: PLAN,
    scopeSha256: SCOPE,
    state: "claimed",
  };
}

function claim(overrides: Record<string, unknown> = {}) {
  return createGovernanceDoctorRepairClaimV1({ ...claimRequest(), ...overrides });
}

describe("governance doctor repair claim record V1", () => {
  it("mints a frozen, bounded, exactly-keyed record", () => {
    const minted = claim();

    expect(Object.keys(minted).sort()).toEqual([
      "claimSha256",
      "claimedAtEpochMs",
      "consentSha256",
      "planSha256",
      "protocol",
      "recordSha256",
      "scopeSha256",
      "state",
    ]);
    expect(minted.protocol).toBe("GovernanceDoctorRepairClaimV1");
    expect(Object.isFrozen(minted)).toBe(true);
    expect(canonicalGovernanceDoctorRepairClaimV1Bytes(minted).length).toBeLessThanOrEqual(
      GOVERNANCE_DOCTOR_REPAIR_CLAIM_V1_LIMITS.maxClaimBytes,
    );
    expect(minted.claimSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(minted.recordSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("keeps the authority identity independent of the state and the instant", () => {
    // The file name is derived from `claimSha256`, so a later state must not be
    // able to move to a second name and read as absent at the first.
    const claimed = claim();
    const consumed = claim({ state: "consumed" });
    const later = claim({ claimedAtEpochMs: AT + 60_000 });

    expect(consumed.claimSha256).toBe(claimed.claimSha256);
    expect(later.claimSha256).toBe(claimed.claimSha256);
    // Content integrity is the opposite: it covers everything.
    expect(consumed.recordSha256).not.toBe(claimed.recordSha256);
    expect(later.recordSha256).not.toBe(claimed.recordSha256);
  });

  it("separates the identity, record, and scope digests by domain", () => {
    const identity = governanceDoctorRepairClaimSha256V1({ planSha256: PLAN, scopeSha256: SCOPE });

    expect(claim().claimSha256).toBe(identity);
    expect(identity).not.toBe(claim().recordSha256);
    expect(identity).not.toBe(governanceDoctorRepairClaimScopeSha256V1({ realPath: "/a" }));
    // Both components move the identity, and neither is interchangeable.
    expect(governanceDoctorRepairClaimSha256V1({ planSha256: SCOPE, scopeSha256: PLAN })).not.toBe(
      identity,
    );
    expect(() => governanceDoctorRepairClaimSha256V1({ planSha256: PLAN })).toThrow(REFUSAL);
    // The consent has no representation in the authority identity at all, so it
    // cannot be handed in here as a third component.
    expect(() =>
      governanceDoctorRepairClaimSha256V1({
        consentSha256: CONSENT,
        planSha256: PLAN,
        scopeSha256: SCOPE,
      }),
    ).toThrow(REFUSAL);
  });

  /**
   * Resolved -- the reviewed identity defect. A claimed record permanently spends
   * the Plan for one canonical root, so the authority identity -- and therefore the
   * one file name the store may ever use -- has to be the Plan and the root scope
   * and nothing else.
   *
   * Letting the consent into that digest gave one Plan under one root as many names
   * as an operator could mint consents for, and a record written at the first name
   * read as absent at the second. The consent stays in the record body, where it is
   * provenance covered by `recordSha256`, and stays out of the name.
   */
  it("pins the authority identity to the plan and the root scope, never the consent", () => {
    const mine = claim();
    const freshConsent = claim({ consentSha256: "9a".repeat(32) });

    expect(freshConsent.consentSha256).not.toBe(mine.consentSha256);
    expect(freshConsent.claimSha256).toBe(mine.claimSha256);
    expect(governanceDoctorRepairClaimFileNameV1(freshConsent.claimSha256)).toBe(
      governanceDoctorRepairClaimFileNameV1(mine.claimSha256),
    );
    // Provenance is kept, and it is content integrity that carries it.
    expect(freshConsent.recordSha256).not.toBe(mine.recordSha256);
    expect(canonicalGovernanceDoctorRepairClaimV1Bytes(freshConsent).toString("utf8")).toContain(
      freshConsent.consentSha256,
    );

    // A different plan, or a different canonical root, is still a distinct name.
    expect(claim({ planSha256: "4e".repeat(32) }).claimSha256).not.toBe(mine.claimSha256);
    expect(claim({ scopeSha256: "5f".repeat(32) }).claimSha256).not.toBe(mine.claimSha256);
  });

  it("binds the scope to the exact canonical real path, byte for byte", () => {
    const posix = governanceDoctorRepairClaimScopeSha256V1({ realPath: "/home/dev/checkout" });

    expect(posix).toMatch(/^[a-f0-9]{64}$/);
    // Moving the checkout is a new authority scope, on purpose.
    expect(governanceDoctorRepairClaimScopeSha256V1({ realPath: "/home/dev/checkout2" })).not.toBe(
      posix,
    );
    // Nothing is case-folded, trimmed, or separator-normalized on the caller's behalf.
    expect(governanceDoctorRepairClaimScopeSha256V1({ realPath: "/home/dev/Checkout" })).not.toBe(
      posix,
    );
    expect(governanceDoctorRepairClaimScopeSha256V1({ realPath: "/home/dev/checkout/" })).not.toBe(
      posix,
    );
    expect(governanceDoctorRepairClaimScopeSha256V1({ realPath: "C:\\dev\\checkout" })).not.toBe(
      governanceDoctorRepairClaimScopeSha256V1({ realPath: "c:\\dev\\checkout" }),
    );
  });

  it("accepts a non-NFC real path but refuses malformed Unicode and an unbounded one", () => {
    // A real path is whatever the filesystem reports; macOS hands back decomposed
    // forms, and refusing those would refuse a legitimate checkout.
    const decomposed = "/home/dev/cafe\u0301";
    expect(governanceDoctorRepairClaimScopeSha256V1({ realPath: decomposed })).toMatch(
      /^[a-f0-9]{64}$/,
    );
    expect(governanceDoctorRepairClaimScopeSha256V1({ realPath: decomposed })).not.toBe(
      governanceDoctorRepairClaimScopeSha256V1({ realPath: "/home/dev/caf\u00e9" }),
    );

    // A lone surrogate would collapse into a replacement character and make two
    // different checkouts digest identically.
    expect(() => governanceDoctorRepairClaimScopeSha256V1({ realPath: "/a\ud800" })).toThrow(
      REFUSAL,
    );
    expect(() => governanceDoctorRepairClaimScopeSha256V1({ realPath: "/a\udc00b" })).toThrow(
      REFUSAL,
    );
    expect(() =>
      governanceDoctorRepairClaimScopeSha256V1({
        realPath: "a".repeat(GOVERNANCE_DOCTOR_REPAIR_CLAIM_V1_LIMITS.maxScopePathCodeUnits + 1),
      }),
    ).toThrow(REFUSAL);
    expect(() => governanceDoctorRepairClaimScopeSha256V1({ realPath: "" })).toThrow(REFUSAL);
    expect(() => governanceDoctorRepairClaimScopeSha256V1({ realPath: 1 })).toThrow(REFUSAL);
    expect(() => governanceDoctorRepairClaimScopeSha256V1({ realPath: "/a", extra: 1 })).toThrow(
      REFUSAL,
    );
  });

  it("requires exactly its schema fields and a closed state", () => {
    expect(() => createGovernanceDoctorRepairClaimV1({ ...claimRequest(), extra: 1 })).toThrow(
      REFUSAL,
    );
    const { state: _state, ...missing } = claimRequest();
    expect(() => createGovernanceDoctorRepairClaimV1(missing)).toThrow(REFUSAL);
    expect(() => claim({ state: "spent" })).toThrow(REFUSAL);
    expect(() => claim({ state: "CLAIMED" })).toThrow(REFUSAL);
    expect(() => createGovernanceDoctorRepairClaimV1(null)).toThrow(REFUSAL);
    expect(() => createGovernanceDoctorRepairClaimV1([])).toThrow(REFUSAL);
  });

  it("requires a bare lowercase SHA-256 in every digest position", () => {
    for (const bad of [
      CONSENT.toUpperCase(),
      CONSENT.slice(0, 63),
      `${CONSENT}0`,
      `0x${CONSENT.slice(2)}`,
      ` ${CONSENT.slice(1)}`,
      `${CONSENT.slice(0, 63)}g`,
      CONSENT.replace("1", "-"),
    ]) {
      expect(() => claim({ consentSha256: bad }), bad).toThrow(REFUSAL);
      expect(() => claim({ planSha256: bad }), bad).toThrow(REFUSAL);
      expect(() => claim({ scopeSha256: bad }), bad).toThrow(REFUSAL);
    }
  });

  it("refuses a proxy, an accessor, a symbol key, and a foreign prototype", () => {
    expect(() => createGovernanceDoctorRepairClaimV1(new Proxy(claimRequest(), {}))).toThrow(
      REFUSAL,
    );

    const accessor = claimRequest();
    Object.defineProperty(accessor, "state", { enumerable: true, get: () => "claimed" });
    expect(() => createGovernanceDoctorRepairClaimV1(accessor)).toThrow(REFUSAL);

    const symbolKeyed = claimRequest() as Record<string | symbol, unknown>;
    symbolKeyed[Symbol("state")] = 1;
    expect(() => createGovernanceDoctorRepairClaimV1(symbolKeyed)).toThrow(REFUSAL);

    expect(() =>
      createGovernanceDoctorRepairClaimV1(
        Object.assign(Object.create({ inherited: true }), claimRequest()),
      ),
    ).toThrow(REFUSAL);
  });

  it("refuses a cyclic and a non-scalar field rather than walking it", () => {
    const cyclic = claimRequest();
    cyclic.state = cyclic;
    expect(() => createGovernanceDoctorRepairClaimV1(cyclic)).toThrow(REFUSAL);

    const selfReferential: Record<string, unknown> = { realPath: "/a" };
    selfReferential.realPath = selfReferential;
    expect(() => governanceDoctorRepairClaimScopeSha256V1(selfReferential)).toThrow(REFUSAL);
  });

  it("refuses an instant outside its bounded era", () => {
    expect(() => claim({ claimedAtEpochMs: 0 })).toThrow(REFUSAL);
    expect(() => claim({ claimedAtEpochMs: 1.5 })).toThrow(REFUSAL);
    expect(() => claim({ claimedAtEpochMs: Number.MAX_SAFE_INTEGER })).toThrow(REFUSAL);
    expect(() => claim({ claimedAtEpochMs: "1777000120000" })).toThrow(REFUSAL);
  });

  it("hands back a defensive copy of the canonical bytes", () => {
    const minted = claim();
    const first = canonicalGovernanceDoctorRepairClaimV1Bytes(minted);
    first.fill(0);

    expect(canonicalGovernanceDoctorRepairClaimV1Bytes(minted).equals(first)).toBe(false);
    expect(canonicalGovernanceDoctorRepairClaimV1Bytes(minted).toString("utf8")).toContain(
      minted.claimSha256,
    );
  });

  it("refuses to hand out bytes for anything it did not mint", () => {
    expect(() => canonicalGovernanceDoctorRepairClaimV1Bytes({ ...claim() })).toThrow(REFUSAL);
    expect(() => canonicalGovernanceDoctorRepairClaimV1Bytes(null)).toThrow(REFUSAL);
  });

  it("round-trips its own canonical bytes in either state", () => {
    const minted = claim();
    const parsed = parseGovernanceDoctorRepairClaimV1(
      canonicalGovernanceDoctorRepairClaimV1Bytes(minted),
    );

    expect(parsed).toEqual(minted);
    expect(canonicalGovernanceDoctorRepairClaimV1Bytes(parsed)).toEqual(
      canonicalGovernanceDoctorRepairClaimV1Bytes(minted),
    );
    // A terminal record parses too: presence in either state spends the plan.
    expect(
      parseGovernanceDoctorRepairClaimV1(
        canonicalGovernanceDoctorRepairClaimV1Bytes(claim({ state: "consumed" })),
      ).state,
    ).toBe("consumed");
  });

  it("refuses transport that is re-encoded, padded, truncated, or oversized", () => {
    const bytes = canonicalGovernanceDoctorRepairClaimV1Bytes(claim());
    const record = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;

    // Same fields, different encoding: a claim is its exact canonical bytes.
    const reordered = Object.fromEntries(Object.entries(record).reverse());
    expect(() =>
      parseGovernanceDoctorRepairClaimV1(Buffer.from(JSON.stringify(reordered), "utf8")),
    ).toThrow(REFUSAL);
    expect(() =>
      parseGovernanceDoctorRepairClaimV1(Buffer.from(JSON.stringify(record, null, 2), "utf8")),
    ).toThrow(REFUSAL);
    expect(() =>
      parseGovernanceDoctorRepairClaimV1(Buffer.concat([bytes, Buffer.from(" ", "utf8")])),
    ).toThrow(REFUSAL);
    // Bytes that are not JSON at all are refused by the shared strict parser, which
    // this foundation's broker, plan, consent, and receipt transports all share. Its
    // diagnostic names parse-error codes and offsets and never any input content, but
    // it is not one of this module's own closed labels -- so the durable store
    // collapses it into one, and only the store's refusals carry a fixed label.
    expect(() => parseGovernanceDoctorRepairClaimV1(bytes.subarray(0, bytes.length - 3))).toThrow(
      TypeError,
    );
    expect(() =>
      parseGovernanceDoctorRepairClaimV1(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes])),
    ).toThrow(REFUSAL);
    expect(() => parseGovernanceDoctorRepairClaimV1(Buffer.alloc(0))).toThrow(REFUSAL);
    expect(() => parseGovernanceDoctorRepairClaimV1("{}")).toThrow(REFUSAL);

    const padded = {
      ...record,
      note: "x".repeat(GOVERNANCE_DOCTOR_REPAIR_CLAIM_V1_LIMITS.maxClaimBytes),
    };
    expect(() =>
      parseGovernanceDoctorRepairClaimV1(Buffer.from(JSON.stringify(padded), "utf8")),
    ).toThrow(REFUSAL);
  });

  it("refuses transport whose declared digests do not match its own content", () => {
    const bytes = canonicalGovernanceDoctorRepairClaimV1Bytes(claim());
    const record = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;

    for (const tamper of [
      { claimSha256: SCOPE },
      { recordSha256: SCOPE },
      { protocol: "GovernanceDoctorRepairReceiptV1" },
      { extra: 1 },
      // A field edited in place moves `recordSha256`, so the declared one no longer fits.
      { state: "consumed" },
    ])
      expect(
        () =>
          parseGovernanceDoctorRepairClaimV1(
            Buffer.from(JSON.stringify({ ...record, ...tamper }), "utf8"),
          ),
        JSON.stringify(tamper),
      ).toThrow(REFUSAL);
  });

  it("derives a fixed file name and refuses anything that is not a digest", () => {
    const minted = claim();
    expect(governanceDoctorRepairClaimFileNameV1(minted.claimSha256)).toBe(
      `${minted.claimSha256}.json`,
    );
    expect(governanceDoctorRepairClaimFileNameV1(minted.claimSha256)).toMatch(
      /^[a-f0-9]{64}\.json$/,
    );

    // No caller-influenced text has any representation in the store's directory.
    for (const bad of ["../escape", "a/b", `${CONSENT}.json`, "", CONSENT.toUpperCase()])
      expect(() => governanceDoctorRepairClaimFileNameV1(bad), bad).toThrow(REFUSAL);
  });

  it("never echoes an input value in a refusal", () => {
    const secret = "/home/dev/secret-checkout";
    let message = "";
    try {
      governanceDoctorRepairClaimScopeSha256V1({ realPath: `${secret}\ud800` });
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toMatch(REFUSAL);
    expect(message).not.toContain(secret);
  });
});
