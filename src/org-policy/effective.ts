import { createHash } from "node:crypto";
import {
  isVerifiedPolicyAuthority,
  type PolicyAuthorityReceipt,
  type VerifiedPolicyAuthority,
} from "./authority.js";
import { type GovernanceDecisionV1, governanceDecisionDigestV1 } from "./governance-decision-v1.js";
import type { NpmPackageEffectiveStateV1 } from "./npm-package-effective-state-v1.js";
import { governanceOwnsAihSurfaces, type OrgPolicy } from "./schema.js";
import type { UpstreamArtifactEffectiveStateV1 } from "./upstream-artifact-effective-state-v1.js";

/**
 * Assertions a detector made about a completed scan. A severe label is
 * evidence, not a verdict, so the accountable administrator decides each one:
 * reject the candidate, record a false positive, or accept the residual risk
 * with an attributable signed reason.
 */
export const DISPOSITIONABLE_POLICY_FINDING_CODES = [
  "malicious-code",
  "prompt-injection",
  "auto-executing-hook",
  "hidden-unicode",
  "secrets",
  "unpinned-source",
  "dependency-confusion",
  "unsafe-path",
] as const;

/**
 * Prerequisites AIH needs before it can evaluate or project at all. Each marks
 * something absent or untrustworthy rather than something a detector asserted,
 * so no signature substitutes for it and approval cannot invent it.
 */
export const FENCED_POLICY_PREREQUISITE_CODES = [
  "mandatory-detector-failed",
  "evidence-identity-drift",
  "missing-projector",
  "unsupported-target",
  "normalized-collision",
  "ownership-conflict",
] as const;

/**
 * The partition's union — the same 14 codes, none renamed or added. Resolution
 * still blocks on every one of them: separating the halves is what lets a
 * consumer tell a disposable finding from a hard prerequisite, and is not by
 * itself the administrator disposition flow, which does not exist yet.
 */
export const UNWAIVABLE_POLICY_DANGER_CODES = [
  ...DISPOSITIONABLE_POLICY_FINDING_CODES,
  ...FENCED_POLICY_PREREQUISITE_CODES,
] as const;

export type DispositionableFindingCode = (typeof DISPOSITIONABLE_POLICY_FINDING_CODES)[number];
export type FencedPrerequisiteCode = (typeof FENCED_POLICY_PREREQUISITE_CODES)[number];
export type PolicyDangerCode = (typeof UNWAIVABLE_POLICY_DANGER_CODES)[number];

/** True for a detector finding the accountable administrator may dispose of. */
export function isDispositionableFinding(value: string): value is DispositionableFindingCode {
  return (DISPOSITIONABLE_POLICY_FINDING_CODES as readonly string[]).includes(value);
}

/** True for a missing or untrustworthy prerequisite that no approval can waive. */
export function isFencedPrerequisite(value: string): value is FencedPrerequisiteCode {
  return (FENCED_POLICY_PREREQUISITE_CODES as readonly string[]).includes(value);
}
export type ResolutionBlockCode =
  | PolicyDangerCode
  | "lifecycle-not-supported"
  | "evidence-missing"
  | "evidence-failed"
  | "authority-receipt-unverified"
  | "authority-receipt-mismatch"
  | "approval-missing"
  | "approval-ambiguous"
  | "approval-expired"
  | "approval-not-yet-valid"
  | "approval-revoked"
  | "approval-signer-untrusted"
  | "approval-digest-mismatch"
  | "approval-scope-mismatch"
  | "approval-clarification-missing"
  | "authority-target-coverage-mismatch"
  | "approval-policy-version-mismatch"
  | "approval-duration-invalid"
  | "framework-contract-unavailable";

export type PolicyDecisionBlockCode =
  | "decision-receipt-missing"
  | "decision-receipt-version"
  | "decision-receipt-expired"
  | "decision-reference-missing"
  | "decision-reference-unresolved";
export type CandidateDecisionBlockCode =
  | "decision-missing"
  | "decision-ambiguous"
  | "decision-receipt-mismatch"
  | "decision-signer-mismatch"
  | "decision-subject-mismatch"
  | "decision-control-mismatch"
  | "decision-scope-mismatch"
  | "decision-coverage-mismatch"
  | "decision-rejected"
  | "decision-revoked"
  | "decision-not-yet-valid"
  | "decision-expired"
  | "decision-review-overdue";
export type DecisionSubjectField =
  | "candidate"
  | "kind"
  | "sourceDigest"
  | "evidenceDigest"
  | "reviewedControlDigest"
  | "policyVersion"
  | "targets"
  | "effects"
  | "issuer";
export type PolicyDecisionBlocker = {
  scope: "policy";
  code: PolicyDecisionBlockCode;
  decision?: string;
};
export type CandidateDecisionBlocker = {
  scope: "candidate";
  code: CandidateDecisionBlockCode;
  decision?: string;
  field?: DecisionSubjectField;
  accepted?: string[];
  observed?: string[];
};
export type DecisionBlocker = PolicyDecisionBlocker | CandidateDecisionBlocker;

type Governance = NonNullable<OrgPolicy["governance"]>;
type Candidate = Governance["catalog"]["reviewed"][number];
type Approval = Governance["authority"]["approvals"][number];
type EvidenceRecord = Extract<PolicyAuthorityReceipt, { version: 1 | 2 }>["evidence"][number];
type Decision = GovernanceDecisionV1;

/** The immutable, action-significant identity of an AIH-shipped reviewed control. */
export type AiReviewedControl = Pick<
  Candidate,
  "id" | "kind" | "source" | "targets" | "projector" | "lifecycle"
>;

/** Built only from the live AIH catalog and owned adapter records at runtime. */
export interface RuntimeReviewedControl {
  control: AiReviewedControl;
  controlDigest: string;
}

export interface RuntimeMcpIdentity {
  subject: string;
  projectable: boolean;
  /** Whether the rendered runtime entry has a Kiro-supported stdio transport. */
  kiroProjectable?: boolean;
}

export interface RuntimeHookIdentity {
  scriptDigest: string;
  projectable: boolean;
}

export interface EffectivePolicyContext {
  now?: Date;
  /** Branded only after a protected file or optional GitHub receipt passes verification. */
  authority?: VerifiedPolicyAuthority;
  /** Actual adapter target set for this invocation; omitted means Claude's leaf-command default. */
  targets?: readonly string[];
  /** Whether this invocation can emit managed adapter actions at all. */
  projectorsEnabled?: boolean;
  /** Exact runtime reason when projectors are intentionally unavailable. */
  projectorDisabledReason?: "vibe-posture";
  mcpIdentities?: Readonly<Record<string, RuntimeMcpIdentity>>;
  hookIdentities?: Readonly<Record<string, RuntimeHookIdentity>>;
  /** Exact AIH-shipped control identities, built from live catalog + owned hooks. */
  aihReviewedControls?: Readonly<Record<string, RuntimeReviewedControl>>;
  projectorFindings?: Readonly<Record<string, readonly PolicyDangerCode[]>>;
  /** Read-only, current-authority comparison of durable npm lifecycle state. */
  npmPackageLifecycle?: readonly NpmPackageEffectiveStateV1[];
  /** Read-only, current-authority comparison of catalog-independent artifact state. */
  upstreamArtifactLifecycle?: readonly UpstreamArtifactEffectiveStateV1[];
}

export interface CandidateProjectionState {
  projector: string;
  requestedTargets: string[];
  supportedTargets: string[];
  availableTargets: string[];
  coverage: "complete" | "blocked";
  ownership:
    | "managed-settings-receipt"
    | "kiro-mcp-receipt"
    | "managed-settings-and-kiro-mcp-receipt"
    | "usage-hook-receipt"
    | "hook-registrar-receipt"
    | "unavailable";
  receipt: "pending-projection" | "unavailable";
}

