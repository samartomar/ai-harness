import {
  DEFAULT_MAX_EVIDENCE_PER_PASS,
  MAX_VERIFICATION_PASSES,
  MAX_VERIFICATION_STRING_FIELD_LENGTH,
  VERIFICATION_CATEGORIES,
  VERIFICATION_CONFIDENCES,
  VERIFICATION_SEVERITIES,
  VERIFICATION_VERDICTS,
} from "./constants.js";
import { compareVerificationResults } from "./merge.js";
import type {
  Evidence,
  VerificationEvidenceGraph,
  VerificationEvidenceGraphEdge,
  VerificationEvidenceGraphNode,
  VerificationEvidenceGraphOptions,
  VerificationResult,
} from "./types.js";
import { isWellFormedUtf16 } from "./validation.js";

function assertString(value: unknown, field: string, index: number): string {
  if (typeof value !== "string") {
    throw new Error(
      `buildEvidenceGraph received invalid ${field} at result ${index}: ${String(value)}`,
    );
  }
  if (value.length > MAX_VERIFICATION_STRING_FIELD_LENGTH) {
    throw new Error(
      `buildEvidenceGraph received ${field} that is too long at result ${index}: ${value.length}/${MAX_VERIFICATION_STRING_FIELD_LENGTH}`,
    );
  }
  if (!isWellFormedUtf16(value)) {
    throw new Error(`buildEvidenceGraph received malformed ${field} at result ${index}`);
  }
  return value;
}

function assertMember<T extends string>(
  value: unknown,
  field: string,
  index: number,
  allowed: readonly T[],
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new Error(
      `buildEvidenceGraph received invalid ${field} at result ${index}: ${String(value)}`,
    );
  }
  return value as T;
}

function assertEvidence(evidence: unknown, resultIndex: number, evidenceIndex: number): Evidence {
  if (typeof evidence !== "object" || evidence === null || Array.isArray(evidence)) {
    throw new Error(
      `buildEvidenceGraph received invalid evidence at result ${resultIndex}[${evidenceIndex}]`,
    );
  }
  const record = evidence as Record<string, unknown>;
  const id = assertString(record.id, "evidence.id", resultIndex);
  const type = assertString(record.type, "evidence.type", resultIndex);
  const source = assertString(record.source, "evidence.source", resultIndex);
  const snippet = record.snippet;
  if (snippet !== undefined && typeof snippet !== "string") {
    throw new Error(
      `buildEvidenceGraph received invalid evidence.snippet at result ${resultIndex}[${evidenceIndex}]: ${String(snippet)}`,
    );
  }
  if (snippet !== undefined && snippet.length > MAX_VERIFICATION_STRING_FIELD_LENGTH) {
    throw new Error(
      `buildEvidenceGraph received evidence.snippet that is too long at result ${resultIndex}[${evidenceIndex}]: ${snippet.length}/${MAX_VERIFICATION_STRING_FIELD_LENGTH}`,
    );
  }
  return snippet === undefined ? { id, type, source } : { id, type, source, snippet };
}

function assertResult(
  result: unknown,
  index: number,
  maxEvidencePerResult: number,
): VerificationResult {
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    throw new Error(`buildEvidenceGraph received invalid result at index ${index}`);
  }
  const record = result as Record<string, unknown>;
  const evidence = record.evidence;
  if (!Array.isArray(evidence)) {
    throw new Error(`buildEvidenceGraph received invalid evidence at result ${index}`);
  }
  if (evidence.length > maxEvidencePerResult) {
    throw new Error(
      `buildEvidenceGraph received too much evidence at result ${index}: ${evidence.length}/${maxEvidencePerResult}`,
    );
  }
  return {
    passName: assertString(record.passName, "passName", index),
    verdict: assertMember(record.verdict, "verdict", index, VERIFICATION_VERDICTS),
    severity: assertMember(record.severity, "severity", index, VERIFICATION_SEVERITIES),
    confidence: assertMember(record.confidence, "confidence", index, VERIFICATION_CONFIDENCES),
    evidence: evidence.map((entry, evidenceIndex) => assertEvidence(entry, index, evidenceIndex)),
    message: assertString(record.message, "message", index),
    category: assertMember(record.category, "category", index, VERIFICATION_CATEGORIES),
  };
}

