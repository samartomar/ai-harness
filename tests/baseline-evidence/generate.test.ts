import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  baselineAnalyzerVersions,
  requiredBaselineAnalyzersForComponent,
  requiredBaselineDetectorsForComponent,
} from "../../src/baseline-evidence/analyzer-profile.js";
import type { BaselineCatalog } from "../../src/baseline-evidence/catalog.js";
import { baselineCatalogById } from "../../src/baseline-evidence/catalogs.js";
import { buildEccPreflightReceipt } from "../../src/baseline-evidence/ecc-preflight-receipt.js";
import {
  generateBaselineArtifacts,
  generateShardReceipts,
  parseGenerateOptions,
} from "../../src/baseline-evidence/generate.js";
import { hashSourceTree } from "../../src/baseline-evidence/hash.js";
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
        { name: "cisco@uvx", version: "2.0.13" },
        { name: "skillspector@docker", version: "pinned-image" },
      ],
      findings: [{ code: "trust.test", detail: "fixture is intentionally blocked" }],
    })),
  };
}

describe("baseline generator CLI mode parser", () => {
  const ordinary = ["--ecc-root", "ecc", "--superpowers-root", "superpowers"];

  it("keeps ordinary non-sharded generation compatible without a receipt", () => {
    const options = parseGenerateOptions(ordinary);

    expect(options).toMatchObject({
      preflightOnly: false,
      reuseFromPaths: [],
    });
    expect(options.shard).toBeUndefined();
    expect(options.preflightReceiptPath).toBeUndefined();
    expect(options.preflightReceiptOut).toBeUndefined();
  });

  it("requires a receipt output for static preflight and rejects incompatible modes", () => {
    expect(() => parseGenerateOptions(["--ecc-root", "ecc", "--preflight-only"])).toThrow(
      /--preflight-only requires --preflight-receipt-out/,
    );

    for (const args of [
      ["--superpowers-root", "superpowers"],
      ["--shard", "1/2"],
      ["--reuse-from", "shard.json"],
      ["--check"],
      ["--full"],
      ["--out", "lock.json"],
      ["--preview-out", "preview.json"],
      ["--receipts-out", "receipts.json"],
      ["--preflight-receipt", "receipt.json"],
    ]) {
      expect(() =>
        parseGenerateOptions([
          "--ecc-root",
          "ecc",
          "--preflight-only",
          "--preflight-receipt-out",
          "preflight.json",
          ...args,
        ]),
      ).toThrow(/--preflight-only cannot be combined with/);
    }

    expect(() =>
      parseGenerateOptions([...ordinary, "--preflight-receipt-out", "preflight.json"]),
    ).toThrow(/--preflight-receipt-out requires --preflight-only/);
  });

  it("requires and accepts the ECC preflight receipt at shard and fan-in boundaries", () => {
    expect(() =>
      parseGenerateOptions([...ordinary, "--shard", "1/2", "--receipts-out", "shard.json"]),
    ).toThrow(/--shard requires --preflight-receipt/);
    expect(() => parseGenerateOptions([...ordinary, "--reuse-from", "shard.json"])).toThrow(
      /--reuse-from requires --preflight-receipt/,
    );

    expect(() =>
      parseGenerateOptions([
        ...ordinary,
        "--shard",
        "1/2",
        "--receipts-out",
        "shard.json",
        "--preflight-receipt",
        "preflight.json",
      ]),
    ).not.toThrow();
    expect(() =>
      parseGenerateOptions([
        ...ordinary,
        "--reuse-from",
        "shard-1.json,shard-2.json",
        "--preflight-receipt",
        "preflight.json",
      ]),
    ).not.toThrow();
  });

  it("rejects an ignored receipt and a shard/reuse mode conflict", () => {
    expect(() =>
      parseGenerateOptions([...ordinary, "--preflight-receipt", "preflight.json"]),
    ).toThrow(/--preflight-receipt requires --shard or --reuse-from/);
    expect(() =>
      parseGenerateOptions([
        ...ordinary,
        "--shard",
        "1/2",
        "--receipts-out",
        "shard.json",
        "--reuse-from",
        "other.json",
        "--preflight-receipt",
        "preflight.json",
      ]),
    ).toThrow(/--shard cannot be combined with --reuse-from/);
  });

  it("rejects missing values at the CLI boundary instead of consuming another flag", () => {
    for (const [flag, args] of [
      ["--ecc-root", ["--ecc-root", "--check", "--superpowers-root", "superpowers"]],
      ["--superpowers-root", ["--ecc-root", "ecc", "--superpowers-root", "--check"]],
      ["--preflight-receipt-out", [...ordinary, "--preflight-receipt-out", "--check"]],
      ["--preflight-receipt", [...ordinary, "--preflight-receipt", "--check"]],
      ["--reuse-from", [...ordinary, "--reuse-from", "--check"]],
    ] as const) {
      expect(() => parseGenerateOptions(args)).toThrow(`${flag} requires a value`);
    }
  });
});

describe("vendor baseline generator", () => {
  it("joins sharded ECC evidence to the full-source preflight digest", async () => {
    const eccRoot = mkdtempSync(join(tmpdir(), "aih-generate-shard-"));
    mkdirSync(join(eccRoot, "scripts/lib/install-targets"), { recursive: true });
    writeFileSync(join(eccRoot, "package.json"), '{"name":"ecc-shard-fixture"}\n');
    writeFileSync(join(eccRoot, "scripts/lib/install-executor.js"), "module.exports = {};\n");
    writeFileSync(join(eccRoot, "scripts/lib/install-manifests.js"), "module.exports = {};\n");
    writeFileSync(
      join(eccRoot, "scripts/lib/install-targets/registry.js"),
      "module.exports = {};\n",
    );

    try {
      const ecc = baselineCatalogById("ecc");
      const preflightReceipt = buildEccPreflightReceipt({ eccRoot, catalog: ecc });
      const vetCatalog = vi.fn(
        async (_root: string, catalog: BaselineCatalog): Promise<BaselineSourceEvidence> => {
          const result = evidence(catalog);
          if (catalog.id === "ecc") {
            result.sourceTreeSha256 = hashSourceTree(_root).treeSha256;
          }
          return result;
        },
      );

      const output = await generateShardReceipts(
        {
          eccRoot,
          superpowersRoot: eccRoot,
          shard: { index: 1, total: 2 },
          preflightReceipt,
        },
        {
          platform: "linux",
          env: {},
          checkoutHead: (_root, catalog) => catalog.pinnedSha,
          preflight: async () => {},
          vetCatalog,
        },
      );
      const bundle = JSON.parse(output) as { sources: BaselineSourceEvidence[] };

      expect(vetCatalog).toHaveBeenCalledTimes(2);
      expect(bundle.sources).toHaveLength(2);
      expect(bundle.sources.find((source) => source.id === "ecc")?.sourceTreeSha256).toBe(
        preflightReceipt.source.sourceTreeSha256,
      );
    } finally {
      rmSync(eccRoot, { recursive: true, force: true });
    }
  });

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
    const generatePreview = vi.fn(() => ({ schemaVersion: 1, operations: [] }));
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
          generatePreview,
          preflight,
        },
      ),
    ).rejects.toThrow(/preflight: required analyzer\(s\) not provisioned.*cisco@uvx/is);

    expect(preflight).toHaveBeenCalledTimes(1);
    expect(vetCatalog).not.toHaveBeenCalled();
    expect(generatePreview).not.toHaveBeenCalled();
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
