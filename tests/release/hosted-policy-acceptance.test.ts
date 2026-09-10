import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

it("enforces hosted acquisition, privacy, ciphertext and failure-retention boundaries", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--test",
      fileURLToPath(new URL("./hosted-policy-acceptance-controls.mjs", import.meta.url)),
    ],
    { encoding: "utf8", windowsHide: true, timeout: 10_000, maxBuffer: 1_000_000 },
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stdout + result.stderr).toBe(0);
  expect(result.stdout).toMatch(/(?:pass|# pass) 8/u);
});
