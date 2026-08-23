import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { readRegularFileWithStats } from "../internals/fsxn.js";
import type { PlanContext } from "../internals/plan.js";
import { defaultRunner } from "../internals/proc.js";
import { findOnPath } from "../live/runner.js";
import { makeHostAdapter } from "../platform/detect.js";
import {
  isVerifiedPolicyAuthority,
  type VerifiedPolicyAuthority,
  verifyPolicyAuthorityReceipt,
} from "./authority.js";
import {
  type GovernanceDecisionEffectV2Schema,
  GovernanceDecisionSubjectV2Schema,
  type GovernanceDecisionV2,
  governanceDecisionDigestV2,
  governanceDecisionSourceDigestV2,
  governanceDecisionSubjectDigestV2,
} from "./governance-decision-v2.js";
import {
  matchesAihSupportedQualificationBindingV1,
  mintAihSupportedQualificationV1,
  type VerifiedQualificationV1,
} from "./qualification-v1.js";

/** Fixed hostile-input path. V1 is intentionally unsupported. */
export const AIH_SUPPORTED_QUALIFICATION_RECEIPT_PATH =
  ".aih/aih-supported-qualification-receipt.json";
/** Measured canonical Receipt V2 ceiling from the supported producer. */
export const MAX_AIH_SUPPORTED_QUALIFICATION_RECEIPT_BYTES_V2 = 5_970;
/** The producer rejects a larger canonical source before receipt emission. */
export const MAX_AIH_SUPPORTED_QUALIFICATION_SOURCE_BYTES_V2 = 4_096;
const MAX_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;
const ZERO_DIGEST = `sha256:${"0".repeat(64)}`;
const repository = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const identity = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:._@/-]{0,255}$/);
const entryId = z.string().regex(/^[a-z][a-z0-9.-]{0,63}$/);
const replayIdentity = z.string().regex(/^catalog-head:[0-9a-f]{64}:[0-9a-f]{64}$/);
const signerKeyId = z.string().regex(/^ed25519:[0-9a-f]{64}$/);
function isCanonicalUtcSecond(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/.exec(value);
  if (match === null) return false;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hour === undefined ||
    minute === undefined ||
    second === undefined ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  )
    return false;
  const isLeapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days =
    month === 2
      ? isLeapYear
        ? 29
        : 28
      : month === 4 || month === 6 || month === 9 || month === 11
        ? 30
        : 31;
  return day <= days;
}
const canonicalTimestamp = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
  .refine(isCanonicalUtcSecond, "must be a canonical UTC timestamp");

const QualificationBasisSchema = z
  .object({
    kind: z.literal("aih-supported"),
    catalogSignerIdentity: identity,
    catalogDigest: digest,
    catalogHeadDigest: digest,
    catalogMemberDigest: digest,
    subjectKind: z.enum(["tool", "skill", "mcp", "package", "profile"]),
    subjectDigest: digest,
  })
  .strict();

