import { assertExactKeysV1, assertRecordV1 } from "./capability-v1.js";
import {
  GOVERNANCE_DOCTOR_REPAIR_EFFECT_KINDS_V1,
  type GovernanceDoctorRepairEffectKindV1,
} from "./repair-broker-v1.js";
import { failGovernanceDoctorRepairV1 } from "./repair-capability-v1.js";
import { acquireGovernanceDoctorRepairClaimV1 } from "./repair-claim-store-v1.js";
import {
  assertGovernanceDoctorRepairContentClosureV1,
  governanceDoctorRepairContentBytesV1,
  normalizeGovernanceDoctorRepairLineEndingsV1,
  recordGovernanceDoctorRepairAttemptEvidenceV1,
  rewriteGovernanceDoctorRepairMarkerBlockV1,
} from "./repair-content-v1.js";
import {
  createGovernanceDoctorRepairMutationGrantV1,
  governanceDoctorRepairCreateDirectoryV1,
  governanceDoctorRepairCustodyPlanSha256V1,
  governanceDoctorRepairCustodyRootRealPathV1,
  governanceDoctorRepairReadV1,
  governanceDoctorRepairWriteFileV1,
} from "./repair-custody-v1.js";
import {
  createGovernanceDoctorRepairReceiptV1,
  type GovernanceDoctorRepairEffectResultV1,
  type GovernanceDoctorRepairReceiptV1,
} from "./repair-outcome-v1.js";
import {
  canonicalGovernanceDoctorRepairPlanV1Bytes,
  type GovernanceDoctorRepairEffectV1,
  type GovernanceDoctorRepairPlanV1,
} from "./repair-plan-v1.js";

/**
 * The internal AIH Core local mechanical Repair executor.
 *
 * It applies exactly the four frozen V1 effect kinds and nothing else. Its whole
 * capability is the plan-bound custody handed to it: bounded reads, one declared
 * directory creation, and managed writes that publish by hard link and never
 * replace. Those writes are deliberately not described as atomic -- they are a
 * write / flush / displace / link / retire sequence with an explicit recovery,
 * and the recovery is the part that carries the guarantee: no failure path
 * destroys an object this executor did not create, and no partial body is ever
 * published under a managed name. There is no process, shell,
 * network, provider, scanner, signer, package, publication, selection, approval,
 * or deletion route in its import closure, and no seam through which a caller
 * could hand it something to run.
 *
 * Authority is assembled, never assumed. A run needs a branded Plan, a granted
 * out-of-band Consent for that same Plan, an execution context that binds both,
 * custody minted for that same Plan identity, and a trusted content input holding
 * exactly the digests the Plan's effects name -- no more and no fewer. The join is
 * checked in full before a single byte is written, and the foundation's own
 * Receipt constructor is what validates the consent decision and the attempt
 * window, so this module cannot grant itself something the contract would refuse.
 *
 * Durable single-use is enforced, and never from caller-provided replay state. A
 * granted Consent is spent exactly once per Plan per canonical checkout, and the
 * record that spends it is committed to the machine-local claim store before the
 * first byte moves. The claim is taken after every pure join above has already
 * passed, so a Plan this run was never going to apply does not burn its one
 * attempt; and it is taken before the first effect, so an interruption anywhere
 * after it leaves the Plan spent rather than replayable.
 *
 * Effects apply in Plan order and stop at the first one that does not reach its
 * goal state; the remainder are recorded as skipped. Applying an effect whose goal
 * state already holds writes nothing, so a second run over the same tree is
 * byte-identical and produces an identical Receipt.
 *
 * The Receipt reports what happened, and only that. It never claims verification:
 * a covering Verification comes from the separate verifier re-reading the result.
 * An effect that already committed is reported as applied even when a later effect
 * fails, because a rollback that did not occur must never be implied.
 *
 * Alongside the Receipt this run records the exact post-state it observed for the
 * effects it applied, keyed by the Receipt object itself. That record is local
 * evidence, not authority: it never travels, so a Receipt reconstructed from
 * transported bytes carries none of it and verifies as unavailable rather than
 * inheriting an attribution nobody local can vouch for.
 */
export const GOVERNANCE_DOCTOR_REPAIR_EXECUTABLE_EFFECT_KINDS_V1: readonly GovernanceDoctorRepairEffectKindV1[] =
  Object.freeze([
    "create-managed-directory",
    "normalize-managed-line-endings",
    "restore-managed-file-content",
    "rewrite-managed-marker-block",
  ] as const);

