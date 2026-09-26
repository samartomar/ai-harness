import { type Cli, SUPPORTED_CLIS } from "../internals/clis.js";
import type { CommandSpec, FileAssertion, Plan, PlanContext } from "../internals/plan.js";
import { dynamicDigest, plan, probe } from "../internals/plan.js";
import type { Check, CheckCode } from "../internals/verify.js";
import {
  isVerifiedPolicyAuthority,
  type PolicyAuthorityVerification,
  verifiedPolicyAuthoritySourceCustodyV1,
  verifyPolicyAuthorityReceipt,
} from "./authority.js";
import { custodyOrganizationEvidenceV1 } from "./evidence-custody-v1.js";
import { type GovernanceDecisionV2, governanceDecisionDigestV2 } from "./governance-decision-v2.js";
import {
  parseOrganizationEvidenceEnvelopeV1Bytes,
  type QualificationProvenanceV1,
  verifyOrganizationQualificationV1,
} from "./qualification-v1.js";
import {
  MAX_UPSTREAM_ARTIFACT_MANIFEST_BYTES_V1,
  parseUpstreamArtifactManifestV1Bytes,
  type UpstreamArtifactManifestV1,
} from "./upstream-artifact-manifest-v1.js";
import {
  type ObservedEffectResolution,
  resolveObservedEffect,
  type UpstreamObservationReceiptV1,
} from "./upstream-observation-receipt-v1.js";
import {
  type CustodiedObservedFileV1,
  custodyObservedFileV1,
  installedUpstreamArtifactIdentityV1,
  isCanonicalUpstreamArtifactRequestPathV1,
  MAX_OBSERVED_FILE_BYTES_V1,
  MAX_OBSERVED_TOTAL_BYTES_V1,
  mintUpstreamObservationReceiptV1,
  UPSTREAM_ARTIFACT_OBSERVER_V1,
} from "./upstream-observed-files-v1.js";

/** The bounded request-path grammar moved beside the custody it guards. */
export { isCanonicalUpstreamArtifactRequestPathV1 };

const SHA256 = /^sha256:[0-9a-f]{64}$/;

type Reason =
  | "invalid-input"
  | "invalid-evidence-path"
  | "unsafe-evidence-custody"
  | "evidence-unavailable"
  | "evidence-changed"
  | "authority-unverified"
  | "authority-version"
  | "authority-not-current"
  | "decision-missing-or-mismatch"
  | "decision-rejected"
  | "decision-revoked"
  | "decision-not-current"
  | "decision-scope-mismatch"
  | "qualification-unverified"
  | "manifest-unavailable"
  | "manifest-unsafe"
  | "manifest-unverified"
  | "manifest-mismatch"
  | "manifest-changed"
  | "observed-file-unavailable"
  | "observed-file-unsafe"
  | "observed-file-mismatch"
  | "observed-file-changed"
  | "observation-unverified";

export interface UpstreamArtifactObservationResultV1 {
  readonly authority: "verified" | "unverified";
  readonly effect?: UpstreamArtifactManifestV1["effect"];
  readonly qualification: QualificationProvenanceV1;
  readonly effective: "observed-effective" | Reason | ObservedEffectResolution["state"];
  readonly outcome: "observed-effective" | "partial" | "refused";
  readonly reason?: Reason;
  readonly observationDigest?: string;
}

export interface UpstreamArtifactObservationLifecycleHandoffV1 {
  readonly authorityReceiptDigest: string;
  readonly custody: readonly { readonly path: string; readonly sha256: string }[];
  readonly fileAssertions: readonly FileAssertion[];
  readonly decision: GovernanceDecisionV2;
  readonly manifest: UpstreamArtifactManifestV1;
  readonly manifestDigest: string;
  readonly request: UpstreamArtifactObservationRequestV1;
  readonly receipt: UpstreamObservationReceiptV1;
}

const lifecycleHandoffs = new WeakMap<object, UpstreamArtifactObservationLifecycleHandoffV1>();
const liveCustodies = new WeakMap<
  object,
  {
    readonly authorityReceiptDigest: string;
    readonly files: readonly { unchanged(): boolean }[];
  }
>();

export function upstreamArtifactObservationHandoffForLifecycleV1(
  result: UpstreamArtifactObservationResultV1,
): UpstreamArtifactObservationLifecycleHandoffV1 | undefined {
  const handoff = lifecycleHandoffs.get(result);
  return handoff === undefined ? undefined : structuredClone(handoff);
}

