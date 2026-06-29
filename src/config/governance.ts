import type { Check } from "../internals/verify.js";
import { type GovernanceControl, gradeVerdict, type Posture } from "./posture.js";

/**
 * Apply posture teeth to a failing check. Advisory postures intentionally keep
 * the process exit green by converting warn-grade findings to `pass` with a
 * `warning-only (...)` detail; deny-grade findings keep the original failing
 * verdict/code so verify/SARIF consumers still block.
 */
export function postureGradeCheck(
  check: Check,
  control: GovernanceControl,
  posture: Posture,
): Check {
  if (check.verdict !== "fail") return check;
  const verdict = gradeVerdict("warn", control, posture);
  if (verdict === "deny") return check;
  return {
    ...check,
    verdict: "pass",
    code: undefined,
    detail: `warning-only (${posture} posture): ${check.detail ?? check.name}`,
  };
}
