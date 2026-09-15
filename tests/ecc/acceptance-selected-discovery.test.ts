import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

const outputs: string[] = [];

afterEach(() => {
  for (const output of outputs.splice(0)) rmSync(output, { recursive: true, force: true });
});

it.runIf(process.env.AIH_PORTABLE_ECC_SOURCE !== undefined)(
  "drives the published CLI through a six-client selected-content lifecycle without claiming receipt paths are native discovery",
  () => {
    const parent = mkdtempSync(join(tmpdir(), "aih-selected-content-"));
    const output = join(parent, "result");
    outputs.push(parent);
    const run = spawnSync(
      process.execPath,
      [
        "tools/verify-selected-content.mjs",
        "--source",
        process.env.AIH_PORTABLE_ECC_SOURCE ?? "",
        "--output",
        output,
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        timeout: 190_000,
        windowsHide: true,
      },
    );
    expect(run.status, run.stderr || run.stdout).toBe(0);
    expect(existsSync(join(output, "RESULT.json"))).toBe(true);
    const report = JSON.parse(readFileSync(join(output, "RESULT.json"), "utf8"));
    expect(report.status).toBe("passed");
    expect(report.activeNativeRoots?.Harbor?.lifecycleStatus).toContain("active retained copy");
    expect(report.activeNativeRoots?.Cedar?.lifecycleStatus).toContain("active retained copy");
    expect(report.rows.map((row: { client: string }) => row.client)).toEqual([
      "claude",
      "codex",
      "cursor",
      "kimi",
      "kiro",
      "opencode",
    ]);
    for (const row of report.rows) {
      expect(row.selection).toBe("required");
      expect(row.receiptOwnedPaths.length).toBeGreaterThan(0);
      expect(row.nativeDiscovery).toBe("not-observed");
      expect(row.enabledEntries).toBeNull();
      expect(row.billing).toBeNull();
    }
  },
  700_000,
);
