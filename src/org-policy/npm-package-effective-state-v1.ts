import type { PlanContext } from "../internals/plan.js";
import {
  isVerifiedPolicyAuthority,
  type PolicyAuthorityVerification,
  type VerifiedPolicyAuthority,
  verifyPolicyAuthorityReceipt,
} from "./authority.js";
import { type GovernanceDecisionV2, governanceDecisionDigestV2 } from "./governance-decision-v2.js";
import {
  type NpmPackageLifecycleStoredStateV1,
  readNpmPackageLifecycleStoreV1,
} from "./npm-package-lifecycle-v1.js";

export interface NpmPackageEffectiveStateV1 {
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
  readonly recordDigest?: string;
  readonly subjectId?: string;
  readonly target?: string;
}

/** One fresh verifier result is shared by runtime policy and lifecycle state. */
export interface NpmPackageEffectiveStateResolutionV1 {
  readonly authority: PolicyAuthorityVerification;
  readonly states: readonly NpmPackageEffectiveStateV1[];
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
  record: NpmPackageLifecycleStoredStateV1,
  state: NpmPackageEffectiveStateV1["state"],
  reason: string,
): NpmPackageEffectiveStateV1 {
  return {
    decision: record.decision,
    recordDigest: record.recordDigest,
    reason,
    state,
    subjectId: record.lineage.subjectId,
    target: record.lineage.target,
  };
}

function matchesRecord(
  decision: GovernanceDecisionV2,
  record: NpmPackageLifecycleStoredStateV1,
): boolean {
  const source = decision.subject.source;
  const observation = record.observation;
  return (
    decision.subject.kind === "package" &&
    source.type === "npm" &&
    source.registry === record.lineage.npm.registry &&
    source.package === record.lineage.npm.package &&
    decision.subject.id === record.lineage.subjectId &&
    decision.subject.subjectDigest === record.subjectDigest &&
    decision.targets.includes(record.lineage.target as never) &&
    decision.allowedEffects.includes("install") &&
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
        observation.allowedEffects[0] === "install" &&
        observation.integration.mode === record.lineage.integration.mode &&
        observation.integration.owner === record.lineage.integration.owner &&
        observation.integration.version === record.lineage.integration.version))
  );
}

function subjectWideRejection(
  decision: GovernanceDecisionV2,
  authority: VerifiedPolicyAuthority,
  record: NpmPackageLifecycleStoredStateV1,
  now: number,
): boolean {
  const receipt = authority.receipt;
  if (receipt.version !== 3) return false;
  return receipt.decisions.some((candidate) => {
    const digest = governanceDecisionDigestV2(candidate);
    return (
      candidate.disposition === "rejected" &&
      currentDecision(candidate, now) &&
      candidate.subject.subjectDigest === decision.subject.subjectDigest &&
      candidate.targets.includes(record.lineage.target as never) &&
      candidate.allowedEffects.includes("install") &&
      !receipt.decisionRevocations.some(
        (revocation) =>
          revocation.decisionDigest === digest && Date.parse(revocation.revokedAt) <= now,
      )
    );
  });
}

function resolveRecord(
  record: NpmPackageLifecycleStoredStateV1,
  authority: PolicyAuthorityVerification["authority"],
  authorityProblem: string | undefined,
  now: number,
): NpmPackageEffectiveStateV1 {
  if (!isVerifiedPolicyAuthority(authority) || authority.receipt.version !== 3)
    return base(
      record,
      authorityProblem === "authority receipt is not currently valid" ? "stale" : "withheld",
      authorityProblem === "authority receipt is not currently valid"
        ? "authority-not-current"
        : "authority-unverified",
    );
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
  if (record.observation === undefined || record.observation.outcome !== "observed-success")
    return base(record, "partial", "observation-partial");
  if (Date.parse(record.observation.observedAt) > now)
    return base(record, "drifted", "observation-drift");
  if (now >= Date.parse(record.observation.validUntil))
    return base(record, "stale", "observation-stale");
  return base(record, "observed-effective", "current-exact-observation");
}

/**
 * Re-resolves persisted npm lifecycle records against freshly verified authority.
 * It only reads the fixed lifecycle store and authority receipt; it never
 * installs, configures, projects, or executes a package.
 */
function resolveStore(
  root: string,
  authority: PolicyAuthorityVerification,
): readonly NpmPackageEffectiveStateV1[] {
  const store = readNpmPackageLifecycleStoreV1(root);
  if (store.kind === "absent") return [];
  if (store.kind !== "complete") {
    return [{ state: "partial", reason: `lifecycle-store-${store.kind}` as const }];
  }
  const now = Date.now();
  return store.records.map((record) =>
    resolveRecord(record, authority.authority, authority.problem, now),
  );
}

/** Re-verify authority once, then resolve only fixed durable lifecycle data. */
export async function npmPackageEffectiveStateResolutionV1(
  ctx: PlanContext,
): Promise<NpmPackageEffectiveStateResolutionV1> {
  const authority = await verifyPolicyAuthorityReceipt(ctx);
  return { authority, states: resolveStore(ctx.root, authority) };
}

/** Public read-only adapter; callers cannot inject a previously verified authority. */
export async function resolveNpmPackageEffectiveStateV1(
  ctx: PlanContext,
): Promise<readonly NpmPackageEffectiveStateV1[]> {
  return (await npmPackageEffectiveStateResolutionV1(ctx)).states;
}