export interface EffectivePolicyCandidate {
  id: string;
  origin: "reviewed" | "custom";
  kind: "mcp" | "hook" | "framework";
  requested: boolean;
  effective: boolean;
  sourceDigest: string;
  source: Candidate["source"];
  evidence: "verified" | "approved" | "missing" | "failed";
  evidenceRecord?: EvidenceRecord;
  approval?: {
    id: string;
    issuer: string;
    repository: string;
    attestationId: string;
    reason: string;
    clarification?: string;
    scope: string[];
    notBefore: string;
    expiresAt: string;
    subjectDigest: string;
  };
  revocation?: {
    issuer: string;
    revokedAt: string;
    reason: string;
  };
  decision?: {
    id: string;
    digest: string;
    issuer: string;
    actor: string;
    disposition: Decision["disposition"];
    conditions: string[];
    notBefore: string;
    expiresAt: string;
    reviewBy?: string;
    acceptedFindings: string[];
    acceptedGaps: string[];
    observedFindings: string[];
    observedGaps: string[];
    riskState?: "clean" | "accepted";
  };
  dangerCodes: PolicyDangerCode[];
  blockingCodes: ResolutionBlockCode[];
  decisionBlockers: CandidateDecisionBlocker[];
  /** Actionable resolver diagnostics; danger codes remain the stable policy fence. */
  resolutionReasons: string[];
  clarification?: string;
  annotation?: string;
  lifecycle: "supported" | "deprecated" | "retired";
  projection: CandidateProjectionState;
}

function candidateResolutionReasons(
  policy: OrgPolicy,
  candidate: Candidate,
  projection: CandidateProjectionState,
  context: EffectivePolicyContext,
): string[] {
  if (context.projectorsEnabled === false) {
    return [
      context.projectorDisabledReason === "vibe-posture"
        ? "projector-disabled-at-vibe-posture"
        : "projector-disabled-for-invocation",
    ];
  }
  if (
    candidate.kind === "mcp" &&
    (candidate.source.type === "stdio" || candidate.source.type === "remote")
  ) {
    return [`custom-${candidate.source.type}-source-is-authorable-only`];
  }

  const reasons: string[] = [];
  if (candidate.kind === "mcp" && policy.mcp?.allowManagedOnly !== true) {
    reasons.push("managed-only-projector-disabled-by-policy");
  }
  if (candidate.kind === "mcp" && candidate.source.type === "mcp") {
    const identity = context.mcpIdentities?.[candidate.source.server];
    if (identity === undefined || identity.subject !== candidate.source.subject) {
      reasons.push("runtime-mcp-identity-mismatch");
    } else if (!identity.projectable) {
      reasons.push("runtime-mcp-entry-is-not-projectable");
    }
  }

  // Naming only the deficit reads as a contradiction when an activation declares several
  // targets: selecting `kiro` alone reports `target-not-selected:claude`, so the operator
  // sees a target they never asked for and re-runs with the other one, flipping the error.
  // An activation is all-or-nothing (see `completeCoverage`), so the reason must state the
  // full requirement against what is actually selected — both are already in scope here.
  const requested = projection.requestedTargets.join(",") || "none";
  const unavailable = projection.requestedTargets.filter(
    (target) => !projection.availableTargets.includes(target),
  );
  if (unavailable.length > 0) {
    reasons.push(
      `target-not-selected:${unavailable.join(",")}` +
        ` (activation requires targets ${requested}; selected ${projection.availableTargets.join(",") || "none"})`,
    );
  }
  const unsupported = projection.requestedTargets.filter(
    (target) => !projection.supportedTargets.includes(target),
  );
  if (unsupported.length > 0) {
    reasons.push(
      `target-not-supported:${unsupported.join(",")}` +
        ` (activation requires targets ${requested}; this AIH ships projectors for ${projection.supportedTargets.join(",") || "none"})`,
    );
  }
  if (projection.coverage === "blocked" && reasons.length === 0) {
    reasons.push("projector-unavailable-for-candidate");
  }
  return sortedUnique(reasons);
}

export interface EffectiveOrgPolicy {
  capabilityPackages?: {
    catalog: { provider: "github"; repository: string };
    roots: string[];
  };
  policyVersion?: string;
  candidates: EffectivePolicyCandidate[];
  activeMcpServerIds: string[];
  frameworkSelections: Array<{ id: string; framework: "ecc" | "superpowers" }>;
  /**
   * Admin-authored external framework curation. It is deliberately surfaced
   * only as report metadata: AIH has no installer or projector for it.
   */
  externalCuration: Array<{
    framework: "ecc" | "superpowers";
    items: Array<{
      kind: "agent" | "skill" | "command";
      id: string;
      source: { repository: string; commit: string; path: string };
      audit: { record: string; digest: string };
      clarification?: string;
    }>;
    status: "external-guidance";
  }>;
  /**
   * Admin-requested intent over externally-owned inventory whose audit evidence
   * does not exist yet. It is reported so a target repository can see exactly
   * what was asked for; it is never a candidate and never becomes effective.
   */
  externalSelections: Array<{
    framework: "ecc" | "superpowers";
    /** Explicit administrator choices; absent on legacy schema-v2 policies. */
    roots?: string[];
    items: Array<{
      kind: string;
      id: string;
      source: { repository: string; commit: string; path: string };
    }>;
    status: "requested-evidence-needed";
  }>;
  /** Observed package state only; it is never a projector or runtime control. */
  npmPackageLifecycle?: readonly NpmPackageEffectiveStateV1[];
  /** Observed organization-managed artifact state; it never installs or projects the artifact. */
  upstreamArtifactLifecycle?: readonly UpstreamArtifactEffectiveStateV1[];
  decisionBlockers: PolicyDecisionBlocker[];
  /** Projection has a narrower lifecycle gate than evaluate/doctor. */
  projectionBlocking?: boolean;
  blocking: boolean;
  authority: { verified: boolean; receiptDigest?: string; problem?: string };
}

export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => ordinalCompare(left, right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function ordinalCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** An aged observation fails evaluation but cannot freeze unrelated projection. */
export function lifecycleStateBlocksProjection(item: NpmPackageEffectiveStateV1): boolean {
  return !(
    item.state === "observed-effective" ||
    (item.state === "stale" && item.reason === "observation-stale")
  );
}

function upstreamArtifactStateBlocksProjection(item: UpstreamArtifactEffectiveStateV1): boolean {
  return !(
    item.state === "observed-effective" ||
    (item.state === "stale" && item.reason === "observation-stale")
  );
}

/** Digest only immutable source identity, never catalog wording or an activation flag. */
export function candidateIdentityDigest(candidate: Pick<Candidate, "source">): string {
  return `sha256:${createHash("sha256").update(stableJson(candidate.source), "utf8").digest("hex")}`;
}

/** Digest every action-significant field; catalog prose and annotations remain report metadata. */
export function reviewedControlDigest(control: AiReviewedControl): string {
  const payload = {
    id: control.id,
    kind: control.kind,
    source: control.source,
    targets: sortedUnique(control.targets),
    projector: control.projector,
    lifecycle: control.lifecycle,
  };
  return `sha256:${createHash("sha256").update(stableJson(payload), "utf8").digest("hex")}`;
}

/**
 * Full approval subject, deliberately excluding only its post-signing transport
 * locator (`github.attestationId`) and its derived digest (`subjectDigest`).
 */
export function approvalAttestationDigest(
  approval: Pick<
    Approval,
    | "id"
    | "issuer"
    | "candidate"
    | "kind"
    | "source"
    | "sourceDigest"
    | "evidenceDigest"
    | "projector"
    | "policyVersion"
    | "reason"
    | "clarification"
    | "scope"
    | "notBefore"
    | "expiresAt"
    | "github"
  >,
): string {
  const payload = {
    id: approval.id,
    issuer: approval.issuer,
    signerRepository: approval.github.repository,
    candidate: approval.candidate,
    kind: approval.kind,
    source: approval.source,
    sourceDigest: approval.sourceDigest,
    evidenceDigest: approval.evidenceDigest,
    projector: approval.projector,
    policyVersion: approval.policyVersion,
    reason: approval.reason,
    ...(approval.clarification === undefined ? {} : { clarification: approval.clarification }),
    scope: sortedUnique(approval.scope),
    notBefore: approval.notBefore,
    expiresAt: approval.expiresAt,
  };
  return `sha256:${createHash("sha256").update(stableJson(payload), "utf8").digest("hex")}`;
}

function sortedUnique<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort(ordinalCompare);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return stableJson(sortedUnique(left)) === stableJson(sortedUnique(right));
}

