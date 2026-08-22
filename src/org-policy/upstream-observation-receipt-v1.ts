import { createHash } from "node:crypto";
import { z } from "zod";
import { isVerifiedPolicyAuthority } from "./authority.js";
import { GovernanceDecisionTimestampSchema } from "./governance-decision-v1.js";
import {
  GovernanceDecisionEffectV2Schema,
  GovernanceDecisionTargetV2Schema,
  type GovernanceDecisionV2,
  governanceDecisionDigestV2,
} from "./governance-decision-v2.js";

const ID = /^[a-z][a-z0-9-]{0,63}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const stableId = z.string().regex(ID, "must be a bounded stable identifier");
const digest = z.string().regex(SHA256, "must be a sha256 digest");
const exactSemver = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);

/** Live upstream state is short-lived; a receipt cannot claim a longer window. */
export const MAX_UPSTREAM_OBSERVATION_WINDOW_MS = 24 * 60 * 60 * 1000;

function ordinalCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortedUnique(values: readonly string[]): boolean {
  return values.every(
    (value, index) => index === 0 || ordinalCompare(values[index - 1] ?? "", value) < 0,
  );
}

const targets = z
  .array(GovernanceDecisionTargetV2Schema)
  .min(1)
  .max(64)
  .refine(sortedUnique, "must be sorted and duplicate-free");
const effects = z
  .array(GovernanceDecisionEffectV2Schema)
  .min(1)
  .max(4)
  .refine(sortedUnique, "must be sorted and duplicate-free");

/**
 * Upstream-managed install observation only. It does not execute, preview, or
 * install candidate code (#744/#745), and it does not broaden generic npm
 * executable-closure admission.
 */
export const UpstreamObservationReceiptV1Schema = z
  .object({
    format: z.literal("aih-upstream-observation-receipt"),
    version: z.literal(1),
    id: stableId.regex(/^observation-/, "observation ids must begin with observation-"),
    decision: z.object({ id: stableId, digest }).strict(),
    subject: z
      .object({
        kind: z.enum(["tool", "skill", "mcp", "package", "profile"]),
        id: stableId,
        sourceDigest: digest,
        subjectDigest: digest,
      })
      .strict(),
    targets,
    allowedEffects: effects,
    integration: z
      .object({
        mode: z.literal("upstream-managed"),
        owner: stableId,
        version: exactSemver,
      })
      .strict(),
    installed: z.object({ id: stableId, digest }).strict(),
    verifier: z.object({ id: stableId, version: exactSemver, digest }).strict(),
    observedAt: GovernanceDecisionTimestampSchema,
    validUntil: GovernanceDecisionTimestampSchema,
    outcome: z.enum(["observed-success", "partial", "refused", "drifted", "revoked", "unknown"]),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (Date.parse(value.validUntil) <= Date.parse(value.observedAt)) {
      ctx.addIssue({ code: "custom", message: "validUntil must be after observedAt" });
    }
    if (
      Date.parse(value.validUntil) - Date.parse(value.observedAt) >
      MAX_UPSTREAM_OBSERVATION_WINDOW_MS
    ) {
      ctx.addIssue({ code: "custom", message: "observation window must not exceed 24 hours" });
    }
  });

export type UpstreamObservationReceiptV1 = z.infer<typeof UpstreamObservationReceiptV1Schema>;

export function parseUpstreamObservationReceiptV1(value: unknown): UpstreamObservationReceiptV1 {
  return UpstreamObservationReceiptV1Schema.parse(value);
}

const verifiedObservationReceipts = new WeakMap<object, Readonly<UpstreamObservationReceiptV1>>();
declare const verifiedObservationBrand: unique symbol;

/** Opaque proof minted only by the code-owned observation verification seam. */
export interface VerifiedUpstreamObservationV1 {
  readonly [verifiedObservationBrand]?: never;
}

