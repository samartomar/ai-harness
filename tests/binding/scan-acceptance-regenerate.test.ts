import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  regenerateSuperpowersScanAcceptance,
  runScanAcceptanceRegenerateCli,
  SCAN_ACCEPTANCE_LEDGER_PATH,
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

  it.each([
    [
      "wrong repository",
      { ...clean, checkout: { ...clean.checkout, repository: "other/repo" as "obra/superpowers" } },
    ],
    ["wrong pin", { ...clean, checkout: { ...clean.checkout, commitSha: "0".repeat(40) } }],
    ["authorization claim", { ...clean, authorizes: true as false }],
  ])("refuses a checker report with %s", async (_label, report) => {
    await expect(
      regenerateSuperpowersScanAcceptance({ checkoutPath: checkout }, { check: async () => report }),
    ).rejects.toBeInstanceOf(ScanAcceptanceRegenerateError);
  });

  it("refuses a linked target before writing and anchors its default target independently of cwd", async () => {
    const dir = mkdtempSync(join(tmpdir(), "aih-regen-"));
    const real = join(dir, "real.json");
    const linked = join(dir, "linked.json");
    writeFileSync(real, "{}\n");
    try { symlinkSync(real, linked, "file"); } catch { return; }
    const writes: string[] = [];
    await expect(
      regenerateSuperpowersScanAcceptance(
        { checkoutPath: checkout },
        { check: async () => clean, targetPath: linked, write: () => writes.push("write") },
      ),
    ).rejects.toBeInstanceOf(ScanAcceptanceRegenerateError);
    expect(writes).toEqual([]);
    expect(SCAN_ACCEPTANCE_LEDGER_PATH.replaceAll("\\", "/")).toMatch(
      /\/src\/binding\/scan-acceptance\.json$/,
    );
  });
});
