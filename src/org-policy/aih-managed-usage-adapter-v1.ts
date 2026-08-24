import { AihError, FsTxnError } from "../errors.js";
import { executePlan, type PlanResult } from "../internals/execute.js";
import {
  type Action,
  dynamicDigest,
  type FileAssertion,
  type Plan,
  type PlanContext,
  plan,
  probe,
  writeExactText,
} from "../internals/plan.js";
import type { Check } from "../internals/verify.js";
import { usageRecorderScript } from "../usage/capture.js";
import { VERSION } from "../version.js";
import {
  AIH_MANAGED_USAGE_RECEIPT_V4_PATH,
  type AihManagedUsageReceiptRevocationV4,
  type AihManagedUsageReceiptStateV4,
  type AihManagedUsageReceiptV4,
  canonicalDigest,
  configuredOutputsMatchV4,
  exactOutputTextsV4,
  inspectAihManagedUsageReceiptV4,
  outputDigestsV4,
  parseAihManagedUsageReceiptV4,
  receiptPayloadV4,
  receiptTextV4,
  resolveAihManagedUsageRevocationV1,
  sha256,
} from "./aih-managed-usage-audit-v1.js";
import { aihManagedUsagePlanResultV1 } from "./aih-managed-usage-result-v1.js";
import { revokeAihManagedUsageAdapterTransactionV1 } from "./aih-managed-usage-revocation-v1.js";
import {
  verifiedPolicyAuthorityReceiptAssertionV1,
  verifyPolicyAuthorityReceipt,
} from "./authority.js";
import { custodyOrganizationEvidenceV1 } from "./evidence-custody-v1.js";
import {
  type GovernanceDecisionV2,
  governanceDecisionDigestV2,
  governanceDecisionSourceDigestV2,
  governanceDecisionSubjectDigestV2,
} from "./governance-decision-v2.js";
import {
  type AihManagedUsageOwnershipSnapshotV4,
  aihManagedUsageExpectedHostHookV4,
  aihManagedUsageHookActionsV1,
  aihManagedUsageOwnershipIsCodeDerivedV4,
  aihManagedUsageOwnershipMatchesCodeV4,
  observeAihManagedUsageOwnershipV4,
} from "./project.js";
import {
  organizationEvidenceEnvelopeDigestV1,
  parseOrganizationEvidenceEnvelopeV1Bytes,
  verifyOrganizationQualificationV1,
} from "./qualification-v1.js";
import { OrgPolicyError } from "./schema.js";

export const AIH_MANAGED_USAGE_ADAPTER_V1 = Object.freeze({
  id: "aih-usage-metering",
  version: "1.0.0",
  effect: "configure" as const,
  targets: ["claude", "codex"] as const,
});
const SHA256 = /^sha256:[0-9a-f]{64}$/;

export { AIH_MANAGED_USAGE_RECEIPT_V4_PATH } from "./aih-managed-usage-audit-v1.js";
export interface AihManagedUsageAdapterRequestV1 {
  readonly decision: string;
  readonly digest: string;
  readonly evidence: string;
  readonly target: string;
}

interface AcceptedAihManagedUsageAdapterRequestV1 extends AihManagedUsageAdapterRequestV1 {
  readonly target: "claude" | "codex";
}
export interface AihManagedUsageAdapterResultV1 {
  readonly adapter: "verified" | "unverified";
  readonly authority: "verified" | "unverified";
  readonly qualification: "organization-qualified" | "unqualified";
  readonly outcome: "fulfilled" | "partial" | "refused" | "reported-only";
  readonly reason?:
    | "invalid-input"
    | "authority-unverified"
    | "authority-version"
    | "descriptor-mismatch"
    | "qualification-unverified"
    | "evidence-changed"
    | "ownership-conflict"
    | "recovery-required"
    | "post-effect-drift"
    | "revoked";
  readonly receiptDigest?: string;
}
export interface AihManagedUsageAdapterInspectionV1 {
  readonly state:
    | "absent"
    | "claimed"
    | "configured"
    | "revoking"
    | "revoked"
    | "drifted"
    | "invalid";
  readonly audit: "bounded-history";
  readonly receiptDigest?: string;
}

