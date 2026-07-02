import { z } from "zod";
import { OrgPolicySchema } from "./schema.js";

/**
 * Policy-bundle envelope — ONE versioned shape shared by the local
 * `aih-org-policy.json` (embedded whole as `policy`) and a future SIGNED org
 * bundle an org distributes to its fleet. The envelope adds only provenance
 * (`bundleVersion`, `issuer`, `issuedAt`) and optional ring metadata around the
 * existing {@link OrgPolicySchema}; it never forks the policy shape itself, so a
 * repo validating its local policy and a fleet validating a distributed bundle
 * are exercising the SAME schema. No network code and no signing live here —
 * signing rides `SHA256SUMS` like every other aih artifact, and the read-only
 * gate over both forms is `aih policy validate`.
 */

/** Deployment-ring metadata a bundle may carry (names only; rollout logic is future work). */
const PolicyRingSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().min(1).optional(),
  })
  .strict();

export const PolicyBundleSchema = z
  .object({
    schemaVersion: z.literal(1),
    /** Issuer-assigned bundle version (opaque; aih never orders or compares it). */
    bundleVersion: z.string().min(1),
    /** Who issued the bundle (an org/team identity, human-auditable). */
    issuer: z.string().min(1),
    /** ISO-8601 issue stamp — operator/issuer-supplied, NEVER a wall-clock read here. */
    issuedAt: z.iso.datetime({ offset: true }),
    /** The embedded org policy — the exact local `aih-org-policy.json` shape. */
    policy: OrgPolicySchema,
    rings: z.array(PolicyRingSchema).optional(),
  })
  .strict();

export type PolicyBundle = z.infer<typeof PolicyBundleSchema>;
export type PolicyRing = z.infer<typeof PolicyRingSchema>;

export type PolicyBundleParse = { ok: true; bundle: PolicyBundle } | { ok: false; error: string };

/** `path — message` for one zod issue, mirroring `readMarketplaceManifest`'s rendering. */
function describeIssue(issue: {
  readonly path: ReadonlyArray<PropertyKey>;
  readonly message: string;
}): string {
  return `${issue.path.map(String).join(".") || "(root)"} — ${issue.message}`;
}

/**
 * Parse a policy-bundle envelope into a discriminated RESULT rather than a throw
 * (the `readMarketplaceManifest` posture, not `parseOrgPolicy`'s): the consumer
 * is `aih policy validate`, a checker, so a malformed bundle is a FINDING it
 * must report — never a crash. One parse covers BOTH layers (the envelope
 * embeds {@link OrgPolicySchema}), and the error message names WHICH layer
 * failed: issues rooted under `policy` are the embedded org policy, everything
 * else is the envelope itself.
 */
export function parsePolicyBundle(value: unknown): PolicyBundleParse {
  const result = PolicyBundleSchema.safeParse(value);
  if (result.success) return { ok: true, bundle: result.data };
  const issues = result.error.issues;
  const envelope = issues.filter((i) => i.path[0] !== "policy").map(describeIssue);
  const policy = issues.filter((i) => i.path[0] === "policy").map(describeIssue);
  const parts: string[] = [];
  if (envelope.length > 0) parts.push(`bundle envelope is invalid: ${envelope.join("; ")}`);
  if (policy.length > 0) parts.push(`embedded org policy is invalid: ${policy.join("; ")}`);
  return { ok: false, error: parts.join(" · ") };
}
