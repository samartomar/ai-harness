import { z } from "zod";
import { GovernanceDecisionTimestampSchema } from "./governance-decision-v1.js";
import {
  GovernanceDecisionRevocationV2Schema,
  GovernanceDecisionTargetV2Schema,
  GovernanceDecisionV2Schema,
  governanceDecisionDigestV2,
} from "./governance-decision-v2.js";

const SafeId = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const Repository = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);

function ordinalCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortedUniqueBy<T>(items: readonly T[], id: (item: T) => string): boolean {
  return items.every(
    (item, index) => index === 0 || ordinalCompare(id(items[index - 1] as T), id(item)) < 0,
  );
}

function sortedUniqueByString(items: readonly string[]): boolean {
  return sortedUniqueBy(items, (item) => item);
}

const ReceiptIssuerV3Schema = z.object({ id: SafeId, githubRepository: Repository }).strict();

const ReceiptDecisionsV3Schema = z
  .array(GovernanceDecisionV2Schema)
  .max(64)
  .superRefine((decisions, ctx) => {
    if (!sortedUniqueBy(decisions, (decision) => decision.id)) {
      ctx.addIssue({
        code: "custom",
        message: "decisions must be ordinal-sorted and unique by id",
      });
    }
    const digests = decisions.map(governanceDecisionDigestV2);
    if (new Set(digests).size !== digests.length) {
      ctx.addIssue({ code: "custom", message: "decisions must be unique by immutable digest" });
    }
  });

const ReceiptDecisionRevocationsV3Schema = z
  .array(GovernanceDecisionRevocationV2Schema)
  .max(64)
  .refine(
    (revocations) => sortedUniqueBy(revocations, (revocation) => revocation.decisionDigest),
    "decisionRevocations must be ordinal-sorted and unique by immutable decision digest",
  );

/**
 * Closed Decision V2 authority payload. Transport verification is deliberately
 * separate: the same exact contract can be attested by GitHub or embedded in
 * an administrator-protected policy bundle without changing decision meaning.
 */
export const PolicyAuthorityReceiptV3Schema = z
  .object({
    format: z.literal("aih-policy-authority-receipt"),
    version: z.literal(3),
    issuerRepository: Repository,
    issuedAt: GovernanceDecisionTimestampSchema,
    expiresAt: GovernanceDecisionTimestampSchema,
    trustedIssuers: z
      .array(ReceiptIssuerV3Schema)
      .min(1)
      .max(64)
      .refine(
        (issuers) => sortedUniqueBy(issuers, (issuer) => issuer.id),
        "trustedIssuers must be ordinal-sorted and unique by id",
      ),
    targets: z
      .array(GovernanceDecisionTargetV2Schema)
      .min(1)
      .max(64)
      .refine(sortedUniqueByString, "targets must be ordinal-sorted and unique"),
    decisions: ReceiptDecisionsV3Schema,
    decisionRevocations: ReceiptDecisionRevocationsV3Schema,
  })
  .strict()
  .superRefine((receipt, ctx) => {
    const issuedAt = Date.parse(receipt.issuedAt);
    const expiresAt = Date.parse(receipt.expiresAt);
    if (expiresAt <= issuedAt) {
      ctx.addIssue({ code: "custom", message: "receipt expiresAt must be after issuedAt" });
    }
    if (expiresAt - issuedAt > 90 * 24 * 60 * 60 * 1000) {
      ctx.addIssue({ code: "custom", message: "receipt lifetime must not exceed 90 days" });
    }
    const trustedIssuers = new Set(receipt.trustedIssuers.map((issuer) => issuer.id));
    const receiptTargets = new Set<string>(receipt.targets);
    const decisions = new Map(
      receipt.decisions.map((decision) => [governanceDecisionDigestV2(decision), decision]),
    );
    for (const decision of receipt.decisions) {
      const digest = governanceDecisionDigestV2(decision);
      if (!trustedIssuers.has(decision.issuer)) {
        ctx.addIssue({ code: "custom", message: `decision ${digest} issuer is not trusted` });
      }
      if (decision.targets.some((target) => !receiptTargets.has(target))) {
        ctx.addIssue({ code: "custom", message: `decision ${digest} exceeds receipt targets` });
      }
      if (Date.parse(decision.issuedAt) > issuedAt || Date.parse(decision.expiresAt) > expiresAt) {
        ctx.addIssue({ code: "custom", message: `decision ${digest} is outside receipt validity` });
      }
    }
    for (const revocation of receipt.decisionRevocations) {
      const decision = decisions.get(revocation.decisionDigest);
      if (decision === undefined) {
        ctx.addIssue({
          code: "custom",
          message: `decision revocation targets unknown ${revocation.decisionDigest}`,
        });
        continue;
      }
      const revokedAt = Date.parse(revocation.revokedAt);
      if (revocation.issuer !== decision.issuer) {
        ctx.addIssue({ code: "custom", message: "decision revocation issuer mismatches decision" });
      }
      if (revokedAt < Date.parse(decision.issuedAt) || revokedAt > issuedAt) {
        ctx.addIssue({ code: "custom", message: "decision revocation time is invalid" });
      }
    }
  });

export type PolicyAuthorityReceiptV3 = z.infer<typeof PolicyAuthorityReceiptV3Schema>;
