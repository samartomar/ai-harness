import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { transformSync } from "esbuild";
import { expect, it } from "vitest";

it("imports package loaders without reading evidence and fails when a required companion is absent", async () => {
  const root = mkdtempSync(join(tmpdir(), "aih-lazy-evidence-"));
  try {
    const loaders = [
      [
        "src/org-policy/workbench/core/packaged-source-data-data.ts",
        "packagedWorkbenchSourceDataInputV1",
        [],
      ],
      [
        "src/org-policy/workbench/core/catalog-qualification-data.ts",
        "catalogQualificationPackageInputV1",
        {},
      ],
      [
        "src/org-policy/packaged-collection-evidence-data.ts",
        "packagedScannerCollectionEvidenceInputV1",
        [],
      ],
    ] as const;
    for (const [source, getter, fixture] of loaders) {
      const basename = source.split("/").at(-1)!;
      const output = join(root, basename.replace(/\.ts$/, ".mjs"));
      writeFileSync(
        output,
        transformSync(readFileSync(source, "utf8"), { loader: "ts", format: "esm" }).code,
      );
      const module = await import(pathToFileURL(output).href);
      expect(() => module[getter]()).toThrow(/Cannot find module/);
      writeFileSync(join(root, basename.replace(/\.ts$/, ".json")), JSON.stringify(fixture));
      expect(module[getter]()).toEqual(fixture);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
