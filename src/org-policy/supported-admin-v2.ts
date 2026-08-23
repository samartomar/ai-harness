import { createHash } from "node:crypto";
import { lstatSync, opendirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { z } from "zod";
import { canonicalStrictJsonBytesV1, parseStrictJsonObjectV1 } from "../contract/strict-json-v1.js";
import { AihError } from "../errors.js";
import { SUPPORTED_CLIS } from "../internals/clis.js";
import {
  inspectContainedRelativePath,
  readContainedRegularFile,
} from "../internals/contained-path.js";
import { readRegularFileWithStats } from "../internals/fsxn.js";
import { dynamicDigest, type Plan, type PlanContext, type WriteAction } from "../internals/plan.js";
import {
  GovernanceDecisionSubjectV2Schema,
  governanceDecisionSourceDigestV2,
  governanceDecisionSubjectDigestV2,
} from "./governance-decision-v2.js";
import {
  AIH_SUPPORTED_QUALIFICATION_RECEIPT_PATH,
  type AihSupportedQualificationReceiptV2,
  AihSupportedQualificationReceiptV2Schema,
  canonicalAihSupportedQualificationReceiptV2,
  isVerifiedAihSupportedCustodyBindingV2,
  MAX_AIH_SUPPORTED_QUALIFICATION_RECEIPT_BYTES_V2,
  parseAihSupportedQualificationReceiptV2Bytes,
  receiptDigestV2,
  type VerifiedAihSupportedCustodyBindingV2,
  verifyAihSupportedCustodyBindingV2,
} from "./supported-qualification-receipt-v2.js";

const CUSTODY_PREFIX = ".aih/supported-qualification/v2";
const MAX_CUSTODY_CANDIDATE_BYTES = 16 * 1024;
const MAX_CUSTODY_RECORD_BYTES = 12 * 1024;
const MAX_CUSTODY_MEMBERS = 4_096;
const ZERO_DIGEST = `sha256:${"0".repeat(64)}`;
const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const timestamp = z.string().refine(isStrictUtcTimestamp, "must be a canonical UTC timestamp");
const decisionId = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const entryId = z.string().regex(/^[a-z][a-z0-9.-]{0,63}$/);
const identity = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9:._@/-]{0,255}$/);
const signerKeyId = z.string().regex(/^ed25519:[0-9a-f]{64}$/);
const replayIdentity = z.string().regex(/^catalog-head:[0-9a-f]{64}:[0-9a-f]{64}$/);
const repository = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/);
const workflow = z
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
    "must be a bounded relative workflow path",
  );

export interface SupportedCustodyPathInputV2 {
  posture: "enterprise" | "vibe";
  platform: "win32" | "darwin" | "linux";
  root: string;
}

export interface SupportedCustodyCandidateV2 {
  receipt: AihSupportedQualificationReceiptV2;
  decision: { id: string; digest: string };
  target: (typeof SUPPORTED_CLIS)[number];
  receiptDigest: string;
  receiptSha256: string;
  authorityReceiptDigest: string;
  repository: string;
  workflow: string;
  acceptedAt: string;
  decisionNotBefore: string;
  decisionExpiresAt: string;
}

const CandidateSchema = z
  .object({
    receipt: AihSupportedQualificationReceiptV2Schema,
    decision: z.object({ id: decisionId, digest }).strict(),
    target: z.enum(SUPPORTED_CLIS),
    receiptDigest: digest,
    receiptSha256: digest,
    authorityReceiptDigest: digest,
    repository,
    workflow,
    acceptedAt: timestamp,
    decisionNotBefore: timestamp,
    decisionExpiresAt: timestamp,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.decisionNotBefore > value.acceptedAt ||
      value.acceptedAt >= value.decisionExpiresAt ||
      value.acceptedAt < value.receipt.notBefore ||
      value.acceptedAt >= value.receipt.expiresAt
    )
      ctx.addIssue({
        code: "custom",
        message: "acceptance must be within receipt and decision validity",
      });
  });

const PlanInputSchema = CandidateSchema.extend({
  posture: z.enum(["enterprise", "vibe"]),
  platform: z.enum(["win32", "darwin", "linux"]).optional(),
  root: z
    .string()
    .min(1)
    .max(4_096)
    .refine((value) => !/[\0\r\n]/.test(value)),
})
  .strict()
  .superRefine((value, ctx) => {
    if (value.posture === "enterprise" && value.platform === undefined)
      ctx.addIssue({ code: "custom", message: "enterprise custody requires an explicit platform" });
  });

export type SupportedCustodyPlanInputV2 = z.input<typeof PlanInputSchema>;

function isStrictUtcTimestamp(value: string): boolean {
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
    hour > 23 ||
    minute > 59 ||
    second > 59
  )
    return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  return day >= 1 && day <= (days ?? 0);
}

function localPlatform(): SupportedCustodyPathInputV2["platform"] {
  return process.platform === "win32"
    ? "win32"
    : process.platform === "darwin"
      ? "darwin"
      : "linux";
}

export function supportedCustodyRootV2(input: SupportedCustodyPathInputV2): string {
  if (input.posture === "vibe")
    return `${input.root.replace(/[\\/]$/, "")}/.aih/supported-qualification/v2`;
  if (input.platform === "win32") return "C:\\ProgramData\\aih\\supported-qualification\\v2";
  return input.platform === "darwin"
    ? "/Library/Application Support/aih/supported-qualification/v2"
    : "/etc/aih/supported-qualification/v2";
}

export function supportedCustodyLockV2(
  input: SupportedCustodyPathInputV2,
): string | { external: true; path: string; trustedBase: string } {
  const root = supportedCustodyRootV2(input);
  const trustedBase =
    input.platform === "win32"
      ? "C:\\ProgramData"
      : input.platform === "darwin"
        ? "/Library/Application Support"
        : "/etc";
  return input.posture === "vibe"
    ? `${CUSTODY_PREFIX}/locks/commit.lock`
    : {
        external: true,
        path: absoluteCustodyPath(root, "locks/commit.lock", input.platform),
        trustedBase,
      };
}

