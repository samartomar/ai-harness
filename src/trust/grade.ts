import type { Check } from "../internals/verify.js";

/**
 * Proven-dangerous trust findings are already emitted as fail checks. Keep them
 * failing at every posture; do not route through postureGradeCheck, whose advisory
 * path intentionally rewrites warn-grade failures to pass.
 */
export function gradeTrustDanger(check: Check): Check {
  return check;
}
