import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  prepareOperationalCatalogQualificationV1,
  prepareWorkbenchCatalogQualificationCommandV1,
} from "../../src/internals/prepare-workbench-catalog-qualification.js";
import { defaultPreparedWorkbenchCatalog } from "../../src/org-policy/workbench/prepared-catalog.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("operational Catalog qualification preparation", () => {
  it("refuses an incomplete fixed artifact layout before any source or attestation path can qualify it", async () => {
    const artifactRoot = mkdtempSync(join(tmpdir(), "aih-catalog-qualification-"));
    roots.push(artifactRoot);
    await expect(
      prepareOperationalCatalogQualificationV1({
        bundle: defaultPreparedWorkbenchCatalog().bundle,
        sourceRoot: artifactRoot,
        providerId: "mattpocock",
        artifactRoot,
      }),
    ).rejects.toThrow(/bounded regular receipt\.json bytes/);
  });

  it("reads a complete Catalog member preimage while leaving full canonical verification to Core", async () => {
    const artifactRoot = mkdtempSync(join(tmpdir(), "aih-catalog-qualification-"));
    roots.push(artifactRoot);
    writeFileSync(join(artifactRoot, "receipt.json"), "{}");
    // A full successor exceeds the former 32 KiB preparation-only limit.
    // It must reach canonical verification rather than fail a stale byte cap.
    writeFileSync(
      join(artifactRoot, "receipt-set.json"),
      JSON.stringify({ data: "x".repeat(40_000) }),
    );
    writeFileSync(
      join(artifactRoot, "member.json"),
      JSON.stringify({
        capabilities: {},
        closure: { identity: "artifact:closures/review.json", sha256: "0".repeat(64) },
        entryId: "recipe.review",
        platforms: [],
        prose: {},
        qualification: {},
        recipe: {},
        subject: {},
        versions: {},
      }),
    );
    writeFileSync(join(artifactRoot, "closure.json"), "{}");
    await expect(
      prepareOperationalCatalogQualificationV1({
        bundle: defaultPreparedWorkbenchCatalog().bundle,
        sourceRoot: artifactRoot,
        providerId: "mattpocock",
        artifactRoot,
      }),
    ).rejects.toThrow(/LICENSE/);
  });
});

describe("prepare-workbench-catalog-qualification command", () => {
  const args = (root: string) => [
    "--source",
    root,
    "--provider",
    "mattpocock",
    "--artifacts",
    root,
    "--output",
    join(root, "draft.json"),
  ];

  it.each([
    [[]],
    [["--source", "a", "--provider", "p", "--artifacts", "b"]],
    [["--provider", "p", "--source", "a", "--artifacts", "b", "--output", "c"]],
    [["--source", "--provider", "p", "--artifacts", "b", "--output", "c", "x"]],
    [["--source", "a", "--provider", "p", "--artifacts", "b", "--output", "--x"]],
  ])("rejects anything but the four fixed flags in order: %j", async (argv) => {
    await expect(prepareWorkbenchCatalogQualificationCommandV1(argv)).rejects.toThrow(
      /^Usage: prepare-workbench-catalog-qualification/,
    );
  });

  it("refuses an existing output before reading any artifact", async () => {
    const root = mkdtempSync(join(tmpdir(), "aih-catalog-qualification-"));
    roots.push(root);
    writeFileSync(join(root, "draft.json"), "keep");
    await expect(prepareWorkbenchCatalogQualificationCommandV1(args(root))).rejects.toThrow(
      /EEXIST/,
    );
    expect(readFileSync(join(root, "draft.json"), "utf8")).toBe("keep");
  });

  it("writes nothing when the artifact layout is incomplete", async () => {
    const root = mkdtempSync(join(tmpdir(), "aih-catalog-qualification-"));
    roots.push(root);
    await expect(prepareWorkbenchCatalogQualificationCommandV1(args(root))).rejects.toThrow(
      /bounded regular receipt\.json bytes/,
    );
    expect(existsSync(join(root, "draft.json"))).toBe(false);
  });
});
