import { describe, expect, it } from "vitest";
import { createProposedPlan } from "../../src/methodology/plan.js";

const discovery = {
  manifestPath: "package.json",
  packageName: "synthetic-provider",
  scripts: { install: "node scripts/install.js --apply" },
  installerEntries: ["install"],
  installerContractFingerprint: "a".repeat(64),
  providerCodeExecuted: false,
} as const;

describe("pure proposed methodology plans", () => {
  it("is byte-stable and records every unproven operational impact as unknown", () => {
    const first = createProposedPlan({ discovery, sourceTreeSha256: "b".repeat(64) });
    const second = createProposedPlan({ discovery, sourceTreeSha256: "b".repeat(64) });

    expect(second).toEqual(first);
    expect(first.providerCodeExecuted).toBe(false);
    expect(first.impacts).toEqual({
      writes: "unknown",
      processes: "unknown",
      services: "unknown",
      network: "unknown",
      updater: "unknown",
      runtime: "unknown",
      uninstall: "unknown",
    });
    expect(first.digest).toMatch(/^[0-9a-f]{64}$/);
  });
});