/** Fixed code-derived adapter; callers cannot select an adapter, command, path, effect, or source revision. */
export function describeAihManagedUsageAdapterV1() {
  const fixedArtifacts = {
    hooks: AIH_MANAGED_USAGE_ADAPTER_V1.targets.map((target) => ({
      target,
      ...aihManagedUsageExpectedHostHookV4(target),
    })),
    recorder: usageRecorderScript(),
  };
  const source = {
    type: "aih" as const,
    release: VERSION,
    revision: canonicalDigest("aih-managed-usage-source/v1\0", fixedArtifacts),
  };
  const sourceDigest = governanceDecisionSourceDigestV2(source);
  const subject = {
    kind: "tool" as const,
    id: "usage-metering",
    source,
    sourceDigest,
    subjectDigest: governanceDecisionSubjectDigestV2({
      kind: "tool",
      id: "usage-metering",
      sourceDigest,
    }),
  };
  const adapter = {
    id: AIH_MANAGED_USAGE_ADAPTER_V1.id,
    version: AIH_MANAGED_USAGE_ADAPTER_V1.version,
    digest: canonicalDigest("aih-managed-usage-adapter/v1\0", {
      effect: AIH_MANAGED_USAGE_ADAPTER_V1.effect,
      id: AIH_MANAGED_USAGE_ADAPTER_V1.id,
      source,
      targets: AIH_MANAGED_USAGE_ADAPTER_V1.targets,
      version: AIH_MANAGED_USAGE_ADAPTER_V1.version,
    }),
  };
  return Object.freeze({
    adapter: Object.freeze(adapter),
    effect: AIH_MANAGED_USAGE_ADAPTER_V1.effect,
    subject: Object.freeze({ ...subject, source: Object.freeze(source) }),
    targets: Object.freeze([...AIH_MANAGED_USAGE_ADAPTER_V1.targets]),
  });
}

function acceptedRequest(value: unknown): AcceptedAihManagedUsageAdapterRequestV1 | undefined {
  try {
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype ||
      Reflect.ownKeys(value).length !== 4
    )
      return undefined;
    const fields = Object.fromEntries(
      ["decision", "digest", "evidence", "target"].map((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true)
          throw new TypeError("request must contain enumerable data properties");
        return [key, descriptor.value];
      }),
    ) as Record<string, unknown>;
    return typeof fields.decision === "string" &&
      /^[a-z][a-z0-9-]{0,63}$/.test(fields.decision) &&
      typeof fields.digest === "string" &&
      SHA256.test(fields.digest) &&
      (fields.target === "claude" || fields.target === "codex") &&
      typeof fields.evidence === "string" &&
      fields.evidence.length > 0
      ? {
          decision: fields.decision,
          digest: fields.digest,
          evidence: fields.evidence,
          target: fields.target,
        }
      : undefined;
  } catch {
    return undefined;
  }
}

function matchingDecision(
  decision: GovernanceDecisionV2,
  request: AihManagedUsageAdapterRequestV1,
): boolean {
  const descriptor = describeAihManagedUsageAdapterV1();
  return (
    decision.id === request.decision &&
    governanceDecisionDigestV2(decision) === request.digest &&
    decision.disposition !== "rejected" &&
    decision.subject.kind === descriptor.subject.kind &&
    decision.subject.id === descriptor.subject.id &&
    decision.subject.sourceDigest === descriptor.subject.sourceDigest &&
    decision.subject.subjectDigest === descriptor.subject.subjectDigest &&
    decision.allowedEffects.includes(descriptor.effect) &&
    decision.targets.includes(request.target)
  );
}

interface AuthorizedAihManagedUsageAdapterV1 {
  readonly authorityReceiptDigest: string;
  readonly commitNotAfter: string;
  readonly decision: GovernanceDecisionV2;
  readonly descriptor: ReturnType<typeof describeAihManagedUsageAdapterV1>;
  readonly request: AcceptedAihManagedUsageAdapterRequestV1;
  readonly qualification: {
    readonly attestor: string;
    readonly evidenceDigest: string;
    readonly record: string;
  };
  readonly fileAssertions: readonly FileAssertion[];
  readonly unchanged: () => boolean;
}

