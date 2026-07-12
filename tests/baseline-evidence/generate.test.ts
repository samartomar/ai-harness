import { describe, expect, it, vi } from "vitest";
import {
  baselineAnalyzerVersions,
  requiredBaselineAnalyzersForComponent,
  requiredBaselineDetectorsForComponent,
} from "../../src/baseline-evidence/analyzer-profile.js";
import type { BaselineCatalog } from "../../src/baseline-evidence/catalog.js";
import { baselineCatalogById } from "../../src/baseline-evidence/catalogs.js";
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
        preflight: async () => {},
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

  it("runs the analyzer preflight before vetting and aborts fail-closed when it fails", async () => {
    const order: string[] = [];
    const vetCatalog = vi.fn(async (_root: string, catalog: BaselineCatalog) => {
      order.push("vet");
      return evidence(catalog);
    });
    const preflight = vi.fn(async () => {
      order.push("preflight");
      throw new Error(
        "baseline vet preflight: required analyzer(s) not provisioned — cisco@uvx unavailable (uv cache miss)",
      );
    });

    await expect(
      generateBaselineArtifacts(
        { eccRoot: process.cwd(), superpowersRoot: process.cwd() },
        {
          run: fakeRunner(() => undefined),
          platform: "linux",
          env: {},
          vetCatalog,
          checkoutHead: (_root, catalog) => catalog.pinnedSha,
          generatePreview: () => ({ schemaVersion: 1, operations: [] }),
          preflight,
        },
      ),
    ).rejects.toThrow(/preflight: required analyzer\(s\) not provisioned.*cisco@uvx/is);

    expect(preflight).toHaveBeenCalledTimes(1);
    expect(vetCatalog).not.toHaveBeenCalled();
    expect(order).toEqual(["preflight"]);
  });

  it("threads a prior lock into both vetCatalog calls and reports the cross-catalog reuse tally (issue #444)", async () => {
    const progress = vi.fn();
    const vetCatalog = vi.fn(
      async (_root: string, catalog: BaselineCatalog, _options?: VetBaselineCatalogOptions) =>
        evidence(catalog),
    );
    // vetCatalog is mocked to ignore reuseFrom and always return the same canned
    // evidence for a given catalog, so seeding the prior lock with that exact
    // evidence for "ecc" only makes tallyReuse see ecc as fully reused and
    // superpowers (absent from the prior lock) as fully rescanned.
    const priorLock = {
      schemaVersion: 1 as const,
      sources: [evidence(baselineCatalogById("ecc"))],
    };

    await generateBaselineArtifacts(
      { eccRoot: process.cwd(), superpowersRoot: process.cwd() },
      {
        run: fakeRunner(() => undefined),
        platform: "linux",
        env: {},
        progress,
        vetCatalog,
        checkoutHead: (_root, catalog) => catalog.pinnedSha,
        generatePreview: () => ({ schemaVersion: 1, operations: [] }),
        preflight: async () => {},
        reuseFrom: priorLock,
      },
    );

    for (const call of vetCatalog.mock.calls) {
      expect(call[2]).toEqual(expect.objectContaining({ reuseFrom: priorLock, full: false }));
    }
    const eccTotal = baselineCatalogById("ecc").components.length;
    const spTotal = baselineCatalogById("superpowers").components.length;
    const lines = progress.mock.calls.map((call) => call[0] as string);
    expect(lines.at(-1)).toBe(
      `baseline reuse TOTAL: reused ${eccTotal}/${eccTotal + spTotal}, rescanned ${spTotal}/${eccTotal + spTotal}   (mode=incremental)`,
    );
  });

  it("passes full=true through to both vetCatalog calls and reports a 0-reused TOTAL line", async () => {
    const progress = vi.fn();
    const vetCatalog = vi.fn(
      async (_root: string, catalog: BaselineCatalog, _options?: VetBaselineCatalogOptions) =>
        evidence(catalog),
    );
    const priorLock = {
      schemaVersion: 1 as const,
      sources: [evidence(baselineCatalogById("ecc")), evidence(baselineCatalogById("superpowers"))],
    };

    await generateBaselineArtifacts(
      { eccRoot: process.cwd(), superpowersRoot: process.cwd() },
      {
        run: fakeRunner(() => undefined),
        platform: "linux",
        env: {},
        progress,
        vetCatalog,
        checkoutHead: (_root, catalog) => catalog.pinnedSha,
        generatePreview: () => ({ schemaVersion: 1, operations: [] }),
        preflight: async () => {},
        reuseFrom: priorLock,
        full: true,
      },
    );

    for (const call of vetCatalog.mock.calls) {
      expect(call[2]).toEqual(expect.objectContaining({ full: true }));
    }
    const total =
      baselineCatalogById("ecc").components.length +
      baselineCatalogById("superpowers").components.length;
    const lines = progress.mock.calls.map((call) => call[0] as string);
    expect(lines.at(-1)).toBe(
      `baseline reuse TOTAL: reused 0/${total}, rescanned ${total}/${total}   (mode=full)`,
    );
  });
});
