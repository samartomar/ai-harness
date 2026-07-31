import { postureGradeCheck } from "../config/governance.js";
import type { Posture } from "../config/posture.js";
import type { Check, CheckCode } from "../internals/verify.js";

export const TRUST_REVIEW_CODES = new Set<CheckCode>([
  "trust.external-egress",
  "trust.license-missing",
  "trust.permission-risk",
  "trust.skill-metadata-license",
  "trust.untrusted-publisher",
]);

export const TRUST_WARN_CODES = new Set<CheckCode>([
  "trust.cisco-finding",
  "trust.detector-finding",
  "trust.legal-text-detector-finding",
  "trust.visible-unicode",
]);

/** @deprecated Use TRUST_REVIEW_CODES for exact-finding acceptance. */
export const TRUST_ORIGIN_CODES = TRUST_REVIEW_CODES;

/**
 * Proven-dangerous trust findings are already emitted as fail checks. Keep them
 * failing at every posture; do not route through postureGradeCheck, whose advisory
 * path intentionally rewrites warn-grade failures to pass.
 */
export function gradeTrustDanger(check: Check): Check {
  return check;
}

function warningOnly(check: Check, posture: Posture): Check {
  return {
    ...check,
    verdict: "pass",
    ...(check.code === "trust.cisco-finding" ? {} : { code: undefined }),
    detail: `warning-only (${posture} posture): ${check.detail ?? check.name}`,
  };
}

export function gradeTrustCheck(check: Check, posture: Posture): Check {
  if (check.verdict !== "fail" || check.code === undefined) return check;
  if (TRUST_WARN_CODES.has(check.code)) return warningOnly(check, posture);
  if (TRUST_REVIEW_CODES.has(check.code)) {
    return postureGradeCheck(check, "trust-origin", posture);
  }
  return gradeTrustDanger(check);
}
