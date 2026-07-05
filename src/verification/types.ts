export type Verdict = "pass" | "fail" | "warn";

export type VerificationCategory = "security" | "exec" | "policy" | "dependency" | "doc" | "other";

export type Severity = "critical" | "high" | "medium" | "low" | "info";

export type Confidence = "high" | "medium" | "low";

export interface Evidence {
  id: string;
  type: string;
  source: string;
  snippet?: string;
}

export interface VerificationInput {
  projectRoot: string;
  projectType?: string;
  context?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface VerificationResult {
  passName: string;
  verdict: Verdict;
  severity: Severity;
  confidence: Confidence;
  evidence: Evidence[];
  message: string;
  category: VerificationCategory;
}

export interface VerificationPass {
  name: string;
  category?: VerificationCategory;
  projectTypes?: readonly string[];
  run(input: VerificationInput): Promise<VerificationResult>;
}

export interface VerificationPipelineOptions {
  passes: readonly VerificationPass[];
  timeoutMs?: number;
  maxEvidencePerPass?: number;
}

export interface VerificationPipelineRun {
  results: VerificationResult[];
  summary: VerificationSummary;
}

export interface VerificationSummary {
  finalVerdict: Verdict;
  /**
   * Starts at 100 and applies penalties only to warn/fail results. Severity on
   * passing results is preserved but does not reduce the score.
   */
  trustScore: number;
  /**
   * Evidence is deduplicated per pass and evidence ID. The same evidence ID from
   * different passes remains visible so callers can inspect independent findings.
   */
  aggregatedEvidence: Evidence[];
  failedPasses: string[];
  warnings: string[];
}