export const AihSupportedQualificationReceiptV2Schema = z
  .object({
    format: z.literal("aih-supported-qualification-receipt"),
    version: z.literal(2),
    organizationAdmission: z.literal("not-authoritative"),
    entryId,
    subject: GovernanceDecisionSubjectV2Schema,
    qualificationBasis: QualificationBasisSchema,
    catalogContinuity: z
      .object({
        catalogHeadDigest: digest,
        previousCatalogHeadDigest: digest,
        sequence: z.number().int().min(0).safe(),
        replayIdentity,
        signerKeyId,
        headValidFrom: canonicalTimestamp,
        headValidUntil: canonicalTimestamp,
      })
      .strict(),
    issuedAt: canonicalTimestamp,
    notBefore: canonicalTimestamp,
    expiresAt: canonicalTimestamp,
  })
  .strict()
  .superRefine((value, ctx) => {
    const issued = Date.parse(value.issuedAt);
    const notBefore = Date.parse(value.notBefore);
    const expires = Date.parse(value.expiresAt);
    const headFrom = Date.parse(value.catalogContinuity.headValidFrom);
    const headUntil = Date.parse(value.catalogContinuity.headValidUntil);
    if (
      !Number.isFinite(issued) ||
      !Number.isFinite(notBefore) ||
      !Number.isFinite(expires) ||
      !Number.isFinite(headFrom) ||
      !Number.isFinite(headUntil) ||
      headFrom >= headUntil ||
      headFrom > issued ||
      issued > notBefore ||
      notBefore >= expires ||
      expires !== headUntil ||
      expires - issued > MAX_WINDOW_MS
    )
      ctx.addIssue({
        code: "custom",
        message: "receipt validity must be ordered and end at its signed head ceiling",
      });
    if (value.catalogContinuity.catalogHeadDigest !== value.qualificationBasis.catalogHeadDigest)
      ctx.addIssue({
        code: "custom",
        message: "continuity head must bind qualification basis",
      });
    if (
      value.qualificationBasis.subjectKind !== value.subject.kind ||
      value.qualificationBasis.subjectDigest !== value.subject.subjectDigest
    )
      ctx.addIssue({
        code: "custom",
        message: "receipt must bind exact subject",
      });
    if (
      value.subject.sourceDigest !== governanceDecisionSourceDigestV2(value.subject.source) ||
      value.subject.subjectDigest !==
        governanceDecisionSubjectDigestV2({
          kind: value.subject.kind,
          id: value.subject.id,
          sourceDigest: value.subject.sourceDigest,
        })
    )
      ctx.addIssue({
        code: "custom",
        message: "receipt subject digests must be canonical",
      });
    if (
      (value.catalogContinuity.sequence === 0) !==
      (value.catalogContinuity.previousCatalogHeadDigest === ZERO_DIGEST)
    )
      ctx.addIssue({
        code: "custom",
        message: "genesis predecessor must be the zero digest only at sequence zero",
      });
    if (
      Object.is(value.catalogContinuity.sequence, -0) ||
      value.catalogContinuity.previousCatalogHeadDigest ===
        value.catalogContinuity.catalogHeadDigest
    )
      ctx.addIssue({
        code: "custom",
        message: "continuity must not carry a self predecessor or negative zero sequence",
      });
    if (
      value.catalogContinuity.replayIdentity.slice(
        "catalog-head:".length,
        "catalog-head:".length + 64,
      ) !== value.catalogContinuity.catalogHeadDigest.slice(7)
    )
      ctx.addIssue({
        code: "custom",
        message: "replay identity must bind the catalog head",
      });
  });
export type AihSupportedQualificationReceiptV2 = z.infer<
  typeof AihSupportedQualificationReceiptV2Schema
>;

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}
export function canonicalAihSupportedQualificationReceiptV2(
  value: AihSupportedQualificationReceiptV2,
): string {
  return stable(value);
}
export function receiptDigestV2(value: AihSupportedQualificationReceiptV2): string {
  return `sha256:${createHash("sha256").update("aih-supported-qualification-receipt/v2\0", "utf8").update(canonicalAihSupportedQualificationReceiptV2(value), "utf8").digest("hex")}`;
}
export function parseAihSupportedQualificationReceiptV2Bytes(
  bytes: Uint8Array,
): AihSupportedQualificationReceiptV2 | undefined {
  if (bytes.byteLength > MAX_AIH_SUPPORTED_QUALIFICATION_RECEIPT_BYTES_V2) return undefined;
  try {
    const text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);
    const parsed = AihSupportedQualificationReceiptV2Schema.safeParse(JSON.parse(text));
    return parsed.success &&
      Buffer.byteLength(stable(parsed.data.subject.source), "utf8") <=
        MAX_AIH_SUPPORTED_QUALIFICATION_SOURCE_BYTES_V2 &&
      text === canonicalAihSupportedQualificationReceiptV2(parsed.data)
      ? parsed.data
      : undefined;
  } catch {
    return undefined;
  }
}

