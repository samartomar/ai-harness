import type { ExactLocalSource } from "./source.js";

export interface MethodologyEvidence {
  repository: string;
  resolvedCommit: string;
  treeSha256: string;
  paths: readonly string[];
  verdict: "pass" | "held" | "blocked";
}

function samePaths(left: readonly string[], right: readonly string[]): boolean {
  const normalizedLeft = [...left].sort((a, b) => a.localeCompare(b));
  const normalizedRight = [...right].sort((a, b) => a.localeCompare(b));
  return (
    normalizedLeft.length === normalizedRight.length &&
    normalizedLeft.every((path, index) => path === normalizedRight[index])
  );
}

export function joinExactEvidence(
  source: Pick<ExactLocalSource, "repository" | "resolvedCommit" | "treeSha256">,
  paths: readonly string[],
  evidence: readonly MethodologyEvidence[],
): MethodologyEvidence | undefined {
  return evidence.find(
    (candidate) =>
      candidate.repository === source.repository &&
      candidate.resolvedCommit === source.resolvedCommit &&
      candidate.treeSha256 === source.treeSha256 &&
      samePaths(candidate.paths, paths),
  );
}
