import { describe, expect, it } from "vitest";
import type { BaselineCatalog } from "../../src/baseline-evidence/catalog.js";
import type { BaselineEvidenceLock } from "../../src/baseline-evidence/schema.js";
import {
  formatShardCoverage,
  maxUsefulShards,
  mergeReceiptBundles,
  parseShardSelector,
  shardCatalog,
  shardCoverage,
} from "../../src/baseline-evidence/shard.js";

const PIN = "a".repeat(40);
const TREE = "b".repeat(64);

function catalog(id: string, count: number): BaselineCatalog {
  return {
    id,
    owner: "owner",
    repo: "repo",
    pinnedSha: PIN,
    components: Array.from({ length: count }, (_unused, index) => ({
      id: `${id}:c${index}`,
      paths: [`p${index}`],
    })),
  };
}

function bundle(
  sourceId: string,
  componentIds: readonly string[],
  tree = TREE,
): BaselineEvidenceLock {
  return {
    schemaVersion: 1,
    sources: [
      {
        id: sourceId,
        // Distinct owner/repo per source id: the lock schema rejects two
        // sources sharing an owner/repo@pin origin, as ecc and superpowers do.
        owner: `${sourceId}-owner`,
        repo: `${sourceId}-repo`,
        pinnedSha: PIN,
        components: componentIds.map((id) => ({
          id,
          paths: ["p"],
          treeSha256: tree,
          verdict: "pass" as const,
          analyzers: [{ name: "aih-native", version: "1" }],
          findings: [],
        })),
      },
    ],
  };
}

describe("parseShardSelector", () => {
  it("parses a plain index/total pair and tolerates surrounding whitespace", () => {
    expect(parseShardSelector("2/4")).toEqual({ index: 2, total: 4 });
    expect(parseShardSelector("  1/1  ")).toEqual({ index: 1, total: 1 });
  });

  it("rejects malformed selectors rather than silently reinterpreting them", () => {
    // Number.parseInt would happily turn each of these into a usable number,
    // which would drop components from the fan-out without any error.
    for (const bad of ["0/4", "2/0", "2.5/4", "2/4x", "-1/4", "2", "", "1e1/4", "5/4"]) {
      expect(() => parseShardSelector(bad), bad).toThrow(/invalid --shard/);
    }
  });
});

describe("shardCatalog", () => {
  it("partitions every component exactly once across the shard set", () => {
    const source = catalog("ecc", 10);
    const seen = [1, 2, 3, 4].flatMap((index) =>
      shardCatalog(source, { index, total: 4 }).components.map((component) => component.id),
    );
    expect(seen.slice().sort()).toEqual(
      source.components
        .map((c) => c.id)
        .slice()
        .sort(),
    );
    expect(new Set(seen).size).toBe(10);
  });

  it("interleaves rather than blocking, so uneven scan cost spreads across hosts", () => {
    const ids = shardCatalog(catalog("ecc", 8), { index: 1, total: 4 }).components.map((c) => c.id);
    expect(ids).toEqual(["ecc:c0", "ecc:c4"]);
  });

  it("preserves catalog identity and relative component order", () => {
    const shard = shardCatalog(catalog("ecc", 6), { index: 2, total: 3 });
    expect(shard.id).toBe("ecc");
    expect(shard.pinnedSha).toBe(PIN);
    expect(shard.components.map((c) => c.id)).toEqual(["ecc:c1", "ecc:c4"]);
  });

  it("refuses a shard count that would leave a shard with nothing to do", () => {
    expect(() => shardCatalog(catalog("sp", 2), { index: 3, total: 3 })).toThrow(
      /selects no components/,
    );
  });
});

describe("maxUsefulShards", () => {
  it("is bounded by the smallest catalog, since each source needs a component", () => {
    expect(maxUsefulShards([catalog("ecc", 136), catalog("superpowers", 15)])).toBe(15);
  });
});

describe("mergeReceiptBundles", () => {
  it("unions components across bundles for the same source", () => {
    const merged = mergeReceiptBundles([bundle("ecc", ["a", "b"]), bundle("ecc", ["c"])]);
    expect(merged.sources).toHaveLength(1);
    expect(merged.sources[0]?.components.map((c) => c.id).sort()).toEqual(["a", "b", "c"]);
  });

  it("keeps distinct sources separate", () => {
    const merged = mergeReceiptBundles([bundle("ecc", ["a"]), bundle("superpowers", ["s"])]);
    expect(merged.sources.map((s) => s.id).sort()).toEqual(["ecc", "superpowers"]);
  });

  it("accepts a byte-identical duplicate of the same component", () => {
    const merged = mergeReceiptBundles([bundle("ecc", ["a"]), bundle("ecc", ["a"])]);
    expect(merged.sources[0]?.components).toHaveLength(1);
  });

  it("refuses to pick a winner when two hosts disagree about the same component", () => {
    expect(() =>
      mergeReceiptBundles([
        bundle("ecc", ["a"], "c".repeat(64)),
        bundle("ecc", ["a"], "d".repeat(64)),
      ]),
    ).toThrow(/different evidence for the same content/);
  });

  it("refuses bundles that disagree about the source pin", () => {
    const other = bundle("ecc", ["b"]);
    const shifted = {
      ...other,
      sources: other.sources.map((source) => ({ ...source, pinnedSha: "f".repeat(40) })),
    };
    expect(() => mergeReceiptBundles([bundle("ecc", ["a"]), shifted])).toThrow(
      /disagree on the pin/,
    );
  });

  it("rejects an empty merge rather than producing an empty lock", () => {
    expect(() => mergeReceiptBundles([])).toThrow(/no receipt bundles/);
  });
});

describe("shardCoverage", () => {
  it("reports complete coverage when every catalog component has a receipt", () => {
    const ecc = catalog("ecc", 3);
    const merged = mergeReceiptBundles([
      bundle(
        "ecc",
        ecc.components.map((c) => c.id),
      ),
    ]);
    const coverage = shardCoverage([ecc], merged);
    expect(coverage[0]).toMatchObject({ sourceId: "ecc", expected: 3, covered: 3, missing: [] });
    expect(formatShardCoverage(coverage)[0]).toContain("complete");
  });

  it("names what the assembly run will have to rescan", () => {
    const ecc = catalog("ecc", 3);
    const coverage = shardCoverage([ecc], mergeReceiptBundles([bundle("ecc", ["ecc:c0"])]));
    expect(coverage[0]?.covered).toBe(1);
    expect(coverage[0]?.missing).toEqual(["ecc:c1", "ecc:c2"]);
    expect(formatShardCoverage(coverage)[0]).toContain("2 to rescan");
  });

  it("treats a source with no bundle at all as fully uncovered", () => {
    const sp = catalog("superpowers", 2);
    const coverage = shardCoverage([sp], mergeReceiptBundles([bundle("ecc", ["ecc:c0"])]));
    expect(coverage[0]).toMatchObject({ sourceId: "superpowers", covered: 0 });
  });
});
