import type { Check } from "../internals/verify.js";
import { type GovernanceControl, gradeVerdict, type Posture } from "./posture.js";

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
