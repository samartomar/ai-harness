import { lstatSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";
import { readRegularFile } from "../internals/fsxn.js";
import type { PlanContext } from "../internals/plan.js";
import { defaultRunner } from "../internals/proc.js";
import { findOnPath } from "../live/runner.js";
import { makeHostAdapter } from "../platform/detect.js";
import {
  isVerifiedPolicyAuthority,
  type VerifiedPolicyAuthority,
  verifyPolicyAuthorityReceipt,
} from "./authority.js";
import { GovernanceDecisionTimestampSchema } from "./governance-decision-v1.js";
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

/** Fixed, regular-file-only support provenance input. */
export const AIH_SUPPORTED_QUALIFICATION_RECEIPT_PATH =
  ".aih/aih-supported-qualification-receipt.json";
/** Bound raw hostile input before UTF-8 decoding or JSON parsing. */
export const MAX_AIH_SUPPORTED_QUALIFICATION_RECEIPT_BYTES_V1 = 4_096;
const MAX_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

const repository = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const qualificationIdentity = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:._@/-]{0,255}$/);

const AihSupportedQualificationBasisV1Schema = z
  .object({
    kind: z.literal("aih-supported"),
    catalogSignerIdentity: qualificationIdentity,
    catalogDigest: digest,
    catalogHeadDigest: digest,
    catalogMemberDigest: digest,
    subjectKind: z.enum(["tool", "skill", "mcp", "package", "profile"]),
    subjectDigest: digest,
  })
  .strict();

/**
 * A receipt attested by the separately configured AIH support publisher. Its
 * admission is deliberately non-authoritative: the V3 organization decision
 * remains the only authority for a local effect.
 */
export const AihSupportedQualificationReceiptV1Schema = z
  .object({
    format: z.literal("aih-supported-qualification-receipt"),
    version: z.literal(1),
    organizationAdmission: z.literal("not-authoritative"),
    subject: GovernanceDecisionSubjectV2Schema,
    qualificationBasis: AihSupportedQualificationBasisV1Schema,
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
        message: "supported qualification validity must be ordered and at most 90 days",
      });
    }
    if (
      value.qualificationBasis.subjectKind !== value.subject.kind ||
      value.qualificationBasis.subjectDigest !== value.subject.subjectDigest
    ) {
      ctx.addIssue({
        code: "custom",
        message: "supported qualification must bind the exact receipt subject",
      });
    }
    if (value.subject.sourceDigest !== governanceDecisionSourceDigestV2(value.subject.source)) {
      ctx.addIssue({
        code: "custom",
        message: "supported qualification subject sourceDigest must bind the exact source",
      });
    }
    if (
      value.subject.subjectDigest !==
      governanceDecisionSubjectDigestV2({
        kind: value.subject.kind,
        id: value.subject.id,
        sourceDigest: value.subject.sourceDigest,
      })
    ) {
      ctx.addIssue({
        code: "custom",
        message: "supported qualification subjectDigest must bind the exact subject descriptor",
      });
    }
  });

export type AihSupportedQualificationReceiptV1 = z.infer<
  typeof AihSupportedQualificationReceiptV1Schema
>;

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

/** Canonical JSON bytes (without a transport newline or byte-order mark). */
export function canonicalAihSupportedQualificationReceiptV1(
  value: AihSupportedQualificationReceiptV1,
): string {
  return stableJson(value);
}

/** Parse only an exact, canonical UTF-8 transport; JSON's duplicate keys fail the byte check. */
export function parseAihSupportedQualificationReceiptV1Bytes(
  bytes: Uint8Array,
): AihSupportedQualificationReceiptV1 | undefined {
  if (bytes.byteLength > MAX_AIH_SUPPORTED_QUALIFICATION_RECEIPT_BYTES_V1) return undefined;
  let text: string;
  let raw: unknown;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    raw = JSON.parse(text);
  } catch {
    return undefined;
  }
  const parsed = AihSupportedQualificationReceiptV1Schema.safeParse(raw);
  if (!parsed.success || text !== canonicalAihSupportedQualificationReceiptV1(parsed.data)) {
    return undefined;
  }
  return parsed.data;
}