function isUnwaivable(value: string): value is PolicyDangerCode {
  return (UNWAIVABLE_POLICY_DANGER_CODES as readonly string[]).includes(value);
}

function runtimeTargets(context: EffectivePolicyContext): string[] {
  return sortedUnique(context.targets?.length ? context.targets : ["claude"]);
}

function projectionCoverage(
  requested: readonly string[],
  supportedTargets: readonly string[],
  availableTargets: readonly string[],
): "complete" | "blocked" {
  const supported = new Set(supportedTargets);
  const available = new Set(availableTargets);
  return requested.every((target) => supported.has(target) && available.has(target))
    ? "complete"
    : "blocked";
}

function projectorSupportedTargets(
  candidate: Candidate,
  context: EffectivePolicyContext,
): string[] {
  if (candidate.kind === "mcp" && candidate.projector === "mcp-managed-settings") {
    // A package/version/integrity declaration identifies the intended custom
    // process but is not an integrity-enforcing materializer. Until AIH owns
    // that lifecycle, it remains authorable/reportable and cannot project.
    if (candidate.source.type === "stdio" || candidate.source.type === "remote") return [];
    const kiroProjectable =
      candidate.source.type !== "mcp" ||
      context.mcpIdentities?.[candidate.source.server]?.kiroProjectable !== false;
    return kiroProjectable ? ["claude", "kiro"] : ["claude"];
  }
  if (candidate.kind === "hook" && candidate.projector === "hook-managed-settings") {
    return ["claude"];
  }
  if (candidate.kind === "hook" && candidate.projector === "usage-hook") {
    return ["claude", "codex"];
  }
  return [];
}

function projectorFor(
  candidate: Candidate,
  requestedTargets: readonly string[],
  context: EffectivePolicyContext,
): CandidateProjectionState {
  const availableTargets = runtimeTargets(context);
  const requested = sortedUnique(requestedTargets);
  const supportedTargets = projectorSupportedTargets(candidate, context);
  if (context.projectorsEnabled === false) {
    return {
      projector: candidate.projector,
      requestedTargets: requested,
      supportedTargets,
      availableTargets,
      coverage: "blocked",
      ownership: "unavailable",
      receipt: "unavailable",
    };
  }
  if (candidate.kind === "mcp" && candidate.projector === "mcp-managed-settings") {
    if (supportedTargets.length === 0) {
      return {
        projector: candidate.projector,
        requestedTargets: requested,
        supportedTargets: [],
        availableTargets,
        coverage: "blocked",
        ownership: "unavailable",
        receipt: "unavailable",
      };
    }
    return {
      projector: candidate.projector,
      requestedTargets: requested,
      supportedTargets,
      availableTargets,
      coverage: projectionCoverage(requested, supportedTargets, availableTargets),
      ownership:
        requested.length === 1 && requested[0] === "kiro"
          ? "kiro-mcp-receipt"
          : requested.includes("kiro")
            ? "managed-settings-and-kiro-mcp-receipt"
            : "managed-settings-receipt",
      receipt: "pending-projection",
    };
  }
  if (candidate.kind === "hook" && candidate.projector === "hook-managed-settings") {
    // The registrar owns the client's native hook configuration. Claude only:
    // Codex publishes no per-event hook output contract AIH has evidence for,
    // and asserting one without a runtime probe would be a guess.
    return {
      projector: candidate.projector,
      requestedTargets: requested,
      supportedTargets,
      availableTargets,
      coverage: projectionCoverage(requested, supportedTargets, availableTargets),
      ownership: "hook-registrar-receipt",
      receipt: "pending-projection",
    };
  }
  if (candidate.kind === "hook" && candidate.projector === "usage-hook") {
    return {
      projector: candidate.projector,
      requestedTargets: requested,
      supportedTargets,
      availableTargets,
      coverage: projectionCoverage(requested, supportedTargets, availableTargets),
      ownership: "usage-hook-receipt",
      receipt: "pending-projection",
    };
  }
  return {
    projector: candidate.projector,
    requestedTargets: requested,
    supportedTargets: [],
    availableTargets,
    coverage: "blocked",
    ownership: "unavailable",
    receipt: "unavailable",
  };
}

function completeCoverage(projection: CandidateProjectionState, candidate: Candidate): boolean {
  const supported = new Set(projection.supportedTargets);
  const available = new Set(projection.availableTargets);
  return (
    projection.coverage === "complete" &&
    projection.requestedTargets.every((target) => supported.has(target) && available.has(target)) &&
    projection.requestedTargets.every((target) =>
      candidate.targets.includes(target as "claude" | "codex" | "kiro"),
    )
  );
}

function aihShippedEvidence(
  candidate: Candidate,
  context: EffectivePolicyContext,
): EvidenceRecord | undefined {
  const sourceDigest = candidateIdentityDigest(candidate);
  const reviewed = context.aihReviewedControls?.[candidate.id];
  const candidateAtShippedTargetCoverage = {
    ...candidate,
    targets: reviewed?.control.targets ?? candidate.targets,
  };
  if (
    reviewed === undefined ||
    reviewed.controlDigest !== reviewedControlDigest(reviewed.control) ||
    reviewed.controlDigest !== reviewedControlDigest(candidateAtShippedTargetCoverage) ||
    !candidate.targets.every((target) => reviewed.control.targets.includes(target))
  ) {
    return undefined;
  }
  if (
    candidate.kind === "mcp" &&
    (candidate.source.type !== "mcp" || candidate.id !== candidate.source.server)
  ) {
    return undefined;
  }
  return {
    id: `aih-${candidate.id}`,
    candidate: candidate.id,
    kind: candidate.kind,
    source: candidate.source,
    sourceDigest,
    evidenceDigest: sourceDigest,
    identityDigest: sourceDigest,
    state: "verified",
    waivable: false,
    detectors: [],
    findings: [],
  };
}

function receiptEvidence(
  candidate: Candidate,
  authority: VerifiedPolicyAuthority | undefined,
): EvidenceRecord | undefined {
  if (authority === undefined || authority.receipt.version === 3) return undefined;
  const sourceDigest = candidateIdentityDigest(candidate);
  const matches = authority.receipt.evidence.filter(
    (record) => record.id === candidate.evidence.record,
  );
  if (matches.length !== 1) return undefined;
  const record = matches[0];
  if (
    record === undefined ||
    record.candidate !== candidate.id ||
    record.kind !== candidate.kind ||
    record.sourceDigest !== sourceDigest ||
    record.identityDigest !== sourceDigest ||
    stableJson(record.source) !== stableJson(candidate.source)
  ) {
    return undefined;
  }
  return record;
}