export function isVerifiedUpstreamObservationV1(
  value: unknown,
): value is VerifiedUpstreamObservationV1 {
  return typeof value === "object" && value !== null && verifiedObservationReceipts.has(value);
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value as object)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export interface VerifyUpstreamObservationV1Input {
  receipt: unknown;
  expectedVerifier: UpstreamObservationReceiptV1["verifier"];
  expectedInstalled: UpstreamObservationReceiptV1["installed"];
  expectedIntegration: UpstreamObservationReceiptV1["integration"];
  subject: Pick<GovernanceDecisionV2["subject"], "kind" | "id" | "sourceDigest" | "subjectDigest">;
  target: string;
  effect: z.infer<typeof GovernanceDecisionEffectV2Schema>;
  supportedTargets: readonly string[];
  now: string;
  /** Code-owned verifier seam; it must not perform process, network, or filesystem work here. */
  verify: (receipt: UpstreamObservationReceiptV1) => boolean;
}

/**
 * The sole pure mint for resolver-usable observations. A parsed JSON object,
 * spread, clone, or self-described verifier can never enter private custody.
 */
export function verifyUpstreamObservationV1(
  input: VerifyUpstreamObservationV1Input,
): VerifiedUpstreamObservationV1 | undefined {
  const parsed = UpstreamObservationReceiptV1Schema.safeParse(input.receipt);
  const now = Date.parse(input.now);
  if (!parsed.success || !Number.isFinite(now)) return undefined;
  const receipt = parsed.data;
  if (
    receipt.outcome !== "observed-success" ||
    Date.parse(receipt.observedAt) > now ||
    now >= Date.parse(receipt.validUntil) ||
    receipt.verifier.id !== input.expectedVerifier.id ||
    receipt.verifier.version !== input.expectedVerifier.version ||
    receipt.verifier.digest !== input.expectedVerifier.digest ||
    receipt.integration.mode !== input.expectedIntegration.mode ||
    receipt.integration.owner !== input.expectedIntegration.owner ||
    receipt.integration.version !== input.expectedIntegration.version ||
    receipt.installed.id !== input.expectedInstalled.id ||
    receipt.installed.digest !== input.expectedInstalled.digest ||
    receipt.subject.kind !== input.subject.kind ||
    receipt.subject.id !== input.subject.id ||
    receipt.subject.sourceDigest !== input.subject.sourceDigest ||
    receipt.subject.subjectDigest !== input.subject.subjectDigest ||
    !input.supportedTargets.includes(input.target) ||
    !receipt.targets.includes(input.target) ||
    !receipt.allowedEffects.includes(input.effect)
  ) {
    return undefined;
  }
  try {
    if (
      input.verify(deepFreeze(structuredClone(receipt)) as UpstreamObservationReceiptV1) !== true
    ) {
      return undefined;
    }
  } catch {
    return undefined;
  }
  const verified: VerifiedUpstreamObservationV1 = Object.freeze({});
  verifiedObservationReceipts.set(verified, deepFreeze(structuredClone(receipt)));
  return verified;
}

export type ObservedEffectResolution =
  | { state: "observed-effective"; decisionDigest: string }
  | {
      state:
        | "authority-unverified"
        | "authority-version"
        | "authority-not-current"
        | "decision-missing-or-mismatch"
        | "decision-rejected"
        | "decision-revoked"
        | "decision-not-current"
        | "decision-scope-mismatch"
        | "observation-missing"
        | "observation-unverified"
        | "observation-stale"
        | "observation-mismatch";
      decisionDigest?: string;
    };

export interface ObservedEffectResolutionInput {
  /** Only an opaque externally verified V3 authority can supply the decision. */
  authority?: unknown;
  decisionReference?: { id: string; digest: string };
  observation?: unknown;
  subject: Pick<GovernanceDecisionV2["subject"], "kind" | "id" | "sourceDigest" | "subjectDigest">;
  target: string;
  effect: z.infer<typeof GovernanceDecisionEffectV2Schema>;
  supportedTargets: readonly string[];
  expectedVerifier: UpstreamObservationReceiptV1["verifier"];
  expectedInstalled: UpstreamObservationReceiptV1["installed"];
  expectedIntegration: UpstreamObservationReceiptV1["integration"];
  now: string;
}

/**
 * Pure exact-match predicate for downstream scanners/catalogs. Success is
 * impossible without a current approved/accepted DecisionV2 and an exact,
 * successful upstream observation; it has no process, network, filesystem, or
 * candidate-execution behavior (#744/#745).
 */