async function authorizeAihManagedUsageAdapterV1(
  ctx: PlanContext,
  request: AihManagedUsageAdapterRequestV1,
): Promise<AuthorizedAihManagedUsageAdapterV1 | AihManagedUsageAdapterResultV1> {
  const accepted = acceptedRequest(request);
  if (accepted === undefined) return refused("invalid-input");
  const custody = custodyOrganizationEvidenceV1(ctx.root, accepted.evidence);
  if ("problem" in custody) return refused("qualification-unverified");
  const verified = await verifyPolicyAuthorityReceipt(ctx);
  if (verified.authority === undefined) return refused("authority-unverified");
  if (verified.authority.receipt.version !== 3) return refused("authority-version", "verified");
  const authorityAssertion = verifiedPolicyAuthorityReceiptAssertionV1(verified.authority);
  if (authorityAssertion === undefined) return refused("authority-unverified");
  if (!custody.evidence.unchanged()) return refused("evidence-changed", "verified");
  const decision = verified.authority.receipt.decisions.find(
    (candidate) =>
      candidate.id === accepted.decision &&
      governanceDecisionDigestV2(candidate) === accepted.digest,
  );
  if (decision === undefined || !matchingDecision(decision, accepted))
    return refused("descriptor-mismatch", "verified");
  const now = new Date().toISOString();
  const qualification = verifyOrganizationQualificationV1({
    authority: verified.authority,
    bytes: custody.evidence.bytes,
    decisionReference: { id: accepted.decision, digest: accepted.digest },
    effect: "configure",
    now,
    subject: decision.subject,
    supportedTargets: AIH_MANAGED_USAGE_ADAPTER_V1.targets,
    target: accepted.target,
  });
  if (qualification === undefined) return refused("qualification-unverified", "verified");
  const envelope = parseOrganizationEvidenceEnvelopeV1Bytes(custody.evidence.bytes);
  if (envelope === undefined) return refused("qualification-unverified", "verified");
  const descriptor = describeAihManagedUsageAdapterV1();
  const deadlines = [
    Date.now() + 60_000,
    Date.parse(verified.authority.receipt.expiresAt),
    Date.parse(decision.expiresAt),
    Date.parse(envelope.expiresAt),
    ...(decision.disposition === "accepted-with-conditions" ? [Date.parse(decision.reviewBy)] : []),
  ];
  const deadline = Math.min(...deadlines);
  if (!Number.isFinite(deadline) || deadline <= Date.now())
    return refused("qualification-unverified", "verified");
  return {
    authorityReceiptDigest: verified.authority.receiptDigest,
    commitNotAfter: new Date(deadline).toISOString(),
    decision,
    descriptor,
    qualification: {
      attestor: envelope.attestor,
      evidenceDigest: organizationEvidenceEnvelopeDigestV1(envelope),
      record: envelope.evidence.id,
    },
    fileAssertions: [authorityAssertion, custody.evidence.assertion],
    request: accepted,
    unchanged: () => custody.evidence.unchanged(),
  };
}

function governedPlan(commitNotAfter: string, name: string, ...actions: Action[]): Plan {
  return { ...plan(name, ...actions), commitNotAfter };
}

function refused(
  reason: NonNullable<AihManagedUsageAdapterResultV1["reason"]>,
  authority: "verified" | "unverified" = "unverified",
): AihManagedUsageAdapterResultV1 {
  return {
    adapter: "unverified",
    authority,
    qualification: "unqualified",
    outcome: "refused",
    reason,
  };
}

function isAuthorized(
  value: AuthorizedAihManagedUsageAdapterV1 | AihManagedUsageAdapterResultV1,
): value is AuthorizedAihManagedUsageAdapterV1 {
  return "decision" in value;
}

function parseReceipt(root: string) {
  return parseAihManagedUsageReceiptV4(root, describeAihManagedUsageAdapterV1());
}

function configuredOutputsMatch(root: string, receipt: AihManagedUsageReceiptV4): boolean {
  return configuredOutputsMatchV4(root, receipt);
}

function receiptOwnershipMatchesCode(ctx: PlanContext, receipt: AihManagedUsageReceiptV4): boolean {
  return aihManagedUsageOwnershipMatchesCodeV4(ctx, receipt.target, receipt.ownership);
}

function receiptPayload(
  authorized: Pick<
    AuthorizedAihManagedUsageAdapterV1,
    "authorityReceiptDigest" | "descriptor" | "qualification" | "request"
  >,
  state: AihManagedUsageReceiptStateV4,
  ownership: AihManagedUsageOwnershipSnapshotV4,
  outputs: readonly { path: string; sha256: string }[] = [],
  prior?: AihManagedUsageReceiptV4,
  revocation?: AihManagedUsageReceiptRevocationV4,
): Record<string, unknown> {
  return receiptPayloadV4({ ...authorized, state, ownership, outputs, prior, revocation });
}

