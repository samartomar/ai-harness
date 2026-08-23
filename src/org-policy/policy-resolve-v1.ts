import type { CommandSpec, Plan, PlanContext } from "../internals/plan.js";
import { dynamicDigest, plan, probe } from "../internals/plan.js";
import type { Check } from "../internals/verify.js";
import { verifyPolicyAuthorityReceipt } from "./authority.js";
import { custodyOrganizationEvidenceV1 } from "./evidence-custody-v1.js";
import { type GovernanceDecisionV2, governanceDecisionDigestV2 } from "./governance-decision-v2.js";
import { verifyOrganizationQualificationV1 } from "./qualification-v1.js";
import {
  type ObservedEffectResolution,
  resolveObservedEffect,
} from "./upstream-observation-receipt-v1.js";

const TARGETS = ["claude", "codex", "kiro"] as const;
const EFFECTS = ["configure", "install", "observe", "use"] as const;
const SHA256 = /^sha256:[0-9a-f]{64}$/;

type PolicyResolveTarget = (typeof TARGETS)[number];
type PolicyResolveEffect = (typeof EFFECTS)[number];

export interface PolicyResolveResultV1 {
  readonly authority: "verified" | "unverified";
  readonly qualification: "qualified" | "unqualified";
  readonly observation: "missing";
  readonly effective: ObservedEffectResolution["state"] | "input-invalid";
  readonly outcome: "partial" | "refused";
}

function optionString(ctx: PlanContext, key: string): string | undefined {
  const value = ctx.options[key];
  return typeof value === "string" && value === value.trim() && value.length > 0
    ? value
    : undefined;
}

function input(ctx: PlanContext):
  | {
      decision: string;
      digest: string;
      target: PolicyResolveTarget;
      effect: PolicyResolveEffect;
      evidence: string;
    }
  | undefined {
  const decision = optionString(ctx, "decision");
  const digest = optionString(ctx, "decisionDigest");
  const target = optionString(ctx, "target");
  const effect = optionString(ctx, "effect");
  const evidence = optionString(ctx, "evidence");
  if (
    decision === undefined ||
    !/^[a-z][a-z0-9-]{0,63}$/.test(decision) ||
    digest === undefined ||
    !SHA256.test(digest) ||
    target === undefined ||
    !TARGETS.includes(target as PolicyResolveTarget) ||
    effect === undefined ||
    !EFFECTS.includes(effect as PolicyResolveEffect) ||
    evidence === undefined
  )
    return undefined;
  return {
    decision,
    digest,
    target: target as PolicyResolveTarget,
    effect: effect as PolicyResolveEffect,
    evidence,
  };
}

function refused(effective: PolicyResolveResultV1["effective"]): PolicyResolveResultV1 {
  return {
    authority: "unverified",
    qualification: "unqualified",
    observation: "missing",
    effective,
    outcome: "refused",
  };
}

function refusedAfterAuthority(
  effective: PolicyResolveResultV1["effective"],
): PolicyResolveResultV1 {
  return {
    authority: "verified",
    qualification: "unqualified",
    observation: "missing",
    effective,
    outcome: "refused",
  };
}

function referencedDecision(
  authority: Awaited<ReturnType<typeof verifyPolicyAuthorityReceipt>>["authority"],
  reference: { decision: string; digest: string },
): GovernanceDecisionV2 | undefined {
  if (authority?.receipt.version !== 3) return undefined;
  return authority.receipt.decisions.find(
    (candidate) =>
      candidate.id === reference.decision &&
      governanceDecisionDigestV2(candidate) === reference.digest,
  );
}

const noObservationExpectation = {
  expectedVerifier: { id: "policy-resolve", version: "1", digest: `sha256:${"0".repeat(64)}` },
  expectedInstalled: { id: "policy-resolve", digest: `sha256:${"0".repeat(64)}` },
  expectedIntegration: { mode: "upstream-managed" as const, owner: "policy-resolve", version: "1" },
};

/**
 * Read-only V3 authority + organization-evidence resolver. It intentionally
 * supplies no observation or caller-owned verifier, so success is always a
 * non-effective partial result until upstream-managed observation exists.
 */
export async function resolvePolicyEvidenceV1(ctx: PlanContext): Promise<PolicyResolveResultV1> {
  const requested = input(ctx);
  if (requested === undefined) return refused("input-invalid");
  const custody = custodyOrganizationEvidenceV1(ctx.root, requested.evidence);
  if ("problem" in custody) return refused("input-invalid");
  const verified = await verifyPolicyAuthorityReceipt(ctx);
  if (verified.authority === undefined) return refused("authority-unverified");
  if (verified.authority.receipt.version !== 3) return refused("authority-version");
  if (!custody.evidence.unchanged()) return refusedAfterAuthority("qualification-unverified");
  const decision = referencedDecision(verified.authority, requested);
  if (decision === undefined) return refusedAfterAuthority("decision-missing-or-mismatch");
  const now = new Date().toISOString();
  const qualification = verifyOrganizationQualificationV1({
    authority: verified.authority,
    bytes: custody.evidence.bytes,
    decisionReference: { id: requested.decision, digest: requested.digest },
    effect: requested.effect,
    now,
    subject: decision.subject,
    supportedTargets: TARGETS,
    target: requested.target,
  });
  const effective = resolveObservedEffect({
    authority: verified.authority,
    decisionReference: { id: requested.decision, digest: requested.digest },
    qualification,
    subject: decision.subject,
    target: requested.target,
    effect: requested.effect,
    supportedTargets: TARGETS,
    now,
    ...noObservationExpectation,
  });
  return {
    authority: "verified",
    qualification: qualification === undefined ? "unqualified" : "qualified",
    observation: "missing",
    effective: effective.state,
    outcome: effective.state === "observation-missing" ? "partial" : "refused",
  };
}

function resultCheck(result: PolicyResolveResultV1): Check {
  return result.outcome === "partial"
    ? {
        name: "policy resolve",
        verdict: "fail",
        code: "org-policy.effective-blocked",
        detail: "upstream observation is missing",
      }
    : {
        name: "policy resolve",
        verdict: "fail",
        code: "org-policy.effective-blocked",
        detail: "policy resolution refused",
      };
}

export function policyResolvePlan(ctx: PlanContext): Plan {
  const resolution = resolvePolicyEvidenceV1(ctx);
  return plan(
    "policy resolve",
    dynamicDigest("policy resolve", async () => ({
      text: JSON.stringify(await resolution),
      data: await resolution,
    })),
    probe("policy resolve", async () => resultCheck(await resolution)),
  );
}

export const policyResolveCommand: CommandSpec = {
  name: "resolve",
  summary:
    "Resolve V3 authority and canonical organization evidence without executing or observing a candidate",
  readOnly: true,
  zeroWrite: true,
  alwaysVerify: true,
  options: [
    { flags: "--decision <id>", description: "exact V3 governance decision identifier (required)" },
    {
      flags: "--decision-digest <sha256>",
      description: "exact V3 governance decision digest (required)",
    },
    { flags: "--target <id>", description: "code-owned target identifier (required)" },
    {
      flags: "--effect <effect>",
      description: "requested governed effect: configure, install, observe, or use (required)",
    },
    {
      flags: "--evidence <root-relative-file>",
      description: "canonical organization evidence envelope below the target root (required)",
    },
  ],
  plan: policyResolvePlan,
};
