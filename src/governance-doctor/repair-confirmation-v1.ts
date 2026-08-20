import process from "node:process";
import { createInterface } from "node:readline";
import { assertExactKeysV1, assertRecordV1 } from "./capability-v1.js";
import { GOVERNANCE_DOCTOR_CANONICAL_CONTEXT_DIR_V1 } from "./repair-eligibility-v1.js";
import {
  canonicalGovernanceDoctorRepairEffectSummaryV1Bytes,
  canonicalGovernanceDoctorRepairPlanV1Bytes,
  type GovernanceDoctorRepairEffectSummaryV1,
  type GovernanceDoctorRepairPlanV1,
} from "./repair-plan-v1.js";

export const GOVERNANCE_DOCTOR_REPAIR_CONFIRMATION_TIMEOUT_MS_V1 = 60_000;

export type GovernanceDoctorRepairConfirmationV1 =
  | { readonly answer: string; readonly kind: "answered" }
  | { readonly kind: "cancelled" | "eof" | "non-interactive" | "timeout" };

/**
 * Displays the exact branded plan and its summary only on the local terminal.
 * No supplied prompter, environment token, or file can stand in for this
 * interaction; callers receive the raw answer and compare it themselves.
 */
export function promptGovernanceDoctorRepairConfirmationV1(
  input: unknown,
): Promise<GovernanceDoctorRepairConfirmationV1> {
  let plan: GovernanceDoctorRepairPlanV1;
  let summary: GovernanceDoctorRepairEffectSummaryV1;
  try {
    const request = assertRecordV1(input, "repair confirmation request");
    assertExactKeysV1(request, ["plan", "summary"], "repair confirmation request");
    canonicalGovernanceDoctorRepairPlanV1Bytes(request.plan);
    canonicalGovernanceDoctorRepairEffectSummaryV1Bytes(request.summary);
    plan = request.plan as GovernanceDoctorRepairPlanV1;
    summary = request.summary as GovernanceDoctorRepairEffectSummaryV1;
    if (summary.planSha256 !== plan.planSha256)
      throw new TypeError(
        "GOVERNANCE_DOCTOR_REPAIR_V1: repair confirmation summary does not bind plan",
      );
    const planEffect = plan.effects[0];
    const summaryEffect = summary.effects[0];
    if (
      plan.effects.length !== 1 ||
      summary.effects.length !== 1 ||
      planEffect === undefined ||
      summaryEffect === undefined ||
      planEffect.effectKind !== "create-managed-directory" ||
      planEffect.arguments.path !== GOVERNANCE_DOCTOR_CANONICAL_CONTEXT_DIR_V1 ||
      summaryEffect.effectId !== planEffect.effectId ||
      summaryEffect.effectKind !== planEffect.effectKind ||
      summaryEffect.arguments.path !== planEffect.arguments.path ||
      Object.keys(summaryEffect.arguments).length !== Object.keys(planEffect.arguments).length ||
      !Object.keys(planEffect.arguments).every(
        (key) => summaryEffect.arguments[key] === planEffect.arguments[key],
      )
    )
      throw new TypeError(
        "GOVERNANCE_DOCTOR_REPAIR_V1: repair confirmation requires exactly one canonical effect",
      );
  } catch (error) {
    return Promise.reject(error);
  }
  if (
    process.stdin.isTTY !== true ||
    process.stdout.isTTY !== true ||
    process.env.AIH_NO_PROMPT !== undefined
  )
    return Promise.resolve({ kind: "non-interactive" });

  // This is intentionally the canonical bounded transport, rather than a
  // hand-written subset. The terminal operator sees every declared effect kind
  // and argument that the digest commits to before entering that digest.
  const canonicalSummary =
    canonicalGovernanceDoctorRepairEffectSummaryV1Bytes(summary).toString("utf8");
  const targetPath = plan.effects[0]?.arguments.path ?? "<unavailable>";

  return new Promise((resolve) => {
    const line = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    let settled = false;
    const finish = (result: GovernanceDoctorRepairConfirmationV1): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      line.close();
      resolve(result);
    };
    const timer = setTimeout(
      () => finish({ kind: "timeout" }),
      GOVERNANCE_DOCTOR_REPAIR_CONFIRMATION_TIMEOUT_MS_V1,
    );
    line.once("SIGINT", () => finish({ kind: "cancelled" }));
    line.once("close", () => finish({ kind: "eof" }));
    process.stdout.write(
      `Governance Doctor Repair\nTarget: ${targetPath}\nPlan: ${plan.planSha256}\nSummary: ${summary.summarySha256}\nCanonical summary: ${canonicalSummary}\n`,
    );
    line.question(
      `Target ${targetPath}; plan ${plan.planSha256}; summary ${summary.summarySha256}. Type full plan digest: `,
      (answer) => finish({ answer, kind: "answered" }),
    );
  });
}