/** @internal Re-check live, private custody after concurrent effective-state observation. */
export function isCurrentUpstreamArtifactObservationCustodyV1(
  result: UpstreamArtifactObservationResultV1,
  verified: PolicyAuthorityVerification,
): boolean {
  if (!isVerifiedPolicyAuthority(verified.authority)) return false;
  const custody = liveCustodies.get(result);
  const handoff = lifecycleHandoffs.get(result);
  const now = Date.now();
  return (
    custody !== undefined &&
    handoff !== undefined &&
    custody.authorityReceiptDigest === verified.authority.receiptDigest &&
    Date.parse(handoff.receipt.observedAt) <= now &&
    now < Date.parse(handoff.receipt.validUntil) &&
    custody.files.every((file) => file.unchanged())
  );
}

let afterObservedReadForInternalTest:
  | ((requested: UpstreamArtifactObservationRequestV1) => void)
  | undefined;

/** @internal Hermetic race seam; never exported from the package root or CLI. */
export function __setUpstreamArtifactObserverInternalTestHookV1(
  hook: ((requested: UpstreamArtifactObservationRequestV1) => void) | undefined,
): void {
  afterObservedReadForInternalTest = hook;
}

function refusal(
  reason: Reason,
  authority: "verified" | "unverified" = "unverified",
  qualification: QualificationProvenanceV1 = "unqualified",
  effective: UpstreamArtifactObservationResultV1["effective"] = reason,
): UpstreamArtifactObservationResultV1 {
  return { authority, qualification, effective, outcome: "refused", reason };
}

function effectiveRefusal(
  state: ObservedEffectResolution["state"],
  qualification: QualificationProvenanceV1,
  effect?: UpstreamArtifactManifestV1["effect"],
): UpstreamArtifactObservationResultV1 {
  const reason: Reason =
    state === "authority-unverified" || state === "authority-version"
      ? "authority-unverified"
      : state === "authority-not-current"
        ? "authority-not-current"
        : state === "decision-rejected" ||
            state === "decision-revoked" ||
            state === "decision-not-current" ||
            state === "decision-scope-mismatch"
          ? state
          : state === "qualification-missing" ||
              state === "qualification-unverified" ||
              state === "qualification-mismatch"
            ? "qualification-unverified"
            : state === "decision-missing-or-mismatch"
              ? "decision-missing-or-mismatch"
              : "observation-unverified";
  return {
    ...refusal(reason, "verified", qualification, state),
    ...(effect === undefined ? {} : { effect }),
  };
}

function option(ctx: PlanContext, key: string): string | undefined {
  const value = ctx.options[key];
  return typeof value === "string" && value.length > 0 && value === value.trim()
    ? value
    : undefined;
}

export interface UpstreamArtifactObservationRequestV1 {
  readonly decision: string;
  readonly digest: string;
  readonly evidence: string;
  readonly manifest: string;
  readonly target: Cli;
}

function request(ctx: PlanContext): UpstreamArtifactObservationRequestV1 | undefined {
  const decision = option(ctx, "decision");
  const digest = option(ctx, "decisionDigest");
  const evidence = option(ctx, "evidence");
  const manifest = option(ctx, "manifest");
  const target = option(ctx, "target");
  return decision !== undefined &&
    /^[a-z][a-z0-9-]{0,63}$/.test(decision) &&
    digest !== undefined &&
    SHA256.test(digest) &&
    evidence !== undefined &&
    isCanonicalUpstreamArtifactRequestPathV1(evidence) &&
    manifest !== undefined &&
    isCanonicalUpstreamArtifactRequestPathV1(manifest) &&
    target !== undefined &&
    SUPPORTED_CLIS.includes(target as Cli)
    ? { decision, digest, evidence, manifest, target: target as Cli }
    : undefined;
}

function decisionFor(
  authority: Awaited<ReturnType<typeof verifyPolicyAuthorityReceipt>>["authority"],
  requested: Pick<UpstreamArtifactObservationRequestV1, "decision" | "digest">,
): GovernanceDecisionV2 | undefined {
  return authority?.receipt.version === 3
    ? authority.receipt.decisions.find(
        (candidate) =>
          candidate.id === requested.decision &&
          governanceDecisionDigestV2(candidate) === requested.digest,
      )
    : undefined;
}

