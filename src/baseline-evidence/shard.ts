import type { BaselineCatalog } from "./catalog.js";
import {
  type BaselineEvidenceLock,
  type BaselineSourceEvidence,
  parseBaselineEvidenceLock,
} from "./schema.js";

/**
 * Fan-out support for the baseline vet.
 *
 * A from-scratch vet is CPU-bound and scales with component count, so a single
 * host is the bottleneck rather than the work being irreducible. This module
 * lets the component set be split across hosts and the resulting receipts
 * merged back into one prior lock, which the ordinary incremental assembly run
 * then consumes.
 *
 * The split is safe because a receipt carries no host-specific state. It is
 * exactly `{id, paths, treeSha256, verdict, analyzers, findings}` — all derived
 * from scanned content — and `decideComponentReuse` re-hashes the live tree and
 * re-checks the required-analyzer identity set before splicing anything. A
 * shard therefore cannot contribute a receipt for content the assembly host
 * does not itself hash to the same value; a mismatched or stale receipt is
 * rescanned rather than trusted. What sharding distributes is the *cost* of
 * producing receipts, never the authority to assert one.
 */

export interface ShardSelector {
  /** 1-based shard number. */
  readonly index: number;
  /** Total number of shards. */
  readonly total: number;
}

const SHARD_PATTERN = /^([1-9]\d*)\/([1-9]\d*)$/;

/**
 * Parse an `i/n` shard selector. Strict on purpose: a silently misparsed shard
 * would drop components from the fan-out and the assembly run would quietly
 * rescan them, turning a correctness bug into a mere slowdown that nobody
 * notices. Both parts must be plain positive integers and `i` must not exceed
 * `n`.
 */
export function parseShardSelector(value: string): ShardSelector {
  const match = SHARD_PATTERN.exec(value.trim());
  const rawIndex = match?.[1];
  const rawTotal = match?.[2];
  if (rawIndex === undefined || rawTotal === undefined) {
    throw new Error(`invalid --shard ${JSON.stringify(value)}; expected <index>/<total>, e.g. 2/4`);
  }
  const index = Number.parseInt(rawIndex, 10);
  const total = Number.parseInt(rawTotal, 10);
  if (index > total) {
    throw new Error(
      `invalid --shard ${JSON.stringify(value)}; index ${index} exceeds total ${total}`,
    );
  }
  return { index, total };
}

/**
 * Select this shard's components from a catalog by round-robin on catalog
 * order. Round-robin rather than contiguous blocks because component scan cost
 * is wildly uneven and correlated with position — the catalog groups large
 * runtime components together — so contiguous blocks would leave one host doing
 * most of the work.
 *
 * Sharding is applied per catalog, so every shard receives at least one
 * component from each source as long as `total` does not exceed the smaller
 * catalog's size. That matters because the evidence schema requires each source
 * to carry at least one component.
 */
export function shardCatalog(catalog: BaselineCatalog, shard: ShardSelector): BaselineCatalog {
  const components = catalog.components.filter(
    (_component, position) => position % shard.total === shard.index - 1,
  );
  if (components.length === 0) {
    throw new Error(
      `shard ${shard.index}/${shard.total} selects no components from catalog ${catalog.id} ` +
        `(${catalog.components.length} components); use fewer shards`,
    );
  }
  return { ...catalog, components };
}

/** Largest shard count for which every catalog still yields a component. */
export function maxUsefulShards(catalogs: readonly BaselineCatalog[]): number {
  return Math.min(...catalogs.map((catalog) => catalog.components.length));
}

function mergeSourceEvidence(
  left: BaselineSourceEvidence,
  right: BaselineSourceEvidence,
): BaselineSourceEvidence {
  if (left.pinnedSha !== right.pinnedSha) {
    throw new Error(
      `receipt bundles disagree on the pin for source ${left.id}: ` +
        `${left.pinnedSha} vs ${right.pinnedSha}`,
    );
  }
  const byId = new Map(left.components.map((component) => [component.id, component]));
  for (const component of right.components) {
    const existing = byId.get(component.id);
    // A duplicate is only benign when the two shards agree byte-for-byte.
    // Disagreement means two hosts scanned the same content and reached
    // different verdicts, which is a real finding about determinism and must
    // never be resolved by picking one.
    if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(component)) {
      throw new Error(
        `receipt bundles disagree on component ${component.id} in source ${left.id}; ` +
          `two hosts produced different evidence for the same content`,
      );
    }
    byId.set(component.id, component);
  }
  return {
    ...left,
    components: [...byId.values()],
  };
}

/**
 * Merge shard receipt bundles into one prior lock for the assembly run.
 *
 * Order-independent: the assembly run looks receipts up by component id and
 * re-verifies each one, so the merged component order is irrelevant to the
 * artifact it produces.
 */
export function mergeReceiptBundles(
  bundles: readonly BaselineEvidenceLock[],
): BaselineEvidenceLock {
  if (bundles.length === 0) throw new Error("no receipt bundles to merge");
  const bySourceId = new Map<string, BaselineSourceEvidence>();
  for (const bundle of bundles) {
    for (const source of bundle.sources) {
      const existing = bySourceId.get(source.id);
      bySourceId.set(
        source.id,
        existing === undefined ? source : mergeSourceEvidence(existing, source),
      );
    }
  }
  return parseBaselineEvidenceLock({
    schemaVersion: 1,
    sources: [...bySourceId.values()],
  });
}

/** Per-source coverage of a merged bundle against the catalogs it must cover. */
export interface ShardCoverage {
  readonly sourceId: string;
  readonly expected: number;
  readonly covered: number;
  readonly missing: readonly string[];
}

/**
 * Report which catalog components no receipt bundle covers. Incomplete coverage
 * is not an error — the assembly run simply rescans what is missing — but it is
 * always worth saying out loud, because a silently-dropped shard would look
 * exactly like a slow assembly run.
 */
export function shardCoverage(
  catalogs: readonly BaselineCatalog[],
  merged: BaselineEvidenceLock,
): ShardCoverage[] {
  return catalogs.map((catalog) => {
    const source = merged.sources.find((candidate) => candidate.id === catalog.id);
    const covered = new Set(source?.components.map((component) => component.id) ?? []);
    const missing = catalog.components
      .map((component) => component.id)
      .filter((id) => !covered.has(id));
    return {
      sourceId: catalog.id,
      expected: catalog.components.length,
      covered: catalog.components.length - missing.length,
      missing,
    };
  });
}

export function formatShardCoverage(coverage: readonly ShardCoverage[]): string[] {
  return coverage.map((entry) => {
    const head = `shard coverage [${entry.sourceId}]: ${entry.covered}/${entry.expected}`;
    if (entry.missing.length === 0) return `${head} — complete`;
    return `${head} — ${entry.missing.length} to rescan: ${entry.missing.slice(0, 8).join(", ")}${
      entry.missing.length > 8 ? ", …" : ""
    }`;
  });
}
