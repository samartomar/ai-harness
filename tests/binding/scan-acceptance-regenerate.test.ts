import { describe, expect, it } from "vitest";
import {
  regenerateSuperpowersScanAcceptance,
  runScanAcceptanceRegenerateCli,
  ScanAcceptanceRegenerateError,
} from "../../src/binding/scan-acceptance-regenerate.js";

const checkout = "C:/vendor/superpowers";
const clean = {
  checkout: {
    repository: "obra/superpowers" as const,
    commitSha: "3dcbd5c4b48e02263fbf4a3c01e3fe4f81d584d9",
  },
  observations: [],
  accepted: [],
  stale: [],
  missing: [],
  new: [],
  critical: [],
  authorizes: false as const,
};

describe("scan-acceptance regeneration", () => {
  it("writes canonical empty ledger bytes without accepting observations and check mode is read-only", async () => {
    const writes: string[] = [];
    const deps = {
      check: async () => ({
        ...clean,
        observations: [
          {
            code: "trust.hidden-unicode",
            path: "x.md",
            fileSha256: "a".repeat(64),
            severity: "high" as const,
          },
        ],
      }),
      read: () => "",
      write: (_path: string, bytes: string) => writes.push(bytes),
    };
    const first = await regenerateSuperpowersScanAcceptance({ checkoutPath: checkout }, deps);
    expect(JSON.parse(first).accepted).toEqual([]);
    expect(writes).toEqual([first]);
    await expect(
      regenerateSuperpowersScanAcceptance(
        { checkoutPath: checkout, check: true },
        { ...deps, read: () => first },
      ),
    ).resolves.toBe(first);
    expect(writes).toEqual([first]);
  });

  it("refuses critical observations and non-canonical check output", async () => {
    await expect(
      regenerateSuperpowersScanAcceptance(
        { checkoutPath: checkout },
        {
          check: async () => ({
            ...clean,
            critical: [
              {
                code: "trust.malicious-code",
                path: "x",
                fileSha256: "a".repeat(64),
                severity: "critical" as const,
              },
            ],
          }),
        },
      ),
    ).rejects.toBeInstanceOf(ScanAcceptanceRegenerateError);
    await expect(
      runScanAcceptanceRegenerateCli(["--checkout", checkout, "--check"], {
        check: async () => clean,
        read: () => "{}\n",
      }),
    ).rejects.toBeInstanceOf(ScanAcceptanceRegenerateError);
  });
});
