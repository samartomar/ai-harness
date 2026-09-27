import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ calls: 0 }));
vi.mock("../../../src/baseline-evidence/hash.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../../src/baseline-evidence/hash.js")>();
  return {
    ...real,
    hashComponentTree: (...args: Parameters<typeof real.hashComponentTree>) => {
      const material = real.hashComponentTree(...args);
      if (++state.calls !== 2) return material;
      return {
        ...material,
        treeSha256: "f".repeat(64),
        files: material.files.map((file) => ({ ...file, sha256: "f".repeat(64) })),
      };
    },
  };
});

import { verifyScannerComponentContainmentV1 } from "../../../src/org-policy/workbench/core/source-data-containment.js";

it("refuses different file digests from two published owners in compiler-catalog mode", async () => {
  const root = mkdtempSync(join(tmpdir(), "aih-overlap-digest-"));
  try {
    writeFileSync(join(root, "one.md"), "original");
    const { hashComponentTree } = await vi.importActual<
      typeof import("../../../src/baseline-evidence/hash.js")
    >("../../../src/baseline-evidence/hash.js");
    const material = hashComponentTree(root, ["one.md"]);
    const file = material.files[0];
    if (!file) throw new Error("fixture");
    const published = [
      { id: "owner:a", paths: ["one.md"], treeSha256: material.treeSha256 },
      { id: "owner:b", paths: ["one.md"], treeSha256: "f".repeat(64) },
    ];
    const declared = [
      {
        componentId: "asset:one",
        paths: ["one.md"],
        files: [{ path: "one.md", digest: `sha256:${file.sha256}` }],
      },
    ];
    state.calls = 0;
    expect(() =>
      verifyScannerComponentContainmentV1(root, declared, published, "compiler-catalog"),
    ).toThrow("Scanner component containment rejected");
    expect(state.calls).toBe(2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
