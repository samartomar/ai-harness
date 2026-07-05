import type { Confidence, Severity, Verdict, VerificationCategory } from "./types.js";

export const VERIFICATION_VERDICTS = ["pass", "fail", "warn"] as const satisfies readonly Verdict[];

export const VERIFICATION_SEVERITIES = [
  "critical",
  "high",
  "medium",
  "low",
  "info",
] as const satisfies readonly Severity[];

export const VERIFICATION_CONFIDENCES = [
  "high",
  "medium",
  "low",
] as const satisfies readonly Confidence[];

export const VERIFICATION_CATEGORIES = [
  "security",
  "exec",
  "policy",
  "dependency",
  "doc",
  "other",
] as const satisfies readonly VerificationCategory[];

export const MAX_VERIFICATION_PASSES = 128;
export const MAX_VERIFICATION_STRING_FIELD_LENGTH = 4_096;
export const DEFAULT_VERIFICATION_PASS_TIMEOUT_MS = 30_000;
export const DEFAULT_MAX_EVIDENCE_PER_PASS = 1_000;