export interface VerifyAihSupportedQualificationReceiptV1Input {
  authority?: unknown;
  decisionReference?: { id: string; digest: string };
  effect: z.infer<typeof GovernanceDecisionEffectV2Schema>;
  now: string;
  subject: Pick<GovernanceDecisionV2["subject"], "kind" | "id" | "sourceDigest" | "subjectDigest">;
  supportedTargets: readonly string[];
  target: string;
}

export interface AihSupportedQualificationVerificationV1 {
  qualification?: VerifiedQualificationV1;
  /** Scrubbed: verifier output is untrusted and can contain credentials. */
  problem?: string;
}

const AihSupportedQualificationArtifactVerificationInputV1Schema = z
  .object({
    root: z.string().min(1),
    decisionReference: z.object({ id: z.string().min(1).max(256), digest }).strict(),
    subject: GovernanceDecisionSubjectV2Schema,
  })
  .strict();

export interface VerifyAihSupportedQualificationArtifactV1Input {
  root: string;
  decisionReference: { id: string; digest: string };
  subject: GovernanceDecisionV2["subject"];
}

/** Inert public verdict: never carries authority, capabilities, or verifier detail. */
export interface AihSupportedQualificationArtifactVerificationV1 {
  state: "verified" | "unverified";
  problem?: "AIH-supported qualification artifact could not be verified";
}

function unverifiedArtifact(): AihSupportedQualificationArtifactVerificationV1 {
  return {
    state: "unverified",
    problem: "AIH-supported qualification artifact could not be verified",
  };
}

function configuredSupportRoot(
  ctx: PlanContext,
  authority: VerifiedPolicyAuthority | undefined,
): { repository: string; workflow: string } | undefined {
  const supportedRepository = ctx.env.AIH_SUPPORTED_QUALIFICATION_REPOSITORY?.trim();
  const supportedWorkflow = ctx.env.AIH_SUPPORTED_QUALIFICATION_WORKFLOW?.trim();
  const hasControl = (value: string) =>
    [...value].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 0x20 || code === 0x7f;
    });
  if (
    supportedRepository === undefined ||
    !repository.safeParse(supportedRepository).success ||
    supportedWorkflow === undefined ||
    supportedWorkflow.length === 0 ||
    supportedWorkflow.length > 1_000 ||
    hasControl(supportedWorkflow)
  ) {
    return undefined;
  }
  if (
    authority !== undefined &&
    (supportedRepository.toLowerCase() === authority.repository.toLowerCase() ||
      (authority.workflow !== undefined && supportedWorkflow === authority.workflow))
  ) {
    return undefined;
  }
  return { repository: supportedRepository, workflow: supportedWorkflow };
}

function receiptHasSymlinkParent(root: string): boolean {
  const parts = AIH_SUPPORTED_QUALIFICATION_RECEIPT_PATH.split("/");
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    try {
      if (lstatSync(current).isSymbolicLink()) return true;
    } catch {
      return false;
    }
  }
  return false;
}

