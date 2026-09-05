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
 * Prerequisites AIH needs before it can evaluate or project at all. Each marks
 * something absent or untrustworthy rather than something a detector asserted,
 * so no signature substitutes for it and approval cannot invent it.
 */
export const FENCED_POLICY_PREREQUISITE_CODES = [
  "mandatory-detector-failed",
  "evidence-identity-drift",
  "missing-projector",
  "unsupported-target",
  "normalized-collision",
  "ownership-conflict",
] as const;

/**
 * The partition's union — the same 14 codes, none renamed or added. Resolution
 * still blocks on every one of them: separating the halves is what lets a
 * consumer tell a disposable finding from a hard prerequisite, and is not by
 * itself the administrator disposition flow, which does not exist yet.
 */
export const UNWAIVABLE_POLICY_DANGER_CODES = [
  ...DISPOSITIONABLE_POLICY_FINDING_CODES,
  ...FENCED_POLICY_PREREQUISITE_CODES,
] as const;