// Load-time guard: this executor can never carry an authority the broker has not frozen.
for (const kind of GOVERNANCE_DOCTOR_REPAIR_EXECUTABLE_EFFECT_KINDS_V1)
  if (!GOVERNANCE_DOCTOR_REPAIR_EFFECT_KINDS_V1.includes(kind))
    failGovernanceDoctorRepairV1("repair executor names an unregistered effect kind");

const EXECUTION_FIELDS = ["consent", "content", "context", "custody", "plan"] as const;

interface AppliedEffectV1 {
  readonly expected?:
    | { readonly effectSha256: string; readonly state: "directory" }
    | { readonly bytes: Buffer; readonly effectSha256: string; readonly state: "file" };
  readonly result: GovernanceDoctorRepairEffectResultV1;
}

/** One declared argument value, or a closed refusal. The Plan schema guarantees it. */
function effectArgument(effect: GovernanceDoctorRepairEffectV1, name: string): string {
  const value = effect.arguments[name];
  if (value === undefined) failGovernanceDoctorRepairV1("repair effect argument is missing");
  return value;
}

/**
 * Applies one effect and reports whether its goal state holds afterwards. Every
 * custody refusal is already a closed label; here it collapses into one closed
 * per-effect result, so no filesystem detail can reach the Receipt.
 */
function applyEffectV1(
  custody: unknown,
  consent: unknown,
  content: unknown,
  effect: GovernanceDoctorRepairEffectV1,
  receipt: GovernanceDoctorRepairReceiptV1,
): AppliedEffectV1 {
  try {
    const path = effectArgument(effect, "path");
    const kind = effect.effectKind;

    if (kind === "create-managed-directory") {
      const live = governanceDoctorRepairReadV1(custody, path);
      if (live.state === "directory")
        return {
          expected: { effectSha256: effect.effectSha256, state: "directory" },
          result: "applied",
        };
      if (live.state !== "absent") return { result: "failed" };
      governanceDoctorRepairCreateDirectoryV1(
        createGovernanceDoctorRepairMutationGrantV1({
          consent,
          custody,
          effectId: effect.effectId,
          receipt,
        }),
      );
      return {
        expected: { effectSha256: effect.effectSha256, state: "directory" },
        result: "applied",
      };
    }

    if (kind === "normalize-managed-line-endings") {
      const live = governanceDoctorRepairReadV1(custody, path);
      if (live.state !== "file") return { result: "failed" };
      const normalized = normalizeGovernanceDoctorRepairLineEndingsV1(live.bytes);
      if (normalized === null) return { result: "failed" };
      if (normalized.equals(live.bytes))
        return {
          expected: { bytes: normalized, effectSha256: effect.effectSha256, state: "file" },
          result: "applied",
        };
      governanceDoctorRepairWriteFileV1(
        createGovernanceDoctorRepairMutationGrantV1({
          consent,
          custody,
          effectId: effect.effectId,
          receipt,
        }),
        normalized,
        live,
      );
      return {
        expected: { bytes: normalized, effectSha256: effect.effectSha256, state: "file" },
        result: "applied",
      };
    }

    if (kind === "restore-managed-file-content") {
      const desired = governanceDoctorRepairContentBytesV1(
        content,
        effectArgument(effect, "contentSha256"),
      );
      const live = governanceDoctorRepairReadV1(custody, path);
      if (live.state === "file" && live.bytes.equals(desired))
        return {
          expected: { bytes: desired, effectSha256: effect.effectSha256, state: "file" },
          result: "applied",
        };
      if (live.state !== "file" && live.state !== "absent") return { result: "failed" };
      governanceDoctorRepairWriteFileV1(
        createGovernanceDoctorRepairMutationGrantV1({
          consent,
          custody,
          effectId: effect.effectId,
          receipt,
        }),
        desired,
        live,
      );
      return {
        expected: { bytes: desired, effectSha256: effect.effectSha256, state: "file" },
        result: "applied",
      };
    }

    if (kind === "rewrite-managed-marker-block") {
      const body = governanceDoctorRepairContentBytesV1(
        content,
        effectArgument(effect, "contentSha256"),
      );
      const live = governanceDoctorRepairReadV1(custody, path);
      if (live.state !== "file") return { result: "failed" };
      const next = rewriteGovernanceDoctorRepairMarkerBlockV1(
        live.bytes,
        effectArgument(effect, "blockId"),
        body,
      );
      if (next === null) return { result: "failed" };
      if (next.equals(live.bytes))
        return {
          expected: { bytes: next, effectSha256: effect.effectSha256, state: "file" },
          result: "applied",
        };
      governanceDoctorRepairWriteFileV1(
        createGovernanceDoctorRepairMutationGrantV1({
          consent,
          custody,
          effectId: effect.effectId,
          receipt,
        }),
        next,
        live,
      );
      return {
        expected: { bytes: next, effectSha256: effect.effectSha256, state: "file" },
        result: "applied",
      };
    }

    // Closed default: an effect kind outside the frozen allowlist is never applied.
    return { result: "failed" };
  } catch {
    return { result: "failed" };
  }
}

