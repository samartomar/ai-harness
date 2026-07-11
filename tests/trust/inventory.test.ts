import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildTrustFileInventory } from "../../src/trust/inventory.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("TrustFileInventory", () => {
  it("stores only stable path metadata and reuses it for filtered views", () => {
    const root = mkdtempSync(join(tmpdir(), "aih-trust-inventory-"));
    roots.push(root);
    mkdirSync(join(root, "nested"), { recursive: true });
    mkdirSync(join(root, "node_modules", "ignored"), { recursive: true });
    writeFileSync(join(root, "AGENTS.md"), "# Agent\n", "utf8");
    writeFileSync(join(root, "nested", "package.json"), "{}\n", "utf8");
    writeFileSync(join(root, "node_modules", "ignored", "SKILL.md"), "ignored\n", "utf8");

    const inventory = buildTrustFileInventory(root);

    expect(inventory.files).toEqual([
      expect.objectContaining({ relativePath: "AGENTS.md", size: 8 }),
      expect.objectContaining({ relativePath: "nested/package.json", size: 3 }),
    ]);
    expect([...inventory.matching((entry) => entry.relativePath.endsWith(".json"))]).toEqual([
      inventory.files[1],
    ]);
    expect(JSON.stringify(inventory.files)).not.toContain("# Agent");
  });

  it("reports bounded inventory progress every 250 files", () => {
    const root = mkdtempSync(join(tmpdir(), "aih-trust-inventory-large-"));
    roots.push(root);
    for (let index = 0; index < 501; index++) {
      writeFileSync(join(root, `file-${String(index).padStart(3, "0")}.txt`), "x", "utf8");
    }
    const progress: number[] = [];

    const inventory = buildTrustFileInventory(root, {
      onProgress: (processed) => progress.push(processed),
    });

    expect(inventory.files).toHaveLength(501);
    expect(progress).toEqual([250, 500]);
  });
});
