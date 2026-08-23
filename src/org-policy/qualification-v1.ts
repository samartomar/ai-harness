import { createHash } from "node:crypto";
import { z } from "zod";
import { isVerifiedPolicyAuthority, type VerifiedPolicyAuthority } from "./authority.js";
import { GovernanceDecisionTimestampSchema } from "./governance-decision-v1.js";
import {
  type GovernanceDecisionEffectV2Schema,
  type GovernanceDecisionV2,
  governanceDecisionDigestV2,
} from "./governance-decision-v2.js";

const ID = /^[a-z][a-z0-9-]{0,63}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;
const MAX_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;
/** Bound portable evidence transport before decoding hostile input. */
export const MAX_ORGANIZATION_EVIDENCE_ENVELOPE_BYTES_V1 = 4_096;
const stableId = z.string().regex(ID, "must be a bounded stable identifier");
const digest = z.string().regex(SHA256, "must be a sha256 digest");
const attestor = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:._@/-]{0,255}$/);
const summary = z
  .string()
  .min(1)
  .max(500)
  .refine((value) => value === value.trim() && !/[\p{C}]/u.test(value), "must be visible text");

function ordinalCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
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

function sortedUnique(values: readonly string[]): boolean {
  return values.every(
    (value, index) => index === 0 || ordinalCompare(values[index - 1] ?? "", value) < 0,
  );
}

/**
 * An attributable organization assertion. Its `attestor` is issuer-claimed
 * data; only the V3 authority transport authenticates the decision that binds
 * this envelope. The envelope itself is never a signature or authorization.
 */
export const OrganizationEvidenceEnvelopeV1Schema = z
  .object({
    format: z.literal("aih-organization-evidence"),
    version: z.literal(1),
    subjectDigest: digest,
    evidence: z
      .object({
        kind: stableId,
        id: stableId,
        summary,
        payloadDigest: digest,
        artifactDigests: z
          .array(digest)
          .min(1)
          .max(16)
          .refine(sortedUnique, "must be sorted and duplicate-free"),
      })
      .strict(),
    attestor,
    issuedAt: GovernanceDecisionTimestampSchema,
    notBefore: GovernanceDecisionTimestampSchema,
    expiresAt: GovernanceDecisionTimestampSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    const issuedAt = Date.parse(value.issuedAt);
    const notBefore = Date.parse(value.notBefore);
    const expiresAt = Date.parse(value.expiresAt);
    if (notBefore < issuedAt || expiresAt <= notBefore || expiresAt - issuedAt > MAX_WINDOW_MS) {
      ctx.addIssue({
        code: "custom",
        message: "evidence validity must be ordered and at most 90 days",
      });
    }
  });

export type OrganizationEvidenceEnvelopeV1 = z.infer<typeof OrganizationEvidenceEnvelopeV1Schema>;

/** Canonical transport bytes; callers must provide precisely these bytes to the mint. */
export function canonicalOrganizationEvidenceEnvelopeV1(
  value: OrganizationEvidenceEnvelopeV1,
): string {
  return stableJson(value);
}

export function organizationEvidenceEnvelopeDigestV1(
  value: OrganizationEvidenceEnvelopeV1,
): string {
  return `sha256:${createHash("sha256")
    .update(
      `aih-organization-evidence/v1\0${canonicalOrganizationEvidenceEnvelopeV1(value)}`,
      "utf8",
    )
    .digest("hex")}`;
}

/**
 * Parses only canonical UTF-8 JSON. Formatting, duplicate members, trailing
 * newlines, byte-order marks, and any unknown member therefore fail closed.
 */
