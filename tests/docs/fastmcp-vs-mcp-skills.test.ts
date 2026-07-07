import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

function read(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

describe("FastMCP vs official mcp skills-over-MCP design note", () => {
  it("captures the framework comparison and selected implementation direction", () => {
    const note = read("docs/research/fastmcp-vs-mcp-skills-over-mcp.md");

    expect(note).toContain("Python FastMCP 3.x");
    expect(note).toContain("Official Python `mcp` SDK");
    expect(note).toContain("SkillProvider");
    expect(note).toContain("SkillsDirectoryProvider");
    expect(note).toContain('supporting_files="template"');
    expect(note).toContain("fallback if dependency review rejects FastMCP");
  });

  it("records the SEP-2640 resource shape without treating it as governance", () => {
    const note = read("docs/research/fastmcp-vs-mcp-skills-over-mcp.md");
    const normalized = note.replace(/\s+/g, " ");

    expect(note).toContain("SEP-2640");
    expect(note).toContain("skill://index.json");
    expect(note).toContain("resources/read");
    expect(note).toContain("adds no new protocol methods or capabilities");
    expect(normalized).toContain(
      "draft does not standardize artifact signing, server package pinning, hot-reload policy, or an `aih` approval model",
    );
    expect(normalized).toContain(
      "framework choice is orthogonal to the skills-over-MCP governance gap",
    );
  });

  it("links the design note from the docs index and changelog", () => {
    expect(read("docs/README.md")).toContain("research/fastmcp-vs-mcp-skills-over-mcp.md");
    expect(read("CHANGELOG.md")).toContain("FastMCP 3.x vs official `mcp` SDK comparison");
  });
});