function matchingApproval(
  governance: Governance,
  candidate: Candidate,
  evidence: EvidenceRecord,
  requestedTargets: readonly string[],
  authority: VerifiedPolicyAuthority | undefined,
  now: Date,
): {
  approval?: Approval;
  code?: ResolutionBlockCode;
  revocation?: { issuer: string; revokedAt: string; reason: string };
} {
  if (
    authority === undefined ||
    !isVerifiedPolicyAuthority(authority) ||
    authority.receipt.version === 3
  ) {
    return { code: "authority-receipt-unverified" };
  }
  const sourceDigest = candidateIdentityDigest(candidate);
  const matches = governance.authority.approvals.filter(
    (approval) => approval.candidate === candidate.id && approval.sourceDigest === sourceDigest,
  );
  if (matches.length === 0) return { code: "approval-missing" };
  if (matches.length !== 1) return { code: "approval-ambiguous" };
  const approval = matches[0];
  if (approval === undefined) return { code: "approval-missing" };
  // Existing signed receipt inputs may omit this field for compatibility, but
  // an approval without a signed clarification cannot waive an evidence gap.
  if (approval.clarification === undefined) {
    return { code: "approval-clarification-missing" };
  }
  if (
    approval.kind !== candidate.kind ||
    approval.projector !== candidate.projector ||
    approval.evidenceDigest !== evidence.evidenceDigest ||
    stableJson(approval.source) !== stableJson(candidate.source)
  ) {
    return { code: "approval-digest-mismatch" };
  }
  if (approval.policyVersion !== governance.policyVersion) {
    return { code: "approval-policy-version-mismatch" };
  }
  if (!sameStrings(approval.scope, requestedTargets)) return { code: "approval-scope-mismatch" };
  if (approval.github.subjectDigest !== approvalAttestationDigest(approval)) {
    return { code: "approval-digest-mismatch" };
  }
  const signed = authority.receipt.approvals.filter(
    (item) => stableJson(item) === stableJson(approval),
  );
  if (signed.length !== 1) return { code: "authority-receipt-mismatch" };
  const issuer = authority.receipt.trustedIssuers.find((item) => item.id === approval.issuer);
  if (issuer === undefined || issuer.githubRepository !== approval.github.repository) {
    return { code: "approval-signer-untrusted" };
  }
  const notBefore = Date.parse(approval.notBefore);
  const expiresAt = Date.parse(approval.expiresAt);
  if (expiresAt <= notBefore || expiresAt - notBefore > 90 * 24 * 60 * 60 * 1000) {
    return { code: "approval-duration-invalid" };
  }
  if (now.getTime() < notBefore) return { code: "approval-not-yet-valid" };
  if (now.getTime() >= expiresAt) return { code: "approval-expired" };
  const revocation = authority.receipt.revocations.find(
    (item) =>
      item.approval === approval.id &&
      item.issuer === approval.issuer &&
      Date.parse(item.revokedAt) <= now.getTime(),
  );
  if (revocation !== undefined) {
    return {
      code: "approval-revoked",
      revocation: {
        issuer: revocation.issuer,
        revokedAt: revocation.revokedAt,
        reason: revocation.reason,
      },
    };
  }
  if (
    !requestedTargets.every(
      (target) =>
        (target === "claude" || target === "codex" || target === "kiro") &&
        authority.receipt.targets.includes(target),
    )
  ) {
    return { code: "approval-scope-mismatch" };
  }
  return { approval };
}

const REGISTERED_DECISION_EFFECTS: Readonly<Record<string, readonly string[]>> = {
  "mcp-managed-settings": ["managed-settings"],
  "hook-managed-settings": ["hook-managed-settings"],
  "usage-hook": ["usage-hook"],
  "framework-contract": ["framework-contract"],
};

function receiptIsCurrent(authority: VerifiedPolicyAuthority | undefined, now: Date): boolean {
  if (authority === undefined) return false;
  const issuedAt = Date.parse(authority.receipt.issuedAt);
  const expiresAt = Date.parse(authority.receipt.expiresAt);
  return issuedAt <= now.getTime() && now.getTime() < expiresAt;
}

function decisionIsRevoked(
  receipt: Extract<PolicyAuthorityReceipt, { version: 2 }>,
  decision: Decision,
  now: Date,
): boolean {
  return receipt.decisionRevocations.some(
    (revocation) =>
      revocation.decision === decision.id &&
      revocation.issuer === decision.issuer &&
      Date.parse(revocation.revokedAt) <= now.getTime(),
  );
}

function currentDecisionState(
  receipt: Extract<PolicyAuthorityReceipt, { version: 2 }>,
  decision: Decision,
  now: Date,
): CandidateDecisionBlockCode | undefined {
  if (decisionIsRevoked(receipt, decision, now)) return "decision-revoked";
  if (now.getTime() < Date.parse(decision.notBefore)) return "decision-not-yet-valid";
  if (now.getTime() >= Date.parse(decision.expiresAt)) return "decision-expired";
  return undefined;
}

function decisionSummary(
  decision: Decision,
  observedFindings: readonly string[],
  effective: boolean,
): NonNullable<EffectivePolicyCandidate["decision"]> {
  return {
    id: decision.id,
    digest: governanceDecisionDigestV1(decision),
    issuer: decision.issuer,
    actor: decision.actor,
    disposition: decision.disposition,
    conditions: sortedUnique(decision.conditions),
    notBefore: decision.notBefore,
    expiresAt: decision.expiresAt,
    ...(decision.disposition === "accepted-with-conditions" ? { reviewBy: decision.reviewBy } : {}),
    acceptedFindings: sortedUnique(decision.acceptedFindings),
    acceptedGaps: sortedUnique(decision.acceptedGaps),
    observedFindings: sortedUnique(observedFindings),
    observedGaps: [],
    ...(effective
      ? {
          riskState:
            decision.disposition === "approved" ? ("clean" as const) : ("accepted" as const),
        }
      : {}),
  };
}

function decisionJoinBlocker(
  decision: Decision,
  candidate: Candidate,
  origin: "reviewed" | "custom",
  evidence: EvidenceRecord | undefined,
  requestedTargets: readonly string[],
  governance: Governance,
  context: EffectivePolicyContext,
  receipt: Extract<PolicyAuthorityReceipt, { version: 2 }>,
): CandidateDecisionBlocker | undefined {
  const sourceDigest = candidateIdentityDigest(candidate);
  if (decision.kind !== candidate.kind) {
    return {
      scope: "candidate",
      code: "decision-subject-mismatch",
      decision: decision.id,
      field: "kind",
    };
  }
  if (decision.sourceDigest !== sourceDigest) {
    return {
      scope: "candidate",
      code: "decision-subject-mismatch",
      decision: decision.id,
      field: "sourceDigest",
    };
  }
  if (decision.evidenceDigest !== evidence?.evidenceDigest) {
    return {
      scope: "candidate",
      code: "decision-subject-mismatch",
      decision: decision.id,
      field: "evidenceDigest",
    };
  }
  if (decision.policyVersion !== governance.policyVersion) {
    return {
      scope: "candidate",
      code: "decision-subject-mismatch",
      decision: decision.id,
      field: "policyVersion",
    };
  }
  if (!sameStrings(decision.targets, requestedTargets)) {
    return {
      scope: "candidate",
      code: "decision-scope-mismatch",
      decision: decision.id,
      field: "targets",
    };
  }
  const effects = REGISTERED_DECISION_EFFECTS[candidate.projector] ?? [];
  if (!sameStrings(decision.effects, effects)) {
    return {
      scope: "candidate",
      code: "decision-scope-mismatch",
      decision: decision.id,
      field: "effects",
    };
  }
  const reviewed = context.aihReviewedControls?.[candidate.id];
  if (
    origin !== "reviewed" ||
    reviewed === undefined ||
    reviewed.controlDigest !== reviewedControlDigest(reviewed.control) ||
    decision.reviewedControlDigest !== reviewed.controlDigest
  ) {
    return {
      scope: "candidate",
      code: "decision-control-mismatch",
      decision: decision.id,
      field: "reviewedControlDigest",
    };
  }
  if (!receipt.trustedIssuers.some((issuer) => issuer.id === decision.issuer)) {
    return {
      scope: "candidate",
      code: "decision-signer-mismatch",
      decision: decision.id,
      field: "issuer",
    };
  }
  return undefined;
}