async function verifyAihSupportedQualificationReceiptArtifact(
  ctx: PlanContext,
  authority: VerifiedPolicyAuthority | undefined,
): Promise<{ receipt?: AihSupportedQualificationReceiptV1; problem?: string }> {
  const supportRoot = configuredSupportRoot(ctx, authority);
  if (supportRoot === undefined) {
    return {
      problem:
        "external AIH support qualification registry is unavailable or reuses the organization authority root",
    };
  }
  if (receiptHasSymlinkParent(ctx.root)) {
    return {
      problem: `supported qualification receipt ${AIH_SUPPORTED_QUALIFICATION_RECEIPT_PATH} has an unsafe symlinked parent`,
    };
  }
  const path = join(ctx.root, AIH_SUPPORTED_QUALIFICATION_RECEIPT_PATH);
  const contents = readRegularFile(path, {
    maxBytes: MAX_AIH_SUPPORTED_QUALIFICATION_RECEIPT_BYTES_V1,
  });
  if (contents === undefined) {
    try {
      if (lstatSync(path).isSymbolicLink()) {
        return {
          problem: `supported qualification receipt ${AIH_SUPPORTED_QUALIFICATION_RECEIPT_PATH} is an unsafe symlink`,
        };
      }
    } catch {
      // The ordinary unavailable result below covers a missing receipt.
    }
    return {
      problem: `supported qualification receipt ${AIH_SUPPORTED_QUALIFICATION_RECEIPT_PATH} is unavailable`,
    };
  }

  let verifierDir: string | undefined;
  let copied: Buffer | undefined;
  try {
    verifierDir = mkdtempSync(join(tmpdir(), "aih-supported-qualification-"));
    const verifierPath = join(verifierDir, "receipt.json");
    writeFileSync(verifierPath, contents, { flag: "wx", mode: 0o600 });
    const gh = findOnPath("gh", ctx.env, process.platform, {
      excludeRoot: ctx.root,
      windowsExeOnly: true,
    });
    if (gh === undefined) {
      return { problem: "GitHub support qualification verifier is unavailable on absolute PATH" };
    }
    const verified = await ctx.run(
      [
        gh,
        "attestation",
        "verify",
        verifierPath,
        "--repo",
        supportRoot.repository,
        "--signer-workflow",
        supportRoot.workflow,
      ],
      { cwd: ctx.root },
    );
    if (verified.spawnError || verified.code !== 0) {
      return { problem: "GitHub support qualification attestation could not be verified" };
    }
    copied = readRegularFile(verifierPath, {
      maxBytes: MAX_AIH_SUPPORTED_QUALIFICATION_RECEIPT_BYTES_V1,
    });
    if (copied === undefined || !copied.equals(contents)) {
      return { problem: "supported qualification receipt changed during verification" };
    }
  } catch {
    return { problem: "GitHub support qualification attestation could not be verified" };
  } finally {
    if (verifierDir !== undefined) {
      try {
        rmSync(verifierDir, { recursive: true, force: true });
      } catch {
        // Cleanup is best effort; it never widens a verification result.
      }
    }
  }

  const receipt =
    copied === undefined ? undefined : parseAihSupportedQualificationReceiptV1Bytes(copied);
  return receipt === undefined
    ? { problem: "supported qualification receipt is malformed" }
    : { receipt };
}

function currentAihSupportedArtifactDecision(
  authority: VerifiedPolicyAuthority,
  input: z.infer<typeof AihSupportedQualificationArtifactVerificationInputV1Schema>,
  now: string,
): GovernanceDecisionV2 | undefined {
  const authorityReceipt = authority.receipt;
  const at = Date.parse(now);
  if (
    authorityReceipt.version !== 3 ||
    !Number.isFinite(at) ||
    at < Date.parse(authorityReceipt.issuedAt) ||
    at >= Date.parse(authorityReceipt.expiresAt)
  ) {
    return undefined;
  }
  const decision = authorityReceipt.decisions.find(
    (candidate) =>
      candidate.id === input.decisionReference.id &&
      governanceDecisionDigestV2(candidate) === input.decisionReference.digest,
  );
  if (
    decision === undefined ||
    decision.disposition === "rejected" ||
    decision.qualificationBasis.kind !== "aih-supported" ||
    at < Date.parse(decision.issuedAt) ||
    at < Date.parse(decision.notBefore) ||
    at >= Date.parse(decision.expiresAt) ||
    (decision.disposition === "accepted-with-conditions" && at >= Date.parse(decision.reviewBy)) ||
    authorityReceipt.decisionRevocations.some(
      (revocation) =>
        revocation.decisionDigest === governanceDecisionDigestV2(decision) &&
        Date.parse(revocation.revokedAt) <= at,
    ) ||
    stableJson(decision.subject) !== stableJson(input.subject)
  ) {
    return undefined;
  }
  return decision;
}

