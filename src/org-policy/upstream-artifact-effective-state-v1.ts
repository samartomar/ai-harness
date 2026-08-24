import type { PlanContext } from "../internals/plan.js";
import {
  isVerifiedPolicyAuthority,
  type PolicyAuthorityVerification,
  type VerifiedPolicyAuthority,
  verifyPolicyAuthorityReceipt,
} from "./authority.js";
import { type GovernanceDecisionV2, governanceDecisionDigestV2 } from "./governance-decision-v2.js";
import {
  readUpstreamArtifactLifecycleStoreV1,
  type UpstreamArtifactLifecycleStoredStateV1,
} from "./upstream-artifact-lifecycle-v1.js";

export interface UpstreamArtifactEffectiveStateV1 {
  readonly state:
    | "observed-effective"
    | "partial"
    | "revoked"
    | "stale"
    | "drifted"
    | "refused"
    | "withheld";
  readonly reason: string;
  readonly decision?: { readonly digest: string; readonly id: string };
  readonly effect?: string;
  readonly recordDigest?: string;
  readonly subject?: { readonly id: string; readonly kind: string };
  readonly target?: string;
}

export interface UpstreamArtifactEffectiveStateResolutionV1 {
  readonly authority: PolicyAuthorityVerification;
  readonly states: readonly UpstreamArtifactEffectiveStateV1[];
}

function currentDecision(decision: GovernanceDecisionV2, now: number): boolean {
  return (
    Date.parse(decision.issuedAt) <= now &&
    Date.parse(decision.notBefore) <= now &&
    now < Date.parse(decision.expiresAt) &&
    (decision.disposition !== "accepted-with-conditions" || now < Date.parse(decision.reviewBy))
  );
}

function base(
  record: UpstreamArtifactLifecycleStoredStateV1,
  state: UpstreamArtifactEffectiveStateV1["state"],
  reason: string,
): UpstreamArtifactEffectiveStateV1 {
  return {
    decision: record.decision,
    effect: record.lineage.effect,
    reason,
    recordDigest: record.recordDigest,
    state,
    subject: record.lineage.subject,
    target: record.lineage.target,
  };
}

function sameIntegration(
  left: { readonly mode: string; readonly owner: string },
  right: UpstreamArtifactLifecycleStoredStateV1["lineage"]["integration"],
): boolean {
  return left.mode === right.mode && left.owner === right.owner;
}

function matchesRecord(
  decision: GovernanceDecisionV2,
  record: UpstreamArtifactLifecycleStoredStateV1,
): boolean {
  const observation = record.observation;
  return (
    decision.qualificationBasis.kind === "organization-qualified" &&
    decision.subject.kind === record.lineage.subject.kind &&
    decision.subject.id === record.lineage.subject.id &&
    decision.subject.subjectDigest === record.subjectDigest &&
    record.subject.kind === decision.subject.kind &&
    record.subject.id === decision.subject.id &&
    decision.targets.includes(record.lineage.target as never) &&
    decision.allowedEffects.includes(record.lineage.effect) &&
    (observation === undefined ||
      (observation.decision.id === record.decision.id &&
        observation.decision.digest === record.decision.digest &&
        observation.subject.kind === decision.subject.kind &&
        observation.subject.id === decision.subject.id &&
        observation.subject.sourceDigest === decision.subject.sourceDigest &&
        observation.subject.subjectDigest === decision.subject.subjectDigest &&
        observation.targets.length === 1 &&
        observation.targets[0] === record.lineage.target &&
        observation.allowedEffects.length === 1 &&
        observation.allowedEffects[0] === record.lineage.effect &&
        sameIntegration(observation.integration, record.lineage.integration)))
  );
}

