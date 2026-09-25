import { SettingsError } from "../errors.js";
import type { CommandOption } from "../internals/plan.js";
import type { Check } from "../internals/verify.js";
import {
  dispositionForTrustFinding,
  isConsumerPolicyCodeV1,
  isFindingLevelV1,
  trustCodeClassV1,
} from "./evidence.js";

/** The conditions `--fail-on` can turn into exit 1 (D66). */
export const FAIL_ON_CONDITIONS_V1 = ["findings", "evidence-problems"] as const;
export type FailOnConditionV1 = (typeof FAIL_ON_CONDITIONS_V1)[number];

export const FAIL_ON_OPTION: CommandOption = {
  flags: "--fail-on <conditions>",
  description:
    "exit 1 when the report carries findings or evidence problems (findings, evidence-problems; comma-separated or repeated); by default both are labels and exit 0",
  repeatable: true,
};

/** Parses `--fail-on` values; an unknown condition is a usage error. */
export function parseFailOnV1(value: unknown): ReadonlySet<FailOnConditionV1> {
  const conditions = new Set<FailOnConditionV1>();
  if (value === undefined) return conditions;
  for (const entry of Array.isArray(value) ? value : [value]) {
    for (const part of String(entry).split(",")) {
      const condition = part.trim();
      if (!(FAIL_ON_CONDITIONS_V1 as readonly string[]).includes(condition)) {
        throw new SettingsError(
          `--fail-on accepts findings or evidence-problems, comma-separated or repeated; got "${condition}"`,
        );
      }
      conditions.add(condition as FailOnConditionV1);
    }
  }
  return conditions;
}

/**
 * What a failed check is, for the exit code (D66): a finding (a finding-class code
 * at a finding level), a label below a finding (a finding-class code the policy
 * reports as informational or suppressed), an evidence problem, or a stop. A stop
 * is an integrity failure, the organization's own configured requirement (D67), or
 * a code no class names (fail closed).
 */
export function failedCheckKindV1(
  check: Check,
): "finding" | "below-finding" | "evidence-problem" | "stop" {
  const code = check.code;
  if (isConsumerPolicyCodeV1(code)) return "stop";
  const trustClass = trustCodeClassV1(code);
  if (trustClass === "evidence-problem") return "evidence-problem";
  if (trustClass !== "finding") return "stop";
  const { level } = dispositionForTrustFinding({
    fingerprint: check.fingerprint ?? check.name,
    code,
    checkVerdict: "fail",
    detail: check.detail ?? check.name,
    rawOccurrenceFingerprints: [],
  });
  return isFindingLevelV1(level) ? "finding" : "below-finding";
}

/**
 * The exit code of a trust report whose findings are labels (D66 option B): 0 when
 * every failed check is a finding or an evidence problem, 1 for any stop, and 1 for
 * a finding or evidence problem the caller named with `--fail-on`.
 */
export function labelledReportExitCodeV1(
  checks: readonly Check[],
  failOn: ReadonlySet<FailOnConditionV1>,
): 0 | 1 {
  let code: 0 | 1 = 0;
  for (const check of checks) {
    if (check.verdict !== "fail") continue;
    const kind = failedCheckKindV1(check);
    if (
      kind === "stop" ||
      (kind === "finding" && failOn.has("findings")) ||
      (kind === "evidence-problem" && failOn.has("evidence-problems"))
    )
      code = 1;
  }
  return code;
}