function manifestMatches(
  manifest: UpstreamArtifactManifestV1,
  decision: GovernanceDecisionV2,
  request: UpstreamArtifactObservationRequestV1,
): boolean {
  return (
    manifest.decisionId === request.decision &&
    manifest.subject.kind === decision.subject.kind &&
    manifest.subject.id === decision.subject.id &&
    manifest.subject.sourceDigest === decision.subject.sourceDigest &&
    manifest.subject.subjectDigest === decision.subject.subjectDigest &&
    manifest.target === request.target &&
    decision.targets.includes(request.target) &&
    decision.allowedEffects.includes(manifest.effect) &&
    decision.qualificationBasis.kind === "organization-qualified"
  );
}

export async function observeUpstreamArtifactV1(
  ctx: PlanContext,
): Promise<UpstreamArtifactObservationResultV1> {
  const requested = request(ctx);
  if (requested === undefined) return refusal("invalid-input");
  return reobserveUpstreamArtifactWithAuthorityV1(
    ctx,
    await verifyPolicyAuthorityReceipt(ctx),
    requested,
  );
}

/**
 * Re-observe a stored exact request using one already verified authority.
 * This still custodies the current authority source and every local input before
 * reporting an observed effect.
 */
export async function reobserveUpstreamArtifactWithAuthorityV1(
  ctx: PlanContext,
  verified: PolicyAuthorityVerification,
  requested: UpstreamArtifactObservationRequestV1,
): Promise<UpstreamArtifactObservationResultV1> {
  if (!isVerifiedPolicyAuthority(verified.authority)) return refusal("authority-unverified");
  if (verified.authority.receipt.version !== 3) return refusal("authority-version", "verified");
  const authorityFile = verifiedPolicyAuthoritySourceCustodyV1(ctx, verified.authority);
  if (authorityFile === undefined) return refusal("authority-unverified");
  const decision = decisionFor(verified.authority, requested);
  if (decision === undefined) return refusal("decision-missing-or-mismatch", "verified");

  const evidence = custodyOrganizationEvidenceV1(ctx.root, requested.evidence);
  if ("problem" in evidence) return refusal(evidence.problem, "verified");
  const envelope = parseOrganizationEvidenceEnvelopeV1Bytes(evidence.evidence.bytes);
  if (envelope === undefined) return refusal("qualification-unverified", "verified");

  const manifestFile = custodyObservedFileV1(
    ctx.root,
    requested.manifest,
    MAX_UPSTREAM_ARTIFACT_MANIFEST_BYTES_V1,
    "assert upstream artifact manifest remains exact",
  );
  if (manifestFile === "unavailable") return refusal("manifest-unavailable", "verified");
  if (manifestFile === "unsafe" || manifestFile.identity.nlink !== 1n)
    return refusal("manifest-unsafe", "verified");
  const manifest = parseUpstreamArtifactManifestV1Bytes(manifestFile.bytes);
  if (manifest === undefined || !envelope.evidence.artifactDigests.includes(manifestFile.rawDigest))
    return refusal("manifest-unverified", "verified");
  if (!manifestMatches(manifest, decision, requested))
    return refusal("manifest-mismatch", "verified");
  if (!evidence.evidence.unchanged()) return refusal("evidence-changed", "verified");
  if (!manifestFile.unchanged()) return refusal("manifest-changed", "verified");

  const qualificationInput = {
    authority: verified.authority,
    bytes: evidence.evidence.bytes,
    decisionReference: { id: requested.decision, digest: requested.digest },
    effect: manifest.effect,
    subject: decision.subject,
    supportedTargets: SUPPORTED_CLIS,
    target: requested.target,
  };
  const initialNow = new Date().toISOString();
  const qualification = verifyOrganizationQualificationV1({
    ...qualificationInput,
    now: initialNow,
  });
  const provenance = "organization-qualified" as const;
  const integration = {
    mode: "upstream-managed" as const,
    owner: manifest.integration.owner,
    version: manifest.integration.version,
  };
  const installed = installedUpstreamArtifactIdentityV1(manifest);
  const initial = resolveObservedEffect({
    authority: verified.authority,
    decisionReference: { id: requested.decision, digest: requested.digest },
    qualification,
    subject: decision.subject,
    target: requested.target,
    effect: manifest.effect,
    supportedTargets: SUPPORTED_CLIS,
    expectedVerifier: UPSTREAM_ARTIFACT_OBSERVER_V1,
    expectedInstalled: installed,
    expectedIntegration: integration,
    now: initialNow,
  });
  if (initial.state !== "observation-missing")
    return effectiveRefusal(
      initial.state,
      qualification === undefined ? "unqualified" : provenance,
      manifest.effect,
    );

  const observedFiles: CustodiedObservedFileV1[] = [];
  let totalBytes = 0;
  for (const file of manifest.files) {
    if (file.path === requested.manifest || file.path === requested.evidence)
      return refusal("manifest-mismatch", "verified", provenance);
    const observed = custodyObservedFileV1(
      ctx.root,
      file.path,
      MAX_OBSERVED_FILE_BYTES_V1,
      "assert observed upstream artifact file remains exact",
    );
    if (observed === "unavailable")
      return refusal("observed-file-unavailable", "verified", provenance);
    if (observed === "unsafe") return refusal("observed-file-unsafe", "verified", provenance);
    totalBytes += observed.size;
    if (totalBytes > MAX_OBSERVED_TOTAL_BYTES_V1 || observed.rawDigest !== file.sha256)
      return refusal("observed-file-mismatch", "verified", provenance);
    observedFiles.push(observed);
  }
  const observedIdentities = new Set(
    observedFiles.map((file) => `${file.identity.dev}:${file.identity.ino}`),
  );
  if (
    observedFiles.some((file) => file.identity.nlink !== 1n) ||
    observedIdentities.size !== observedFiles.length
  )
    return refusal("observed-file-unsafe", "verified", provenance);

  afterObservedReadForInternalTest?.(requested);
  if (!authorityFile.unchanged()) return refusal("authority-unverified");
  if (!evidence.evidence.unchanged()) return refusal("evidence-changed", "verified", provenance);
  if (!manifestFile.unchanged()) return refusal("manifest-changed", "verified", provenance);
  if (!observedFiles.every((file) => file.unchanged()))
    return refusal("observed-file-changed", "verified", provenance);

  const observedAt = new Date().toISOString();
  const currentQualification = verifyOrganizationQualificationV1({
    ...qualificationInput,
    now: observedAt,
  });
  const current = resolveObservedEffect({
    authority: verified.authority,
    decisionReference: { id: requested.decision, digest: requested.digest },
    qualification: currentQualification,
    subject: decision.subject,
    target: requested.target,
    effect: manifest.effect,
    supportedTargets: SUPPORTED_CLIS,
    expectedVerifier: UPSTREAM_ARTIFACT_OBSERVER_V1,
    expectedInstalled: installed,
    expectedIntegration: integration,
    now: observedAt,
  });
  if (current.state !== "observation-missing")
    return effectiveRefusal(
      current.state,
      currentQualification === undefined ? "unqualified" : provenance,
      manifest.effect,
    );
  const minted = mintUpstreamObservationReceiptV1({
    authorityExpiresAt: verified.authority.receipt.expiresAt,
    decision,
    decisionReference: { id: requested.decision, digest: requested.digest },
    evidenceExpiresAt: envelope.expiresAt,
    manifest,
    observedAt,
    target: requested.target,
  });
  const receipt = minted.receipt;
  const observation = minted.observation;
  const effective = resolveObservedEffect({
    authority: verified.authority,
    decisionReference: { id: requested.decision, digest: requested.digest },
    qualification: currentQualification,
    observation,
    subject: decision.subject,
    target: requested.target,
    effect: manifest.effect,
    supportedTargets: SUPPORTED_CLIS,
    expectedVerifier: UPSTREAM_ARTIFACT_OBSERVER_V1,
    expectedInstalled: installed,
    expectedIntegration: integration,
    now: observedAt,
  });
  if (effective.state !== "observed-effective")
    return effectiveRefusal(effective.state, provenance, manifest.effect);

  const result: UpstreamArtifactObservationResultV1 = {
    authority: "verified",
    qualification: provenance,
    effective: "observed-effective",
    outcome: "observed-effective",
    observationDigest: minted.digest,
  };
  const fileAssertions = [
    authorityFile.assertion,
    evidence.evidence.assertion,
    manifestFile.assertion,
    ...observedFiles.map((file) => file.assertion),
  ];
  lifecycleHandoffs.set(result, {
    authorityReceiptDigest: verified.authority.receiptDigest,
    custody: [
      { path: requested.evidence, sha256: `sha256:${evidence.evidence.assertion.sha256}` },
      { path: requested.manifest, sha256: manifestFile.rawDigest },
      {
        path:
          authorityFile.assertion.external === true
            ? "external-policy-bundle"
            : authorityFile.assertion.path,
        sha256: verified.authority.receiptDigest,
      },
      ...observedFiles.map((file) => ({ path: file.assertion.path, sha256: file.rawDigest })),
    ],
    fileAssertions,
    decision,
    manifest,
    manifestDigest: manifestFile.rawDigest,
    request: requested,
    receipt,
  });
  liveCustodies.set(result, {
    authorityReceiptDigest: verified.authority.receiptDigest,
    files: [authorityFile, evidence.evidence, manifestFile, ...observedFiles],
  });
  return result;
}