function resolvedArtifactRoot(root: string): string | undefined {
  try {
    const resolved = realpathSync(resolve(root));
    return statSync(resolved).isDirectory() ? resolved : undefined;
  } catch {
    return undefined;
  }
}

function productionArtifactContext(root: string): PlanContext {
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

/** @internal Test seam; deliberately absent from the package-root exports. */
export async function verifyAihSupportedQualificationArtifactV1WithContext(
  ctx: PlanContext,
  input: unknown,
): Promise<AihSupportedQualificationArtifactVerificationV1> {
  const parsed = AihSupportedQualificationArtifactVerificationInputV1Schema.safeParse(input);
  if (!parsed.success) return unverifiedArtifact();
  const root = resolvedArtifactRoot(parsed.data.root);
  if (root === undefined) return unverifiedArtifact();
  const safeCtx = { ...ctx, root };
  const authorityVerification = await verifyPolicyAuthorityReceipt(safeCtx);
  if (authorityVerification.authority === undefined) return unverifiedArtifact();
  const now = new Date().toISOString();
  const supportVerification = await verifyAihSupportedQualificationReceiptArtifact(
    safeCtx,
    authorityVerification.authority,
  );
  if (supportVerification.receipt === undefined) return unverifiedArtifact();
  const decision = currentAihSupportedArtifactDecision(
    authorityVerification.authority,
    parsed.data,
    now,
  );
  if (
    decision === undefined ||
    !matchesAihSupportedQualificationBindingV1({
      decision,
      now,
      receipt: supportVerification.receipt,
    })
  ) {
    return unverifiedArtifact();
  }
  return { state: "verified" };
}

/**
 * Verify a package-shipped AIH-supported qualification artifact without
 * minting authority or enabling an effect. The package owns the runtime
 * context; callers receive only a scrubbed, inert verdict.
 */
export async function verifyAihSupportedQualificationArtifactV1(
  input: VerifyAihSupportedQualificationArtifactV1Input,
): Promise<AihSupportedQualificationArtifactVerificationV1> {
  const parsed = AihSupportedQualificationArtifactVerificationInputV1Schema.safeParse(input);
  const root = parsed.success ? resolvedArtifactRoot(parsed.data.root) : undefined;
  if (parsed.success === false || root === undefined) return unverifiedArtifact();
  return verifyAihSupportedQualificationArtifactV1WithContext(productionArtifactContext(root), {
    ...parsed.data,
    root,
  });
}

/**
 * Verify the fixed support receipt against a dedicated external GitHub root,
 * then mint the same process-local qualification capability used by the V3
 * organization path. This only observes receipt bytes and runs `gh`; it never
 * evaluates candidate code, configures a host, or inspects Catalog V2 crypto.
 */
export async function verifyAihSupportedQualificationReceiptV1(
  ctx: PlanContext,
  input: VerifyAihSupportedQualificationReceiptV1Input,
): Promise<AihSupportedQualificationVerificationV1> {
  const verifiedAuthority = isVerifiedPolicyAuthority(input.authority)
    ? input.authority
    : undefined;
  const supportVerification = await verifyAihSupportedQualificationReceiptArtifact(
    ctx,
    verifiedAuthority,
  );
  if (supportVerification.receipt === undefined) return { problem: supportVerification.problem };
  const qualification = mintAihSupportedQualificationV1({
    ...input,
    receipt: supportVerification.receipt,
  });
  if (qualification === undefined) {
    return {
      problem: "supported qualification receipt does not match the current authority decision",
    };
  }
  return { qualification };
}
