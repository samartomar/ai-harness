import { describe, expect, it } from "vitest";
import { frontmatter, indent, jsonFile, lines, managedBlock } from "../../src/internals/render.js";

describe("render helpers", () => {
  it("lines joins parts and ensures a single trailing newline", () => {
    expect(lines("a", ["b", "c"])).toBe("a\nb\nc\n");
    expect(lines("x\n\n")).toBe("x\n");
  });

  it("indent pads non-empty lines only", () => {
    expect(indent("a\n\nb", 2)).toBe("  a\n\n  b");
  });

  it("frontmatter renders arrays and booleans", () => {
    expect(frontmatter({ description: "x", globs: ["**/*"], alwaysApply: true })).toBe(
      '---\ndescription: x\nglobs: ["**/*"]\nalwaysApply: true\n---',
    );
  });

  it("jsonFile is 2-space with a trailing newline", () => {
    expect(jsonFile({ a: 1 })).toBe('{\n  "a": 1\n}\n');
  });

  it("managedBlock wraps body in begin/end markers", () => {
    expect(managedBlock("certs", "X")).toBe(
      "# >>> aih managed (certs) >>>\nX\n# <<< aih managed (certs) <<<",
    );
  });
});
