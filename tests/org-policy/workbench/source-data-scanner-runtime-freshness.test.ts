import { describe, expect, it } from "vitest";
import { assertCurrentRuntimeDescriptorEvidenceV1 } from "../../../src/org-policy/workbench/core/source-data-scanner.js";

describe("authenticated runtime descriptor freshness", () => {
  it("uses the ninety-day signed-report boundary rather than archived custody expiry", () => {
    const reportFreshnessExpiry = "2026-12-07T21:04:56.000Z";
    expect(() =>
      assertCurrentRuntimeDescriptorEvidenceV1(reportFreshnessExpiry, "2026-09-09T03:25:52.929Z"),
    ).not.toThrow();
    expect(() =>
      assertCurrentRuntimeDescriptorEvidenceV1(reportFreshnessExpiry, reportFreshnessExpiry),
    ).toThrow(/independent Scanner proof or source binding rejected/);
  });
});
