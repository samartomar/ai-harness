import { createHash } from "node:crypto";
import { z } from "zod";

const ID = /^[a-z][a-z0-9-]{0,63}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const OFFSET_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
const MAX_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

const stableId = z.string().regex(ID, "must be a bounded stable identifier");
const decisionId = stableId.regex(/^decision-/, "decision ids must begin with decision-");
const digest = z.string().regex(SHA256, "must be a sha256 digest");
const text = z
  .string()
  .min(1)
  .max(500)
  .refine((value) => value === value.trim() && !/[\p{C}]/u.test(value), "must be visible text");

function timestamp(value: string): boolean {
  return OFFSET_TIMESTAMP.test(value) && Number.isFinite(Date.parse(value));
}

const timestampSchema = z
  .string()
  .refine(timestamp, "must be an offset-qualified ISO-8601 timestamp");

function sortedUnique(values: readonly string[]): boolean {
  return values.every(
    (value, index) => index === 0 || (values[index - 1]?.localeCompare(value) ?? 0) < 0,
  );
}

const exactSet = z
  .array(stableId)
  .max(64)
  .refine(sortedUnique, "must be sorted and duplicate-free");
const conditions = z.array(text).max(32).refine(sortedUnique, "must be sorted and duplicate-free");

const decisionBase = z
  .object({
    id: decisionId,
    candidate: stableId,
    kind: stableId,
    targets: exactSet.min(1),
    effects: exactSet.min(1),
    policyVersion: text,
    sourceDigest: digest,
    evidenceDigest: digest,
    reviewedControlDigest: digest,
    issuer: stableId,
    actor: stableId,
    reason: text,
    issuedAt: timestampSchema,
    notBefore: timestampSchema,
    expiresAt: timestampSchema,
  })
  .strict();

const approved = decisionBase
  .extend({
    disposition: z.literal("approved"),
    acceptedFindings: exactSet.max(0),
    acceptedGaps: exactSet.max(0),
    conditions: conditions.max(0),
  })
  .strict();

const accepted = decisionBase
  .extend({
    disposition: z.literal("accepted-with-conditions"),
    acceptedFindings: exactSet.min(1),
    acceptedGaps: exactSet.min(1),
    conditions: conditions.min(1),
    reviewBy: timestampSchema,
  })
  .strict();

const rejected = decisionBase
  .extend({
    disposition: z.literal("rejected"),
    acceptedFindings: exactSet.max(0),
    acceptedGaps: exactSet.max(0),
    conditions: conditions.max(0),
  })
  .strict();

export const GovernanceDecisionV1Schema = z
  .discriminatedUnion("disposition", [approved, accepted, rejected])
  .superRefine((value, ctx) => {
    const issued = Date.parse(value.issuedAt);
    const notBefore = Date.parse(value.notBefore);
    const expires = Date.parse(value.expiresAt);
    if (notBefore < issued || expires <= notBefore || expires - issued > MAX_WINDOW_MS) {
      ctx.addIssue({
        code: "custom",
        message: "decision validity must be ordered and at most 90 days",
      });
    }
    if (value.disposition === "accepted-with-conditions") {
      const review = Date.parse(value.reviewBy);
      if (review < notBefore || review > expires || review - issued > MAX_WINDOW_MS) {
        ctx.addIssue({
          code: "custom",
          message: "reviewBy must fall inside the bounded validity window",
        });
      }
    }
  });

export type GovernanceDecisionV1 = z.infer<typeof GovernanceDecisionV1Schema>;

export const GovernanceDecisionRevocationV1Schema = z
  .object({
    decision: decisionId,
    issuer: stableId,
    revokedAt: timestampSchema,
    reason: text,
  })
  .strict();

export type GovernanceDecisionRevocationV1 = z.infer<typeof GovernanceDecisionRevocationV1Schema>;

export function parseGovernanceDecisionV1(value: unknown): GovernanceDecisionV1 {
  return GovernanceDecisionV1Schema.parse(value);
}

export function parseGovernanceDecisionRevocationV1(
  value: unknown,
): GovernanceDecisionRevocationV1 {
  return GovernanceDecisionRevocationV1Schema.parse(value);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Canonical bytes are inert transport material until a future authority seam verifies them. */
export function canonicalGovernanceDecisionV1(value: GovernanceDecisionV1): string {
  return stableJson(value);
}

export function governanceDecisionDigestV1(value: GovernanceDecisionV1): string {
  return `sha256:${createHash("sha256").update(canonicalGovernanceDecisionV1(value), "utf8").digest("hex")}`;
}