function absoluteCustodyPath(
  root: string,
  relativePath: string,
  platform: SupportedCustodyPathInputV2["platform"],
): string {
  const separator = platform === "win32" ? "\\" : "/";
  return `${root}${separator}${relativePath.replaceAll("/", separator)}`;
}

function custodySlot(domain: string, value: unknown): string {
  return createHash("sha256")
    .update(`aih-supported-qualification-custody/v2/${domain}\0`, "utf8")
    .update(canonicalStrictJsonBytesV1(value))
    .digest("hex");
}

function custodyRecord(value: unknown): string {
  const bytes = canonicalStrictJsonBytesV1(value);
  if (bytes.byteLength > MAX_CUSTODY_RECORD_BYTES)
    throw new AihError("supported custody record exceeds its bounded format", "AIH_TRUST");
  return bytes.toString("utf8");
}

function parseCandidate(input: unknown): {
  posture: "enterprise" | "vibe";
  platform: "win32" | "darwin" | "linux";
  root: string;
  candidate: SupportedCustodyCandidateV2;
} {
  const parsed = PlanInputSchema.safeParse(input);
  if (!parsed.success) throw new AihError("supported custody candidate is invalid", "AIH_TRUST");
  const { posture, platform, root, ...candidate } = parsed.data;
  let bytes: Buffer;
  try {
    bytes = canonicalStrictJsonBytesV1(candidate);
  } catch {
    throw new AihError("supported custody candidate is invalid", "AIH_TRUST");
  }
  if (bytes.byteLength > MAX_CUSTODY_CANDIDATE_BYTES)
    throw new AihError("supported custody candidate is invalid", "AIH_TRUST");
  const receiptBytes = Buffer.from(
    canonicalAihSupportedQualificationReceiptV2(candidate.receipt),
    "utf8",
  );
  const receipt = parseAihSupportedQualificationReceiptV2Bytes(receiptBytes);
  const receiptSha256 = `sha256:${createHash("sha256").update(receiptBytes).digest("hex")}`;
  if (
    receipt === undefined ||
    candidate.receiptDigest !== receiptDigestV2(receipt) ||
    candidate.receiptSha256 !== receiptSha256
  )
    throw new AihError("supported custody candidate is invalid", "AIH_TRUST");
  return {
    posture,
    platform: platform ?? localPlatform(),
    root,
    candidate: { ...candidate, receipt },
  };
}

function candidateFromVerifiedBinding(
  binding: VerifiedAihSupportedCustodyBindingV2,
): SupportedCustodyCandidateV2 {
  if (!isVerifiedAihSupportedCustodyBindingV2(binding))
    throw new AihError("supported custody verification failed", "AIH_TRUST");
  return {
    receipt: binding.receipt,
    decision: { id: binding.decision.id, digest: binding.decision.digest },
    target: binding.target,
    receiptDigest: binding.receiptDigest,
    receiptSha256: binding.receiptSha256,
    authorityReceiptDigest: binding.authorityReceiptDigest,
    repository: binding.repository,
    workflow: binding.workflow,
    acceptedAt: binding.acceptedAt,
    decisionNotBefore: binding.decision.notBefore,
    decisionExpiresAt: binding.decision.expiresAt,
  };
}

function candidateWithHistoricAcceptance(input: {
  root: string;
  posture: "enterprise" | "vibe";
  platform?: "win32" | "darwin" | "linux";
  candidate: SupportedCustodyCandidateV2;
}): SupportedCustodyCandidateV2 {
  const planned = planSupportedCustodyAcceptV2({
    ...input.candidate,
    root: input.root,
    posture: input.posture,
    ...(input.platform === undefined ? {} : { platform: input.platform }),
  });
  const member = planned.actions.filter(
    (action): action is WriteAction => action.kind === "write",
  )[2];
  if (member === undefined)
    throw new AihError("supported custody verification failed", "AIH_TRUST");
  const parsed = parseCandidate({
    ...input.candidate,
    root: input.root,
    posture: input.posture,
    ...(input.platform === undefined ? {} : { platform: input.platform }),
  });
  const existing = storedRecord(input.root, parsed.posture, member);
  if (existing.state !== "present") return input.candidate;
  const stored = MemberRecordSchema.safeParse(existing.value);
  if (!stored.success) return input.candidate;
  const historic = { ...input.candidate, acceptedAt: stored.data.acceptedAt };
  const historicPlan = planSupportedCustodyAcceptV2({
    ...historic,
    root: input.root,
    posture: input.posture,
    ...(input.platform === undefined ? {} : { platform: input.platform }),
  });
  const historicMember = historicPlan.actions.filter(
    (action): action is WriteAction => action.kind === "write",
  )[2];
  return historicMember !== undefined && sameStoredRecord(existing, historicMember)
    ? historic
    : input.candidate;
}

/** Internal transaction assertion for the exact locally verified support receipt. */
export function verifiedSupportedReceiptAssertionV2(
  binding: VerifiedAihSupportedCustodyBindingV2,
): WriteAction {
  const candidate = candidateFromVerifiedBinding(binding);
  const contents = canonicalAihSupportedQualificationReceiptV2(candidate.receipt);
  const expected = `sha256:${createHash("sha256").update(contents, "utf8").digest("hex")}`;
  if (expected !== candidate.receiptSha256)
    throw new AihError("supported custody verification failed", "AIH_TRUST");
  return {
    kind: "write",
    path: AIH_SUPPORTED_QUALIFICATION_RECEIPT_PATH,
    contents,
    exactContents: true,
    describe: "assert verified supported receipt unchanged",
    sensitive: { path: true },
    assertUnchanged: true,
    expect: { sha256: expected.slice("sha256:".length) },
  };
}

