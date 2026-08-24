import { AihError, FsTxnError } from "../errors.js";
import { executePlan, type PlanResult } from "../internals/execute.js";
import { type Action, type PlanContext, plan, writeExactText } from "../internals/plan.js";
import type { AihManagedUsageAdapterResultV1 } from "./aih-managed-usage-adapter-v1.js";
import {
  AIH_MANAGED_USAGE_RECEIPT_V4_PATH,
  type AihManagedUsageDescriptorV4,
  type AihManagedUsageReceiptV4,
  configuredOutputsMatchV4,
  parseAihManagedUsageReceiptV4,
  receiptPayloadV4,
  receiptTextV4,
  resolveAihManagedUsageRevocationV1,
  revokedOutputsClearV4,
  sameAihManagedUsageRevocationV1,
  sha256,
} from "./aih-managed-usage-audit-v1.js";
import { verifyPolicyAuthorityReceipt } from "./authority.js";
import {
  aihManagedUsageHookRollbackActionsV1,
  aihManagedUsageOwnershipMatchesCodeV4,
} from "./project.js";
import { OrgPolicyError } from "./schema.js";

interface DurableReceipt {
  readonly receipt: AihManagedUsageReceiptV4;
  readonly digest: string;
  readonly text: string;
}

function result(
  outcome: AihManagedUsageAdapterResultV1["outcome"],
  reason: NonNullable<AihManagedUsageAdapterResultV1["reason"]>,
  authority: AihManagedUsageAdapterResultV1["authority"] = "verified",
  receiptDigest?: string,
): AihManagedUsageAdapterResultV1 {
  return {
    adapter: "verified",
    authority,
    qualification: "unqualified",
    outcome,
    reason,
    ...(receiptDigest === undefined ? {} : { receiptDigest }),
  };
}

function transition(
  receipt: AihManagedUsageReceiptV4,
  authorityReceiptDigest: string,
  descriptor: AihManagedUsageDescriptorV4,
) {
  return {
    authorityReceiptDigest,
    descriptor,
    qualification: receipt.qualification,
    request: {
      decision: receipt.decision.id,
      digest: receipt.decision.digest,
      evidence: "revocation-does-not-read-qualification-evidence",
      target: receipt.target,
    },
  };
}

function receipt(
  prior: AihManagedUsageReceiptV4,
  state: "revoking" | "revoked",
  authorityReceiptDigest: string,
  descriptor: AihManagedUsageDescriptorV4,
  revocation: NonNullable<AihManagedUsageReceiptV4["revocation"]>,
): string {
  return receiptTextV4(
    receiptPayloadV4({
      ...transition(prior, authorityReceiptDigest, descriptor),
      state,
      ownership: prior.ownership,
      outputs: prior.outputs,
      prior,
      revocation,
    }),
  );
}

function exactReceiptWrite(contents: string, expected: string, describe: string): Action {
  return {
    ...writeExactText(AIH_MANAGED_USAGE_RECEIPT_V4_PATH, contents, describe),
    mode: 0o600,
    expect: { sha256: sha256(expected).slice("sha256:".length) },
    durable: true,
  };
}

function exactReceiptAssertion(contents: string, describe: string): Action {
  return {
    ...writeExactText(AIH_MANAGED_USAGE_RECEIPT_V4_PATH, contents, describe),
    expect: { sha256: sha256(contents).slice("sha256:".length) },
    assertUnchanged: true,
  };
}

function parse(root: string, descriptor: AihManagedUsageDescriptorV4): DurableReceipt | undefined {
  return parseAihManagedUsageReceiptV4(root, descriptor);
}

