import type { CommandSpec, Plan, PlanContext } from "../internals/plan.js";
import { digest, dynamicDigest, plan, probe } from "../internals/plan.js";
import type { Check } from "../internals/verify.js";
import {
  type AihManagedUsageAdapterRequestV1,
  aihManagedUsageAdapterPlanV1,
  describeAihManagedUsageAdapterV1,
  executeAihManagedUsageAdapterV1,
  inspectAihManagedUsageAdapterV1,
} from "./aih-managed-usage-adapter-v1.js";

function requestFromContext(ctx: PlanContext): AihManagedUsageAdapterRequestV1 {
  return {
    decision: typeof ctx.options.decision === "string" ? ctx.options.decision : "",
    digest: typeof ctx.options.decisionDigest === "string" ? ctx.options.decisionDigest : "",
    evidence: typeof ctx.options.evidence === "string" ? ctx.options.evidence : "",
    target: typeof ctx.options.target === "string" ? ctx.options.target : "",
  };
}

function describePlan(): Plan {
  const descriptor = describeAihManagedUsageAdapterV1();
  return plan(
    "policy managed usage-metering describe",
    digest("fixed AIH-managed usage-metering adapter", JSON.stringify(descriptor), descriptor),
  );
}

function inspectionCheck(inspection: ReturnType<typeof inspectAihManagedUsageAdapterV1>): Check {
  if (
    inspection.state === "absent" ||
    inspection.state === "configured" ||
    inspection.state === "revoked"
  )
    return {
      name: "AIH-managed usage-metering custody",
      verdict: "pass",
      detail: `bounded custody state is ${inspection.state}`,
    };
  return {
    name: "AIH-managed usage-metering custody",
    verdict: "fail",
    code: inspection.state === "invalid" ? "org-policy.invalid" : "org-policy.drift",
    detail: `bounded custody requires reconciliation: ${inspection.state}`,
  };
}

function inspectPlan(ctx: PlanContext): Plan {
  let inspection: ReturnType<typeof inspectAihManagedUsageAdapterV1> | undefined;
  const inspectOnce = () => (inspection ??= inspectAihManagedUsageAdapterV1(ctx.root));
  return plan(
    "policy managed usage-metering inspect",
    dynamicDigest("AIH-managed usage-metering custody", () => {
      const result = inspectOnce();
      return { text: JSON.stringify(result), data: result };
    }),
    probe("AIH-managed usage-metering custody", () => inspectionCheck(inspectOnce())),
  );
}

const exactAuthorityOptions = [
  { flags: "--decision <id>", description: "exact current V3 governance decision identifier" },
  {
    flags: "--decision-digest <sha256>",
    description: "exact current V3 governance decision digest",
  },
  { flags: "--target <id>", description: "fixed adapter target: claude or codex" },
  {
    flags: "--evidence <root-relative-file>",
    description: "canonical organization qualification evidence below the target root",
  },
] as const;

export const policyManagedUsageDescribeCommandV1: CommandSpec = {
  name: "describe",
  summary: "Describe the fixed code-owned AIH usage-metering adapter",
  readOnly: true,
  zeroWrite: true,
  plan: describePlan,
};

export const policyManagedUsageReconcileCommandV1: CommandSpec = {
  name: "reconcile",
  summary: "Preview or reconcile the fixed AIH usage-metering adapter under current authority",
  zeroWrite: true,
  requireExplicitApply: true,
  alwaysVerify: true,
  options: [...exactAuthorityOptions],
  plan: (ctx) => aihManagedUsageAdapterPlanV1(ctx, requestFromContext(ctx)),
};

export const policyManagedUsageInspectCommandV1: CommandSpec = {
  name: "inspect",
  summary: "Inspect bounded AIH usage-metering ownership and recovery history",
  readOnly: true,
  zeroWrite: true,
  alwaysVerify: true,
  honorReadOnlyPostureFlag: true,
  plan: inspectPlan,
};

export function executePolicyManagedUsageReconcileCommandV1(ctx: PlanContext) {
  return executeAihManagedUsageAdapterV1(ctx, requestFromContext(ctx));
}