function subjectWideRejection(
  decision: GovernanceDecisionV2,
  authority: VerifiedPolicyAuthority,
  record: UpstreamArtifactLifecycleStoredStateV1,
  now: number,
): boolean {
  if (authority.receipt.version !== 3) return false;
  const receipt = authority.receipt;
  return receipt.decisions.some((candidate) => {
    const digest = governanceDecisionDigestV2(candidate);
    return (
      candidate.disposition === "rejected" &&
      currentDecision(candidate, now) &&
      candidate.subject.subjectDigest === decision.subject.subjectDigest &&
      candidate.targets.includes(record.lineage.target as never) &&
      candidate.allowedEffects.includes(record.lineage.effect) &&
      !receipt.decisionRevocations.some(
        (revocation) =>
          revocation.decisionDigest === digest && Date.parse(revocation.revokedAt) <= now,
      )
    );
  });
}

function resolveRecord(
  record: UpstreamArtifactLifecycleStoredStateV1,
  authority: PolicyAuthorityVerification["authority"],
  authorityProblem: string | undefined,
  now: number,
): UpstreamArtifactEffectiveStateV1 {
  if (!isVerifiedPolicyAuthority(authority) || authority.receipt.version !== 3) {
    return base(
      record,
      authorityProblem === "authority receipt is not currently valid" ? "stale" : "withheld",
      authorityProblem === "authority receipt is not currently valid"
        ? "authority-not-current"
        : "authority-unverified",
    );
  }
  if (
    now < Date.parse(authority.receipt.issuedAt) ||
    now >= Date.parse(authority.receipt.expiresAt)
  )
    return base(record, "stale", "authority-not-current");
  const decision = authority.receipt.decisions.find(
    (candidate) =>
      candidate.id === record.decision.id &&
      governanceDecisionDigestV2(candidate) === record.decision.digest,
  );
  if (decision === undefined || !matchesRecord(decision, record))
    return base(record, "drifted", "decision-or-custody-drift");
  if (subjectWideRejection(decision, authority, record, now) || decision.disposition === "rejected")
    return base(record, "refused", "decision-rejected");
  const revocation = authority.receipt.decisionRevocations.find(
    (candidate) =>
      candidate.decisionDigest === record.decision.digest && Date.parse(candidate.revokedAt) <= now,
  );
  if (revocation !== undefined) return base(record, "revoked", "decision-revoked");
  if (record.authorityReceiptDigest !== authority.receiptDigest)
    return base(record, "drifted", "authority-receipt-drift");
  if (!currentDecision(decision, now)) return base(record, "stale", "decision-not-current");
  if (record.state === "decision-revoked") return base(record, "drifted", "revocation-drift");
  const observation = record.observation;
  if (observation === undefined || observation.outcome !== "observed-success")
    return base(record, "partial", "observation-partial");
  if (Date.parse(observation.observedAt) > now) return base(record, "drifted", "observation-drift");
  if (now >= Date.parse(observation.validUntil)) return base(record, "stale", "observation-stale");
  return base(record, "observed-effective", "current-exact-recorded-observation");
}

/** Resolve only the fixed durable store using one freshly verified authority result. */
export function resolveUpstreamArtifactEffectiveStateWithAuthorityV1(
  root: string,
  authority: PolicyAuthorityVerification,
): readonly UpstreamArtifactEffectiveStateV1[] {
  const store = readUpstreamArtifactLifecycleStoreV1(root);
  if (store.kind === "absent") return [];
  if (store.kind !== "complete")
    return [{ state: "partial", reason: `lifecycle-store-${store.kind}` }];
  const now = Date.now();
  return store.records.map((record) =>
    resolveRecord(record, authority.authority, authority.problem, now),
  );
}

/** Re-verify authority once, then resolve the fixed upstream-artifact lifecycle store. */
export async function upstreamArtifactEffectiveStateResolutionV1(
  ctx: PlanContext,
): Promise<UpstreamArtifactEffectiveStateResolutionV1> {
  const authority = await verifyPolicyAuthorityReceipt(ctx);
  return {
    authority,
    states: resolveUpstreamArtifactEffectiveStateWithAuthorityV1(ctx.root, authority),
  };
}

/** Public read-only adapter; callers cannot inject a self-described authority. */
export async function resolveUpstreamArtifactEffectiveStateV1(
  ctx: PlanContext,
): Promise<readonly UpstreamArtifactEffectiveStateV1[]> {
  return (await upstreamArtifactEffectiveStateResolutionV1(ctx)).states;
}
