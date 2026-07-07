import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

function read(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

describe("locked-skills MCP framework decision", () => {
  it("chooses Python FastMCP 3.x with the skills provider and no reload", () => {
    const note = read("docs/research/locked-skills-mcp-framework.md");

    expect(note).toContain("Python with FastMCP 3.x");
    expect(note).toContain("fastmcp==3.2.4");
    expect(note).toContain("SkillsDirectoryProvider");
    expect(note).toContain("reload=False");
    expect(note).toContain('supporting_files="template"');
    expect(note).toContain("stdio-only");
  });

  it("records the security-surface constraints and official SDK alternatives", () => {
    const note = read("docs/research/locked-skills-mcp-framework.md");

    expect(note).toContain("pin the exact FastMCP release");
    expect(note).toContain("load roots derived from `aih-skills.lock.json`");
    expect(note).toContain("do not expose tools");
    expect(note).toContain("Official Python MCP SDK");
    expect(note).toContain("Official TypeScript MCP SDK");
    expect(note.replace(/\s+/g, " ")).toContain("no native `SkillProvider`");
  });

  it("links the decision from the docs index", () => {
    expect(read("docs/README.md")).toContain("research/locked-skills-mcp-framework.md");
  });
});
