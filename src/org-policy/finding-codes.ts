/**
 * Assertions a detector made about a completed scan. A severe label is
 * evidence, not a verdict, so the accountable administrator decides each one:
 * reject the candidate, record a false positive, or accept the residual risk
 * with an attributable signed reason.
 */
export const DISPOSITIONABLE_POLICY_FINDING_CODES = [
  "malicious-code",
  "prompt-injection",
  "auto-executing-hook",
  "hidden-unicode",
  "secrets",
  "unpinned-source",
  "dependency-confusion",
  "unsafe-path",
] as const;

/**
 * What kept the evidence from being complete. It is a label of its own, beside
 * the findings, and never a gate: the requested control stays effective.
 */
export const EVIDENCE_PROBLEM_POLICY_CODES = ["mandatory-detector-failed"] as const;

/**
 * Prerequisites AIH needs before it can evaluate or project at all. Each marks
 * something absent or untrustworthy rather than something a detector asserted,
 * so no signature substitutes for it and approval cannot invent it.
 */
export const FENCED_POLICY_PREREQUISITE_CODES = [
  "evidence-identity-drift",
  "missing-projector",
  "unsupported-target",
  "normalized-collision",
  "ownership-conflict",
] as const;

/**
 * The partition's union — the same 14 codes, none renamed or added. Findings
 * and evidence problems are labels on the candidate; only the fenced
 * prerequisites keep a candidate from taking effect.
 */
export const UNWAIVABLE_POLICY_DANGER_CODES = [
  ...DISPOSITIONABLE_POLICY_FINDING_CODES,
  ...EVIDENCE_PROBLEM_POLICY_CODES,
  ...FENCED_POLICY_PREREQUISITE_CODES,
] as const;