export function parseOrganizationEvidenceEnvelopeV1Bytes(
  bytes: Uint8Array,
): OrganizationEvidenceEnvelopeV1 | undefined {
  if (bytes.byteLength > MAX_ORGANIZATION_EVIDENCE_ENVELOPE_BYTES_V1) return undefined;
  let text: string;
  let raw: unknown;
  try {
    // Keep a byte-order mark visible so the exact canonical-byte comparison rejects it.
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  const parsed = OrganizationEvidenceEnvelopeV1Schema.safeParse(raw);
  if (!parsed.success || text !== canonicalOrganizationEvidenceEnvelopeV1(parsed.data))
    return undefined;
  return parsed.data;
}

const verifiedQualifications = new WeakMap<object, Readonly<QualificationBinding>>();
declare const verifiedQualificationBrand: unique symbol;

/** Opaque, process-local capability minted only after the V3-bound checks below. */
export interface VerifiedQualificationV1 {
  readonly [verifiedQualificationBrand]?: never;
}

interface QualificationBinding {
  readonly authorityReceiptDigest: string;
  readonly decisionDigest: string;
  readonly effect: z.infer<typeof GovernanceDecisionEffectV2Schema>;
  readonly expiresAt: string;
  /** Closed today, but permits a future code-owned qualification mint without a token API break. */
  readonly kind: GovernanceDecisionV2["qualificationBasis"]["kind"];
  readonly notBefore: string;
  readonly subjectDigest: string;
  readonly target: string;
}

export interface AihSupportedQualificationBindingV1 {
  readonly subject: GovernanceDecisionV2["subject"];
  readonly qualificationBasis: Extract<
    GovernanceDecisionV2["qualificationBasis"],
    { kind: "aih-supported" }
  >;
  readonly issuedAt: string;
  readonly notBefore: string;
  readonly expiresAt: string;
}

export function isVerifiedQualificationV1(value: unknown): value is VerifiedQualificationV1 {
  return typeof value === "object" && value !== null && verifiedQualifications.has(value);
}

export interface VerifyOrganizationQualificationV1Input {
  authority?: unknown;
  bytes: Uint8Array;
  decisionReference?: { id: string; digest: string };
  effect: z.infer<typeof GovernanceDecisionEffectV2Schema>;
  now: string;
  subject: Pick<GovernanceDecisionV2["subject"], "kind" | "id" | "sourceDigest" | "subjectDigest">;
  supportedTargets: readonly string[];
  target: string;
}

interface CurrentDecisionInput {
  authority?: unknown;
  decisionReference?: { id: string; digest: string };
  effect: z.infer<typeof GovernanceDecisionEffectV2Schema>;
  now: string;
  subject: Pick<GovernanceDecisionV2["subject"], "kind" | "id" | "sourceDigest" | "subjectDigest">;
  supportedTargets: readonly string[];
  target: string;
}

function currentDecision(input: CurrentDecisionInput):
  | {
      authority: VerifiedPolicyAuthority;
      decision: GovernanceDecisionV2;
      digest: string;
      now: number;
    }
  | undefined {
  const authority = input.authority;
  if (!isVerifiedPolicyAuthority(authority)) return undefined;
  const receipt = authority.receipt;
  if (receipt.version !== 3) return undefined;
  const now = Date.parse(input.now);
  if (
    !Number.isFinite(now) ||
    now < Date.parse(receipt.issuedAt) ||
    now >= Date.parse(receipt.expiresAt)
  )
    return undefined;
  const decision = receipt.decisions.find(
    (candidate) =>
      candidate.id === input.decisionReference?.id &&
      governanceDecisionDigestV2(candidate) === input.decisionReference.digest,
  );
  if (decision === undefined) return undefined;
  const decisionDigest = governanceDecisionDigestV2(decision);
  const rejected = receipt.decisions.some(
    (candidate) =>
      candidate.disposition === "rejected" &&
      candidate.subject.subjectDigest === decision.subject.subjectDigest &&
      candidate.targets.includes(input.target) &&
      candidate.allowedEffects.includes(input.effect) &&
      Date.parse(candidate.notBefore) <= now &&
      now < Date.parse(candidate.expiresAt) &&
      !receipt.decisionRevocations.some(
        (revocation) => revocation.decisionDigest === governanceDecisionDigestV2(candidate),
      ),
  );
  if (
    rejected ||
    decision.disposition === "rejected" ||
    now < Date.parse(decision.issuedAt) ||
    now < Date.parse(decision.notBefore) ||
    now >= Date.parse(decision.expiresAt) ||
    (decision.disposition === "accepted-with-conditions" && now >= Date.parse(decision.reviewBy)) ||
    receipt.decisionRevocations.some(
      (revocation) =>
        revocation.decisionDigest === decisionDigest && Date.parse(revocation.revokedAt) <= now,
    ) ||
    decision.subject.kind !== input.subject.kind ||
    decision.subject.id !== input.subject.id ||
    decision.subject.sourceDigest !== input.subject.sourceDigest ||
    decision.subject.subjectDigest !== input.subject.subjectDigest ||
    !input.supportedTargets.includes(input.target) ||
    !decision.targets.includes(input.target) ||
    !decision.allowedEffects.includes(input.effect)
  )
    return undefined;
  return { authority, decision, digest: decisionDigest, now };
}

function mintVerifiedQualificationV1(binding: QualificationBinding): VerifiedQualificationV1 {
  const verified: VerifiedQualificationV1 = Object.freeze({});
  verifiedQualifications.set(verified, Object.freeze(binding));
  return verified;
}

/**
 * Creates a capability only for canonical evidence bound to a current,
 * externally verified V3 organization-qualified decision. No scanner output,
 * caller callback, or raw envelope can authorize an observed effect on its own.
 */
export function verifyOrganizationQualificationV1(
  input: VerifyOrganizationQualificationV1Input,
): VerifiedQualificationV1 | undefined {
  const current = currentDecision(input);
  const envelope = parseOrganizationEvidenceEnvelopeV1Bytes(input.bytes);
  if (current === undefined || envelope === undefined) return undefined;
  const evidenceDigest = organizationEvidenceEnvelopeDigestV1(envelope);
  if (
    current.decision.qualificationBasis.kind !== "organization-qualified" ||
    current.decision.qualificationBasis.evidenceDigest !== evidenceDigest ||
    current.decision.qualificationBasis.attestor !== envelope.attestor ||
    current.decision.evidence.id !== envelope.evidence.id ||
    current.decision.evidence.digest !== evidenceDigest ||
    current.decision.evidence.attestor !== envelope.attestor ||
    current.decision.subject.subjectDigest !== envelope.subjectDigest ||
    current.now < Date.parse(envelope.notBefore) ||
    current.now >= Date.parse(envelope.expiresAt)
  )
    return undefined;
  return mintVerifiedQualificationV1({
    authorityReceiptDigest: current.authority.receiptDigest,
    decisionDigest: current.digest,
    effect: input.effect,
    expiresAt: envelope.expiresAt,
    kind: "organization-qualified",
    notBefore: envelope.notBefore,
    subjectDigest: envelope.subjectDigest,
    target: input.target,
  });
}

/**
 * Internal custody bridge for the package-shipped, externally attested AIH
 * support receipt. The caller must supply only bytes whose provenance has
 * already been verified; arbitrary Catalog V2 structures are never inspected
 * or verified here.
 */
export function mintAihSupportedQualificationV1(input: {
  authority?: unknown;
  decisionReference?: { id: string; digest: string };
  effect: z.infer<typeof GovernanceDecisionEffectV2Schema>;
  now: string;
  receipt: AihSupportedQualificationBindingV1;
  subject: Pick<GovernanceDecisionV2["subject"], "kind" | "id" | "sourceDigest" | "subjectDigest">;
  supportedTargets: readonly string[];
  target: string;
}): VerifiedQualificationV1 | undefined {
  const current = currentDecision(input);
  if (current === undefined) return undefined;
  const receipt = input.receipt;
  if (
    current.decision.qualificationBasis.kind !== "aih-supported" ||
    stableJson(receipt.subject) !== stableJson(current.decision.subject) ||
    stableJson(receipt.qualificationBasis) !== stableJson(current.decision.qualificationBasis) ||
    current.now < Date.parse(receipt.notBefore) ||
    current.now >= Date.parse(receipt.expiresAt) ||
    Date.parse(receipt.notBefore) < Date.parse(current.decision.notBefore) ||
    Date.parse(receipt.expiresAt) > Date.parse(current.decision.expiresAt)
  ) {
    return undefined;
  }
  return mintVerifiedQualificationV1({
    authorityReceiptDigest: current.authority.receiptDigest,
    decisionDigest: current.digest,
    effect: input.effect,
    expiresAt: receipt.expiresAt,
    kind: "aih-supported",
    notBefore: receipt.notBefore,
    subjectDigest: receipt.subject.subjectDigest,
    target: input.target,
  });
}

/** @internal Opaque token plus every active runtime binding must still match. */
export function matchesVerifiedQualificationV1(input: {
  authority: VerifiedPolicyAuthority;
  decisionDigest: string;
  effect: z.infer<typeof GovernanceDecisionEffectV2Schema>;
  now: string;
  qualification: unknown;
  qualificationKind: GovernanceDecisionV2["qualificationBasis"]["kind"];
  subjectDigest: string;
  target: string;
}): boolean {
  if (!isVerifiedQualificationV1(input.qualification)) return false;
  const binding = verifiedQualifications.get(input.qualification);
  const now = Date.parse(input.now);
  return (
    binding !== undefined &&
    Number.isFinite(now) &&
    binding.authorityReceiptDigest === input.authority.receiptDigest &&
    binding.decisionDigest === input.decisionDigest &&
    binding.effect === input.effect &&
    binding.kind === input.qualificationKind &&
    binding.subjectDigest === input.subjectDigest &&
    binding.target === input.target &&
    now >= Date.parse(binding.notBefore) &&
    now < Date.parse(binding.expiresAt)
  );
}
