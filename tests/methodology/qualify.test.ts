import { describe, expect, it } from "vitest";
import { qualifyMethodology } from "../../src/methodology/qualify.js";

describe("synthetic methodology qualification", () => {
  it("fails closed for shared destinations and self-updaters", () => {
    expect(
      qualifyMethodology({
        compatibility: "supported",
        hostCoverage: "complete",
        isolation: "conflict",
        selfUpdater: false,
      }),
    ).toMatchObject({
      classification: "QUALIFICATION_FAIL_CLOSED",
      supportLevel: "plannable",
      findings: ["ISOLATION_CONFLICT"],
      providerCodeExecuted: false,
    });
    expect(
      qualifyMethodology({
        compatibility: "supported",
        hostCoverage: "complete",
        isolation: "proven",
        selfUpdater: true,
      }),
    ).toMatchObject({
      classification: "QUALIFICATION_FAIL_CLOSED",
      findings: ["PROVIDER_SELF_UPDATE_ENABLED"],
    });
  });

  it("blocks unknown facts and caps partial-host qualification at plannable", () => {
    expect(
      qualifyMethodology({
        compatibility: "unknown",
        hostCoverage: "complete",
        isolation: "proven",
        selfUpdater: false,
      }),
    ).toMatchObject({
      classification: "QUALIFICATION_BLOCKED",
      findings: ["ADAPTER_COMPATIBILITY_UNKNOWN"],
    });
    expect(
      qualifyMethodology({
        compatibility: "supported",
        hostCoverage: "partial",
        isolation: "proven",
        selfUpdater: false,
      }),
    ).toMatchObject({
      classification: "QUALIFICATION_PASS",
      supportLevel: "plannable",
    });
  });
});
