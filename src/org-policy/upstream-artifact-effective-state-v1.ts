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
import {
  reobserveUpstreamArtifactWithAuthorityV1,
  upstreamArtifactObservationHandoffForLifecycleV1,
} from "./upstream-artifact-observer-v1.js";

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

async function resolveRecord(
  record: UpstreamArtifactLifecycleStoredStateV1,
  ctx: PlanContext,
  verification: PolicyAuthorityVerification,
  now: number,
): Promise<UpstreamArtifactEffectiveStateV1> {
  const authority = verification.authority;
  const authorityProblem = verification.problem;
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
  if (record.request === undefined) return base(record, "partial", "observation-request-missing");
  if (Date.parse(observation.observedAt) > now) return base(record, "drifted", "observation-drift");
  if (now >= Date.parse(observation.validUntil)) return base(record, "stale", "observation-stale");
  const live = await reobserveUpstreamArtifactWithAuthorityV1(ctx, verification, record.request);
  if (live.outcome !== "observed-effective")
    return base(record, "partial", `live-observation-${live.reason ?? "unverified"}`);
  const handoff = upstreamArtifactObservationHandoffForLifecycleV1(live);
  if (
    handoff === undefined ||
    handoff.request.decision !== record.request.decision ||
    handoff.request.digest !== record.request.digest ||
    handoff.request.evidence !== record.request.evidence ||
    handoff.request.manifest !== record.request.manifest ||
    handoff.request.target !== record.request.target ||
    handoff.decision.id !== record.decision.id ||
    governanceDecisionDigestV2(handoff.decision) !== record.decision.digest ||
    handoff.manifestDigest !== record.manifestDigest ||
    handoff.manifest.subject.kind !== record.lineage.subject.kind ||
    handoff.manifest.subject.id !== record.lineage.subject.id ||
    handoff.manifest.target !== record.lineage.target ||
    handoff.manifest.effect !== record.lineage.effect ||
    handoff.manifest.integration.owner !== record.lineage.integration.owner ||
    handoff.receipt.installed.id !== observation.installed.id ||
    handoff.receipt.installed.digest !== observation.installed.digest ||
    handoff.receipt.integration.mode !== observation.integration.mode ||
    handoff.receipt.integration.owner !== observation.integration.owner ||
    handoff.receipt.integration.version !== observation.integration.version ||
    handoff.receipt.verifier.id !== observation.verifier.id ||
    handoff.receipt.verifier.digest !== observation.verifier.digest ||
    handoff.receipt.verifier.version !== observation.verifier.version
  )
    return base(record, "drifted", "live-observation-drift");
  return base(record, "observed-effective", "current-exact-recorded-observation");
}

/** Resolve durable records only after live re-observation with one verified authority result. */
export async function resolveUpstreamArtifactEffectiveStateWithAuthorityV1(
  ctx: PlanContext,
  authority: PolicyAuthorityVerification,
): Promise<readonly UpstreamArtifactEffectiveStateV1[]> {
  const store = readUpstreamArtifactLifecycleStoreV1(ctx.root);
  if (store.kind === "absent") return [];
  if (store.kind !== "complete")
    return [{ state: "partial", reason: `lifecycle-store-${store.kind}` }];
  const now = Date.now();
  return Promise.all(store.records.map((record) => resolveRecord(record, ctx, authority, now)));
}

/** Re-verify authority once, then resolve the fixed upstream-artifact lifecycle store. */
export async function upstreamArtifactEffectiveStateResolutionV1(
  ctx: PlanContext,
): Promise<UpstreamArtifactEffectiveStateResolutionV1> {
  const authority = await verifyPolicyAuthorityReceipt(ctx);
  return {
    authority,
    states: await resolveUpstreamArtifactEffectiveStateWithAuthorityV1(ctx, authority),
  };
}

/** Public read-only adapter; callers cannot inject a self-described authority. */
export async function resolveUpstreamArtifactEffectiveStateV1(
  ctx: PlanContext,
): Promise<readonly UpstreamArtifactEffectiveStateV1[]> {
  return (await upstreamArtifactEffectiveStateResolutionV1(ctx)).states;
}