function assertUniquePassNames(results: readonly VerificationResult[]): void {
  const seen = new Set<string>();
  for (const result of results) {
    if (seen.has(result.passName)) {
      throw new Error(`buildEvidenceGraph received duplicate passName: ${result.passName}`);
    }
    seen.add(result.passName);
  }
}

function graphIdSegment(value: string): string {
  return encodeURIComponent(value);
}

function sourceNodeId(evidence: Evidence): string {
  return `source:${graphIdSegment(evidence.type)}:${graphIdSegment(evidence.source)}`;
}

function findingNodeId(result: VerificationResult): string {
  return `finding:${graphIdSegment(result.passName)}`;
}

function edgeId(result: VerificationResult, evidence: Evidence): string {
  return [
    "edge",
    graphIdSegment(result.passName),
    graphIdSegment(evidence.type),
    graphIdSegment(evidence.source),
    graphIdSegment(evidence.id),
  ].join(":");
}

function evidenceKey(result: VerificationResult, evidence: Evidence): string {
  return JSON.stringify([result.passName, evidence.id]);
}

function maxResultsFor(options: VerificationEvidenceGraphOptions): number {
  const maxResults = options.maxResults ?? MAX_VERIFICATION_PASSES;
  if (!Number.isSafeInteger(maxResults) || maxResults < 1) {
    throw new Error(
      `verification graph max results must be a positive integer: ${String(maxResults)}`,
    );
  }
  return maxResults;
}

function maxEvidenceFor(options: VerificationEvidenceGraphOptions): number {
  const maxEvidencePerResult = options.maxEvidencePerResult ?? DEFAULT_MAX_EVIDENCE_PER_PASS;
  if (!Number.isSafeInteger(maxEvidencePerResult) || maxEvidencePerResult < 1) {
    throw new Error(
      `verification graph max evidence per result must be a positive integer: ${String(maxEvidencePerResult)}`,
    );
  }
  return maxEvidencePerResult;
}

function dedupeEvidenceFor(result: VerificationResult): Evidence[] {
  const deduped = new Map<string, Evidence>();
  for (const evidence of result.evidence) {
    const key = evidenceKey(result, evidence);
    if (!deduped.has(key)) deduped.set(key, evidence);
  }
  return [...deduped.values()];
}

export function buildEvidenceGraph(
  results: readonly VerificationResult[],
  options: VerificationEvidenceGraphOptions = {},
): VerificationEvidenceGraph {
  if (results.length === 0) throw new Error("buildEvidenceGraph requires at least one result");
  const maxResults = maxResultsFor(options);
  if (results.length > maxResults) {
    throw new Error(
      `buildEvidenceGraph received too many results: ${results.length}/${maxResults}`,
    );
  }
  const maxEvidencePerResult = maxEvidenceFor(options);
  const validated = results.map((result, index) =>
    assertResult(result, index, maxEvidencePerResult),
  );
  assertUniquePassNames(validated);
  const ordered = validated.sort(compareVerificationResults);
  const nodes: VerificationEvidenceGraphNode[] = [];
  const edges: VerificationEvidenceGraphEdge[] = [];
  const seenNodes = new Set<string>();
  const seenEdges = new Set<string>();

  for (const result of ordered) {
    const findingId = findingNodeId(result);
    const evidence = dedupeEvidenceFor(result);
    if (!seenNodes.has(findingId)) {
      nodes.push({
        id: findingId,
        kind: "finding",
        passName: result.passName,
        verdict: result.verdict,
        severity: result.severity,
        category: result.category,
        confidence: result.confidence,
        message: result.message,
        evidenceCount: evidence.length,
      });
      seenNodes.add(findingId);
    }

    for (const entry of evidence) {
      const sourceId = sourceNodeId(entry);
      if (!seenNodes.has(sourceId)) {
        nodes.push({
          id: sourceId,
          kind: "source",
          evidenceType: entry.type,
          source: entry.source,
        });
        seenNodes.add(sourceId);
      }

      const edge: VerificationEvidenceGraphEdge = {
        id: edgeId(result, entry),
        kind: "finding-source",
        from: findingId,
        to: sourceId,
        evidenceId: entry.id,
      };
      if (!seenEdges.has(edge.id)) {
        edges.push(edge);
        seenEdges.add(edge.id);
      }
    }
  }

  return { nodes, edges };
}
