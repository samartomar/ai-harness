import { describe, expect, it } from "vitest";
import {
  DEFAULT_EVIDENCE_MAX_AGE_DAYS_V1,
  evidenceExpiryV1,
  evidenceIsCurrentV1,
} from "../../src/evidence-freshness.js";

describe("evidence freshness policy", () => {
  it("uses ninety days from the original date and preserves earlier signed expiry", () => {
    expect(DEFAULT_EVIDENCE_MAX_AGE_DAYS_V1).toBe(90);
    expect(evidenceExpiryV1("2026-09-07T12:00:00Z")).toBe("2026-12-06T12:00:00Z");
    expect(evidenceExpiryV1("2026-09-07T12:00:00Z", "2026-10-07T12:00:00Z")).toBe(
      "2026-10-07T12:00:00Z",
    );
    expect(evidenceExpiryV1("2026-09-07T12:00:00Z", "2027-01-01T12:00:00Z")).toBe(
      "2026-12-06T12:00:00Z",
    );
  });
  it("does not restart the clock at verification and expires at the boundary", () => {
    const original = "2026-09-07T12:00:00Z";
    const expiry = evidenceExpiryV1(original);
    expect(evidenceIsCurrentV1(original, expiry, Date.parse("2026-12-06T11:59:59Z"))).toBe(true);
    expect(evidenceIsCurrentV1(original, expiry, Date.parse(expiry))).toBe(false);
    expect(evidenceIsCurrentV1(original, expiry, Date.parse(original) - 1)).toBe(false);
    expect(evidenceIsCurrentV1(original, expiry, Number.NaN)).toBe(false);
  });
  it.each(["2026-02-30T12:00:00Z", "2026-09-07", "2026-09-07T12:00:00+01:00", "garbage"])(
    "rejects invalid original dates: %s",
    (date) => {
      expect(() => evidenceExpiryV1(date)).toThrow();
    },
  );
  it("rejects an expiry at or before the original date", () => {
    expect(() => evidenceExpiryV1("2026-09-07T12:00:00Z", "2026-09-07T12:00:00Z")).toThrow();
  });
});
