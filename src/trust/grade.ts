import { postureGradeCheck } from "../config/governance.js";
import type { Posture } from "../config/posture.js";
import type { Check, CheckCode } from "../internals/verify.js";

export const TRUST_ORIGIN_CODES = new Set<CheckCode>([
  "trust.unpinned-dependency",
  "trust.untrusted-publisher",
  "trust.unsigned-source",
]);

/**
 * Proven-dangerous trust findings are already emitted as fail checks. Keep them
 * failing at every posture; do not route through postureGradeCheck, whose advisory
 * path intentionally rewrites warn-grade failures to pass.
 */
export function gradeTrustDanger(check: Check): Check {
  return check;
}

export function gradeTrustCheck(check: Check, posture: Posture): Check {
  if (check.verdict !== "fail" || check.code === undefined) return check;
  if (TRUST_ORIGIN_CODES.has(check.code)) {
    return postureGradeCheck(check, "trust-origin", posture);
  }
  return gradeTrustDanger(check);
}