type Custody = { bytes: Buffer; unchanged(): boolean };
function hasSymlinkParent(root: string): boolean {
  let current = root;
  for (const part of AIH_SUPPORTED_QUALIFICATION_RECEIPT_PATH.split("/").slice(0, -1)) {
    current = join(current, part);
    try {
      if (!lstatSync(current).isDirectory() || lstatSync(current).isSymbolicLink()) return true;
    } catch {
      return false;
    }
  }
  return false;
}
function custody(root: string): Custody | undefined {
  if (hasSymlinkParent(root)) return undefined;
  const path = join(root, AIH_SUPPORTED_QUALIFICATION_RECEIPT_PATH);
  const opened = readRegularFileWithStats(path, {
    maxBytes: MAX_AIH_SUPPORTED_QUALIFICATION_RECEIPT_BYTES_V2,
  });
  if (opened === undefined || opened.identity.nlink !== 1n) return undefined;
  const original = Buffer.from(opened.contents);
  const identity = {
    dev: opened.identity.dev,
    ino: opened.identity.ino,
    size: opened.stats.size,
  };
  return {
    bytes: original,
    unchanged: () => {
      if (hasSymlinkParent(root)) return false;
      const current = readRegularFileWithStats(path, {
        maxBytes: MAX_AIH_SUPPORTED_QUALIFICATION_RECEIPT_BYTES_V2,
      });
      return (
        current !== undefined &&
        current.identity.nlink === 1n &&
        current.identity.dev === identity.dev &&
        current.identity.ino === identity.ino &&
        current.stats.size === identity.size &&
        current.contents.equals(original)
      );
    },
  };
}
function supportRoot(
  ctx: PlanContext,
  authority: VerifiedPolicyAuthority | undefined,
): { repository: string; workflow: string } | undefined {
  const supportedRepository = ctx.env.AIH_SUPPORTED_QUALIFICATION_REPOSITORY?.trim();
  const workflow = ctx.env.AIH_SUPPORTED_QUALIFICATION_WORKFLOW?.trim();
  const hasControl = (value: string) =>
    [...value].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 0x20 || code === 0x7f;
    });
  if (
    supportedRepository === undefined ||
    workflow === undefined ||
    workflow.length === 0 ||
    workflow.length > 1_000 ||
    !repository.safeParse(supportedRepository).success ||
    hasControl(workflow)
  )
    return undefined;
  if (
    authority !== undefined &&
    (supportedRepository.toLowerCase() === authority.repository.toLowerCase() ||
      workflow === authority.workflow)
  )
    return undefined;
  return { repository: supportedRepository, workflow };
}
async function verifiedReceipt(
  ctx: PlanContext,
  authority: VerifiedPolicyAuthority | undefined,
): Promise<{ receipt?: AihSupportedQualificationReceiptV2; problem?: string }> {
  const root = supportRoot(ctx, authority);
  if (root === undefined)
    return {
      problem:
        "external AIH support qualification registry is unavailable or reuses the organization authority root",
    };
  if (hasSymlinkParent(ctx.root))
    return {
      problem: `supported qualification receipt ${AIH_SUPPORTED_QUALIFICATION_RECEIPT_PATH} has an unsafe symlinked parent`,
    };
  const original = custody(ctx.root);
  if (original === undefined) {
    const path = join(ctx.root, AIH_SUPPORTED_QUALIFICATION_RECEIPT_PATH);
    try {
      if (lstatSync(path).isSymbolicLink())
        return {
          problem: `supported qualification receipt ${AIH_SUPPORTED_QUALIFICATION_RECEIPT_PATH} is an unsafe symlink`,
        };
    } catch {}
    return {
      problem: `supported qualification receipt ${AIH_SUPPORTED_QUALIFICATION_RECEIPT_PATH} is unavailable`,
    };
  }
  let dir: string | undefined;
  try {
    dir = mkdtempSync(join(tmpdir(), "aih-supported-qualification-v2-"));
    const copy = join(dir, "receipt.json");
    writeFileSync(copy, original.bytes, { flag: "wx", mode: 0o600 });
    const gh = findOnPath("gh", ctx.env, process.platform, {
      excludeRoot: ctx.root,
      windowsExeOnly: true,
    });
    if (gh === undefined)
      return {
        problem: "GitHub support qualification verifier is unavailable on absolute PATH",
      };
    const result = await ctx.run(
      [
        gh,
        "attestation",
        "verify",
        copy,
        "--repo",
        root.repository,
        "--signer-workflow",
        root.workflow,
      ],
      { cwd: ctx.root },
    );
    if (result.spawnError || result.code !== 0)
      return {
        problem: "GitHub support qualification attestation could not be verified",
      };
    if (!original.unchanged())
      return {
        problem: "supported qualification receipt changed during verification",
      };
    const copied = readRegularFileWithStats(copy, {
      maxBytes: MAX_AIH_SUPPORTED_QUALIFICATION_RECEIPT_BYTES_V2,
    });
    if (copied === undefined || !copied.contents.equals(original.bytes))
      return {
        problem: "supported qualification receipt changed during verification",
      };
    const receipt = parseAihSupportedQualificationReceiptV2Bytes(copied.contents);
    return receipt === undefined
      ? { problem: "supported qualification receipt is malformed" }
      : { receipt };
  } catch {
    return {
      problem: "GitHub support qualification attestation could not be verified",
    };
  } finally {
    if (dir !== undefined)
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {}
  }
}

