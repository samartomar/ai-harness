import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { aihIgnoreWrite } from "../../src/internals/gitignore.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aih-gi-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("aihIgnoreWrite", () => {
  it("creates .gitignore with the aih patterns when none exists", () => {
    const w = aihIgnoreWrite(root);
    expect(w.path).toBe(".gitignore");
    expect(w.contents).toContain("*.aih.bak");
    expect(w.contents).toContain("*.aih.tmp");
  });

  it("appends the patterns while preserving existing content", () => {
    writeFileSync(join(root, ".gitignore"), "node_modules/\ndist/\n");
    const w = aihIgnoreWrite(root);
    expect(w.contents).toContain("node_modules/");
    expect(w.contents).toContain("dist/");
    expect(w.contents).toContain("*.aih.bak");
  });

  it("is a no-op when the patterns are already present (byte-identical)", () => {
    const original = "node_modules/\n*.aih.bak\n*.aih.tmp\n";
    writeFileSync(join(root, ".gitignore"), original);
    expect(aihIgnoreWrite(root).contents).toBe(original);
  });
});
