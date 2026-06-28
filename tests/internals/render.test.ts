import { describe, expect, it } from "vitest";
import {
  frontmatter,
  indent,
  jsonFile,
  lines,
  managedBlock,
  stripTrailingNewlines,
} from "../../src/internals/render.js";

describe("stripTrailingNewlines", () => {
  it("strips a run of trailing newlines", () => {
    expect(stripTrailingNewlines("a\n\n\n")).toBe("a");
  });

  it("leaves a string with no trailing newline unchanged", () => {
    expect(stripTrailingNewlines("a\nb")).toBe("a\nb");
  });

  it("preserves interior newlines, stripping only the trailing run", () => {
    expect(stripTrailingNewlines("a\n\nb\n\n")).toBe("a\n\nb");
  });

  it("collapses an all-newline string to empty", () => {
    expect(stripTrailingNewlines("\n\n\n")).toBe("");
    expect(stripTrailingNewlines("")).toBe("");
  });

  it("strips only \\n (U+000A), preserving a trailing \\r of a CRLF (matches the old /\\n+$/)", () => {
    // The old regex stripped only \n, so a final \r survives — keep that behavior.
    expect(stripTrailingNewlines("a\r\n")).toBe("a\r");
  });

  it("is linear on the polynomial-ReDoS input (many \\n then a non-\\n tail)", () => {
    // `/\n+$/` backtracks O(n²) here; the reverse scan stays O(n). No trailing-run
    // (the tail is non-\n) so the value is returned unchanged — and fast.
    const evil = `${"\n".repeat(100_000)}x`;
    expect(stripTrailingNewlines(evil)).toBe(evil);
  });
});

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
