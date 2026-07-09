import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
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

  it("uses the selected skill folder license before falling back to the source root", () => {
    const dir = tempSkill();
    const skillDir = join(dir, "skills", "clean");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "---\nname: clean\n---\n\n# Clean\n", "utf8");
    writeFileSync(join(skillDir, "LICENSE"), "MIT License\n", "utf8");

    expect(licenseCheck(dir, { skillRoot: skillDir })).toMatchObject({
      name: "skill license",
      verdict: "pass",
      detail: "skills/clean/LICENSE: MIT License",
    });
  });

  it("falls back to source-root license evidence for a selected skill with no local license", () => {
    const dir = tempSkill();
    const skillDir = join(dir, "skills", "clean");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(dir, "LICENSE"), "MIT License\n", "utf8");
    writeFileSync(join(skillDir, "SKILL.md"), "---\nname: clean\n---\n\n# Clean\n", "utf8");

    expect(licenseCheck(dir, { skillRoot: skillDir })).toMatchObject({
      name: "skill license",
      verdict: "pass",
      detail: "LICENSE: MIT License",
    });
  });

  it("accepts root license evidence when the selected skill is the source root", () => {
    const dir = tempSkill();
    writeFileSync(join(dir, "SKILL.md"), "---\nname: root-skill\n---\n\n# Root Skill\n", "utf8");
    writeFileSync(join(dir, "LICENSE"), "MIT License\n", "utf8");

    expect(licenseCheck(dir, { skillRoot: dir })).toMatchObject({
      name: "skill license",
      verdict: "pass",
      detail: "LICENSE: MIT License",
    });
  });

  it("does not use a sibling skill license for the selected skill", () => {
    const dir = tempSkill();
    const selected = join(dir, "skills", "selected");
    const sibling = join(dir, "skills", "sibling");
    mkdirSync(selected, { recursive: true });
    mkdirSync(sibling, { recursive: true });
    writeFileSync(join(selected, "SKILL.md"), "---\nname: selected\n---\n\n# Selected\n", "utf8");
    writeFileSync(join(sibling, "SKILL.md"), "---\nname: sibling\n---\n\n# Sibling\n", "utf8");
    writeFileSync(join(sibling, "LICENSE"), "MIT License\n", "utf8");

    expect(licenseCheck(dir, { skillRoot: selected })).toMatchObject({
      name: "skill license",
      verdict: "fail",
      code: "trust.license-missing",
    });
  });

  it("does not follow selected skill evidence symlinks into a sibling skill", () => {
    const cases = [
      {
        file: "LICENSE",
        body: "MIT License\n",
      },
      {
        file: "SKILL.md",
        body: "---\nname: sibling\nlicense: Apache-2.0\n---\n\n# Sibling\n",
      },
      {
        file: "package.json",
        body: JSON.stringify({ license: "BSD-3-Clause" }),
      },
    ];

    for (const item of cases) {
      const dir = tempSkill();
      const selected = join(dir, "skills", "selected");
      const sibling = join(dir, "skills", "sibling");
      mkdirSync(selected, { recursive: true });
      mkdirSync(sibling, { recursive: true });
      writeFileSync(join(sibling, item.file), item.body, "utf8");
      try {
        symlinkSync(join("..", "sibling", item.file), join(selected, item.file));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EPERM") return;
        throw err;
      }

      expect(licenseCheck(dir, { skillRoot: selected })).toMatchObject({
        name: "skill license",
        verdict: "fail",
        code: "trust.license-missing",
      });
    }
  });

  it("does not fall back to source-root evidence for an out-of-root skill path", () => {
    const dir = tempSkill();
    const outside = tempSkill();
    writeFileSync(join(dir, "LICENSE"), "MIT License\n", "utf8");
    writeFileSync(join(outside, "LICENSE"), "Apache License\n", "utf8");

    expect(licenseCheck(dir, { skillRoot: outside })).toMatchObject({
      name: "skill license",
      verdict: "fail",
      code: "trust.license-missing",
      detail: "selected skill root is outside the source root; no license evidence accepted",
    });
  });

  it("fails when neither the selected skill nor the source root has license evidence", () => {
    const dir = tempSkill();
    const skillDir = join(dir, "skills", "missing");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "---\nname: missing\n---\n\n# Missing\n", "utf8");

    expect(licenseCheck(dir, { skillRoot: skillDir })).toMatchObject({
      name: "skill license",
      verdict: "fail",
      code: "trust.license-missing",
      detail:
        "no LICENSE/LICENSE.md/LICENSE.txt/COPYING file, SKILL.md license frontmatter, or package.json license field at the selected skill root or source root",
    });
  });

  it("prefers selected skill frontmatter over conflicting root license evidence", () => {
    const dir = tempSkill();
    const skillDir = join(dir, "skills", "clean");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(dir, "LICENSE"), "MIT License\n", "utf8");
    writeFileSync(
      join(skillDir, "SKILL.md"),
      "---\nname: clean\nlicense: Apache-2.0\n---\n\n# Clean\n",
      "utf8",
    );

    expect(licenseCheck(dir, { skillRoot: skillDir })).toMatchObject({
      name: "skill license",
      verdict: "pass",
      detail: "skills/clean/SKILL.md license: Apache-2.0",
    });
  });
});