function policyDecisionBlockers(
  governance: Governance,
  candidates: readonly Candidate[],
  authority: VerifiedPolicyAuthority | undefined,
  now: Date,
): PolicyDecisionBlocker[] {
  const references = governance.authority.decisions;
  if (references.length === 0) return [];
  if (authority === undefined) return [{ scope: "policy", code: "decision-receipt-missing" }];
  if (authority.receipt.version !== 2)
    return [{ scope: "policy", code: "decision-receipt-version" }];
  if (!receiptIsCurrent(authority, now))
    return [{ scope: "policy", code: "decision-receipt-expired" }];
  const blockers: PolicyDecisionBlocker[] = [];
  for (const id of references) {
    const decision = authority.receipt.decisions.find((item) => item.id === id);
    if (decision === undefined) {
      blockers.push({ scope: "policy", code: "decision-reference-missing", decision: id });
    } else if (!candidates.some((candidate) => candidate.id === decision.candidate)) {
      blockers.push({ scope: "policy", code: "decision-reference-unresolved", decision: id });
    }
  }
  return blockers.sort((left, right) => {
    const leftKey = `${left.code}:${left.decision ?? ""}`;
    const rightKey = `${right.code}:${right.decision ?? ""}`;
    return ordinalCompare(leftKey, rightKey);
  });
}

function resolveDecision(
  governance: Governance,
  candidate: Candidate,
  origin: "reviewed" | "custom",
  evidence: EvidenceRecord | undefined,
  requestedTargets: readonly string[],
  context: EffectivePolicyContext,
  authority: VerifiedPolicyAuthority | undefined,
  now: Date,
): { decision?: Decision; blockers: CandidateDecisionBlocker[] } {
  if (
    authority === undefined ||
    authority.receipt.version !== 2 ||
    !receiptIsCurrent(authority, now)
  ) {
    return governance.authority.decisions.length === 0
      ? { blockers: [] }
      : { blockers: [{ scope: "candidate", code: "decision-receipt-mismatch" }] };
  }
  const receipt = authority.receipt;
  const referenced = receipt.decisions.filter(
    (decision) =>
      governance.authority.decisions.includes(decision.id) && decision.candidate === candidate.id,
  );
  const activeRejection = receipt.decisions.find(
    (decision) =>
      decision.disposition === "rejected" &&
      decision.candidate === candidate.id &&
      decision.kind === candidate.kind &&
      currentDecisionState(receipt, decision, now) === undefined,
  );
  if (activeRejection !== undefined) {
    return {
      decision: activeRejection,
      blockers: [{ scope: "candidate", code: "decision-rejected", decision: activeRejection.id }],
    };
  }
  if (governance.authority.decisions.length === 0) return { blockers: [] };
  if (referenced.length === 0) return { blockers: [] };

  const current = referenced.filter(
    (decision) =>
      decision.disposition !== "rejected" &&
      currentDecisionState(receipt, decision, now) === undefined,
  );
  const exact = current.filter(
    (decision) =>
      decisionJoinBlocker(
        decision,
        candidate,
        origin,
        evidence,
        requestedTargets,
        governance,
        context,
        receipt,
      ) === undefined,
  );
  if (exact.length > 1) {
    return {
      blockers: exact.map((decision) => ({
        scope: "candidate" as const,
        code: "decision-ambiguous" as const,
        decision: decision.id,
      })),
    };
  }
  if (exact.length === 1) return { decision: exact[0], blockers: [] };
  const firstCurrent = current[0];
  if (firstCurrent !== undefined) {
    return {
      decision: firstCurrent,
      blockers: [
        decisionJoinBlocker(
          firstCurrent,
          candidate,
          origin,
          evidence,
          requestedTargets,
          governance,
          context,
          receipt,
        ) ?? { scope: "candidate", code: "decision-subject-mismatch", decision: firstCurrent.id },
      ],
    };
  }
  const first = referenced[0];
  if (first === undefined) return { blockers: [{ scope: "candidate", code: "decision-missing" }] };
  return {
    decision: first,
    blockers: [
      {
        scope: "candidate",
        code: currentDecisionState(receipt, first, now) ?? "decision-subject-mismatch",
        decision: first.id,
      },
    ],
  };
}