function receiptText(payload: Record<string, unknown>): string {
  return receiptTextV4(payload);
}

function outputDigests(root: string, target: "claude" | "codex") {
  return outputDigestsV4(root, target);
}

export function inspectAihManagedUsageAdapterV1(root: string): AihManagedUsageAdapterInspectionV1 {
  const observed = inspectAihManagedUsageReceiptV4(root, describeAihManagedUsageAdapterV1());
  const parsed = parseReceipt(root);
  if (
    parsed !== undefined &&
    !aihManagedUsageOwnershipIsCodeDerivedV4(parsed.receipt.target, parsed.receipt.ownership)
  )
    return { audit: "bounded-history", receiptDigest: parsed.digest, state: "invalid" };
  return { ...observed, audit: "bounded-history" };
}

function inspectionRecovery(
  inspection: AihManagedUsageAdapterInspectionV1,
): AihManagedUsageAdapterResultV1 | undefined {
  if (inspection.state === "absent" || inspection.state === "configured") return undefined;
  return {
    adapter: "verified",
    authority: "unverified",
    qualification: "unqualified",
    outcome: "partial",
    reason: inspection.state === "drifted" ? "post-effect-drift" : "recovery-required",
    ...(inspection.receiptDigest === undefined ? {} : { receiptDigest: inspection.receiptDigest }),
  };
}

function receiptMatchesAuthorization(
  receipt: AihManagedUsageReceiptV4,
  authorized: AuthorizedAihManagedUsageAdapterV1,
): boolean {
  return (
    receipt.state === "configured" &&
    receipt.authorityReceiptDigest === authorized.authorityReceiptDigest &&
    receipt.decision.id === authorized.request.decision &&
    receipt.decision.digest === authorized.request.digest &&
    receipt.qualification.attestor === authorized.qualification.attestor &&
    receipt.qualification.evidenceDigest === authorized.qualification.evidenceDigest &&
    receipt.qualification.record === authorized.qualification.record &&
    receipt.target === authorized.request.target
  );
}

function sameAuthorization(
  left: AuthorizedAihManagedUsageAdapterV1,
  right: AuthorizedAihManagedUsageAdapterV1,
): boolean {
  return (
    left.authorityReceiptDigest === right.authorityReceiptDigest &&
    left.request.decision === right.request.decision &&
    left.request.digest === right.request.digest &&
    left.request.target === right.request.target &&
    left.qualification.attestor === right.qualification.attestor &&
    left.qualification.evidenceDigest === right.qualification.evidenceDigest &&
    left.qualification.record === right.qualification.record
  );
}

function exactReceiptWrite(contents: string, expected: string, describe: string) {
  return {
    ...writeExactText(AIH_MANAGED_USAGE_RECEIPT_V4_PATH, contents, describe),
    mode: 0o600,
    expect: { sha256: sha256(expected).slice("sha256:".length) },
    durable: true as const,
  };
}

function exactReceiptAssertion(contents: string, describe: string) {
  return {
    ...writeExactText(AIH_MANAGED_USAGE_RECEIPT_V4_PATH, contents, describe),
    expect: { sha256: sha256(contents).slice("sha256:".length) },
    assertUnchanged: true,
  };
}

function outputAssertions(root: string, target: "claude" | "codex"): Action[] | undefined {
  const outputs = exactOutputTextsV4(root, target);
  return outputs?.map((output) => ({
    ...writeExactText(
      output.path,
      output.contents,
      "assert fixed usage adapter output remains exact",
    ),
    expect: { sha256: output.sha256.slice("sha256:".length) },
    assertUnchanged: true,
  }));
}

function withAuthorizationAssertions(
  governed: Plan,
  authorized: AuthorizedAihManagedUsageAdapterV1,
): Plan {
  return { ...governed, fileAssertions: authorized.fileAssertions };
}

