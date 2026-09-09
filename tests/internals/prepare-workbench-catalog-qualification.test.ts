import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareOperationalCatalogQualificationV1 } from "../../src/internals/prepare-workbench-catalog-qualification.js";
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
