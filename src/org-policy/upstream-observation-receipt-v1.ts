import { createHash } from "node:crypto";
import { z } from "zod";
import { GovernanceDecisionTimestampSchema } from "./governance-decision-v1.js";
import {
  GovernanceDecisionEffectV2Schema,
  GovernanceDecisionRevocationV2Schema,
  GovernanceDecisionTargetV2Schema,
  type GovernanceDecisionV2,
  GovernanceDecisionV2Schema,
  governanceDecisionDigestV2,
} from "./governance-decision-v2.js";

const ID = /^[a-z][a-z0-9-]{0,63}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const stableId = z.string().regex(ID, "must be a bounded stable identifier");
const digest = z.string().regex(SHA256, "must be a sha256 digest");
const exactSemver = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);

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
  .max(3)
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
  });

export type UpstreamObservationReceiptV1 = z.infer<typeof UpstreamObservationReceiptV1Schema>;

export function parseUpstreamObservationReceiptV1(value: unknown): UpstreamObservationReceiptV1 {
  return UpstreamObservationReceiptV1Schema.parse(value);
}

export type ObservedEffectResolution =
  | { state: "observed-effective"; decisionDigest: string }
  | {
      state:
        | "decision-invalid"
        | "decision-rejected"
        | "decision-revoked"
        | "decision-not-current"
        | "decision-revocation-invalid"
        | "decision-scope-mismatch"
        | "observation-missing"
        | "observation-invalid"
        | "observation-stale"
        | "observation-unsuccessful"
        | "observation-mismatch";
      decisionDigest?: string;
    };

export interface ObservedEffectResolutionInput {
  decision: unknown;
  observation?: unknown;
  revocation?: unknown;
  subject: Pick<GovernanceDecisionV2["subject"], "kind" | "id" | "sourceDigest" | "subjectDigest">;
  target: string;
  effect: z.infer<typeof GovernanceDecisionEffectV2Schema>;
  supportedTargets: readonly string[];
  expectedVerifier: UpstreamObservationReceiptV1["verifier"];
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
  const parsedDecision = GovernanceDecisionV2Schema.safeParse(input.decision);
  if (!parsedDecision.success) return { state: "decision-invalid" };
  const decision = parsedDecision.data;
  const decisionDigest = governanceDecisionDigestV2(decision);
  const now = Date.parse(input.now);
  if (!Number.isFinite(now)) return { state: "decision-not-current", decisionDigest };
  if (decision.disposition === "rejected") return { state: "decision-rejected", decisionDigest };
  if (
    now < Date.parse(decision.notBefore) ||
    now >= Date.parse(decision.expiresAt) ||
    now < Date.parse(decision.issuedAt) ||
    (decision.disposition === "accepted-with-conditions" && now >= Date.parse(decision.reviewBy))
  ) {
    return { state: "decision-not-current", decisionDigest };
  }
  if (input.revocation !== undefined) {
    const parsedRevocation = GovernanceDecisionRevocationV2Schema.safeParse(input.revocation);
    if (
      !parsedRevocation.success ||
      parsedRevocation.data.decisionDigest !== decisionDigest ||
      parsedRevocation.data.issuer !== decision.issuer
    ) {
      return { state: "decision-revocation-invalid", decisionDigest };
    }
    if (Date.parse(parsedRevocation.data.revokedAt) <= now) {
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
  const parsedObservation = UpstreamObservationReceiptV1Schema.safeParse(input.observation);
  if (!parsedObservation.success) return { state: "observation-invalid", decisionDigest };
  const observation = parsedObservation.data;
  if (observation.outcome !== "observed-success") {
    return { state: "observation-unsuccessful", decisionDigest };
  }
  if (now >= Date.parse(observation.validUntil)) {
    return { state: "observation-stale", decisionDigest };
  }
  if (
    Date.parse(observation.observedAt) < Date.parse(decision.issuedAt) ||
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