function resolveCandidate(
  policy: OrgPolicy,
  governance: Governance,
  candidate: Candidate,
  origin: "reviewed" | "custom",
  context: EffectivePolicyContext,
  now: Date,
  policyDecisionBlocked: boolean,
): EffectivePolicyCandidate {
  const activation = governance.activations.find((item) => item.candidate === candidate.id);
  const requested = activation?.state === "active";
  const requestedTargets = activation?.targets ?? candidate.targets;
  const dangerCodes: PolicyDangerCode[] = [];
  const blockingCodes: ResolutionBlockCode[] = [];
  const projection = projectorFor(candidate, requestedTargets, context);
  const resolutionReasons = candidateResolutionReasons(policy, candidate, projection, context);
  const sourceDigest = candidateIdentityDigest(candidate);

  for (const finding of candidate.findings) if (isUnwaivable(finding)) dangerCodes.push(finding);
  for (const finding of context.projectorFindings?.[candidate.id] ?? []) dangerCodes.push(finding);
  if (candidate.autoExecute) dangerCodes.push("auto-executing-hook");
  if (!completeCoverage(projection, candidate)) dangerCodes.push("unsupported-target");
  if (candidate.lifecycle !== "supported") blockingCodes.push("lifecycle-not-supported");
  if (candidate.kind === "framework") blockingCodes.push("framework-contract-unavailable");
  if (projection.coverage === "blocked") dangerCodes.push("missing-projector");
  if (candidate.kind === "mcp" && policy.mcp?.allowManagedOnly !== true) {
    dangerCodes.push("missing-projector");
  }

  if (candidate.kind === "mcp" && candidate.source.type === "mcp") {
    const identity = context.mcpIdentities?.[candidate.source.server];
    if (identity === undefined || identity.subject !== candidate.source.subject) {
      dangerCodes.push("evidence-identity-drift");
    } else if (!identity.projectable) {
      dangerCodes.push("missing-projector");
    }
  } else if (
    candidate.kind === "mcp" &&
    (candidate.source.type === "stdio" || candidate.source.type === "remote")
  ) {
    dangerCodes.push("missing-projector");
  } else if (candidate.kind === "mcp") {
    dangerCodes.push("evidence-identity-drift");
  }
  if (candidate.kind === "hook") {
    const hook =
      candidate.source.type === "hook"
        ? context.hookIdentities?.[candidate.source.handler]
        : undefined;
    if (
      candidate.source.type !== "hook" ||
      candidate.projector !== "usage-hook" ||
      hook === undefined ||
      !hook.projectable ||
      hook.scriptDigest !== candidate.source.scriptDigest
    ) {
      dangerCodes.push("missing-projector");
    }
  }

  const authority = isVerifiedPolicyAuthority(context.authority) ? context.authority : undefined;
  const externalEvidence =
    origin === "reviewed"
      ? aihShippedEvidence(candidate, context)
      : receiptEvidence(candidate, authority);
  if (externalEvidence === undefined) {
    blockingCodes.push(
      authority === undefined ? "authority-receipt-unverified" : "authority-receipt-mismatch",
    );
    blockingCodes.push("evidence-missing");
  }
  if (
    origin === "custom" &&
    externalEvidence !== undefined &&
    authority !== undefined &&
    !requestedTargets.every(
      (target) =>
        (target === "claude" || target === "codex" || target === "kiro") &&
        authority.receipt.targets.includes(target),
    )
  ) {
    // Receipt-wide target coverage constrains verified evidence too, not just
    // explicit approval waivers.
    blockingCodes.push("authority-target-coverage-mismatch");
  }
  let evidence: EffectivePolicyCandidate["evidence"] = externalEvidence?.state ?? "missing";
  let approval: EffectivePolicyCandidate["approval"];
  let revocation: EffectivePolicyCandidate["revocation"];
  let mandatoryEvidenceGap = false;
  let waivableGap = false;
  const candidateHasDecisionReference =
    authority?.receipt.version === 2 &&
    authority.receipt.decisions.some(
      (decision) =>
        governance.authority.decisions.includes(decision.id) && decision.candidate === candidate.id,
    );
  if (externalEvidence !== undefined) {
    for (const finding of externalEvidence.findings)
      if (isUnwaivable(finding)) dangerCodes.push(finding);
    for (const detector of externalEvidence.detectors) {
      if (detector.required && detector.status === "fail")
        dangerCodes.push("mandatory-detector-failed");
      if (detector.required && detector.status === "missing") mandatoryEvidenceGap = true;
      if (!detector.required && detector.status !== "pass") waivableGap = true;
    }
    if (mandatoryEvidenceGap) blockingCodes.push("evidence-missing");
    const needsApproval =
      !mandatoryEvidenceGap &&
      externalEvidence.waivable &&
      (externalEvidence.state === "missing" ||
        (externalEvidence.state === "failed" && externalEvidence.waivable) ||
        waivableGap);
    if (needsApproval && !candidateHasDecisionReference) {
      const decision = matchingApproval(
        governance,
        candidate,
        externalEvidence,
        requestedTargets,
        authority,
        now,
      );
      if (decision.approval === undefined) {
        blockingCodes.push(decision.code ?? "approval-missing");
        revocation = decision.revocation;
      } else {
        evidence = "approved";
        approval = {
          id: decision.approval.id,
          issuer: decision.approval.issuer,
          repository: decision.approval.github.repository,
          attestationId: decision.approval.github.attestationId,
          reason: decision.approval.reason,
          ...(decision.approval.clarification === undefined
            ? {}
            : { clarification: decision.approval.clarification }),
          scope: sortedUnique(decision.approval.scope),
          notBefore: decision.approval.notBefore,
          expiresAt: decision.approval.expiresAt,
          subjectDigest: decision.approval.github.subjectDigest,
        };
      }
    } else if (externalEvidence.state === "failed") {
      blockingCodes.push("evidence-failed");
    } else if (externalEvidence.state === "missing" || waivableGap) {
      blockingCodes.push("evidence-missing");
    }
  }

  const uniqueDangerCodes = sortedUnique(dangerCodes);
  const uniqueBlockingCodes = sortedUnique(blockingCodes);
  const observedFindings = uniqueDangerCodes.filter(isDispositionableFinding);
  const decisionResolution = resolveDecision(
    governance,
    candidate,
    origin,
    externalEvidence,
    requestedTargets,
    context,
    authority,
    now,
  );
  const decisionBlockers = decisionResolution.blockers;
  let coverageBlocker: CandidateDecisionBlocker | undefined;
  if (decisionResolution.decision !== undefined && decisionBlockers.length === 0) {
    const decision = decisionResolution.decision;
    if (decision.disposition === "approved") {
      if (
        observedFindings.length !== 0 ||
        decision.acceptedFindings.length !== 0 ||
        decision.acceptedGaps.length !== 0
      ) {
        coverageBlocker = {
          scope: "candidate",
          code: "decision-coverage-mismatch",
          decision: decision.id,
          accepted: sortedUnique(decision.acceptedFindings),
          observed: observedFindings,
        };
      }
    } else if (decision.disposition === "accepted-with-conditions") {
      if (
        !sameStrings(decision.acceptedFindings, observedFindings) ||
        decision.acceptedGaps.length !== 0
      ) {
        coverageBlocker = {
          scope: "candidate",
          code: "decision-coverage-mismatch",
          decision: decision.id,
          accepted: sortedUnique(decision.acceptedFindings),
          observed: observedFindings,
        };
      } else if (now.getTime() >= Date.parse(decision.reviewBy)) {
        coverageBlocker = {
          scope: "candidate",
          code: "decision-review-overdue",
          decision: decision.id,
        };
      }
    }
  }
  if (coverageBlocker !== undefined) decisionBlockers.push(coverageBlocker);
  const acceptedFindings =
    decisionResolution.decision?.disposition === "accepted-with-conditions" &&
    decisionBlockers.length === 0
      ? decisionResolution.decision.acceptedFindings
      : [];
  const hasUnacceptedFinding = observedFindings.some(
    (finding) => !acceptedFindings.includes(finding),
  );
  const hasFencedDanger = uniqueDangerCodes.some(isFencedPrerequisite);
  const effective =
    requested &&
    !hasFencedDanger &&
    !hasUnacceptedFinding &&
    uniqueBlockingCodes.length === 0 &&
    decisionBlockers.length === 0 &&
    !policyDecisionBlocked &&
    (evidence === "verified" || evidence === "approved");
  return {
    id: candidate.id,
    origin,
    kind: candidate.kind,
    requested,
    effective,
    sourceDigest,
    source: candidate.source,
    evidence,
    ...(externalEvidence === undefined ? {} : { evidenceRecord: externalEvidence }),
    ...(approval === undefined ? {} : { approval }),
    ...(revocation === undefined ? {} : { revocation }),
    ...(decisionResolution.decision === undefined
      ? {}
      : { decision: decisionSummary(decisionResolution.decision, observedFindings, effective) }),
    dangerCodes: uniqueDangerCodes,
    blockingCodes: uniqueBlockingCodes,
    decisionBlockers,
    resolutionReasons,
    ...((activation?.clarification ?? candidate.clarification)
      ? { clarification: activation?.clarification ?? candidate.clarification }
      : {}),
    ...(candidate.annotation === undefined ? {} : { annotation: candidate.annotation }),
    lifecycle: candidate.lifecycle,
    projection,
  };
}

/** Resolve requested candidates against freshly verified authority and live adapters. */
export function resolveEffectiveOrgPolicy(
  policy: OrgPolicy,
  context: EffectivePolicyContext = {},
): EffectiveOrgPolicy {
  const now = context.now ?? new Date();
  const resolvedContext = { ...context, now };
  const authority = isVerifiedPolicyAuthority(context.authority) ? context.authority : undefined;
  if (!governanceOwnsAihSurfaces(policy)) {
    return {
      ...(policy.capabilityPackages === undefined
        ? {}
        : {
            capabilityPackages: {
              catalog: {
                provider: "github" as const,
                repository: policy.capabilityPackages.catalog.repository.toLowerCase(),
              },
              roots: [...policy.capabilityPackages.roots].sort(),
            },
          }),
      candidates: [],
      activeMcpServerIds: [],
      frameworkSelections: [],
      externalCuration: [],
      externalSelections: [],
      npmPackageLifecycle: [...(context.npmPackageLifecycle ?? [])],
      upstreamArtifactLifecycle: [...(context.upstreamArtifactLifecycle ?? [])],
      decisionBlockers: [],
      projectionBlocking:
        (context.npmPackageLifecycle ?? []).some(lifecycleStateBlocksProjection) ||
        (context.upstreamArtifactLifecycle ?? []).some(upstreamArtifactStateBlocksProjection),
      blocking:
        (context.npmPackageLifecycle ?? []).some((item) => item.state !== "observed-effective") ||
        (context.upstreamArtifactLifecycle ?? []).some(
          (item) => item.state !== "observed-effective",
        ),
      authority: {
        verified: authority !== undefined,
        ...(authority ? { receiptDigest: authority.receiptDigest } : {}),
      },
    };
  }
  const governance = policy.governance;
  const sourceCandidates = [...governance.catalog.reviewed, ...governance.catalog.custom];
  const decisionBlockers = policyDecisionBlockers(governance, sourceCandidates, authority, now);
  const candidates = [
    ...governance.catalog.reviewed.map((candidate) =>
      resolveCandidate(
        policy,
        governance,
        candidate,
        "reviewed",
        resolvedContext,
        now,
        decisionBlockers.length > 0,
      ),
    ),
    ...governance.catalog.custom.map((candidate) =>
      resolveCandidate(
        policy,
        governance,
        candidate,
        "custom",
        resolvedContext,
        now,
        decisionBlockers.length > 0,
      ),
    ),
  ].sort((left, right) => ordinalCompare(left.id, right.id));
  return {
    ...(policy.capabilityPackages === undefined
      ? {}
      : {
          capabilityPackages: {
            catalog: {
              provider: "github" as const,
              repository: policy.capabilityPackages.catalog.repository.toLowerCase(),
            },
            roots: [...policy.capabilityPackages.roots].sort(),
          },
        }),
    policyVersion: governance.policyVersion,
    candidates,
    activeMcpServerIds: candidates
      .filter(
        (candidate) =>
          decisionBlockers.length === 0 && candidate.effective && candidate.kind === "mcp",
      )
      .map((candidate) => candidate.id)
      .sort(ordinalCompare),
    frameworkSelections: candidates
      .filter((candidate) => candidate.requested && candidate.kind === "framework")
      .flatMap((candidate) => {
        const source = [...governance.catalog.reviewed, ...governance.catalog.custom].find(
          (item) => item.id === candidate.id,
        );
        return source?.framework === undefined
          ? []
          : [{ id: candidate.id, framework: source.framework }];
      })
      .sort((left, right) => ordinalCompare(left.id, right.id)),
    externalCuration: governance.externalCuration.map((curation) => ({
      framework: curation.framework,
      items: curation.items.map((item) => ({ ...item })),
      status: "external-guidance" as const,
    })),
    externalSelections: governance.externalSelections.map((selection) => ({
      framework: selection.framework,
      ...(selection.roots === undefined ? {} : { roots: [...selection.roots] }),
      items: selection.items.map((item) => ({ ...item, source: { ...item.source } })),
      status: "requested-evidence-needed" as const,
    })),
    npmPackageLifecycle: [...(context.npmPackageLifecycle ?? [])],
    upstreamArtifactLifecycle: [...(context.upstreamArtifactLifecycle ?? [])],
    decisionBlockers,
    projectionBlocking:
      decisionBlockers.length > 0 ||
      candidates.some((candidate) => candidate.requested && !candidate.effective) ||
      (context.npmPackageLifecycle ?? []).some(lifecycleStateBlocksProjection) ||
      (context.upstreamArtifactLifecycle ?? []).some(upstreamArtifactStateBlocksProjection),
    blocking:
      decisionBlockers.length > 0 ||
      candidates.some((candidate) => candidate.requested && !candidate.effective) ||
      (context.npmPackageLifecycle ?? []).some((item) => item.state !== "observed-effective") ||
      (context.upstreamArtifactLifecycle ?? []).some((item) => item.state !== "observed-effective"),
    authority: {
      verified: authority !== undefined,
      ...(authority === undefined
        ? { problem: "organization authority has not been verified" }
        : { receiptDigest: authority.receiptDigest }),
    },
  };
}