const CODE: Readonly<Record<Reason, CheckCode>> = {
  "invalid-input": "org-policy.observe-input-invalid",
  "invalid-evidence-path": "org-policy.observe-input-invalid",
  "unsafe-evidence-custody": "org-policy.observe-evidence-invalid",
  "evidence-unavailable": "org-policy.observe-evidence-invalid",
  "evidence-changed": "org-policy.observe-evidence-changed",
  "authority-unverified": "org-policy.observe-authority-unverified",
  "authority-version": "org-policy.observe-authority-unverified",
  "authority-not-current": "org-policy.observe-authority-not-current",
  "decision-missing-or-mismatch": "org-policy.observe-decision-mismatch",
  "decision-rejected": "org-policy.observe-decision-rejected",
  "decision-revoked": "org-policy.observe-artifact-decision-revoked",
  "decision-not-current": "org-policy.observe-decision-not-current",
  "decision-scope-mismatch": "org-policy.observe-decision-scope-mismatch",
  "qualification-unverified": "org-policy.observe-qualification-unverified",
  "manifest-unavailable": "org-policy.observe-installed-evidence-unavailable",
  "manifest-unsafe": "org-policy.observe-installed-evidence-invalid",
  "manifest-unverified": "org-policy.observe-artifact-identity-mismatch",
  "manifest-mismatch": "org-policy.observe-artifact-identity-mismatch",
  "manifest-changed": "org-policy.observe-installed-evidence-changed",
  "observed-file-unavailable": "org-policy.observe-installed-evidence-unavailable",
  "observed-file-unsafe": "org-policy.observe-installed-evidence-invalid",
  "observed-file-mismatch": "org-policy.observe-artifact-identity-mismatch",
  "observed-file-changed": "org-policy.observe-installed-evidence-changed",
  "observation-unverified": "org-policy.observe-invariant-violation",
};

