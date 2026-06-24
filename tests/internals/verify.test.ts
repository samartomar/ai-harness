import { describe, expect, it } from "vitest";
import { VerificationReport } from "../../src/internals/verify.js";

describe("VerificationReport", () => {
  it("counts verdicts and stays ok unless a check fails", () => {
    const r = new VerificationReport();
    r.pass("a").skip("b").pass("c");
    expect(r.ok).toBe(true);
    expect(r.counts()).toEqual({ pass: 2, fail: 0, skip: 1 });
    expect(r.exitCode()).toBe(0);
  });

  it("fails the report and exit code when any check fails", () => {
    const r = new VerificationReport();
    r.pass("a").fail("b", "boom");
    expect(r.ok).toBe(false);
    expect(r.exitCode()).toBe(1);
    expect(r.toJSON().checks).toHaveLength(2);
  });

  it("renders a summary line with counts", () => {
    const r = new VerificationReport();
    r.pass("alpha");
    expect(r.summary()).toContain("alpha");
    expect(r.summary()).toContain("1 passed, 0 failed, 0 skipped");
  });
});