/** Read-only preflight for Commander and library callers; it emits no effect actions. */
export async function resolveAihManagedUsageAdapterV1(
  ctx: PlanContext,
  request: AihManagedUsageAdapterRequestV1,
): Promise<AihManagedUsageAdapterResultV1> {
  const inspection = inspectAihManagedUsageAdapterV1(ctx.root);
  const recovery = inspectionRecovery(inspection);
  if (recovery !== undefined && inspection.state !== "revoking" && inspection.state !== "revoked")
    return recovery;
  const durable = parseReceipt(ctx.root);
  if (
    durable !== undefined &&
    (durable.receipt.state === "configured" ||
      durable.receipt.state === "revoking" ||
      durable.receipt.state === "revoked")
  ) {
    const revocation = await resolveAihManagedUsageRevocationV1(ctx, durable.receipt);
    if (revocation !== undefined) {
      return {
        adapter: "verified",
        authority: "verified",
        qualification: "unqualified",
        outcome: "reported-only",
        reason: "revoked",
        receiptDigest: durable.digest,
      };
    }
  }
  if (recovery !== undefined) return recovery;
  const authorized = await authorizeAihManagedUsageAdapterV1(ctx, request);
  if (!isAuthorized(authorized)) return authorized;
  return {
    adapter: "verified",
    authority: "verified",
    qualification: "organization-qualified",
    outcome: "reported-only",
  };
}

export function aihManagedUsageAdapterPlanV1(
  ctx: PlanContext,
  request: AihManagedUsageAdapterRequestV1,
): Plan {
  let result: Promise<AihManagedUsageAdapterResultV1> | undefined;
  const once = () => (result ??= resolveAihManagedUsageAdapterV1(ctx, request));
  return plan(
    "policy usage-metering",
    dynamicDigest("policy usage-metering", async () => {
      const data = await once();
      return { text: JSON.stringify(data), data };
    }),
    probe("AIH-managed usage adapter custody", async (): Promise<Check> => {
      const data = await once();
      const qualifiedPreview =
        data.outcome === "reported-only" &&
        data.reason === undefined &&
        data.authority === "verified" &&
        data.qualification === "organization-qualified";
      return qualifiedPreview
        ? {
            name: "AIH-managed usage adapter custody",
            verdict: "pass",
            detail: "qualified preview is non-effective",
          }
        : {
            name: "AIH-managed usage adapter custody",
            verdict: "fail",
            detail: `non-effective ${data.outcome}${data.reason === undefined ? "" : `: ${data.reason}`}`,
          };
    }),
  );
}

async function revokeAihManagedUsageAdapterV1(
  ctx: PlanContext,
  initial: { receipt: AihManagedUsageReceiptV4; digest: string; text: string },
  phases: PlanResult[],
): Promise<AihManagedUsageAdapterResultV1> {
  return revokeAihManagedUsageAdapterTransactionV1({
    ctx,
    describe: describeAihManagedUsageAdapterV1,
    initial,
    phases,
  });
}

/**
 * Claim-before-effect executor. The claimed receipt is committed in its own
 * transaction before the fixed configuration actions are planned. A crash then
 * leaves visible recovery evidence rather than a false configured receipt.
 */
