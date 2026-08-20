import { createHash, randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { readAihConfig } from "../config/marker.js";
import { executePlan, type PlanResult } from "../internals/execute.js";
import { type CommandSpec, digest, type PlanContext, plan, probe } from "../internals/plan.js";
import {
  loadShippedGovernanceDoctorProfileV1,
  resolveGovernanceDoctorPolicyStateV1,
} from "./command-v1.js";
import {
  createGovernanceDoctorOperationalContextV1,
  runGovernanceDoctorOperationV1,
} from "./operational-v1.js";
import type { GovernanceDoctorProfileV1 } from "./profile-v1.js";
import {
  attemptGovernanceDoctorRepairV1,
  deriveGovernanceDoctorRepairAttemptCompletionV1,
  didGovernanceDoctorRepairAttemptEffectChangeV1,
  type GovernanceDoctorRepairPostClaimEffectStateV1,
  isGovernanceDoctorRepairPostClaimRefusalV1,
  isGovernanceDoctorRepairPreClaimRefusalV1,
} from "./repair-attempt-v1.js";
import { promptGovernanceDoctorRepairConfirmationV1 } from "./repair-confirmation-v1.js";
import {
  createGovernanceDoctorRepairConsentContextV1,
  createGovernanceDoctorRepairConsentV1,
} from "./repair-consent-v1.js";
import { createGovernanceDoctorRepairContentV1 } from "./repair-content-v1.js";
import { createGovernanceDoctorRepairCustodyV1 } from "./repair-custody-v1.js";
import {
  GOVERNANCE_DOCTOR_CANONICAL_CONTEXT_DIR_V1,
  mintGovernanceDoctorRepairEligibilityV1,
} from "./repair-eligibility-v1.js";
import { deriveGovernanceDoctorRepairLiveCanonicalPlanV1 } from "./repair-live-canon-plan-v1.js";
import {
  createGovernanceDoctorRepairExecutionContextV1,
  createGovernanceDoctorRepairVerificationContextV1,
} from "./repair-outcome-v1.js";
import { observeGovernanceDoctorRepairPreconditionV1 } from "./repair-precondition-v1.js";
import { mintGovernanceDoctorRepairPreconditionScopeV1 } from "./repair-scope-v1.js";
import { verifyGovernanceDoctorRepairV1 } from "./repair-verifier-v1.js";

/** Names the sole code-owned local TTY confirmation boundary, not caller input. */
const TRUST_ANCHOR = createHash("sha256")
  .update("aih:governance-doctor:local-tty-confirmation:v1")
  .digest("hex");

function rejection(ctx: PlanContext, reason: string): Promise<PlanResult> {
  return executePlan(
    plan(
      "repair",
      probe("governance doctor repair", () => ({
        detail: reason,
        name: "governance-doctor-repair",
        verdict: "fail" as const,
      })),
      digest("governance doctor repair", "Governance Doctor repair was not applied.\n", {
        outcome: "refused",
        reason,
      }),
    ),
    { ...ctx, apply: false },
  );
}

function incomplete(ctx: PlanContext, reason: string): Promise<PlanResult> {
  return executePlan(
    plan(
      "repair",
      probe("governance doctor repair", () => ({
        detail: reason,
        name: "governance-doctor-repair",
        verdict: "fail" as const,
      })),
      digest("governance doctor repair", "Governance Doctor repair was not completed.\n", {
        outcome: "failed",
        reason,
        repairState: "failed",
      }),
    ),
    ctx,
  );
}

function incompleteAfterClaim(
  ctx: PlanContext,
  reason: string,
  effectState: GovernanceDoctorRepairPostClaimEffectStateV1,
): Promise<PlanResult> {
  return executePlan(
    plan(
      "repair",
      probe("governance doctor repair", () => ({
        detail: reason,
        name: "governance-doctor-repair",
        verdict: "fail" as const,
      })),
      digest("governance doctor repair", "Governance Doctor repair was not completed.\n", {
        claimState: "spent",
        ...(effectState === "not-applied" ? { effectApplied: false } : {}),
        effectState,
        outcome: "failed",
        reason,
        repairState: "failed",
      }),
    ),
    ctx,
  ).then((result) => withRepairMutationSummaries(result));
}

function withRepairMutationSummaries(
  result: PlanResult,
  effect?: {
    readonly applied: boolean;
    readonly changed: boolean | undefined;
    readonly path: string;
  },
): PlanResult {
  return {
    ...result,
    writes: [
      ...result.writes,
      {
        describe: "spend durable repair claim",
        effect: "create",
        merged: false,
        path: "<local repair claim store>",
      },
      ...(effect === undefined || !effect.applied || effect.changed === undefined
        ? []
        : [
            {
              describe: "create canonical managed directory",
              effect: effect.changed ? ("create" as const) : ("unchanged" as const),
              merged: false,
              path: effect.path,
            },
          ]),
    ],
  };
}

function postEffectFailure(
  ctx: PlanContext,
  planSha256: string,
  summarySha256: string,
  targetPath: string,
  effectApplied: boolean,
  effectChanged: boolean | undefined,
): Promise<PlanResult> {
  return reportResult(
    ctx,
    "repair incomplete",
    completionDigestText(
      "unverified",
      "unavailable",
      "failed",
      planSha256,
      summarySha256,
      targetPath,
    ),
    {
      claimState: "spent",
      effectApplied,
      ...(effectChanged === undefined ? { effectChangeState: "unknown" } : {}),
      effectVerification: "unverified",
      outcome: "failed",
      planSha256,
      postAuditState: "unavailable",
      repairState: "failed",
      summarySha256,
      targetPath,
    },
    false,
  ).then((result) =>
    withRepairMutationSummaries(result, {
      applied: effectApplied,
      changed: effectChanged,
      path: targetPath,
    }),
  );
}

function isInteractiveApply(ctx: PlanContext): boolean {
  const options = ctx.options as Record<string, unknown>;
  return (
    ctx.apply === true &&
    ctx.json !== true &&
    ctx.env.AIH_NO_PROMPT === undefined &&
    ctx.env.AIH_REPAIR_CONFIRM === undefined &&
    options.yes !== true &&
    options.confirm === undefined &&
    options.confirmationFile === undefined
  );
}

function reportResult(
  ctx: PlanContext,
  detail:
    | "no mechanical repair"
    | "preview available"
    | "repair complete"
    | "repair incomplete"
    | "repair partial",
  text: string,
  data: Record<string, unknown>,
  passed: boolean,
): Promise<PlanResult> {
  return executePlan(
    plan(
      "repair",
      probe("governance doctor repair", () => ({
        detail,
        name: "governance-doctor-repair",
        verdict: passed ? ("pass" as const) : ("fail" as const),
      })),
      digest("governance doctor repair", text, data),
    ),
    ctx,
  );
}

/**
 * Human rendering is deliberately a closed, code-owned field list. The plan
 * and summary records have already established these bounded identities and
 * target; arbitrary result data never becomes terminal text.
 */
function dryRunDigestText(
  auditCompleteness: string,
  planSha256: string,
  preconditionSha256: string,
  summarySha256: string,
  targetOccupancy: string,
  targetPath: string,
): string {
  return [
    "Governance Doctor repair preview",
    `Target: ${targetPath}`,
    `Plan SHA-256: ${planSha256}`,
    `Precondition SHA-256: ${preconditionSha256}`,
    `Summary SHA-256: ${summarySha256}`,
    `Target occupancy: ${targetOccupancy}`,
    `Audit completeness: ${auditCompleteness}`,
    "",
  ].join("\n");
}

function nonPlanDryRunDigestText(
  auditCompleteness: string | null,
  outcome: string,
  preconditionSha256: string | null,
  targetOccupancy: string | null,
): string {
  return [
    "Governance Doctor repair preview",
    `Outcome: ${outcome}`,
    `Precondition SHA-256: ${preconditionSha256 ?? "unavailable"}`,
    `Target occupancy: ${targetOccupancy ?? "unavailable"}`,
    `Audit completeness: ${auditCompleteness ?? "unavailable"}`,
    "",
  ].join("\n");
}

function completionDigestText(
  effectVerification: string,
  postAuditState: string,
  repairState: string,
  planSha256: string,
  summarySha256: string,
  targetPath: string,
): string {
  return [
    "Governance Doctor repair result",
    `Target: ${targetPath}`,
    `Plan SHA-256: ${planSha256}`,
    `Summary SHA-256: ${summarySha256}`,
    `effectVerification: ${effectVerification}`,
    `postAuditState: ${postAuditState}`,
    `repairState: ${repairState}`,
    "",
  ].join("\n");
}

/** Runs the custom-executor canonical-directory repair command. */
export async function executeGovernanceDoctorRepairCommandV1(
  ctx: PlanContext,
): Promise<PlanResult> {
  let root: string;
  try {
    root = realpathSync.native(ctx.root);
  } catch {
    return rejection(ctx, "root-unavailable");
  }
  const readOnlyContext = createGovernanceDoctorOperationalContextV1({
    ...ctx,
    apply: false,
    json: true,
    options: {},
    root,
    verify: true,
  });
  let policy: ReturnType<typeof resolveGovernanceDoctorPolicyStateV1>;
  let profile: GovernanceDoctorProfileV1;
  try {
    policy = resolveGovernanceDoctorPolicyStateV1(readOnlyContext);
    profile = loadShippedGovernanceDoctorProfileV1();
  } catch {
    return rejection(ctx, "profile-unavailable");
  }
  let operation: Awaited<ReturnType<typeof runGovernanceDoctorOperationV1>>;
  let eligibility: ReturnType<typeof mintGovernanceDoctorRepairEligibilityV1> | undefined;
  let scope: ReturnType<typeof mintGovernanceDoctorRepairPreconditionScopeV1> | undefined;
  let precondition: ReturnType<typeof observeGovernanceDoctorRepairPreconditionV1> | undefined;
  try {
    operation = await runGovernanceDoctorOperationV1({
      context: readOnlyContext,
      policy: { decision: policy.decision, revisionSha256: policy.revisionSha256 },
      profile,
    });
    const marker = readAihConfig(root);
    eligibility =
      marker === undefined
        ? undefined
        : mintGovernanceDoctorRepairEligibilityV1(
            marker.contextDir,
            ctx.contextDir,
            operation.record.rootSha256,
          );
    scope = mintGovernanceDoctorRepairPreconditionScopeV1(readOnlyContext);
    precondition = observeGovernanceDoctorRepairPreconditionV1(scope);
  } catch {
    return rejection(ctx, "repair-unavailable");
  }
  const canonical = deriveGovernanceDoctorRepairLiveCanonicalPlanV1({
    eligibility,
    operation,
    precondition,
    profile,
    scope,
  });
  if (canonical.kind !== "plan") {
    if (ctx.apply === true) return rejection(ctx, `repair-${canonical.kind}`);
    const noMechanicalRepair = canonical.kind === "no-mechanical-repair";
    return reportResult(
      { ...ctx, apply: false },
      noMechanicalRepair ? "no mechanical repair" : "repair incomplete",
      nonPlanDryRunDigestText(
        canonical.auditCompleteness,
        canonical.kind,
        canonical.preconditionSha256,
        canonical.targetOccupancy,
      ),
      {
        auditCompleteness: canonical.auditCompleteness,
        outcome: canonical.kind,
        preconditionSha256: canonical.preconditionSha256,
        targetOccupancy: canonical.targetOccupancy,
      },
      noMechanicalRepair,
    );
  }
  const repairPlan = canonical.plan;
  const summary = canonical.summary;
  const targetEffect = repairPlan.effects[0];
  if (
    repairPlan.effects.length !== 1 ||
    targetEffect === undefined ||
    targetEffect.effectKind !== "create-managed-directory" ||
    targetEffect.arguments.path !== GOVERNANCE_DOCTOR_CANONICAL_CONTEXT_DIR_V1
  )
    return rejection(ctx, "repair-plan-unavailable");
  const targetPath = targetEffect.arguments.path;
  const dryData = {
    auditCompleteness: canonical.auditCompleteness,
    outcome: "plan",
    planSha256: repairPlan.planSha256,
    preconditionSha256: canonical.preconditionSha256,
    summarySha256: summary.summarySha256,
    targetOccupancy: canonical.targetOccupancy,
    targetPath,
  };
  if (ctx.apply !== true)
    return reportResult(
      { ...ctx, apply: false },
      "preview available",
      dryRunDigestText(
        canonical.auditCompleteness,
        repairPlan.planSha256,
        canonical.preconditionSha256,
        summary.summarySha256,
        canonical.targetOccupancy,
        targetPath,
      ),
      dryData,
      true,
    );
  if (!isInteractiveApply(ctx)) return rejection(ctx, "interactive-confirmation-required");
  let confirmation: Awaited<ReturnType<typeof promptGovernanceDoctorRepairConfirmationV1>>;
  try {
    confirmation = await promptGovernanceDoctorRepairConfirmationV1({
      auditCompleteness: canonical.auditCompleteness,
      plan: repairPlan,
      precondition,
      summary,
    });
  } catch {
    return rejection(ctx, "confirmation-refused");
  }
  if (confirmation.kind !== "answered" || confirmation.answer !== repairPlan.planSha256)
    return rejection(ctx, "confirmation-refused");

  let consent: ReturnType<typeof createGovernanceDoctorRepairConsentV1>;
  let custody: ReturnType<typeof createGovernanceDoctorRepairCustodyV1>;
  let content: ReturnType<typeof createGovernanceDoctorRepairContentV1>;
  let executionContext: ReturnType<typeof createGovernanceDoctorRepairExecutionContextV1>;
  try {
    const consentContext = createGovernanceDoctorRepairConsentContextV1({
      channel: "out-of-band",
      signerId: "aih:local-operator",
      subjectId: repairPlan.targetId,
      trustAnchorSha256: TRUST_ANCHOR,
    });
    consent = createGovernanceDoctorRepairConsentV1({
      consentNonce: randomBytes(32).toString("hex"),
      consentedAtEpochMs: Date.now(),
      context: consentContext,
      decision: "granted",
      plan: repairPlan,
      summary,
    });
    custody = createGovernanceDoctorRepairCustodyV1({
      contextDir: ctx.contextDir,
      plan: repairPlan,
      root,
    });
    content = createGovernanceDoctorRepairContentV1({ entries: [] });
    executionContext = createGovernanceDoctorRepairExecutionContextV1({
      brokerId: repairPlan.brokerId,
      executorId: "aih:governance-doctor.repair-executor",
      owner: "aih",
      recipeSha256: repairPlan.recipeSha256,
      registrySha256: repairPlan.registrySha256,
      rootSha256: repairPlan.rootSha256,
    });
    if (scope === undefined) return rejection(ctx, "repair-preflight-unavailable");
  } catch {
    return rejection(ctx, "repair-preflight-unavailable");
  }
  let receipt: ReturnType<typeof attemptGovernanceDoctorRepairV1>;
  try {
    receipt = attemptGovernanceDoctorRepairV1({
      consent,
      content,
      context: executionContext,
      custody,
      plan: repairPlan,
      scope,
    });
  } catch (error) {
    // A claim may already be durable at this point. Report an incomplete repair
    // rather than recasting that post-claim fact as a pre-consent refusal.
    if (isGovernanceDoctorRepairPostClaimRefusalV1(error))
      return incompleteAfterClaim(ctx, "repair-incomplete-after-claim", error.effectState);
    if (isGovernanceDoctorRepairPreClaimRefusalV1(error))
      return rejection(ctx, "precondition-ineligible");
    return incomplete(ctx, "repair-incomplete");
  }
  const effectApplied = receipt.effects.some(
    (effect) => effect.effectId === targetEffect.effectId && effect.result === "applied",
  );
  let effectChanged: boolean | undefined;
  try {
    effectChanged = didGovernanceDoctorRepairAttemptEffectChangeV1({
      effectSha256: targetEffect.effectSha256,
      receipt,
    });
  } catch {
    return postEffectFailure(
      ctx,
      repairPlan.planSha256,
      summary.summarySha256,
      targetPath,
      effectApplied,
      undefined,
    );
  }
  try {
    const verification = verifyGovernanceDoctorRepairV1({
      content,
      context: createGovernanceDoctorRepairVerificationContextV1({
        brokerId: repairPlan.brokerId,
        recipeSha256: repairPlan.recipeSha256,
        registrySha256: repairPlan.registrySha256,
        rootSha256: repairPlan.rootSha256,
        trustAnchorSha256: TRUST_ANCHOR,
        verifierId: "aih:governance-doctor.repair-verifier",
      }),
      custody,
      plan: repairPlan,
      receipt,
    });
    let postAudit: unknown;
    try {
      postAudit = (
        await runGovernanceDoctorOperationV1({
          context: readOnlyContext,
          policy: { decision: policy.decision, revisionSha256: policy.revisionSha256 },
          profile,
        })
      ).audit;
    } catch {
      postAudit = undefined;
    }
    const completion = deriveGovernanceDoctorRepairAttemptCompletionV1({
      effectSha256: targetEffect.effectSha256,
      postAudit,
      receipt,
      verification,
    });
    const result = await reportResult(
      ctx,
      completion.repairState === "complete"
        ? "repair complete"
        : completion.repairState === "partial"
          ? "repair partial"
          : "repair incomplete",
      completionDigestText(
        completion.effectVerification,
        completion.postAuditState,
        completion.repairState,
        repairPlan.planSha256,
        summary.summarySha256,
        completion.targetPath,
      ),
      {
        effectVerification: completion.effectVerification,
        planSha256: repairPlan.planSha256,
        postAuditState: completion.postAuditState,
        repairState: completion.repairState,
        residual: completion.residual,
        summarySha256: summary.summarySha256,
        targetPath: completion.targetPath,
      },
      completion.repairState === "complete" || completion.repairState === "partial",
    );
    return withRepairMutationSummaries(result, {
      applied: effectApplied,
      changed: effectChanged,
      path: completion.targetPath,
    });
  } catch {
    return postEffectFailure(
      ctx,
      repairPlan.planSha256,
      summary.summarySha256,
      targetPath,
      effectApplied,
      effectChanged,
    );
  }
}

export const governanceDoctorRepairCommand: CommandSpec = {
  name: "repair",
  summary: "Interactively confirm and apply the canonical local Governance Doctor repair",
  alwaysVerify: true,
  requireExplicitApply: true,
  zeroWrite: true,
  plan: async (_ctx) =>
    plan("repair", digest("governance doctor repair", "Repair uses its custom executor.\n")),
};
