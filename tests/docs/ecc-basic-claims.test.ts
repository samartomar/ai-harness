import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const commands = readFileSync(
  fileURLToPath(new URL("../../docs/commands.md", import.meta.url)),
  "utf8",
);
const matrix = readFileSync(
  fileURLToPath(new URL("../../docs/CONTROL_MATRIX.md", import.meta.url)),
  "utf8",
);

it("describes third-party selection as guidance and detector findings as informational", () => {
  expect(commands).not.toMatch(/framework intents[^\n]*hard-blocked/i);
  expect(commands).not.toMatch(/Mandatory detector failures[^\n]*remain blocked/i);
  expect(commands).toContain("third-party selection");
  expect(commands).toContain("AIH-owned projection");
  expect(matrix).not.toContain("framework intents are report-only and hard-blocked");
});