async function runAihManagedUsageAdapterUncheckedV1(
  ctx: PlanContext,
  request: AihManagedUsageAdapterRequestV1,
  phases: PlanResult[],
) {
  const done = (domain: AihManagedUsageAdapterResultV1) => ({ domain, phases: [...phases] });
  const prior = inspectAihManagedUsageAdapterV1(ctx.root);
  const recovery = inspectionRecovery(prior);
  if (recovery !== undefined && prior.state !== "revoking" && prior.state !== "revoked")
    return done(recovery);
  const durable = parseReceipt(ctx.root);
  if (
    durable !== undefined &&
    (durable.receipt.state === "configured" ||
      durable.receipt.state === "revoking" ||
      durable.receipt.state === "revoked")
  ) {
    const revocation = await resolveAihManagedUsageRevocationV1(ctx, durable.receipt);
    if (revocation !== undefined) {
      if (!ctx.apply) {
        return done({
          adapter: "verified",
          authority: "verified",
          qualification: "unqualified",
          outcome: "reported-only",
          reason: "revoked",
          receiptDigest: durable.digest,
        });
      }
      return done(await revokeAihManagedUsageAdapterV1(ctx, durable, phases));
    }
  }
  if (recovery !== undefined) return done(recovery);
  const authorized = await authorizeAihManagedUsageAdapterV1(ctx, request);
  if (!isAuthorized(authorized)) return done(authorized);
  if (!ctx.apply) {
    return done({
      adapter: "verified" as const,
      authority: "verified" as const,
      qualification: "organization-qualified" as const,
      outcome: "reported-only" as const,
    });
  }
  if (prior.state === "configured") {
    const parsed = parseReceipt(ctx.root);
    if (
      parsed !== undefined &&
      receiptOwnershipMatchesCode(ctx, parsed.receipt) &&
      receiptMatchesAuthorization(parsed.receipt, authorized) &&
      configuredOutputsMatch(ctx.root, parsed.receipt)
    ) {
      return done({
        adapter: "verified" as const,
        authority: "verified" as const,
        qualification: "organization-qualified" as const,
        outcome: "fulfilled" as const,
        receiptDigest: parsed.digest,
      });
    }
    if (
      parsed !== undefined &&
      receiptOwnershipMatchesCode(ctx, parsed.receipt) &&
      configuredOutputsMatch(ctx.root, parsed.receipt)
    ) {
      // Current authority/evidence may legitimately replace an otherwise exact
      // configured receipt. This updates only the bounded custody record; the
      // fixed recorder and hook bytes are re-observed and are never supplied by
      // the caller. A future packed release can extend the recognized
      // predecessor descriptor set before it performs a code-derived source
      // revision update; an unknown receipt is never a migration authority.
      const refreshPins = outputAssertions(ctx.root, parsed.receipt.target);
      if (refreshPins === undefined)
        return done({
          adapter: "verified",
          authority: "verified",
          qualification: "organization-qualified",
          outcome: "partial",
          reason: "post-effect-drift",
        });
      const refreshed = receiptText(
        receiptPayload(
          authorized,
          "configured",
          parsed.receipt.ownership,
          parsed.receipt.outputs,
          parsed.receipt,
        ),
      );
      phases.push(
        await executePlan(
          withAuthorizationAssertions(
            governedPlan(
              authorized.commitNotAfter,
              "policy usage-metering refresh custody",
              ...refreshPins,
              exactReceiptWrite(
                refreshed,
                parsed.text,
                "record current exact usage adapter authority and qualification",
              ),
            ),
            authorized,
          ),
          ctx,
          { skipWorktreeGate: true },
        ),
      );
      const refreshedReceipt = parseReceipt(ctx.root);
      if (
        refreshedReceipt === undefined ||
        refreshedReceipt.text !== refreshed ||
        !receiptOwnershipMatchesCode(ctx, refreshedReceipt.receipt) ||
        !receiptMatchesAuthorization(refreshedReceipt.receipt, authorized) ||
        !configuredOutputsMatch(ctx.root, refreshedReceipt.receipt)
      ) {
        return done({
          adapter: "verified" as const,
          authority: "verified" as const,
          qualification: "organization-qualified" as const,
          outcome: "partial" as const,
          reason: "post-effect-drift" as const,
        });
      }
      return done({
        adapter: "verified" as const,
        authority: "verified" as const,
        qualification: "organization-qualified" as const,
        outcome: "fulfilled" as const,
        receiptDigest: sha256(refreshed),
      });
    }
    return done({
      adapter: "verified" as const,
      authority: "verified" as const,
      qualification: "organization-qualified" as const,
      outcome: "partial" as const,
      reason: "recovery-required" as const,
      receiptDigest: prior.receiptDigest,
    });
  }
  let ownership: AihManagedUsageOwnershipSnapshotV4;
  try {
    ownership = observeAihManagedUsageOwnershipV4(ctx, authorized.request.target);
  } catch (error) {
    if (!(error instanceof OrgPolicyError)) throw error;
    return done({
      adapter: "verified",
      authority: "verified",
      qualification: "organization-qualified",
      outcome: "partial",
      reason: "ownership-conflict",
    });
  }
  const claim = receiptText(receiptPayload(authorized, "claimed", ownership));
  phases.push(
    await executePlan(
      withAuthorizationAssertions(
        governedPlan(authorized.commitNotAfter, "policy usage-metering claim", {
          ...writeExactText(
            AIH_MANAGED_USAGE_RECEIPT_V4_PATH,
            claim,
            "durably claim fixed usage adapter before configuration",
          ),
          mode: 0o600,
          expect: { absent: true },
          durable: true,
        }),
        authorized,
      ),
      ctx,
    ),
  );
  const current = await authorizeAihManagedUsageAdapterV1(ctx, request);
  if (!isAuthorized(current) || !current.unchanged() || !sameAuthorization(authorized, current)) {
    return done({
      adapter: "verified" as const,
      authority: "verified" as const,
      qualification: "organization-qualified" as const,
      outcome: "partial" as const,
      reason: "recovery-required" as const,
    });
  }
  let actions: Action[];
  try {
    actions = aihManagedUsageHookActionsV1(ctx, authorized.request.target, claim, ownership);
  } catch (error) {
    if (!(error instanceof OrgPolicyError)) throw error;
    return done({
      adapter: "verified" as const,
      authority: "verified" as const,
      qualification: "organization-qualified" as const,
      outcome: "partial" as const,
      reason: "ownership-conflict" as const,
    });
  }
  phases.push(
    await executePlan(
      withAuthorizationAssertions(
        governedPlan(
          current.commitNotAfter,
          "policy usage-metering configure",
          ...actions,
          exactReceiptAssertion(
            claim,
            "assert exact V4 claim remains unchanged through configuration",
          ),
        ),
        current,
      ),
      ctx,
    ),
  );
  const outputs = outputDigests(ctx.root, authorized.request.target);
  const fresh = await authorizeAihManagedUsageAdapterV1(ctx, request);
  if (
    outputs === undefined ||
    !current.unchanged() ||
    !isAuthorized(fresh) ||
    !fresh.unchanged() ||
    !sameAuthorization(current, fresh)
  ) {
    return done({
      adapter: "verified" as const,
      authority: "verified" as const,
      qualification: "organization-qualified" as const,
      outcome: "partial" as const,
      reason: "post-effect-drift" as const,
    });
  }
  const outputPins = outputAssertions(ctx.root, authorized.request.target);
  if (outputPins === undefined) {
    return done({
      adapter: "verified" as const,
      authority: "verified" as const,
      qualification: "organization-qualified" as const,
      outcome: "partial" as const,
      reason: "post-effect-drift" as const,
    });
  }
  const configured = receiptText(receiptPayload(fresh, "configured", ownership, outputs));
  phases.push(
    await executePlan(
      withAuthorizationAssertions(
        governedPlan(
          fresh.commitNotAfter,
          "policy usage-metering finalize",
          ...outputPins,
          exactReceiptWrite(configured, claim, "record exact fixed usage adapter outputs"),
        ),
        fresh,
      ),
      ctx,
      { skipWorktreeGate: true },
    ),
  );
  const finalized = parseReceipt(ctx.root);
  if (
    finalized === undefined ||
    finalized.text !== configured ||
    !receiptOwnershipMatchesCode(ctx, finalized.receipt) ||
    !receiptMatchesAuthorization(finalized.receipt, fresh) ||
    !configuredOutputsMatch(ctx.root, finalized.receipt)
  ) {
    return done({
      adapter: "verified" as const,
      authority: "verified" as const,
      qualification: "organization-qualified" as const,
      outcome: "partial" as const,
      reason: "post-effect-drift" as const,
    });
  }
  return done({
    adapter: "verified" as const,
    authority: "verified" as const,
    qualification: "organization-qualified" as const,
    outcome: "fulfilled" as const,
    receiptDigest: sha256(configured),
  });
}