async function revocationCommitDeadline(
  ctx: PlanContext,
  authorityReceiptDigest: string,
): Promise<string | undefined> {
  const verified = await verifyPolicyAuthorityReceipt(ctx);
  if (
    verified.authority === undefined ||
    verified.authority.receipt.version !== 3 ||
    verified.authority.receiptDigest !== authorityReceiptDigest
  )
    return undefined;
  const deadline = Math.min(Date.now() + 60_000, Date.parse(verified.authority.receipt.expiresAt));
  return Number.isFinite(deadline) && deadline > Date.now()
    ? new Date(deadline).toISOString()
    : undefined;
}

function governedPlan(commitNotAfter: string, name: string, ...actions: Action[]) {
  return { ...plan(name, ...actions), commitNotAfter };
}

/** Claim-before-cleanup V4 revocation. No qualification bytes are read here. */
export async function revokeAihManagedUsageAdapterTransactionV1(input: {
  readonly ctx: PlanContext;
  readonly describe: () => AihManagedUsageDescriptorV4;
  readonly initial: DurableReceipt;
  readonly phases: PlanResult[];
}): Promise<AihManagedUsageAdapterResultV1> {
  const { ctx, initial, phases } = input;
  const descriptor = input.describe();
  if (
    !aihManagedUsageOwnershipMatchesCodeV4(ctx, initial.receipt.target, initial.receipt.ownership)
  )
    return result("partial", "recovery-required", "verified", initial.digest);
  const first = await resolveAihManagedUsageRevocationV1(ctx, initial.receipt);
  if (first === undefined)
    return result("partial", "recovery-required", "unverified", initial.digest);
  if (initial.receipt.state === "revoked") {
    if (!sameAihManagedUsageRevocationV1(initial.receipt.revocation, first.revocation))
      return result("partial", "recovery-required", "verified", initial.digest);
    if (!revokedOutputsClearV4(ctx.root, initial.receipt))
      return result("partial", "post-effect-drift", "verified", initial.digest);
    if (initial.receipt.authorityReceiptDigest === first.authorityReceiptDigest)
      return result("fulfilled", "revoked", "verified", initial.digest);
    const refreshed = receipt(
      initial.receipt,
      "revoked",
      first.authorityReceiptDigest,
      descriptor,
      first.revocation,
    );
    const deadline = await revocationCommitDeadline(ctx, first.authorityReceiptDigest);
    if (deadline === undefined)
      return result("partial", "recovery-required", "verified", initial.digest);
    phases.push(
      await executePlan(
        governedPlan(
          deadline,
          "policy usage-metering refresh revoked custody",
          exactReceiptWrite(
            refreshed,
            initial.text,
            "record current revoked usage adapter authority",
          ),
        ),
        ctx,
        { skipWorktreeGate: true },
      ),
    );
    const parsed = parse(ctx.root, descriptor);
    return parsed === undefined ||
      parsed.text !== refreshed ||
      !aihManagedUsageOwnershipMatchesCodeV4(
        ctx,
        parsed.receipt.target,
        parsed.receipt.ownership,
      ) ||
      !revokedOutputsClearV4(ctx.root, parsed.receipt)
      ? result("partial", "post-effect-drift")
      : result("fulfilled", "revoked", "verified", parsed.digest);
  }
  if (initial.receipt.state !== "configured" && initial.receipt.state !== "revoking")
    return result("partial", "recovery-required", "verified", initial.digest);
  if (!configuredOutputsMatchV4(ctx.root, initial.receipt))
    return result("partial", "post-effect-drift", "verified", initial.digest);

  let revoking = initial;
  if (initial.receipt.state === "configured") {
    const contents = receipt(
      initial.receipt,
      "revoking",
      first.authorityReceiptDigest,
      descriptor,
      first.revocation,
    );
    const deadline = await revocationCommitDeadline(ctx, first.authorityReceiptDigest);
    if (deadline === undefined)
      return result("partial", "recovery-required", "verified", initial.digest);
    phases.push(
      await executePlan(
        governedPlan(
          deadline,
          "policy usage-metering revocation claim",
          exactReceiptWrite(
            contents,
            initial.text,
            "durably claim fixed usage adapter revocation before cleanup",
          ),
        ),
        ctx,
        { skipWorktreeGate: true },
      ),
    );
    const parsed = parse(ctx.root, descriptor);
    if (parsed === undefined || parsed.text !== contents)
      return result("partial", "recovery-required");
    revoking = parsed;
  }
  if (
    !sameAihManagedUsageRevocationV1(revoking.receipt.revocation, first.revocation) ||
    revoking.receipt.authorityReceiptDigest !== first.authorityReceiptDigest
  )
    return result("partial", "recovery-required", "verified", revoking.digest);
  const current = await resolveAihManagedUsageRevocationV1(ctx, revoking.receipt);
  if (
    current === undefined ||
    current.authorityReceiptDigest !== first.authorityReceiptDigest ||
    !sameAihManagedUsageRevocationV1(revoking.receipt.revocation, current.revocation)
  )
    return result("partial", "recovery-required", "verified", revoking.digest);
  try {
    const deadline = await revocationCommitDeadline(ctx, current.authorityReceiptDigest);
    if (deadline === undefined)
      return result("partial", "recovery-required", "verified", revoking.digest);
    phases.push(
      await executePlan(
        governedPlan(
          deadline,
          "policy usage-metering revoke",
          exactReceiptAssertion(
            revoking.text,
            "assert exact V4 revocation claim remains unchanged through cleanup",
          ),
          ...aihManagedUsageHookRollbackActionsV1(
            ctx,
            revoking.receipt.target,
            revoking.receipt.outputs,
            revoking.receipt.ownership,
          ),
        ),
        ctx,
        // These cleanup mutations are fixed-code, exact-output CAS
        // subtractions under the revoking receipt; an AIH-created untracked
        // recorder must not block its authenticated removal as user dirt.
        { skipWorktreeGate: true },
      ),
    );
  } catch (error) {
    if (
      !(error instanceof OrgPolicyError) &&
      !(error instanceof FsTxnError) &&
      !(error instanceof AihError && error.code === "AIH_TRUST")
    )
      throw error;
    return result("partial", "post-effect-drift", "verified", revoking.digest);
  }
  if (!revokedOutputsClearV4(ctx.root, { ...revoking.receipt, state: "revoked" }))
    return result("partial", "post-effect-drift", "verified", revoking.digest);
  const finalAuthority = await resolveAihManagedUsageRevocationV1(ctx, revoking.receipt);
  if (
    finalAuthority === undefined ||
    finalAuthority.authorityReceiptDigest !== current.authorityReceiptDigest ||
    !sameAihManagedUsageRevocationV1(revoking.receipt.revocation, finalAuthority.revocation)
  )
    return result("partial", "recovery-required", "verified", revoking.digest);
  const revoked = receipt(
    revoking.receipt,
    "revoked",
    finalAuthority.authorityReceiptDigest,
    descriptor,
    finalAuthority.revocation,
  );
  const finalDeadline = await revocationCommitDeadline(ctx, finalAuthority.authorityReceiptDigest);
  if (finalDeadline === undefined)
    return result("partial", "recovery-required", "verified", revoking.digest);
  phases.push(
    await executePlan(
      governedPlan(
        finalDeadline,
        "policy usage-metering revocation finalize",
        exactReceiptWrite(
          revoked,
          revoking.text,
          "retain bounded fixed usage adapter revocation audit",
        ),
      ),
      ctx,
      { skipWorktreeGate: true },
    ),
  );
  const finalized = parse(ctx.root, descriptor);
  return finalized === undefined ||
    finalized.text !== revoked ||
    !aihManagedUsageOwnershipMatchesCodeV4(
      ctx,
      finalized.receipt.target,
      finalized.receipt.ownership,
    ) ||
    !revokedOutputsClearV4(ctx.root, finalized.receipt)
    ? result("partial", "post-effect-drift")
    : result("fulfilled", "revoked", "verified", finalized.digest);
}
