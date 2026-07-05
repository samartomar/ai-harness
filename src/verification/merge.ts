import type {
  Evidence,
  Severity,
  Verdict,
  VerificationCategory,
  VerificationResult,
  VerificationSummary,
} from "./types.js";

const VERDICT_RANK: Record<Verdict, number> = { fail: 0, warn: 1, pass: 2 };
const CATEGORY_RANK: Record<VerificationCategory, number> = {
  security: 0,
  exec: 1,
  policy: 2,
  dependency: 3,
  doc: 4,
  other: 5,
};
const SEVERITY_RANK: Record<Severity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  info: 4,
};
const SEVERITY_PENALTY: Record<Severity, number> = {
  critical: 30,
  high: 20,
  medium: 12,
  low: 6,
  info: 2,
};
const VERDICT_PENALTY: Record<Verdict, number> = { fail: 20, warn: 8, pass: 0 };

function hasKey<T extends string>(record: Record<T, number>, value: unknown): value is T {
  return typeof value === "string" && Object.hasOwn(record, value);
}

function assertKnownResult(result: VerificationResult, index: number): void {
  if (!hasKey(VERDICT_RANK, result.verdict)) {
    throw new Error(
      `mergeVerificationResults received invalid verdict at result ${index}: ${String(result.verdict)}`,
    );
  }
  if (!hasKey(SEVERITY_RANK, result.severity)) {
    throw new Error(
      `mergeVerificationResults received invalid severity at result ${index}: ${String(result.severity)}`,
    );
  }
  if (!hasKey(CATEGORY_RANK, result.category)) {
    throw new Error(
      `mergeVerificationResults received invalid category at result ${index}: ${String(result.category)}`,
    );
  }
}

interface ResultRank {
  verdict: number;
  category: number;
  severity: number;
  passName: string;
}

function resultRank(result: VerificationResult): ResultRank {
  return {
    verdict: VERDICT_RANK[result.verdict],
    category: CATEGORY_RANK[result.category],
    severity: SEVERITY_RANK[result.severity],
    passName: result.passName,
  };
}

export function compareVerificationResults(a: VerificationResult, b: VerificationResult): number {
  const left = resultRank(a);
  const right = resultRank(b);
  const verdictDelta = left.verdict - right.verdict;
  if (verdictDelta !== 0) return verdictDelta;
  const categoryDelta = left.category - right.category;
  if (categoryDelta !== 0) return categoryDelta;
  const severityDelta = left.severity - right.severity;
  if (severityDelta !== 0) return severityDelta;
  return left.passName < right.passName ? -1 : left.passName > right.passName ? 1 : 0;
}

function aggregateEvidence(results: readonly VerificationResult[]): Evidence[] {
  const byId = new Map<string, Evidence>();
  for (const result of results) {
    for (const evidence of result.evidence) {
      const key = JSON.stringify([result.passName, evidence.id]);
      if (!byId.has(key)) byId.set(key, evidence);
    }
  }
  return [...byId.values()];
}

function trustScoreFor(results: readonly VerificationResult[]): number {
  const penalty = results.reduce((total, result) => {
    if (result.verdict === "pass") return total;
    return total + VERDICT_PENALTY[result.verdict] + SEVERITY_PENALTY[result.severity];
  }, 0);
  return Math.max(0, 100 - penalty);
}

export function mergeVerificationResults(
  results: readonly VerificationResult[],
): VerificationSummary {
  if (results.length === 0)
    throw new Error("mergeVerificationResults requires at least one result");
  results.forEach(assertKnownResult);
  const ordered = [...results].sort(compareVerificationResults);
  const finalVerdict: Verdict = ordered.some((result) => result.verdict === "fail")
    ? "fail"
    : ordered.some((result) => result.verdict === "warn")
      ? "warn"
      : "pass";
  return {
    finalVerdict,
    trustScore: trustScoreFor(ordered),
    aggregatedEvidence: aggregateEvidence(ordered),
    failedPasses: ordered
      .filter((result) => result.verdict === "fail")
      .map((result) => result.passName),
    warnings: ordered
      .filter((result) => result.verdict === "warn")
      .map((result) => result.passName),
  };
}
