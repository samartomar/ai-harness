import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { licenseCheck } from "../../src/skill/license.js";

function tempSkill(): string {
  return mkdtempSync(join(tmpdir(), "aih-license-"));
}

describe("skill license check", () => {
  it("prefers the explicit SKILL.md SPDX license over the LICENSE file title", () => {
    const dir = tempSkill();
    writeFileSync(
      join(dir, "SKILL.md"),
      "---\nname: betterdoc\nlicense: Apache-2.0\n---\n\n# BetterDoc\n",
      "utf8",
    );
    writeFileSync(join(dir, "LICENSE"), "Apache License\nVersion 2.0\n", "utf8");

    expect(licenseCheck(dir)).toMatchObject({
      name: "skill license",
      verdict: "pass",
      detail: "SKILL.md license: Apache-2.0",
    });
  });

  it("falls back to LICENSE when SKILL.md has no license field", () => {
    const dir = tempSkill();
    writeFileSync(join(dir, "SKILL.md"), "---\nname: clean\n---\n\n# Clean\n", "utf8");
    writeFileSync(join(dir, "LICENSE"), "MIT License\n", "utf8");

    expect(licenseCheck(dir)).toMatchObject({
      name: "skill license",
      verdict: "pass",
      detail: "LICENSE: MIT License",
    });
  });
});
