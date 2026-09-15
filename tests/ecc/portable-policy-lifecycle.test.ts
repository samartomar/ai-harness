import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";

const outputs: string[] = [];

afterEach(() => {
  for (const output of outputs.splice(0)) rmSync(output, { recursive: true, force: true });
});

it.runIf(process.env.AIH_PORTABLE_ECC_SOURCE !== undefined)(
  "drives the published CLI through two isolated governed adopter lifecycles",
  () => {
    const parent = mkdtempSync(join(tmpdir(), "aih-portable-policy-delivery-"));
    const output = join(parent, "result");
    outputs.push(parent);
    const result = spawnSync(
      process.execPath,
      [
        "tools/verify-policy-delivery.mjs",
        "--source",
        process.env.AIH_PORTABLE_ECC_SOURCE ?? "",
        "--output",
        output,
      ],
      { cwd: process.cwd(), encoding: "utf8", timeout: 180_000, windowsHide: true },
    );
    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(existsSync(join(output, "RESULT.json"))).toBe(true);
  },
  190_000,
);