function check(result: UpstreamArtifactObservationResultV1): Check {
  return result.outcome === "observed-effective"
    ? {
        name: "policy observe upstream-artifact",
        verdict: "pass",
        detail: "policy observe upstream-artifact observed-effective",
      }
    : {
        name: "policy observe upstream-artifact",
        verdict: "fail",
        code: CODE[result.reason ?? "observation-unverified"],
        detail: `policy observe upstream-artifact ${result.reason ?? "observation-unverified"}`,
      };
}

export function upstreamArtifactObservePlan(ctx: PlanContext): Plan {
  let value: Promise<UpstreamArtifactObservationResultV1> | undefined;
  const once = () => (value ??= observeUpstreamArtifactV1(ctx));
  return plan(
    "policy observe upstream-artifact",
    dynamicDigest("policy observe upstream-artifact", async () => {
      const result = await once();
      return { text: JSON.stringify(result), data: result };
    }),
    probe("policy observe upstream-artifact", async () => check(await once())),
  );
}

export const upstreamArtifactObserveCommand: CommandSpec = {
  name: "upstream-artifact",
  summary:
    "Observe exact organization-managed artifact files under current V3 policy without executing or changing them",
  readOnly: true,
  zeroWrite: true,
  alwaysVerify: true,
  options: [
    { flags: "--decision <id>", description: "exact V3 governance decision identifier (required)" },
    {
      flags: "--decision-digest <sha256>",
      description: "exact V3 governance decision digest (required)",
    },
    { flags: "--target <cli>", description: "exact supported target (required)" },
    {
      flags: "--evidence <path>",
      description: "root-relative canonical organization evidence path (required)",
    },
    {
      flags: "--manifest <path>",
      description: "root-relative evidence-bound upstream artifact manifest path (required)",
    },
  ],
  plan: upstreamArtifactObservePlan,
};
