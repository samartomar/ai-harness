import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Guards the coverage gate itself (AIH-TEST-001): if a future change silently drops
 * the Vitest coverage thresholds, the gate becomes decorative. This asserts they
 * still exist for all four metrics, so removing them is a visible, failing change.
 */
describe("coverage policy", () => {
  const config = readFileSync(join(process.cwd(), "vitest.config.ts"), "utf8");

  it("vitest config declares a thresholds block", () => {
    expect(config).toMatch(/thresholds:\s*\{/);
  });

  it("enforces all four coverage metrics with numeric floors", () => {
    for (const metric of ["statements", "branches", "functions", "lines"]) {
      expect(config).toMatch(new RegExp(`${metric}:\\s*\\d+`));
    }
  });
});