/**
 * Applies one consented Repair Plan under its own root and returns the bound
 * Receipt. Every identity is joined before any mutation, and the Receipt records
 * every effect result without asserting that any of them were verified.
 */
export function executeGovernanceDoctorRepairV1(input: unknown): GovernanceDoctorRepairReceiptV1 {
  const request = assertRecordV1(input, "repair execution request");
  assertExactKeysV1(request, EXECUTION_FIELDS, "repair execution request");
  canonicalGovernanceDoctorRepairPlanV1Bytes(request.plan);
  const plan = request.plan as GovernanceDoctorRepairPlanV1;

  if (governanceDoctorRepairCustodyPlanSha256V1(request.custody) !== plan.planSha256)
    failGovernanceDoctorRepairV1("repair custody was not minted for this plan");
  for (const effect of plan.effects)
    if (!GOVERNANCE_DOCTOR_REPAIR_EXECUTABLE_EFFECT_KINDS_V1.includes(effect.effectKind))
      failGovernanceDoctorRepairV1("repair plan names an effect this executor cannot apply");
  assertGovernanceDoctorRepairContentClosureV1(request.content, plan.effects);

  // Authority preflight: the foundation's own Receipt constructor validates the
  // plan, granted consent, execution context, and attempt window. Minting a
  // discarded all-skipped Receipt runs that check before anything is written.
  const receiptRequest = {
    // Read the clock only after all non-effectful joins and immediately before
    // the first authority-consuming preflight. Callers cannot choose this fact.
    attemptedAtEpochMs: Date.now(),
    consent: request.consent,
    context: request.context,
    plan,
  };
  const preflight = createGovernanceDoctorRepairReceiptV1({
    ...receiptRequest,
    effects: plan.effects.map((effect) => ({ effectId: effect.effectId, result: "skipped" })),
  });

  // The last thing before the first effect, and the first thing that outlives this
  // process. Every join above is pure or in-memory, so a Plan refused up there has
  // spent nothing; from here on the Plan is spent whatever happens next, including
  // a crash, because a claim that survives is never a licence to try again.
  acquireGovernanceDoctorRepairClaimV1({
    consent: request.consent,
    plan,
    rootRealPath: governanceDoctorRepairCustodyRootRealPathV1(request.custody),
  });

  const results: AppliedEffectV1[] = [];
  let halted = false;
  for (const effect of plan.effects) {
    if (halted) {
      results.push({ result: "skipped" });
      continue;
    }
    const result = applyEffectV1(
      request.custody,
      request.consent,
      request.content,
      effect,
      preflight,
    );
    results.push(result);
    halted = result.result !== "applied";
  }

  const receipt = createGovernanceDoctorRepairReceiptV1({
    ...receiptRequest,
    effects: plan.effects.map((effect, index) => ({
      effectId: effect.effectId,
      result: results[index]?.result ?? "skipped",
    })),
  });
  // Applied-only, and strictly so: the post-state is recorded for an effect this
  // run actually applied and for no other. A failed or skipped effect contributes
  // nothing, so the verifier can never read local evidence as a claim about work
  // that did not happen.
  recordGovernanceDoctorRepairAttemptEvidenceV1(
    receipt,
    results.flatMap((result, index) =>
      result.result === "applied" &&
      result.expected !== undefined &&
      receipt.effects[index]?.result === "applied"
        ? [result.expected]
        : [],
    ),
  );
  return receipt;
}
