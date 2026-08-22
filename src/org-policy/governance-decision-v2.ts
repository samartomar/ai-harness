import { createHash } from "node:crypto";
import { z } from "zod";
import { GovernanceDecisionTimestampSchema } from "./governance-decision-v1.js";

const ID = /^[a-z][a-z0-9-]{0,63}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const SHA1 = /^[0-9a-f]{40}$/;
const MAX_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

const stableId = z.string().regex(ID, "must be a bounded stable identifier");
const digest = z.string().regex(SHA256, "must be a sha256 digest");
const text = z
  .string()
  .min(1)
  .max(500)
  .refine((value) => value === value.trim() && !/[\p{C}]/u.test(value), "must be visible text");
const repository = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
const sourcePath = z
  .string()
  .min(1)
  .max(500)
  .refine(
    (value) =>
      value === value.trim() &&
      !value.startsWith("/") &&
      !value.includes("\\") &&
      value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..") &&
      !/[\p{C}]/u.test(value),
    "must be a bounded relative source path",
  );
const exactSemver = z.string().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
const ociRepository = z.string().regex(/^[a-z0-9][a-z0-9._/-]*$/);
const httpsOrigin = z.string().refine((value) => {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.username === "" &&
      url.password === "" &&
      value === url.origin &&
      url.search === "" &&
      url.hash === ""
    );
  } catch {
    return false;
  }
}, "must be a bare HTTPS origin");

function ordinalCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortedUnique(values: readonly string[]): boolean {
  return values.every(
    (value, index) => index === 0 || ordinalCompare(values[index - 1] ?? "", value) < 0,
  );
}

function validSha512Sri(value: string): boolean {
  const match = /^sha512-([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (match?.[1] === undefined) return false;
  const encoded = match[1];
  const decoded = Buffer.from(encoded, "base64");
  return decoded.length === 64 && decoded.toString("base64") === encoded;
}

const exactSet = z
  .array(stableId)
  .max(64)
  .refine(sortedUnique, "must be sorted and duplicate-free");
export const GovernanceDecisionTargetV2Schema = stableId;
const targets = z
  .array(GovernanceDecisionTargetV2Schema)
  .min(1)
  .max(64)
  .refine(sortedUnique, "must be sorted and duplicate-free");
export const GovernanceDecisionEffectV2Schema = z.enum(["configure", "install", "observe", "use"]);
const effects = z
  .array(GovernanceDecisionEffectV2Schema)
  .min(1)
  .max(4)
  .refine(sortedUnique, "must be sorted and duplicate-free");
const conditions = z.array(text).max(32).refine(sortedUnique, "must be sorted and duplicate-free");

/** Immutable source identity; neither branch permits a mutable branch, tag, range, or URL path. */
export const GovernanceDecisionSourceV2Schema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("github"),
      repository,
      commit: z.string().regex(SHA1),
      path: sourcePath,
    })
    .strict(),
  z
    .object({
      type: z.literal("npm"),
      registry: httpsOrigin,
      package: z.string().regex(/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/),
      version: exactSemver,
      integrity: z.string().refine(validSha512Sri, "must be a canonical sha512 SRI digest"),
    })
    .strict(),
  z
    .object({
      type: z.literal("pypi"),
      registry: httpsOrigin,
      package: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/),
      version: exactSemver,
      filename: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/),
      sha256: digest,
    })
    .strict(),
  z
    .object({
      type: z.literal("oci"),
      registry: z.string().regex(/^[A-Za-z0-9.-]+(?::[0-9]{1,5})?$/),
      repository: ociRepository,
      indexDigest: digest,
      platform: z
        .object({ os: stableId, architecture: stableId, variant: stableId.optional() })
        .strict(),
      manifestDigest: digest,
    })
    .strict(),
  z.object({ type: z.literal("remote"), origin: httpsOrigin, contentDigest: digest }).strict(),
  z.object({ type: z.literal("aih"), release: exactSemver, revision: digest }).strict(),
]);

export const GovernanceDecisionSubjectV2Schema = z
  .object({
    kind: z.enum(["tool", "skill", "mcp", "package", "profile"]),
    id: stableId,
    source: GovernanceDecisionSourceV2Schema,
    sourceDigest: digest,
    subjectDigest: digest,
  })
  .strict();