/** True only while the verified, canonical support receipt still occupies its fixed local custody path. */
export function isVerifiedSupportedReceiptCurrentV2(
  root: string,
  binding: VerifiedAihSupportedCustodyBindingV2,
): boolean {
  try {
    const candidate = candidateFromVerifiedBinding(binding);
    const read = readContainedRegularFile(root, AIH_SUPPORTED_QUALIFICATION_RECEIPT_PATH, {
      maxBytes: MAX_AIH_SUPPORTED_QUALIFICATION_RECEIPT_BYTES_V2,
    });
    return (
      read.state === "present" &&
      read.stats.nlink === 1 &&
      read.contents.equals(
        Buffer.from(canonicalAihSupportedQualificationReceiptV2(candidate.receipt), "utf8"),
      )
    );
  } catch {
    return false;
  }
}

function immutableWrite(
  path: string,
  value: unknown,
  describe: string,
  external: { trustedBase: string } | undefined,
): WriteAction {
  return {
    kind: "write",
    path,
    contents: custodyRecord(value),
    exactContents: true,
    describe,
    sensitive: { path: true },
    once: true,
    expect: { absent: true },
    durable: true,
    ...(external === undefined ? {} : { external: true, trustedBase: external.trustedBase }),
  };
}

function exactCustodyBytes(root: string, relativePath: string, expected: Buffer): boolean {
  let current = root;
  const segments = relativePath.split("/");
  for (const segment of segments.slice(0, -1)) {
    try {
      const stats = lstatSync(current);
      if (!stats.isDirectory() || stats.isSymbolicLink()) return false;
      current = join(current, segment);
    } catch {
      return false;
    }
  }
  try {
    const stats = lstatSync(current);
    if (!stats.isDirectory() || stats.isSymbolicLink()) return false;
  } catch {
    return false;
  }
  const leaf = segments.at(-1);
  if (leaf === undefined) return false;
  const opened = readRegularFileWithStats(join(current, leaf), { maxBytes: expected.byteLength });
  return opened !== undefined && opened.identity.nlink === 1n && opened.contents.equals(expected);
}

type StoredRecord =
  | { state: "absent" }
  | { state: "invalid" }
  | { state: "present"; bytes: Buffer; value: Record<string, unknown> };

const HeadRecordSchema = z
  .object({
    format: z.literal("aih-supported-qualification-custody"),
    version: z.literal(2),
    kind: z.literal("catalog-head"),
    catalogSignerIdentity: identity,
    signerKeyId,
    catalogHeadDigest: digest,
    previousCatalogHeadDigest: digest,
    sequence: z.number().int().min(0).safe(),
    replayIdentity,
    headValidFrom: timestamp,
    headValidUntil: timestamp,
  })
  .strict()
  .superRefine((value, ctx) => {
    if ((value.sequence === 0) !== (value.previousCatalogHeadDigest === ZERO_DIGEST))
      ctx.addIssue({ code: "custom", message: "invalid genesis predecessor" });
    if (
      Object.is(value.sequence, -0) ||
      value.previousCatalogHeadDigest === value.catalogHeadDigest
    )
      ctx.addIssue({ code: "custom", message: "invalid catalog predecessor" });
    if (
      value.replayIdentity.slice("catalog-head:".length, "catalog-head:".length + 64) !==
      value.catalogHeadDigest.slice("sha256:".length)
    )
      ctx.addIssue({ code: "custom", message: "replay does not bind catalog head" });
    if (value.headValidFrom >= value.headValidUntil)
      ctx.addIssue({ code: "custom", message: "invalid catalog head validity" });
  });

const MemberRecordSchema = z
  .object({
    format: z.literal("aih-supported-qualification-custody"),
    version: z.literal(2),
    kind: z.literal("member-claim"),
    entryId,
    catalogSignerIdentity: identity,
    signerKeyId,
    catalogDigest: digest,
    catalogHeadDigest: digest,
    catalogMemberDigest: digest,
    replayIdentity,
    sequence: z.number().int().min(0).safe(),
    subject: GovernanceDecisionSubjectV2Schema,
    decisionId,
    decisionDigest: digest,
    target: z.enum(SUPPORTED_CLIS),
    receiptDigest: digest,
    receiptSha256: digest,
    receiptIssuedAt: timestamp,
    receiptNotBefore: timestamp,
    receiptExpiresAt: timestamp,
    headValidFrom: timestamp,
    headValidUntil: timestamp,
    decisionNotBefore: timestamp,
    decisionExpiresAt: timestamp,
    repository,
    workflow,
    authorityReceiptDigest: digest,
    acceptedAt: timestamp,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.replayIdentity.slice("catalog-head:".length, "catalog-head:".length + 64) !==
      value.catalogHeadDigest.slice("sha256:".length)
    )
      ctx.addIssue({ code: "custom", message: "member replay does not bind its head" });
    if (
      value.receiptIssuedAt > value.receiptNotBefore ||
      value.receiptNotBefore >= value.receiptExpiresAt ||
      value.headValidFrom >= value.headValidUntil ||
      value.decisionNotBefore > value.acceptedAt ||
      value.acceptedAt >= value.decisionExpiresAt
    )
      ctx.addIssue({ code: "custom", message: "member validity is unordered" });
    if (
      value.subject.sourceDigest !== governanceDecisionSourceDigestV2(value.subject.source) ||
      value.subject.subjectDigest !==
        governanceDecisionSubjectDigestV2({
          kind: value.subject.kind,
          id: value.subject.id,
          sourceDigest: value.subject.sourceDigest,
        })
    )
      ctx.addIssue({ code: "custom", message: "member subject digests are invalid" });
    if (
      value.acceptedAt < value.receiptNotBefore ||
      value.acceptedAt >= value.receiptExpiresAt ||
      value.headValidFrom > value.receiptIssuedAt ||
      value.receiptExpiresAt !== value.headValidUntil
    )
      ctx.addIssue({ code: "custom", message: "member receipt and head bindings are invalid" });
  });

