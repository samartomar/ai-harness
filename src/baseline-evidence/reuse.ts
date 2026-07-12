import type { BaselineCatalogComponent } from "./catalog.js";
import type {
  BaselineComponentEvidence,
  BaselineEvidenceLock,
  BaselineSourceEvidence,
} from "./schema.js";

/**
 * Closed reason enum surfaced in the reuse summary (Decision 5). `full` covers
 * every component whenever `--full` disables reuse outright; the others record
 * why one component's prior receipt either was or was not carried forward.
 */
export type BaselineReuseReason =
  | "unchanged"
  | "content-changed"
  | "new-component"
  | "full"
  | `analyzer-identity-changed:${string}`;

export interface BaselineComponentReuseDecision {
  readonly reuse: boolean;
  readonly reason: BaselineReuseReason;
  readonly priorEntry?: BaselineComponentEvidence;
}

export interface ReuseTally {
  readonly total: number;
  readonly reused: number;
  readonly rescanned: number;
}

export interface ComponentReuseRecord {
  readonly componentId: string;
  readonly decision: BaselineComponentReuseDecision;
  readonly currentTreeSha256: string;
  readonly priorTreeSha256?: string;
  readonly analyzerNames: readonly string[];
}

/**
 * Find the prior evidence for one catalog source, matched by (id, owner, repo) —
 * deliberately NOT `pinnedSha` (Decision 4). `generate.ts` always vets a source at
 * its catalog's pinned SHA, so a real content change can only arrive via a pin
 * rebind; keying reuse on the pin would make every rebind reuse nothing and fail
 * acceptance bullet 2.
 */
export function findPriorSource(
  priorLock: Pick<BaselineEvidenceLock, "sources"> | undefined,
  catalog: { id: string; owner: string; repo: string },
): BaselineSourceEvidence | undefined {
  return priorLock?.sources.find(
    (source) =>
      source.id === catalog.id && source.owner === catalog.owner && source.repo === catalog.repo,
  );
}