const base = z
  .object({
    format: z.literal("aih-governance-decision"),
    version: z.literal(2),
    id: stableId.regex(/^decision-/, "decision ids must begin with decision-"),
    qualification: z.enum(["aih-supported", "organization-qualified"]),
    subject: GovernanceDecisionSubjectV2Schema,
    targets,
    allowedEffects: effects,
    policy: z.object({ id: stableId, version: text, digest }).strict(),
    control: z.object({ id: stableId, digest }).strict(),
    evidence: z.object({ id: stableId, digest, attestor: stableId }).strict(),
    issuer: stableId,
    actor: stableId,
    reason: text,
    issuedAt: GovernanceDecisionTimestampSchema,
    notBefore: GovernanceDecisionTimestampSchema,
    expiresAt: GovernanceDecisionTimestampSchema,
  })
  .strict();

const approved = base
  .extend({
    disposition: z.literal("approved"),
    acceptedFindings: exactSet.max(0),
    acceptedGaps: exactSet.max(0),
    conditions: conditions.max(0),
  })
  .strict();
const accepted = base
  .extend({
    disposition: z.literal("accepted-with-conditions"),
    acceptedFindings: exactSet,
    acceptedGaps: exactSet,
    conditions: conditions.min(1),
    reviewBy: GovernanceDecisionTimestampSchema,
  })
  .strict();
const rejected = base
  .extend({
    disposition: z.literal("rejected"),
    acceptedFindings: exactSet.max(0),
    acceptedGaps: exactSet.max(0),
    conditions: conditions.max(0),
  })
  .strict();

/**
 * Domain-separated, exact-subject governance artifact. `unqualified` is
 * intentionally absent: it is a resolver state, never an approvable origin.
 */
export const GovernanceDecisionV2Schema = z
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
      if (value.acceptedFindings.some((finding) => value.acceptedGaps.includes(finding))) {
        ctx.addIssue({ code: "custom", message: "accepted findings and gaps must not overlap" });
      }
      if (value.acceptedFindings.length + value.acceptedGaps.length === 0) {
        ctx.addIssue({
          code: "custom",
          message: "accepted decisions require findings and/or named waivable gaps",
        });
      }
      const review = Date.parse(value.reviewBy);
      if (review < notBefore || review > expires || review - issued > MAX_WINDOW_MS) {
        ctx.addIssue({ code: "custom", message: "reviewBy must fall inside the validity window" });
      }
    }
  });

export type GovernanceDecisionV2 = z.infer<typeof GovernanceDecisionV2Schema>;

/** Revocation binds the immutable decision digest and issuer, never just a mutable decision id. */
export const GovernanceDecisionRevocationV2Schema = z
  .object({
    format: z.literal("aih-governance-decision-revocation"),
    version: z.literal(2),
    decisionDigest: digest,
    issuer: stableId,
    revokedAt: GovernanceDecisionTimestampSchema,
    reason: text,
  })
  .strict();

export type GovernanceDecisionRevocationV2 = z.infer<typeof GovernanceDecisionRevocationV2Schema>;

export function parseGovernanceDecisionV2(value: unknown): GovernanceDecisionV2 {
  return GovernanceDecisionV2Schema.parse(value);
}

export function parseGovernanceDecisionRevocationV2(
  value: unknown,
): GovernanceDecisionRevocationV2 {
  return GovernanceDecisionRevocationV2Schema.parse(value);
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

/** Canonical bytes are domain-separated so V1 and V2 digests cannot collide. */
export function canonicalGovernanceDecisionV2(value: GovernanceDecisionV2): string {
  return `aih-governance-decision/v2\0${stableJson(value)}`;
}

export function governanceDecisionDigestV2(value: GovernanceDecisionV2): string {
  return `sha256:${createHash("sha256")
    .update(canonicalGovernanceDecisionV2(value), "utf8")
    .digest("hex")}`;
}

export function canonicalGovernanceDecisionRevocationV2(
  value: GovernanceDecisionRevocationV2,
): string {
  return `aih-governance-decision-revocation/v2\0${stableJson(value)}`;
}

export function governanceDecisionRevocationDigestV2(
  value: GovernanceDecisionRevocationV2,
): string {
  return `sha256:${createHash("sha256")
    .update(canonicalGovernanceDecisionRevocationV2(value), "utf8")
    .digest("hex")}`;
}
