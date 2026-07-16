import type { CompatibilityKey, CompatibilityResult } from "./compatibility.js";

export interface QualificationFinding {
  code: string;
  summary: string;
  rootCauseHint?: string;
  safeRetry?: string;
  stopCondition?: string;
}

export interface QualificationEnvelope<T> {
  status: "success" | "warning" | "error";
  summary: string;
  nextActions: readonly string[];
  artifacts: readonly string[];
  findings: readonly QualificationFinding[];
  value?: T;
}

export interface ProviderQualificationAdapter {
  describe(): QualificationEnvelope<{ providerKind: string; supportedHosts: readonly string[] }>;
  discover(source: unknown): QualificationEnvelope<unknown>;
  resolveLocal(source: unknown): QualificationEnvelope<unknown>;
  evaluate(source: unknown): QualificationEnvelope<unknown>;
  fingerprint(source: unknown): QualificationEnvelope<{ fingerprint: string }>;
  planProposed(context: unknown): QualificationEnvelope<unknown>;
  qualify(context: { compatibility: CompatibilityKey }): QualificationEnvelope<CompatibilityResult>;
}