const CANDIDATE_LEAF_CONSUMERS: Readonly<Record<string, string>> = {
  accountableOwner: "effective report: accountable candidate owner identity only",
  annotation: "effective report metadata consumer",
  autoExecute: "effective resolver: uncontrolled hook danger gate",
  "capabilities.*": "effective report metadata consumer",
  clarification: "effective report metadata consumer",
  description: "effective report metadata consumer",
  "evidence.record": "effective resolver: verified receipt evidence lookup",
  "findings.*": "effective resolver: local additive unwaivable danger gate",
  framework: "effective resolver: framework adapter availability gate",
  id: "effective resolver: candidate identity and activation lookup",
  kind: "effective resolver: identity, evidence, and projector binding",
  lifecycle: "effective resolver: lifecycle gate",
  projector: "effective resolver: projector and approval binding",
  "risks.*": "effective report metadata consumer",
  "source.args.*":
    "effective resolver: immutable stdio curation/evidence identity; no launch projector exists",
  "source.command":
    "effective resolver: immutable executable identity; stdio has no launch projector",
  "source.commit": "effective resolver: immutable git source identity",
  "source.executableDigest": "effective resolver: executable source identity",
  "source.handler": "effective resolver: AIH-owned hook identity",
  "source.integrity": "effective resolver: verified package integrity identity",
  "source.package":
    "effective resolver: immutable stdio curation/evidence package identity; no launch projector exists",
  "source.registry":
    "effective resolver: immutable stdio curation/evidence registry identity; no launch projector exists",
  "source.repository": "effective resolver: immutable repository identity",
  "source.resolver":
    "effective resolver: immutable stdio curation/evidence resolver identity; no launch projector exists",
  "source.scriptDigest": "effective resolver: AIH-owned hook script identity",
  "source.server": "effective resolver: AIH-shipped MCP identity",
  "source.subject": "effective resolver: AIH-shipped MCP subject identity",
  "source.tree": "effective resolver: immutable git tree identity",
  "source.approval.allowedDataClasses.*":
    "effective report metadata consumer; remote approval record is fenced until later machinery",
  "source.approval.approvedBy":
    "effective report metadata consumer; remote approval record is fenced until later machinery",
  "source.approval.authenticationMode":
    "effective report metadata consumer; remote approval record is fenced until later machinery",
  "source.administrativeStatus":
    "effective report metadata consumer; remote availability remains administrator-managed",
  "source.contentScanned":
    "effective report metadata consumer; remote records explicitly state no content scan",
  "source.origin": "effective resolver: exact remote HTTPS origin identity",
  "source.toolSurfaceDigest":
    "effective report metadata consumer; remote tool-surface snapshot is fenced until later machinery",
  "source.type": "effective resolver: source union and identity gate",
  "source.verdict":
    "effective report metadata consumer; legacy remote verdict vocabulary is fenced until later machinery",
  "source.version":
    "effective resolver: immutable stdio curation/evidence version identity; no launch projector exists",
  "targets.*": "effective resolver: declared target parity gate",
};

const ACTIVATION_LEAF_CONSUMERS: Readonly<Record<string, string>> = {
  candidate: "effective resolver: candidate activation lookup",
  clarification: "effective report metadata consumer",
  state: "effective resolver: requested/effective decision",
  "targets.*": "effective resolver: runtime target/projector parity gate",
};

const AUTHORITY_LEAF_CONSUMERS: Readonly<Record<string, string>> = {
  "decisions.*": "effective resolver: candidate-scoped exact policy decision-reference lookup",
  "approvals.*.candidate": "authority resolver: exact candidate binding",
  "approvals.*.clarification":
    "authority resolver: signed clarification binding and report consumer",
  "approvals.*.evidenceDigest": "authority resolver: exact verified evidence binding",
  "approvals.*.expiresAt": "authority resolver: expiry and maximum-lifetime gate",
  "approvals.*.github.attestationId":
    "effective report: externally signed receipt transport locator",
  "approvals.*.github.repository": "authority resolver: trusted issuer repository binding",
  "approvals.*.github.subjectDigest": "authority resolver: full canonical approval subject digest",
  "approvals.*.id": "authority resolver: exact receipt and revocation lookup",
  "approvals.*.issuer": "authority resolver: verified issuer registry lookup",
  "approvals.*.kind": "authority resolver: candidate kind binding",
  "approvals.*.notBefore": "authority resolver: not-before and maximum-lifetime gate",
  "approvals.*.policyVersion": "authority resolver: policy-version binding",
  "approvals.*.projector": "authority resolver: projector/control binding",
  "approvals.*.reason": "authority resolver: signed reason binding and report consumer",
  "approvals.*.scope.*": "authority resolver: signed target-scope binding",
  "approvals.*.source.args.*": "authority resolver: immutable source binding",
  "approvals.*.source.command": "authority resolver: immutable source binding",
  "approvals.*.source.commit": "authority resolver: immutable source binding",
  "approvals.*.source.executableDigest": "authority resolver: immutable source binding",
  "approvals.*.source.handler": "authority resolver: immutable source binding",
  "approvals.*.source.integrity": "authority resolver: immutable source binding",
  "approvals.*.source.package": "authority resolver: immutable source binding",
  "approvals.*.source.registry": "authority resolver: immutable source binding",
  "approvals.*.source.repository": "authority resolver: immutable source binding",
  "approvals.*.source.resolver": "authority resolver: immutable source binding",
  "approvals.*.source.scriptDigest": "authority resolver: immutable source binding",
  "approvals.*.source.server": "authority resolver: immutable source binding",
  "approvals.*.source.subject": "authority resolver: immutable source binding",
  "approvals.*.source.tree": "authority resolver: immutable source binding",
  "approvals.*.source.approval.allowedDataClasses.*":
    "authority resolver: exact remote source binding",
  "approvals.*.source.approval.approvedBy": "authority resolver: exact remote source binding",
  "approvals.*.source.approval.authenticationMode":
    "authority resolver: exact remote source binding",
  "approvals.*.source.administrativeStatus":
    "authority resolver: administrator-managed remote availability binding",
  "approvals.*.source.contentScanned": "authority resolver: exact remote source binding",
  "approvals.*.source.origin": "authority resolver: exact remote source binding",
  "approvals.*.source.toolSurfaceDigest": "authority resolver: exact remote source binding",
  "approvals.*.source.type": "authority resolver: immutable source binding",
  "approvals.*.source.verdict": "authority resolver: exact remote source binding",
  "approvals.*.source.version": "authority resolver: immutable source binding",
  "approvals.*.sourceDigest": "authority resolver: exact source digest binding",
};