function strictStoredRecord(bytes: Buffer): StoredRecord {
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    const value = parseStrictJsonObjectV1(text, "supported custody state");
    return Buffer.from(custodyRecord(value), "utf8").equals(bytes)
      ? { state: "present", bytes, value }
      : { state: "invalid" };
  } catch {
    return { state: "invalid" };
  }
}

function custodyReadBoundary(
  root: string,
  posture: "enterprise" | "vibe",
  action: Pick<WriteAction, "path" | "trustedBase">,
): { root: string; relativePath: string } | undefined {
  if (posture === "vibe") return { root, relativePath: action.path };
  if (action.trustedBase === undefined) return undefined;
  return { root: action.trustedBase, relativePath: relative(action.trustedBase, action.path) };
}

function storedRecord(
  root: string,
  posture: "enterprise" | "vibe",
  action: WriteAction,
): StoredRecord {
  const boundary = custodyReadBoundary(root, posture, action);
  if (boundary === undefined) return { state: "invalid" };
  const read = readContainedRegularFile(boundary.root, boundary.relativePath, {
    maxBytes: MAX_CUSTODY_RECORD_BYTES,
  });
  if (read.state === "absent") return { state: "absent" };
  if (read.state !== "present" || read.stats.nlink !== 1) return { state: "invalid" };
  return strictStoredRecord(read.contents);
}

function sameStoredRecord(record: StoredRecord, action: WriteAction): boolean {
  return (
    record.state === "present" &&
    action.contents !== undefined &&
    record.bytes.equals(Buffer.from(action.contents, "utf8"))
  );
}

function recordHash(record: Extract<StoredRecord, { state: "present" }>): string {
  return createHash("sha256").update(record.bytes).digest("hex");
}

function boundedMemberEntries(directory: string): string[] {
  const opened = opendirSync(directory);
  const entries: string[] = [];
  try {
    for (let entry = opened.readSync(); entry !== null; entry = opened.readSync()) {
      if (entries.length === MAX_CUSTODY_MEMBERS)
        throw new AihError("supported custody state is invalid", "AIH_TRUST");
      entries.push(entry.name);
    }
    return entries.sort();
  } finally {
    opened.closeSync();
  }
}

function hasCurrentHeadMember(
  root: string,
  posture: "enterprise" | "vibe",
  member: WriteAction,
  head: z.infer<typeof HeadRecordSchema>,
): boolean {
  const memberDirectory = dirname(member.path);
  const boundary = custodyReadBoundary(root, posture, { ...member, path: memberDirectory });
  if (boundary === undefined) throw new AihError("supported custody state is invalid", "AIH_TRUST");
  const before = inspectContainedRelativePath(boundary.root, boundary.relativePath);
  if (before.state === "absent") return false;
  if (before.state !== "present" || before.kind !== "directory")
    throw new AihError("supported custody state is invalid", "AIH_TRUST");
  try {
    const entries = boundedMemberEntries(before.realPath);
    let found = false;
    for (const entry of entries) {
      if (!/^[0-9a-f]{64}\.json$/.test(entry))
        throw new AihError("supported custody state is invalid", "AIH_TRUST");
      const separator = member.path.includes("\\") ? "\\" : "/";
      const record = storedRecord(root, posture, {
        ...member,
        path: `${memberDirectory}${separator}${entry}`,
      });
      if (record.state !== "present")
        throw new AihError("supported custody state is invalid", "AIH_TRUST");
      const parsedMember = MemberRecordSchema.safeParse(record.value);
      if (!parsedMember.success)
        throw new AihError("supported custody state is invalid", "AIH_TRUST");
      const memberSlot = custodySlot("member", {
        catalogHeadDigest: parsedMember.data.catalogHeadDigest,
        catalogMemberDigest: parsedMember.data.catalogMemberDigest,
        subject: parsedMember.data.subject,
        target: parsedMember.data.target,
      });
      if (entry !== `${memberSlot}.json`)
        throw new AihError("supported custody state is invalid", "AIH_TRUST");
      if (
        parsedMember.data.catalogHeadDigest === head.catalogHeadDigest &&
        parsedMember.data.catalogSignerIdentity === head.catalogSignerIdentity &&
        parsedMember.data.signerKeyId === head.signerKeyId &&
        parsedMember.data.replayIdentity === head.replayIdentity &&
        parsedMember.data.sequence === head.sequence &&
        parsedMember.data.headValidFrom === head.headValidFrom &&
        parsedMember.data.headValidUntil === head.headValidUntil
      )
        found = true;
    }
    const after = inspectContainedRelativePath(boundary.root, boundary.relativePath);
    if (
      after.state !== "present" ||
      after.kind !== "directory" ||
      after.realPath !== before.realPath ||
      after.stats.dev !== before.stats.dev ||
      after.stats.ino !== before.stats.ino
    )
      throw new AihError("supported custody state is invalid", "AIH_TRUST");
    return found;
  } catch (error) {
    if (error instanceof AihError) throw error;
    return false;
  }
}

function assertUnchanged(
  action: WriteAction,
  record: Extract<StoredRecord, { state: "present" }>,
): WriteAction {
  return {
    ...action,
    once: undefined,
    durable: undefined,
    assertUnchanged: true,
    expect: { sha256: recordHash(record) },
  };
}

