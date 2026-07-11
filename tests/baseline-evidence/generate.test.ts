import { describe, expect, it, vi } from "vitest";
import {
  baselineAnalyzerVersions,
  requiredBaselineAnalyzersForComponent,
  requiredBaselineDetectorsForComponent,
} from "../../src/baseline-evidence/analyzer-profile.js";
import type { BaselineCatalog } from "../../src/baseline-evidence/catalog.js";
import { generateBaselineArtifacts } from "../../src/baseline-evidence/generate.js";
import type { BaselineSourceEvidence } from "../../src/baseline-evidence/schema.js";
import type { VetBaselineCatalogOptions } from "../../src/baseline-evidence/vet.js";
import { fakeRunner } from "../../src/internals/proc.js";

function evidence(catalog: BaselineCatalog): BaselineSourceEvidence {
  return {
    id: catalog.id,
    owner: catalog.owner,
    repo: catalog.repo,
    pinnedSha: catalog.pinnedSha,
    components: catalog.components.map((component) => ({
      id: component.id,
      paths: [...component.paths],
      treeSha256: "a".repeat(64),
      verdict: "blocked",
      analyzers: [
        { name: "aih-native", version: "2.8.0" },
        { name: "cisco@uvx", version: "2.0.12" },
        { name: "skillspector@docker", version: "pinned-image" },
      ],
      findings: [{ code: "trust.test", detail: "fixture is intentionally blocked" }],
    })),
  };
}

describe("vendor baseline generator", () => {
  it("runs both exact source catalogs through the required analyzer runtime", async () => {
    const run = fakeRunner(() => undefined);
    const progress = vi.fn();
    const vetCatalog = vi.fn(
      async (_root: string, catalog: BaselineCatalog, _options?: VetBaselineCatalogOptions) =>
        evidence(catalog),
    );

    await generateBaselineArtifacts(
      { eccRoot: process.cwd(), superpowersRoot: process.cwd() },
      {
        run,
        platform: "linux",
        env: {},
        progress,
        vetCatalog,
        checkoutHead: (_root, catalog) => catalog.pinnedSha,
        generatePreview: () => ({ schemaVersion: 1, operations: [] }),
      },
    );

    expect(vetCatalog).toHaveBeenCalledTimes(2);
    for (const call of vetCatalog.mock.calls) {
      expect(call[2]).toEqual(
        expect.objectContaining({
          analyzerVersions: baselineAnalyzerVersions(),
          requiredAnalyzers: requiredBaselineAnalyzersForComponent,
          requiredDetectorsForComponent: requiredBaselineDetectorsForComponent,
          scanOptions: {
            env: {},
            platform: "linux",
            progress,
            run,
          },
        }),
      );
    }
  });
});