const EXTERNAL_CURATION_LEAF_CONSUMERS: Readonly<Record<string, string>> = {
  framework: "effective report: external framework identity only",
  "items.*.accountableOwner": "effective report: accountable curation owner identity only",
  "items.*.audit.digest": "effective report: external audit reference digest only",
  "items.*.audit.record": "effective report: external audit reference locator only",
  "items.*.clarification": "effective report: external curation clarification only",
  "items.*.id": "effective report: external curation item identity only",
  "items.*.kind": "effective report: external curation item kind only",
  "items.*.source.commit": "effective report: external curation source pin only",
  "items.*.source.path": "effective report: external curation source path only",
  "items.*.source.repository": "effective report: external curation source repository only",
};

const EXTERNAL_SELECTION_LEAF_CONSUMERS: Readonly<Record<string, string>> = {
  framework: "effective report: requested external framework identity only",
  "roots.*": "effective report: explicit external selection root identity only",
  "items.*.id": "effective report: requested external component identity only",
  "items.*.kind": "effective report: requested external component kind only",
  "items.*.source.commit": "effective report: requested external source pin only",
  "items.*.source.path": "effective report: requested external source path only",
  "items.*.source.repository": "effective report: requested external source repository only",
};

/**
 * Seat-side Add authority only. These fields deliberately do not feed the
 * effective candidate resolver, a projector, a scanner, or any network action.
 */
const ECC_MCP_APPROVAL_LEAF_CONSUMERS: Readonly<Record<string, string>> = {
  "allowedDataClasses.*": "seat Add authority: declarative permitted-data disclosure only",
  approvedBy: "seat Add authority: declarative administrator identity only",
  authenticationMode: "seat Add authority: declarative authentication disclosure only",
  id: "seat Add authority: source-locked external ECC MCP lookup only",
  sourceContentSha256: "seat Add authority: pinned source-match refusal only",
  state: "seat Add authority: declarative approved/revoked decision only",
};

const HOOK_REGISTRATION_LEAF_CONSUMERS: Readonly<Record<string, string>> = {
  command:
    "hook-managed-settings projector: written verbatim into the owned client destination; the effective resolver never reads it",
  event: "hook registrar: native client event key for projection, drift, and overlap reporting",
  "functionTags.*": "hook registrar: declared overlap key; never inferred by reading a command",
  id: "hook registrar: registration identity, duplicate refusal, and receipt lookup",
  nativeGroup:
    "hook registrar: the native group's own captured fields (matcher above all), re-emitted verbatim and never interpreted",
  nativeHook:
    "hook registrar: the native hook object's own captured fields, re-emitted verbatim and never interpreted",
  "owner.declaredControls.*":
    "hook registrar: third-party controls recorded read-only, never implemented or mirrored",
  "owner.framework": "hook registrar: third-party owner identity and the one-framework rule",
  "owner.kind": "hook registrar: owner partition for receipts and drift attribution",
  "owner.launcherSha256":
    "hook registrar: adoption-captured launcher hash for an unattributable owner; parse-time refusal and drift detection",
  "owner.pin.commit": "hook registrar: administrator-declared provenance recorded into the receipt",
  "owner.pin.launcherSha256":
    "hook registrar: parse-time launcher hash refusal and drift detection",
  "owner.pin.path": "hook registrar: administrator-declared provenance recorded into the receipt",
  "owner.pin.repository":
    "hook registrar: administrator-declared provenance recorded into the receipt",
  "owner.pin.runtimeVersion":
    "hook registrar: administrator-declared provenance recorded into the receipt",
  sourceDisabled:
    "hook registrar: source-disabled spawn accounting; a disabled hook still spawns a process",
  spawns: "hook registrar: projected process spawns per firing, nested launcher spawns included",
  timeout: "hook registrar: projected native entry timeout, transported unchanged",
};

function prefixedConsumers(
  prefix: string,
  leaves: Readonly<Record<string, string>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(leaves).map(([leaf, consumer]) => [`${prefix}.${leaf}`, consumer]),
  );
}

/** Exact, mechanically compared schema-leaf consumer contract. */
export const POLICY_ENGINE_FIELD_CONSUMERS: Readonly<Record<string, string>> = Object.freeze({
  "security.strix.enabled":
    "declarative Strix scan intent; no runtime security-scan consumer is wired",
  "security.strix.required":
    "declarative Strix requirement; no posture enforcement consumer is wired",
  "security.strix.targetKind":
    "declarative local-fixture boundary; no runtime security-scan consumer is wired",
  "security.strix.mode":
    "declarative bounded scan mode; no runtime security-scan consumer is wired",
  "security.strix.maxBudgetCents":
    "declarative cost ceiling; no runtime budget enforcement consumer is wired",
  "security.strix.maxTurns":
    "declarative turn ceiling; no runtime turn enforcement consumer is wired",
  "security.strix.timeoutMs":
    "declarative timeout ceiling; no runtime timeout enforcement consumer is wired",
  "security.strix.telemetry":
    "declarative telemetry-off boundary; no runtime security-scan consumer is wired",
  "security.strix.imageDigest":
    "declarative immutable container identity; no container execution consumer is wired",
  "security.strix.allowLiveTargets":
    "declarative live-target denial; no live-target execution consumer is wired",
  "security.strix.allowMounts": "declarative mount denial; no mount execution consumer is wired",
  "governance.policyVersion": "effective resolver: approval policy-version and report consumer",
  "governance.supportedClis.*": "target resolution: organization sanction gate",
  ...prefixedConsumers("governance.activations.*", ACTIVATION_LEAF_CONSUMERS),
  ...prefixedConsumers("governance.authority", AUTHORITY_LEAF_CONSUMERS),
  ...prefixedConsumers("governance.externalCuration.*", EXTERNAL_CURATION_LEAF_CONSUMERS),
  ...prefixedConsumers("governance.externalSelections.*", EXTERNAL_SELECTION_LEAF_CONSUMERS),
  ...prefixedConsumers("governance.eccMcpApprovals.*", ECC_MCP_APPROVAL_LEAF_CONSUMERS),
  "governance.eccHookControls.profile":
    "ECC hook-controls resolver and Claude settings receipt-backed projection; no launcher execution or enforcement claim",
  "governance.eccHookControls.disabledIds.*":
    "ECC hook-controls resolver canonicalizes source-gated IDs and the receipt-backed projection writes only ECC_DISABLED_HOOKS",
  ...prefixedConsumers("governance.hookRegistrations.*", HOOK_REGISTRATION_LEAF_CONSUMERS),
  ...prefixedConsumers("governance.catalog.reviewed.*", CANDIDATE_LEAF_CONSUMERS),
  ...prefixedConsumers("governance.catalog.custom.*", CANDIDATE_LEAF_CONSUMERS),
});