function headCas(
  action: WriteAction,
  record: Extract<StoredRecord, { state: "present" }>,
): WriteAction {
  return {
    ...action,
    once: undefined,
    assertUnchanged: undefined,
    expect: { sha256: recordHash(record) },
  };
}

function replayForHead(action: WriteAction, head: z.infer<typeof HeadRecordSchema>): WriteAction {
  const path = action.path.replace(
    /([\\/])replays[\\/][0-9a-f]{64}\.json$/,
    `$1replays${action.path.includes("\\") ? "\\" : "/"}${custodySlot("replay", head.replayIdentity)}.json`,
  );
  const value = {
    format: "aih-supported-qualification-custody",
    version: 2,
    kind: "replay-claim",
    replayIdentity: head.replayIdentity,
    catalogSignerIdentity: head.catalogSignerIdentity,
    signerKeyId: head.signerKeyId,
    catalogHeadDigest: head.catalogHeadDigest,
    sequence: head.sequence,
  };
  return { ...action, path, contents: custodyRecord(value) };
}

/** Plans only immutable genesis custody records; successor handling is intentionally separate. */
export function planSupportedCustodyAcceptV2(input: SupportedCustodyPlanInputV2): Plan {
  const { posture, platform, root, candidate } = parseCandidate(input);
  const receipt = candidate.receipt;
  const basis = receipt.qualificationBasis;
  const continuity = receipt.catalogContinuity;
  const signerSlot = custodySlot("signer", basis.catalogSignerIdentity);
  const replaySlot = custodySlot("replay", continuity.replayIdentity);
  const memberSlot = custodySlot("member", {
    catalogHeadDigest: basis.catalogHeadDigest,
    catalogMemberDigest: basis.catalogMemberDigest,
    subject: receipt.subject,
    target: candidate.target,
  });

  const records = [
    {
      relativePath: `${CUSTODY_PREFIX}/signers/${signerSlot}.json`,
      describe: "write supported custody signer claim",
      value: {
        format: "aih-supported-qualification-custody",
        version: 2,
        kind: "signer-claim",
        catalogSignerIdentity: basis.catalogSignerIdentity,
        signerKeyId: continuity.signerKeyId,
      },
    },
    {
      relativePath: `${CUSTODY_PREFIX}/replays/${replaySlot}.json`,
      describe: "write supported custody replay claim",
      value: {
        format: "aih-supported-qualification-custody",
        version: 2,
        kind: "replay-claim",
        replayIdentity: continuity.replayIdentity,
        catalogSignerIdentity: basis.catalogSignerIdentity,
        signerKeyId: continuity.signerKeyId,
        catalogHeadDigest: continuity.catalogHeadDigest,
        sequence: continuity.sequence,
      },
    },
    {
      relativePath: `${CUSTODY_PREFIX}/members/${memberSlot}.json`,
      describe: "write supported custody member claim",
      value: {
        format: "aih-supported-qualification-custody",
        version: 2,
        kind: "member-claim",
        entryId: receipt.entryId,
        catalogSignerIdentity: basis.catalogSignerIdentity,
        signerKeyId: continuity.signerKeyId,
        catalogDigest: basis.catalogDigest,
        catalogHeadDigest: basis.catalogHeadDigest,
        catalogMemberDigest: basis.catalogMemberDigest,
        replayIdentity: continuity.replayIdentity,
        sequence: continuity.sequence,
        subject: receipt.subject,
        decisionId: candidate.decision.id,
        decisionDigest: candidate.decision.digest,
        target: candidate.target,
        receiptDigest: candidate.receiptDigest,
        receiptSha256: candidate.receiptSha256,
        receiptIssuedAt: receipt.issuedAt,
        receiptNotBefore: receipt.notBefore,
        receiptExpiresAt: receipt.expiresAt,
        headValidFrom: continuity.headValidFrom,
        headValidUntil: continuity.headValidUntil,
        decisionNotBefore: candidate.decisionNotBefore,
        decisionExpiresAt: candidate.decisionExpiresAt,
        repository: candidate.repository,
        workflow: candidate.workflow,
        authorityReceiptDigest: candidate.authorityReceiptDigest,
        acceptedAt: candidate.acceptedAt,
      },
    },
    {
      relativePath: `${CUSTODY_PREFIX}/heads/${signerSlot}.json`,
      describe: "write supported custody genesis head",
      value: {
        format: "aih-supported-qualification-custody",
        version: 2,
        kind: "catalog-head",
        catalogSignerIdentity: basis.catalogSignerIdentity,
        signerKeyId: continuity.signerKeyId,
        catalogHeadDigest: continuity.catalogHeadDigest,
        previousCatalogHeadDigest: continuity.previousCatalogHeadDigest,
        sequence: continuity.sequence,
        replayIdentity: continuity.replayIdentity,
        headValidFrom: continuity.headValidFrom,
        headValidUntil: continuity.headValidUntil,
      },
    },
  ] as const;
  const lock = supportedCustodyLockV2({ posture, platform, root });
  const external =
    posture === "enterprise"
      ? {
          trustedBase:
            platform === "win32"
              ? "C:\\ProgramData"
              : platform === "darwin"
                ? "/Library/Application Support"
                : "/etc",
        }
      : undefined;
  const writes = records.map((record) =>
    immutableWrite(
      posture === "enterprise"
        ? absoluteCustodyPath(
            supportedCustodyRootV2({ posture, platform, root }),
            record.relativePath.slice(`${CUSTODY_PREFIX}/`.length),
            platform,
          )
        : record.relativePath,
      record.value,
      record.describe,
      external,
    ),
  );
  const expected = records.map((record) => ({
    relativePath: record.relativePath,
    bytes: Buffer.from(custodyRecord(record.value), "utf8"),
  }));
  const custodyRoot = supportedCustodyRootV2({ posture, platform, root });
  return {
    capability: "policy-supported-custody-v2",
    commitLock: lock,
    commitNotAfter: new Date(Date.now() + 60_000).toISOString(),
    actions: [
      ...writes,
      dynamicDigest("verify supported custody state", (ctx) => {
        if (!ctx.apply) return { text: "supported custody state pending" };
        const actualRoot = posture === "vibe" ? join(root, CUSTODY_PREFIX) : custodyRoot;
        const matched = expected.every(({ relativePath, bytes }) =>
          exactCustodyBytes(actualRoot, relativePath.slice(`${CUSTODY_PREFIX}/`.length), bytes),
        );
        if (!matched)
          throw new AihError("supported custody state verification failed", "AIH_TRUST");
        return { text: "supported custody state verified" };
      }),
    ],
  };
}

