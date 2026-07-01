import { describe, expect, it } from "vitest";
import {
  beginLine,
  endLine,
  extractManagedBlock,
  mergeManagedBlock,
  PROJECT_EXTENSION_MARKER,
  splitManagedBody,
  stripManagedBlock,
} from "../../src/internals/markers.js";

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

describe("splitManagedBody — carve the human project extension", () => {
  const canonical =
    "## Start here\n\nRead the router.\n\n## Working agreement\n\n- Think before coding.";

  it("returns '' when the on-disk body is already canonical (already-adopted)", () => {
    expect(splitManagedBody(canonical, canonical)).toBe("");
  });

  it("diff-infers a folded-in extension (eicp shape)", () => {
    const onDisk = `${canonical}\n\n## EICP project extension\n\n- Honor the gateway enforcement contract.\n- Never bypass the control plane.`;
    const ext = splitManagedBody(onDisk, canonical);
    expect(ext).toContain("## EICP project extension");
    expect(ext).toContain("- Honor the gateway enforcement contract.");
    expect(ext).toContain("- Never bypass the control plane.");
    // Canonical lines must NOT leak into the extension.
    expect(ext).not.toContain("Think before coding");
    expect(ext).not.toContain("Start here");
  });

  it("a pure reordering of canonical lines yields no false extension", () => {
    const reordered =
      "## Working agreement\n\n- Think before coding.\n\n## Start here\n\nRead the router.";
    expect(splitManagedBody(reordered, canonical)).toBe("");
  });

  it("prefers an explicit project-extension sub-marker (precise, verbatim)", () => {
    const fenced = `${beginLine(PROJECT_EXTENSION_MARKER, "owned by the team")}\n\n## Custom\n\n- exact line.\n\n${endLine(PROJECT_EXTENSION_MARKER)}`;
    const onDisk = `${canonical}\n\n${fenced}`;
    const ext = splitManagedBody(onDisk, canonical);
    expect(ext).toBe("## Custom\n\n- exact line.");
  });

  it("sub-marker wins even when its content overlaps canonical wording", () => {
    // With the sub-marker present, we take it verbatim and do NOT diff.
    const fenced = `${beginLine(PROJECT_EXTENSION_MARKER, "x")}\nThink before coding.\n${endLine(PROJECT_EXTENSION_MARKER)}`;
    expect(splitManagedBody(`${canonical}\n\n${fenced}`, canonical)).toBe("Think before coding.");
  });
});

describe("stripManagedBlock", () => {
  it("removes the fenced block and leaves the preamble (the prune subtract)", () => {
    const file = mergeManagedBlock(undefined, block, "# Preamble\n\nhand text.");
    const out = stripManagedBlock(file, block.marker);
    expect(out).toBe("# Preamble\n\nhand text.\n");
    expect(extractManagedBlock(out, block.marker)).toBeUndefined();
  });

  it("preserves user content BOTH before and after the block, no double-blank gap", () => {
    const file =
      "# Before\n\nkeep A.\n\n" +
      `${beginLine(block.marker, "n")}\nx\n${endLine(block.marker)}` +
      "\n\nkeep B.\n";
    const out = stripManagedBlock(file, block.marker);
    expect(out).toBe("# Before\n\nkeep A.\n\nkeep B.\n");
    expect(out).not.toContain("\n\n\n");
  });

  it("is a no-op when the marker is absent (returns the input unchanged)", () => {
    const text = "# Just my notes\n\nnothing managed here.\n";
    expect(stripManagedBlock(text, block.marker)).toBe(text);
  });

  it("returns empty string when the block was the file's entire content", () => {
    const only = `${beginLine(block.marker, "n")}\nbody\n${endLine(block.marker)}\n`;
    expect(stripManagedBlock(only, block.marker)).toBe("");
  });

  it("preserves CRLF line endings", () => {
    const file = mergeManagedBlock(undefined, block, "# P\n\nx.").replace(/\n/g, "\r\n");
    const out = stripManagedBlock(file, block.marker);
    expect(out).toBe("# P\r\n\r\nx.\r\n");
  });

  it("round-trips: merge then strip leaves just the preamble", () => {
    const preamble = "# Repo — Claude Code";
    const merged = mergeManagedBlock(undefined, block, preamble);
    expect(stripManagedBlock(merged, block.marker)).toBe(`${preamble}\n`);
  });
});
