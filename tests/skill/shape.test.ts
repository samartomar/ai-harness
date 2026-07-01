import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { skillShape } from "../../src/skill/shape.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aih-skill-shape-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function skill(rel: string, body: string): void {
  const root = join(dir, rel);
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "SKILL.md"), body, "utf8");
}

function write(rel: string, body: string): void {
  const path = join(dir, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, "utf8");
}

describe("skillShape", () => {
  it("detects skill directories by their logical promoted names", () => {
    skill("skills/clean", "# Clean\n");
    skill("skills/extra", "# Extra\n");

    expect(skillShape(dir).skillDirs).toEqual(["clean", "extra"]);
  });

  it("reports an empty tree with no triggers", () => {
    mkdirSync(join(dir, "docs"), { recursive: true });

    expect(skillShape(dir)).toEqual({
      skillDirs: [],
      installScripts: false,
      mcpConfig: false,
      packageManifests: [],
      fullCodebaseAnalysis: false,
    });
  });

  it("detects install lifecycle hooks in package.json scripts", () => {
    skill("skills/clean", "# Clean\n");
    write("package.json", JSON.stringify({ scripts: { postinstall: "node setup.js" } }));

    const shape = skillShape(dir);

    expect(shape.installScripts).toBe(true);
    expect(shape.packageManifests).toEqual(["package.json"]);
  });

  it("detects shell install scripts at the root and under scripts/", () => {
    skill("skills/clean", "# Clean\n");
    write("setup.sh", "echo setup\n");
    expect(skillShape(dir).installScripts).toBe(true);

    rmSync(join(dir, "setup.sh"));
    write("scripts/install.ps1", "Write-Output install\n");
    expect(skillShape(dir).installScripts).toBe(true);
  });

  it("does not flag a plain package.json without lifecycle hooks", () => {
    skill("skills/clean", "# Clean\n");
    write("package.json", JSON.stringify({ scripts: { test: "vitest run" } }));

    expect(skillShape(dir).installScripts).toBe(false);
  });

  it("detects incoming MCP config files", () => {
    skill("skills/clean", "# Clean\n");
    expect(skillShape(dir).mcpConfig).toBe(false);

    write(".mcp.json", JSON.stringify({ mcpServers: {} }));
    expect(skillShape(dir).mcpConfig).toBe(true);
  });

  it("lists every package manifest found at the tree root", () => {
    skill("skills/clean", "# Clean\n");
    write("package.json", JSON.stringify({ name: "x" }));
    write("pyproject.toml", "[project]\nname = 'x'\n");
    write("go.mod", "module example.com/x\n");

    expect(skillShape(dir).packageManifests).toEqual(["package.json", "pyproject.toml", "go.mod"]);
  });

  it("flags skill docs that advertise full-codebase analysis", () => {
    skill("skills/graph", "# Graph\n\nThis skill analyzes the entire codebase to build a map.\n");

    expect(skillShape(dir).fullCodebaseAnalysis).toBe(true);
  });

  it("flags a root README that advertises whole-repository scanning", () => {
    skill("skills/clean", "# Clean\n");
    write("README.md", "# Tool\n\nScans the whole repository for architecture insight.\n");

    expect(skillShape(dir).fullCodebaseAnalysis).toBe(true);
  });

  it("does not flag docs that only mention scoped file reads", () => {
    skill("skills/clean", "# Clean\n\nReads the files you name and nothing else.\n");
    write("README.md", "# Tool\n\nWorks on a single file at a time.\n");

    expect(skillShape(dir).fullCodebaseAnalysis).toBe(false);
  });
});