export function prepareSupportedCustodyAcceptV2(input: {
  root: string;
  posture: "enterprise" | "vibe";
  platform?: "win32" | "darwin" | "linux";
  candidate: SupportedCustodyCandidateV2;
}): Plan {
  const planned = planSupportedCustodyAcceptV2({
    ...input.candidate,
    posture: input.posture,
    root: input.root,
    ...(input.platform === undefined ? {} : { platform: input.platform }),
  });
  const plannedWrites = planned.actions.filter(
    (action): action is WriteAction => action.kind === "write",
  );
  const [signer, replay, member, head] = plannedWrites;
  if (signer === undefined || replay === undefined || member === undefined || head === undefined)
    throw new AihError("supported custody candidate is invalid", "AIH_TRUST");
  const parsed = parseCandidate({
    ...input.candidate,
    posture: input.posture,
    root: input.root,
    ...(input.platform === undefined ? {} : { platform: input.platform }),
  });
  const signerState = storedRecord(input.root, parsed.posture, signer);
  const replayState = storedRecord(input.root, parsed.posture, replay);
  const memberState = storedRecord(input.root, parsed.posture, member);
  const headState = storedRecord(input.root, parsed.posture, head);
  if (
    [signerState, replayState, memberState, headState].some((record) => record.state === "invalid")
  )
    throw new AihError("supported custody state is invalid", "AIH_TRUST");
  const continuity = parsed.candidate.receipt.catalogContinuity;
  const allAbsent = [signerState, replayState, memberState, headState].every(
    (record) => record.state === "absent",
  );
  if (allAbsent) {
    if (
      continuity.sequence !== 0 ||
      continuity.previousCatalogHeadDigest !== `sha256:${"0".repeat(64)}`
    )
      throw new AihError("supported custody continuity is invalid", "AIH_TRUST");
    return planned;
  }
  if (
    signerState.state !== "present" ||
    headState.state !== "present" ||
    !sameStoredRecord(signerState, signer)
  )
    throw new AihError("supported custody state is invalid", "AIH_TRUST");
  const currentHead = HeadRecordSchema.safeParse(headState.value);
  if (!currentHead.success) throw new AihError("supported custody state is invalid", "AIH_TRUST");
  const basis = parsed.candidate.receipt.qualificationBasis;
  if (
    currentHead.data.catalogSignerIdentity !== basis.catalogSignerIdentity ||
    currentHead.data.signerKeyId !== continuity.signerKeyId
  )
    throw new AihError("supported custody state is invalid", "AIH_TRUST");
  const currentReplay = replayForHead(replay, currentHead.data);
  const currentReplayState = storedRecord(input.root, parsed.posture, currentReplay);
  if (
    currentReplayState.state !== "present" ||
    !sameStoredRecord(currentReplayState, currentReplay)
  )
    throw new AihError("supported custody state is invalid", "AIH_TRUST");
  const sameHead = continuity.catalogHeadDigest === currentHead.data.catalogHeadDigest;
  if (sameHead) {
    if (
      !sameStoredRecord(headState, head) ||
      replayState.state !== "present" ||
      !sameStoredRecord(replayState, replay) ||
      continuity.sequence !== currentHead.data.sequence ||
      continuity.replayIdentity !== currentHead.data.replayIdentity
    )
      throw new AihError("supported custody continuity is invalid", "AIH_TRUST");
    if (memberState.state === "present") {
      if (!sameStoredRecord(memberState, member))
        throw new AihError(
          "supported custody member conflicts with accepted decision",
          "AIH_TRUST",
        );
      return { ...planned, actions: planned.actions.filter((action) => action.kind !== "write") };
    }
    if (!hasCurrentHeadMember(input.root, parsed.posture, member, currentHead.data))
      throw new AihError("supported custody state is invalid", "AIH_TRUST");
    return {
      ...planned,
      actions: [
        assertUnchanged(signer, signerState),
        assertUnchanged(replay, replayState),
        assertUnchanged(head, headState),
        member,
        ...planned.actions.filter((action) => action.kind !== "write"),
      ],
    };
  }
  if (
    continuity.sequence !== currentHead.data.sequence + 1 ||
    continuity.previousCatalogHeadDigest !== currentHead.data.catalogHeadDigest ||
    continuity.replayIdentity === currentHead.data.replayIdentity ||
    replayState.state !== "absent" ||
    memberState.state !== "absent"
  )
    throw new AihError("supported custody continuity is invalid", "AIH_TRUST");
  if (!hasCurrentHeadMember(input.root, parsed.posture, member, currentHead.data))
    throw new AihError("supported custody state is invalid", "AIH_TRUST");
  return {
    ...planned,
    actions: [
      assertUnchanged(signer, signerState),
      assertUnchanged(currentReplay, currentReplayState),
      replay,
      member,
      headCas(head, headState),
      ...planned.actions.filter((action) => action.kind !== "write"),
    ],
  };
}

export type CurrentSupportedCustodyValidationV2 = Readonly<{
  state: "verified" | "unverified";
  scrubbed: true;
}>;