/** @internal Shared subject-wide rejection gate for the inert artifact path. */
export function isCurrentUnrevokedSubjectRejectionV2(input: {
  decisions: readonly GovernanceDecisionV2[];
  decisionRevocations: readonly { decisionDigest: string; revokedAt: string }[];
  subjectDigest: string;
  now: string;
}): boolean {
  const at = Date.parse(input.now);
  if (!Number.isFinite(at)) return false;
  return input.decisions.some(
    (candidate) =>
      candidate.disposition === "rejected" &&
      candidate.subject.subjectDigest === input.subjectDigest &&
      Date.parse(candidate.notBefore) <= at &&
      at < Date.parse(candidate.expiresAt) &&
      !input.decisionRevocations.some(
        (revocation) =>
          revocation.decisionDigest === governanceDecisionDigestV2(candidate) &&
          Date.parse(revocation.revokedAt) <= at,
      ),
  );
}
function currentUnrevokedSubjectRejection(
  authority: VerifiedPolicyAuthority,
  subjectDigest: string,
  now: string,
): boolean {
  if (authority.receipt.version !== 3) return false;
  const receipt = authority.receipt;
  return isCurrentUnrevokedSubjectRejectionV2({
    decisions: receipt.decisions,
    decisionRevocations: receipt.decisionRevocations,
    subjectDigest,
    now,
  });
}
function currentDecision(
  authority: VerifiedPolicyAuthority,
  input: {
    decisionReference: { id: string; digest: string };
    subject: GovernanceDecisionV2["subject"];
  },
  now: string,
): GovernanceDecisionV2 | undefined {
  const at = Date.parse(now);
  const receipt = authority.receipt;
  if (
    receipt.version !== 3 ||
    !Number.isFinite(at) ||
    at < Date.parse(receipt.issuedAt) ||
    at >= Date.parse(receipt.expiresAt)
  )
    return undefined;
  const decision = receipt.decisions.find(
    (d) =>
      d.id === input.decisionReference.id &&
      governanceDecisionDigestV2(d) === input.decisionReference.digest,
  );
  if (
    decision === undefined ||
    decision.disposition === "rejected" ||
    decision.qualificationBasis.kind !== "aih-supported" ||
    stable(decision.subject) !== stable(input.subject) ||
    currentUnrevokedSubjectRejection(authority, decision.subject.subjectDigest, now) ||
    at < Date.parse(decision.issuedAt) ||
    at < Date.parse(decision.notBefore) ||
    at >= Date.parse(decision.expiresAt) ||
    (decision.disposition === "accepted-with-conditions" && at >= Date.parse(decision.reviewBy)) ||
    receipt.decisionRevocations.some(
      (r) =>
        r.decisionDigest === governanceDecisionDigestV2(decision) && Date.parse(r.revokedAt) <= at,
    )
  )
    return undefined;
  return decision;
}

