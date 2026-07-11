import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readVendorBaselineLock } from "../../src/baseline-evidence/vendor.js";
import { checkInstallableBaseline } from "../../src/internals/check-baseline-installable.js";

describe("shipped ECC baseline installability", () => {
  it("reproduces the v2.8.0 zero-installable enterprise lock", async () => {
    const lock = JSON.parse(
      readFileSync(
        join(process.cwd(), "tests/fixtures/baseline-evidence/ecc-v2.8.0-vendor-lock.json"),
        "utf8",
      ),
    );

    const report = await checkInstallableBaseline({ lock, fixtureOnly: true });

    expect(report.pin).toBe("4130457d674d2180c5af2c5f634f3cae4cbc6c4f");
    expect(report.postures.enterprise.installed).toBe(0);
    expect(report.ok).toBe(false);
  });

  it("installs the current shipped lock at every posture and holds hooks-runtime at enterprise", async () => {
    const lock = readVendorBaselineLock();
    const eccPin = lock.sources.find((source) => source.id === "ecc")?.pinnedSha;

    const report = await checkInstallableBaseline({ lock, fixtureOnly: true });

    expect(report.pin).toBe(eccPin);
    expect(report.ok).toBe(true);
    for (const posture of ["vibe", "team", "enterprise"] as const) {
      expect(report.postures[posture].installed).toBeGreaterThan(0);
      expect(report.postures[posture].installedComponentIds).toContain("runtime:ecc-installer");
    }

    // Enterprise installs the authorized common/project baseline while holding the auto-exec hook
    // module. The current pinned candidate holds module:hooks-runtime via strict-surface Unicode
    // findings rather than trust.auto-exec-hook, so assert it is held and named with codes.
    const heldHooks = report.postures.enterprise.held.find(
      (entry) => entry.componentId === "module:hooks-runtime",
    );
    expect(heldHooks).toBeDefined();
    expect(heldHooks?.codes.length ?? 0).toBeGreaterThan(0);
  });
});