async function runAihManagedUsageAdapterV1(
  ctx: PlanContext,
  request: AihManagedUsageAdapterRequestV1,
) {
  const phases: PlanResult[] = [];
  try {
    return await runAihManagedUsageAdapterUncheckedV1(ctx, request, phases);
  } catch (error) {
    if (
      !(error instanceof FsTxnError) &&
      !(error instanceof AihError && error.code === "AIH_TRUST")
    )
      throw error;
    const inspection = inspectAihManagedUsageAdapterV1(ctx.root);
    return {
      domain: {
        adapter: "unverified" as const,
        authority: "unverified" as const,
        qualification: "unqualified" as const,
        outcome: "partial" as const,
        reason:
          inspection.state === "configured" || inspection.state === "revoked"
            ? ("post-effect-drift" as const)
            : ("recovery-required" as const),
        receiptDigest: inspection.receiptDigest,
      },
      phases: [...phases],
    };
  }
}

export async function applyAihManagedUsageAdapterV1(
  ctx: PlanContext,
  request: AihManagedUsageAdapterRequestV1,
): Promise<AihManagedUsageAdapterResultV1> {
  return (await runAihManagedUsageAdapterV1(ctx, request)).domain;
}

export async function executeAihManagedUsageAdapterV1(
  ctx: PlanContext,
  request: AihManagedUsageAdapterRequestV1,
): Promise<PlanResult> {
  const run = await runAihManagedUsageAdapterV1(ctx, request);
  return aihManagedUsagePlanResultV1(
    run.domain,
    inspectAihManagedUsageAdapterV1(ctx.root),
    run.phases,
  );
}
