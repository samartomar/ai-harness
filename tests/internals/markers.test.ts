import { describe, expect, it } from "vitest";
import { extractManagedBlock, mergeManagedBlock } from "../../src/internals/markers.js";

const block = {
  marker: "ai-canonical:shared",
  note: "generated; do not edit",
  body: "## Hello\n\nbody line.",
};

describe("mergeManagedBlock", () => {
  it("creates a fresh file as preamble + fenced block", () => {
    const out = mergeManagedBlock(undefined, block, "# Preamble\n\nhand text.");
    expect(out).toContain("# Preamble");
    expect(out).toContain("<!-- BEGIN ai-canonical:shared (generated; do not edit) -->");
    expect(out).toContain("## Hello");
    expect(out).toContain("<!-- END ai-canonical:shared -->");
    expect(out.endsWith("\n")).toBe(true);
  });

  it("replaces only the fenced region, preserving surrounding content", () => {
    const first = mergeManagedBlock(undefined, block, "# Keep me\n\npreserved.");
    const updated = mergeManagedBlock(
      first,
      { ...block, body: "## Hello\n\nNEW body." },
      "ignored on update",
    );
    expect(updated).toContain("# Keep me");
    expect(updated).toContain("preserved.");
    expect(updated).toContain("NEW body.");
    expect(updated).not.toContain("body line.");
    expect(updated).not.toContain("ignored on update"); // preamble ignored when file exists
  });

  it("appends the block when the file exists without markers", () => {
    const out = mergeManagedBlock("# Existing\n\nno markers here.\n", block, "unused");
    expect(out).toContain("# Existing");
    expect(out).toContain("no markers here.");
    expect(out).toContain("<!-- BEGIN ai-canonical:shared");
  });

  it("is idempotent — merging the same body twice is byte-identical", () => {
    const once = mergeManagedBlock(undefined, block, "# P");
    const twice = mergeManagedBlock(once, block, "# P");
    expect(twice).toBe(once);
  });

  it("preserves CRLF line endings", () => {
    const crlf = "# Head\r\n\r\nbody.\r\n";
    const out = mergeManagedBlock(crlf, block, "unused");
    expect(out).toContain("\r\n");
    expect(out).not.toMatch(/[^\r]\n/); // every \n is preceded by \r
  });
});

describe("extractManagedBlock", () => {
  it("returns the trimmed body, ignoring the note text", () => {
    const file = mergeManagedBlock(undefined, block, "# P");
    expect(extractManagedBlock(file, "ai-canonical:shared")).toBe("## Hello\n\nbody line.");
  });

  it("returns undefined when the markers are absent", () => {
    expect(extractManagedBlock("# Just a file\n", "ai-canonical:shared")).toBeUndefined();
  });

  it("round-trips with mergeManagedBlock regardless of the BEGIN note", () => {
    const a = mergeManagedBlock(undefined, block, "# P");
    const b = mergeManagedBlock(undefined, { ...block, note: "a different note" }, "# P");
    expect(extractManagedBlock(a, block.marker)).toBe(extractManagedBlock(b, block.marker));
  });
});
