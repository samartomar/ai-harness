import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { canonicalStrictJsonBytesV1 } from "../contract/strict-json-v1.js";
import { AihError } from "../errors.js";
import { SUPPORTED_CLIS } from "../internals/clis.js";
import { readRegularFileWithStats } from "../internals/fsxn.js";
import { dynamicDigest, type Plan, type WriteAction } from "../internals/plan.js";
import {
  type AihSupportedQualificationReceiptV2,
  AihSupportedQualificationReceiptV2Schema,
} from "./supported-qualification-receipt-v2.js";

const CUSTODY_PREFIX = ".aih/supported-qualification/v2";
const MAX_CUSTODY_CANDIDATE_BYTES = 16 * 1024;
const MAX_CUSTODY_RECORD_BYTES = 12 * 1024;
const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const timestamp = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
const decisionId = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
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
  target: string;
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
    const acceptedAt = Date.parse(value.acceptedAt);
    const receiptNotBefore = Date.parse(value.receipt.notBefore);
    const receiptExpiresAt = Date.parse(value.receipt.expiresAt);
    const decisionNotBefore = Date.parse(value.decisionNotBefore);
    const decisionExpiresAt = Date.parse(value.decisionExpiresAt);
    if (
      !Number.isFinite(acceptedAt) ||
      !Number.isFinite(decisionNotBefore) ||
      !Number.isFinite(decisionExpiresAt) ||
      decisionNotBefore > acceptedAt ||
      acceptedAt >= decisionExpiresAt ||
      acceptedAt < receiptNotBefore ||
      acceptedAt >= receiptExpiresAt
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
}).strict();

export type SupportedCustodyPlanInputV2 = z.input<typeof PlanInputSchema>;

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
  let bytes: Buffer;
  try {
    bytes = canonicalStrictJsonBytesV1(parsed.data);
  } catch {
    throw new AihError("supported custody candidate is invalid", "AIH_TRUST");
  }
  if (bytes.byteLength > MAX_CUSTODY_CANDIDATE_BYTES)
    throw new AihError("supported custody candidate is invalid", "AIH_TRUST");
  const { posture, platform = "linux", root, ...candidate } = parsed.data;
  return { posture, platform, root, candidate };
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
  const absolutePath = join(root, ...relativePath.split("/"));
  const opened = readRegularFileWithStats(absolutePath, { maxBytes: expected.byteLength });
  if (opened === undefined || opened.identity.nlink !== 1n || !opened.contents.equals(expected))
    return false;
  let current = root;
  for (const segment of relativePath.split("/")) {
    try {
      const stats = lstatSync(current);
      if (!stats.isDirectory() || stats.isSymbolicLink()) return false;
      current = join(current, segment);
    } catch {
      return false;
    }
  }
  return true;
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
        catalogDigest: basis.catalogDigest,
        catalogHeadDigest: basis.catalogHeadDigest,
        catalogMemberDigest: basis.catalogMemberDigest,
        subject: receipt.subject,
        decisionId: candidate.decision.id,
        decisionDigest: candidate.decision.digest,
        target: candidate.target,
        receiptDigest: candidate.receiptDigest,
        receiptSha256: candidate.receiptSha256,
        receiptIssuedAt: receipt.issuedAt,
        receiptNotBefore: receipt.notBefore,
        receiptExpiresAt: receipt.expiresAt,
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
      dynamicDigest("verify supported custody genesis", () => {
        const actualRoot = posture === "vibe" ? join(root, CUSTODY_PREFIX) : custodyRoot;
        const matched = expected.every(({ relativePath, bytes }) =>
          exactCustodyBytes(actualRoot, relativePath.slice(`${CUSTODY_PREFIX}/`.length), bytes),
        );
        if (!matched)
          throw new AihError("supported custody genesis verification failed", "AIH_TRUST");
        return { text: "supported custody genesis verified" };
      }),
    ],
  };
}