export function resolveObservedEffect(
  input: ObservedEffectResolutionInput,
): ObservedEffectResolution {
  if (!isVerifiedPolicyAuthority(input.authority)) return { state: "authority-unverified" };
  const receipt = input.authority.receipt;
  if (receipt.version !== 3) return { state: "authority-version" };
  const now = Date.parse(input.now);
  if (
    !Number.isFinite(now) ||
    now < Date.parse(receipt.issuedAt) ||
    now >= Date.parse(receipt.expiresAt)
  ) {
    return { state: "authority-not-current" };
  }
  const reference = input.decisionReference;
  const decision = receipt.decisions.find(
    (candidate) =>
      candidate.id === reference?.id && governanceDecisionDigestV2(candidate) === reference.digest,
  );
  if (decision === undefined) return { state: "decision-missing-or-mismatch" };
  const decisionDigest = governanceDecisionDigestV2(decision);
  if (decision.disposition === "rejected") return { state: "decision-rejected", decisionDigest };
  if (
    now < Date.parse(decision.notBefore) ||
    now >= Date.parse(decision.expiresAt) ||
    now < Date.parse(decision.issuedAt) ||
    (decision.disposition === "accepted-with-conditions" && now >= Date.parse(decision.reviewBy))
  ) {
    return { state: "decision-not-current", decisionDigest };
  }
  const revocation = receipt.decisionRevocations.find(
    (candidate) => candidate.decisionDigest === decisionDigest,
  );
  if (revocation !== undefined) {
    if (Date.parse(revocation.revokedAt) <= now) {
      return { state: "decision-revoked", decisionDigest };
    }
  }
  if (
    decision.subject.kind !== input.subject.kind ||
    decision.subject.id !== input.subject.id ||
    decision.subject.sourceDigest !== input.subject.sourceDigest ||
    decision.subject.subjectDigest !== input.subject.subjectDigest ||
    !input.supportedTargets.includes(input.target) ||
    !decision.targets.includes(input.target) ||
    !decision.allowedEffects.includes(input.effect)
  ) {
    return { state: "decision-scope-mismatch", decisionDigest };
  }
  if (input.observation === undefined) return { state: "observation-missing", decisionDigest };
  if (!isVerifiedUpstreamObservationV1(input.observation)) {
    return { state: "observation-unverified", decisionDigest };
  }
  const observation = verifiedObservationReceipts.get(input.observation);
  if (observation === undefined) return { state: "observation-unverified", decisionDigest };
  if (now >= Date.parse(observation.validUntil)) {
    return { state: "observation-stale", decisionDigest };
  }
  if (
    Date.parse(observation.observedAt) < Date.parse(decision.notBefore) ||
    Date.parse(observation.observedAt) > now ||
    observation.decision.id !== decision.id ||
    observation.decision.digest !== decisionDigest ||
    observation.subject.kind !== decision.subject.kind ||
    observation.subject.id !== decision.subject.id ||
    observation.subject.sourceDigest !== decision.subject.sourceDigest ||
    observation.subject.subjectDigest !== decision.subject.subjectDigest ||
    observation.verifier.id !== input.expectedVerifier.id ||
    observation.verifier.version !== input.expectedVerifier.version ||
    observation.verifier.digest !== input.expectedVerifier.digest ||
    observation.integration.mode !== input.expectedIntegration.mode ||
    observation.integration.owner !== input.expectedIntegration.owner ||
    observation.integration.version !== input.expectedIntegration.version ||
    observation.installed.id !== input.expectedInstalled.id ||
    observation.installed.digest !== input.expectedInstalled.digest ||
    Date.parse(observation.validUntil) > Date.parse(decision.expiresAt) ||
    (decision.disposition === "accepted-with-conditions" &&
      Date.parse(observation.validUntil) > Date.parse(decision.reviewBy)) ||
    !observation.targets.includes(input.target) ||
    !observation.allowedEffects.includes(input.effect)
  ) {
    return { state: "observation-mismatch", decisionDigest };
  }
  return { state: "observed-effective", decisionDigest };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => ordinalCompare(left, right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Domain-separated canonical identity for a receipt produced by one observer. */
export function canonicalUpstreamObservationReceiptV1(value: UpstreamObservationReceiptV1): string {
  return `aih-upstream-observation-receipt/v1\0${stableJson(value)}`;
}

export function upstreamObservationReceiptDigestV1(value: UpstreamObservationReceiptV1): string {
  return `sha256:${createHash("sha256")
    .update(canonicalUpstreamObservationReceiptV1(value), "utf8")
    .digest("hex")}`;
}