/**
 * Proves the current four custody records still exactly bind a production-verified
 * support receipt, decision, target, authority receipt, and support root.
 */
export function validateCurrentSupportedCustodyV2(input: {
  root: string;
  posture: "enterprise" | "vibe";
  platform?: "win32" | "darwin" | "linux";
  binding: VerifiedAihSupportedCustodyBindingV2;
}): CurrentSupportedCustodyValidationV2 {
  try {
    const candidate = candidateWithHistoricAcceptance({
      ...input,
      candidate: candidateFromVerifiedBinding(input.binding),
    });
    const now = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
    const receipt = candidate.receipt;
    if (
      now < receipt.notBefore ||
      now >= receipt.expiresAt ||
      now < candidate.decisionNotBefore ||
      now >= candidate.decisionExpiresAt ||
      now < receipt.catalogContinuity.headValidFrom ||
      now >= receipt.catalogContinuity.headValidUntil ||
      now >= input.binding.authorityExpiresAt ||
      (input.binding.decision.reviewBy !== undefined && now >= input.binding.decision.reviewBy)
    )
      return { state: "unverified", scrubbed: true };
    if (!isVerifiedSupportedReceiptCurrentV2(input.root, input.binding))
      return { state: "unverified", scrubbed: true };
    const plan = planSupportedCustodyAcceptV2({
      ...candidate,
      root: input.root,
      posture: input.posture,
      ...(input.platform === undefined ? {} : { platform: input.platform }),
    });
    const writes = plan.actions.filter((action): action is WriteAction => action.kind === "write");
    if (writes.length !== 4) return { state: "unverified", scrubbed: true };
    const parsed = parseCandidate({
      ...candidate,
      root: input.root,
      posture: input.posture,
      ...(input.platform === undefined ? {} : { platform: input.platform }),
    });
    const records = writes.map((action) => storedRecord(input.root, parsed.posture, action));
    if (!records.every((record, index) => sameStoredRecord(record, writes[index] as WriteAction)))
      return { state: "unverified", scrubbed: true };
    const head =
      records[3]?.state === "present" ? HeadRecordSchema.safeParse(records[3].value) : undefined;
    return head?.success &&
      hasCurrentHeadMember(input.root, parsed.posture, writes[2] as WriteAction, head.data)
      ? { state: "verified", scrubbed: true }
      : { state: "unverified", scrubbed: true };
  } catch {
    return { state: "unverified", scrubbed: true };
  }
}

/** Converts only opaque production-verifier facts into the internal custody candidate. */
export function prepareVerifiedSupportedCustodyAcceptV2(input: {
  root: string;
  posture: "enterprise" | "vibe";
  platform?: "win32" | "darwin" | "linux";
  binding: VerifiedAihSupportedCustodyBindingV2;
}): Plan {
  const candidate = candidateWithHistoricAcceptance({
    ...input,
    candidate: candidateFromVerifiedBinding(input.binding),
  });
  const planned = prepareSupportedCustodyAcceptV2({
    ...input,
    candidate,
  });
  const deadlines = [
    new Date(Date.now() + 60_000),
    new Date(candidate.receipt.expiresAt),
    new Date(candidate.receipt.catalogContinuity.headValidUntil),
    new Date(candidate.decisionExpiresAt),
    new Date(input.binding.authorityExpiresAt),
    ...(input.binding.decision.reviewBy === undefined
      ? []
      : [new Date(input.binding.decision.reviewBy)]),
  ];
  const deadline = deadlines.reduce((earliest, candidateDeadline) =>
    candidateDeadline.getTime() < earliest.getTime() ? candidateDeadline : earliest,
  );
  if (!Number.isFinite(deadline.getTime()) || deadline.getTime() <= Date.now())
    throw new AihError("supported custody verification failed", "AIH_TRUST");
  return { ...planned, commitNotAfter: deadline.toISOString() };
}

/** Fixed-production accept path: only the decision reference and target arrive from Commander. */
export async function supportedCustodyAcceptPlanV2(ctx: PlanContext): Promise<Plan> {
  const binding = await verifyAihSupportedCustodyBindingV2(ctx, {
    decision: ctx.options.decision,
    decisionDigest: ctx.options.decisionDigest,
    target: ctx.options.target,
  });
  if (binding === undefined)
    throw new AihError("supported custody verification failed", "AIH_TRUST");
  const planned = prepareVerifiedSupportedCustodyAcceptV2({
    root: ctx.root,
    posture: ctx.posture === "enterprise" ? "enterprise" : "vibe",
    platform:
      ctx.host.platform === "windows"
        ? "win32"
        : ctx.host.platform === "darwin"
          ? "darwin"
          : "linux",
    binding,
  });
  return {
    ...planned,
    actions: [
      verifiedSupportedReceiptAssertionV2(binding),
      ...planned.actions,
      dynamicDigest("verify supported receipt unchanged", () => {
        if (!isVerifiedSupportedReceiptCurrentV2(ctx.root, binding))
          throw new AihError("supported custody verification failed", "AIH_TRUST");
        return { text: "supported receipt verified" };
      }),
    ],
  };
}

export type SupportedCustodyInspectionV2 = Readonly<{
  deterministic: true;
  scrubbed: true;
  limit: 4096;
  members: readonly Readonly<{
    entryId: string;
    subject: { kind: string; id: string; digest: string };
    target: string;
    decision: { id: string; digest: string };
    acceptedAt: string;
  }>[];
}>;