function samePaths(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** First required-analyzer name whose expected identity does not exactly match the
 * prior receipt (checked both ways: a newly required analyzer with no prior
 * receipt, and a prior receipt for an analyzer that is no longer required, both
 * count as a mismatch on that name). Sorted so the result is deterministic. */
function firstAnalyzerIdentityMismatch(
  requiredAnalyzers: readonly string[],
  analyzerVersions: Readonly<Record<string, string>>,
  priorAnalyzers: readonly { name: string; version: string }[],
): string | undefined {
  const expected = new Map(requiredAnalyzers.map((name) => [name, analyzerVersions[name] ?? ""]));
  const actual = new Map(priorAnalyzers.map((receipt) => [receipt.name, receipt.version]));
  const names = [...new Set([...expected.keys(), ...actual.keys()])].sort((left, right) =>
    left.localeCompare(right),
  );
  for (const name of names) {
    if (expected.get(name) !== actual.get(name)) return name;
  }
  return undefined;
}

/**
 * Decide whether one component's prior receipt may be reused verbatim. Pure: the
 * caller supplies the component's CURRENT tree hash (already computed once by
 * `vetBaselineCatalog` for the rescan path) instead of this function touching the
 * filesystem itself, so content is never hashed twice and the decision stays
 * trivially unit-testable. Reuse iff: same id AND same ordered `paths` AND same
 * `treeSha256` AND the exact same required-analyzer name/version set (Decision 4).
 */
export function decideComponentReuse(input: {
  priorSource: BaselineSourceEvidence | undefined;
  component: Pick<BaselineCatalogComponent, "id" | "paths">;
  currentTreeSha256: string;
  requiredAnalyzers: readonly string[];
  analyzerVersions: Readonly<Record<string, string>>;
  full: boolean;
}): BaselineComponentReuseDecision {
  if (input.full) return { reuse: false, reason: "full" };
  const priorEntry = input.priorSource?.components.find(
    (candidate) => candidate.id === input.component.id,
  );
  if (priorEntry === undefined) return { reuse: false, reason: "new-component" };
  if (
    !samePaths(priorEntry.paths, input.component.paths) ||
    priorEntry.treeSha256 !== input.currentTreeSha256
  ) {
    return { reuse: false, reason: "content-changed", priorEntry };
  }
  const mismatch = firstAnalyzerIdentityMismatch(
    input.requiredAnalyzers,
    input.analyzerVersions,
    priorEntry.analyzers,
  );
  if (mismatch !== undefined) {
    return { reuse: false, reason: `analyzer-identity-changed:${mismatch}`, priorEntry };
  }
  return { reuse: true, reason: "unchanged", priorEntry };
}

/**
 * Reconstruct a reused receipt in canonical schema field order so a fully-reused
 * lock serializes byte-identical to the prior one — `generate.ts`'s `--check`
 * byte-diff and the migration verdict-stability gate both depend on this. Never
 * fabricates: every field is copied verbatim from `prior`.
 */
export function spliceReusedComponent(prior: BaselineComponentEvidence): BaselineComponentEvidence {
  return {
    id: prior.id,
    paths: [...prior.paths],
    treeSha256: prior.treeSha256,
    verdict: prior.verdict,
    analyzers: prior.analyzers.map((receipt) => ({ name: receipt.name, version: receipt.version })),
    findings: prior.findings.map((finding) => ({
      code: finding.code,
      ...(finding.count !== undefined ? { count: finding.count } : {}),
      detail: finding.detail,
      ...(finding.fingerprint !== undefined ? { fingerprint: finding.fingerprint } : {}),
    })),
  };
}

/**
 * Post-hoc reuse tally for a whole source, derived from the FINAL evidence rather
 * than from live per-component decisions — this is what lets `generate.ts` report
 * a cross-catalog TOTAL line without `vetBaselineCatalog` widening its return type.
 * Sound because reuse always splices the prior entry verbatim: whenever a rescan
 * happens (content or analyzer identity changed), the fresh receipt provably
 * differs from the prior one in the very field that changed, so byte-equality to
 * the prior entry is exactly equivalent to "this component was reused."
 */
export function tallyReuse(
  priorSource: BaselineSourceEvidence | undefined,
  evidence: BaselineSourceEvidence,
  full: boolean,
): ReuseTally {
  const total = evidence.components.length;
  if (full || priorSource === undefined) return { total, reused: 0, rescanned: total };
  const priorById = new Map(priorSource.components.map((component) => [component.id, component]));
  const reused = evidence.components.filter((component) => {
    const prior = priorById.get(component.id);
    return (
      prior !== undefined &&
      JSON.stringify(spliceReusedComponent(prior)) ===
        JSON.stringify(spliceReusedComponent(component))
    );
  }).length;
  return { total, reused, rescanned: total - reused };
}

function shortHash(hash: string): string {
  return hash.slice(0, 12);
}

function reuseLineDetail(record: ComponentReuseRecord): string {
  const { decision } = record;
  if (decision.reason === "unchanged") {
    return `(treeSha256 ${shortHash(record.currentTreeSha256)}…, analyzers ${record.analyzerNames.join("+")})`;
  }
  if (decision.reason === "content-changed") {
    return `(treeSha256 ${shortHash(record.priorTreeSha256 ?? "")}… → ${shortHash(record.currentTreeSha256)}…)`;
  }
  if (decision.reason === "new-component") return "(no prior receipt)";
  if (decision.reason === "full") return "";
  return `(treeSha256 unchanged ${shortHash(record.currentTreeSha256)}…)`;
}

/** Catalog-scoped reuse summary block (Decision 5): one header line plus one
 * deterministically-ordered line per component, meant to be emitted through the
 * existing `progress` hook so every reuse decision is visible in CI logs. */
export function formatCatalogReuseSummary(
  catalog: { id: string; pinnedSha: string },
  records: readonly ComponentReuseRecord[],
): string[] {
  const total = records.length;
  const reused = records.filter((record) => record.decision.reuse).length;
  const rescanned = total - reused;
  const header = `baseline reuse [${catalog.id} @ ${shortHash(catalog.pinnedSha)}]: reused ${reused}/${total}, rescanned ${rescanned}/${total}`;
  const lines = records.map((record) => {
    const label = record.decision.reuse ? "reused" : "rescan";
    const detail = reuseLineDetail(record);
    const reasonPart = `reason=${record.decision.reason}`;
    return `  ${label.padEnd(7)} ${record.componentId}    ${detail ? `${reasonPart} ${detail}` : reasonPart}`;
  });
  return [header, ...lines];
}

/** Cross-catalog TOTAL line (Decision 5), summed from each source's `tallyReuse`. */
export function formatTotalReuseSummary(tallies: readonly ReuseTally[], full: boolean): string {
  const total = tallies.reduce((sum, tally) => sum + tally.total, 0);
  const reused = tallies.reduce((sum, tally) => sum + tally.reused, 0);
  const rescanned = total - reused;
  return `baseline reuse TOTAL: reused ${reused}/${total}, rescanned ${rescanned}/${total}   (mode=${full ? "full" : "incremental"})`;
}