export interface VerifyAihSupportedQualificationReceiptV2Input {
  authority?: unknown;
  decisionReference?: { id: string; digest: string };
  effect: z.infer<typeof GovernanceDecisionEffectV2Schema>;
  now: string;
  subject: GovernanceDecisionV2["subject"];
  supportedTargets: readonly string[];
  target: string;
}
export interface AihSupportedQualificationVerificationV2 {
  qualification?: VerifiedQualificationV1;
  problem?: string;
  receipt?: AihSupportedQualificationReceiptV2;
}
/** Internal observer bridge. The outer path is always production GitHub attestation verification. */
export async function verifyAihSupportedQualificationReceiptV2(
  ctx: PlanContext,
  input: VerifyAihSupportedQualificationReceiptV2Input,
): Promise<AihSupportedQualificationVerificationV2> {
  const authority = isVerifiedPolicyAuthority(input.authority) ? input.authority : undefined;
  const support = await verifiedReceipt(ctx, authority);
  if (
    authority === undefined ||
    support.receipt === undefined ||
    input.decisionReference === undefined
  )
    return {
      problem: support.problem ?? "AIH-supported qualification artifact could not be verified",
    };
  const receipt = support.receipt;
  const decision = currentDecision(
    authority,
    { decisionReference: input.decisionReference, subject: input.subject },
    input.now,
  );
  if (
    decision === undefined ||
    !matchesAihSupportedQualificationBindingV1({
      decision,
      now: input.now,
      receipt,
    })
  )
    return {
      problem: "AIH-supported qualification artifact could not be verified",
    };
  const qualification = mintAihSupportedQualificationV1({ ...input, receipt });
  return qualification === undefined
    ? { problem: "AIH-supported qualification artifact could not be verified" }
    : { qualification, receipt };
}

export interface VerifyAihSupportedQualificationArtifactV2Input {
  root: string;
  decisionReference: { id: string; digest: string };
  subject: GovernanceDecisionV2["subject"];
}
export interface AihSupportedQualificationArtifactVerificationV2 {
  state: "verified" | "unverified";
  problem?: "AIH-supported qualification artifact could not be verified";
}
const ArtifactInputSchema = z
  .object({
    root: z.string().min(1),
    decisionReference: z.object({ id: z.string().min(1).max(256), digest }).strict(),
    subject: GovernanceDecisionSubjectV2Schema,
  })
  .strict();
function unverifiedArtifact(): AihSupportedQualificationArtifactVerificationV2 {
  return {
    state: "unverified",
    problem: "AIH-supported qualification artifact could not be verified",
  };
}
function artifactRoot(root: string): string | undefined {
  try {
    const resolved = realpathSync(resolve(root));
    return statSync(resolved).isDirectory() ? resolved : undefined;
  } catch {
    return undefined;
  }
}
function productionContext(root: string): PlanContext {
  const env = { ...process.env };
  const run = defaultRunner;
  return {
    root,
    contextDir: "ai-coding",
    apply: false,
    verify: true,
    json: false,
    run,
    host: makeHostAdapter({ run, env }),
    env,
    options: {},
  };
}
/** @internal Test seam; it never mints an effect-bearing capability. */
export async function verifyAihSupportedQualificationArtifactV2WithContext(
  ctx: PlanContext,
  input: unknown,
): Promise<AihSupportedQualificationArtifactVerificationV2> {
  const parsed = ArtifactInputSchema.safeParse(input);
  if (!parsed.success) return unverifiedArtifact();
  const root = artifactRoot(parsed.data.root);
  if (root === undefined) return unverifiedArtifact();
  const safeCtx = { ...ctx, root };
  const authority = await verifyPolicyAuthorityReceipt(safeCtx);
  if (authority.authority === undefined) return unverifiedArtifact();
  const support = await verifiedReceipt(safeCtx, authority.authority);
  if (support.receipt === undefined) return unverifiedArtifact();
  const now = new Date().toISOString();
  const decision = currentDecision(authority.authority, parsed.data, now);
  return decision !== undefined &&
    matchesAihSupportedQualificationBindingV1({
      decision,
      now,
      receipt: support.receipt,
    })
    ? { state: "verified" }
    : unverifiedArtifact();
}
/** Inert public verdict; it never exposes credentials, receipt bytes, or a capability. */
export async function verifyAihSupportedQualificationArtifactV2(
  input: VerifyAihSupportedQualificationArtifactV2Input,
): Promise<AihSupportedQualificationArtifactVerificationV2> {
  const parsed = ArtifactInputSchema.safeParse(input);
  if (!parsed.success) return unverifiedArtifact();
  const root = artifactRoot(parsed.data.root);
  return root === undefined
    ? unverifiedArtifact()
    : verifyAihSupportedQualificationArtifactV2WithContext(productionContext(root), parsed.data);
}