function custodyDirectoryAction(
  root: string,
  posture: "enterprise" | "vibe",
  platform: "win32" | "darwin" | "linux",
  directory: "heads" | "members",
): WriteAction {
  const external = posture === "enterprise";
  const trustedBase =
    platform === "win32"
      ? "C:\\ProgramData"
      : platform === "darwin"
        ? "/Library/Application Support"
        : "/etc";
  return {
    kind: "write",
    path: external
      ? absoluteCustodyPath(
          supportedCustodyRootV2({ root, posture, platform }),
          directory,
          platform,
        )
      : `${CUSTODY_PREFIX}/${directory}`,
    contents: "",
    describe: "inspect supported custody directory",
    ...(external ? { external: true, trustedBase } : {}),
  };
}

/** Bounded, deterministic, path-scrubbed view of members bound to currently stored heads. */
export function inspectSupportedCustodyV2(input: {
  root: string;
  posture: "enterprise" | "vibe";
  platform?: "win32" | "darwin" | "linux";
}): SupportedCustodyInspectionV2 {
  const empty: SupportedCustodyInspectionV2 = {
    deterministic: true,
    scrubbed: true,
    limit: MAX_CUSTODY_MEMBERS,
    members: [],
  };
  try {
    if (input.posture === "enterprise" && input.platform === undefined)
      throw new AihError("supported custody state is invalid", "AIH_TRUST");
    const platform = input.platform ?? localPlatform();
    const headsDirectory = custodyDirectoryAction(input.root, input.posture, platform, "heads");
    const membersDirectory = custodyDirectoryAction(input.root, input.posture, platform, "members");
    const headBoundary = custodyReadBoundary(input.root, input.posture, headsDirectory);
    const memberBoundary = custodyReadBoundary(input.root, input.posture, membersDirectory);
    if (headBoundary === undefined || memberBoundary === undefined)
      throw new AihError("supported custody state is invalid", "AIH_TRUST");
    const headsBefore = inspectContainedRelativePath(headBoundary.root, headBoundary.relativePath);
    const membersBefore = inspectContainedRelativePath(
      memberBoundary.root,
      memberBoundary.relativePath,
    );
    if (headsBefore.state === "absent" && membersBefore.state === "absent") return empty;
    if (
      headsBefore.state !== "present" ||
      headsBefore.kind !== "directory" ||
      membersBefore.state !== "present" ||
      membersBefore.kind !== "directory"
    )
      throw new AihError("supported custody state is invalid", "AIH_TRUST");
    const heads = new Map<string, z.infer<typeof HeadRecordSchema>>();
    for (const entry of boundedMemberEntries(headsBefore.realPath)) {
      if (!/^[0-9a-f]{64}\.json$/.test(entry))
        throw new AihError("supported custody state is invalid", "AIH_TRUST");
      const separator = headsDirectory.path.includes("\\") ? "\\" : "/";
      const record = storedRecord(input.root, input.posture, {
        ...headsDirectory,
        path: `${headsDirectory.path}${separator}${entry}`,
      });
      if (record.state !== "present")
        throw new AihError("supported custody state is invalid", "AIH_TRUST");
      const head = HeadRecordSchema.safeParse(record.value);
      if (!head.success) throw new AihError("supported custody state is invalid", "AIH_TRUST");
      heads.set(
        `${head.data.catalogHeadDigest}\0${head.data.catalogSignerIdentity}\0${head.data.signerKeyId}\0${head.data.replayIdentity}\0${head.data.sequence}\0${head.data.headValidFrom}\0${head.data.headValidUntil}`,
        head.data,
      );
    }
    const members: Array<SupportedCustodyInspectionV2["members"][number]> = [];
    for (const entry of boundedMemberEntries(membersBefore.realPath)) {
      if (!/^[0-9a-f]{64}\.json$/.test(entry))
        throw new AihError("supported custody state is invalid", "AIH_TRUST");
      const separator = membersDirectory.path.includes("\\") ? "\\" : "/";
      const record = storedRecord(input.root, input.posture, {
        ...membersDirectory,
        path: `${membersDirectory.path}${separator}${entry}`,
      });
      if (record.state !== "present")
        throw new AihError("supported custody state is invalid", "AIH_TRUST");
      const member = MemberRecordSchema.safeParse(record.value);
      if (!member.success) throw new AihError("supported custody state is invalid", "AIH_TRUST");
      const slot = custodySlot("member", {
        catalogHeadDigest: member.data.catalogHeadDigest,
        catalogMemberDigest: member.data.catalogMemberDigest,
        subject: member.data.subject,
        target: member.data.target,
      });
      if (entry !== `${slot}.json`)
        throw new AihError("supported custody state is invalid", "AIH_TRUST");
      const key = `${member.data.catalogHeadDigest}\0${member.data.catalogSignerIdentity}\0${member.data.signerKeyId}\0${member.data.replayIdentity}\0${member.data.sequence}\0${member.data.headValidFrom}\0${member.data.headValidUntil}`;
      if (!heads.has(key)) continue;
      members.push({
        entryId: member.data.entryId,
        subject: {
          kind: member.data.subject.kind,
          id: member.data.subject.id,
          digest: member.data.subject.subjectDigest,
        },
        target: member.data.target,
        decision: { id: member.data.decisionId, digest: member.data.decisionDigest },
        acceptedAt: member.data.acceptedAt,
      });
    }
    return { ...empty, members };
  } catch (error) {
    if (error instanceof AihError) throw error;
    throw new AihError("supported custody state is invalid", "AIH_TRUST");
  }
}

export function supportedCustodyInspectPlanV2(ctx: PlanContext): Plan {
  return {
    capability: "policy-supported-custody-inspect-v2",
    actions: [
      dynamicDigest("inspect supported custody", () => ({
        text: "supported custody inspected",
        data: inspectSupportedCustodyV2({
          root: ctx.root,
          posture: ctx.posture === "enterprise" ? "enterprise" : "vibe",
          platform:
            ctx.host.platform === "windows"
              ? "win32"
              : ctx.host.platform === "darwin"
                ? "darwin"
                : "linux",
        }),
      })),
    ],
  };
}
