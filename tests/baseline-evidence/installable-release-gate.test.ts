import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkInstallableBaseline } from "../../src/internals/check-baseline-installable.js";

describe("shipped ECC baseline installability", () => {
  it("reproduces the v2.8.0 zero-installable enterprise lock", async () => {
    const lock = JSON.parse(
      readFileSync(
        join(
          process.cwd(),
          "tests/fixtures/baseline-evidence/ecc-v2.8.0-vendor-lock.json",
        ),
        "utf8",
      ),
    );

    const report = await checkInstallableBaseline({ lock, fixtureOnly: true });

    expect(report.pin).toBe("4130457d674d2180c5af2c5f634f3cae4cbc6c4f");
    expect(report.postures.enterprise.installed).toBe(0);
    expect(report.ok).toBe(false);
  });
});
