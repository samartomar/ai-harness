import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const commandModule = pathToFileURL(
  fileURLToPath(new URL("../../src/methodology/command.ts", import.meta.url)),
).href;

function exitCodeFor(result: object): number | null {
  const script = [
    `import { methodologyExitCode } from ${JSON.stringify(commandModule)};`,
    `process.exitCode = methodologyExitCode(${JSON.stringify(result)});`,
  ].join("\n");
  const child = spawnSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", script],
    {
      cwd: fileURLToPath(new URL("../..", import.meta.url)),
      encoding: "utf8",
      timeout: 20_000,
    },
  );

  if (child.error) throw child.error;
  expect(child.signal).toBeNull();
  expect(child.stderr).toBe("");
  return child.status;
}

describe("methodology CLI process exit contract", () => {
  it.each([
    ["read-only inspection", { status: "success", value: {} }, 0],
    [
      "passed qualification",
      { status: "success", value: { qualification: { classification: "QUALIFICATION_PASS" } } },
      0,
    ],
    [
      "blocked qualification",
      { status: "warning", value: { qualification: { classification: "QUALIFICATION_BLOCKED" } } },
      2,
    ],
    [
      "failed-closed qualification",
      {
        status: "warning",
        value: { qualification: { classification: "QUALIFICATION_FAIL_CLOSED" } },
      },
      3,
    ],
    ["invalid input or command failure", { status: "error", value: {} }, 1],
  ])("%s maps to its required process exit code", (_name, result, expected) => {
    expect(exitCodeFor(result)).toBe(expected);
  });
});
