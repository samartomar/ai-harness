import { createHash } from "node:crypto";
import { type BigIntStats, closeSync, constants, fstatSync, lstatSync, openSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { inspectContainedRelativePath } from "../internals/contained-path.js";
import { readBoundedFileDescriptor, readIfExists } from "../internals/fsxn.js";
import type { Check } from "../internals/verify.js";

/** Repo-relative trust lockfile path — the promoted-source evidence `trust verify` re-hashes. */
export const TRUST_LOCK_FILE = ".aih/trust-lock.json";

export interface TrustLock {
  schemaVersion: 1;
  sources: TrustLockSource[];
}

export interface TrustLockSource {
  id: string;
  kind: "local" | "github";
  source: string;
  ref?: string;
  pinnedSha?: string;
  promotedAt: string;
  promotedSkills: string[];
  analyzersRun: string[];
  artifactHashes: Array<{ path: string; sha256: string }>;
  findings: Array<{
    name: string;
    verdict: string;
    code?: string;
    detail?: string;
    location?: Check["location"];
    fingerprint?: string;
  }>;
}

const LOWER_FULL_SHA = /^[0-9a-f]{40}$/;
const LOWER_SHA256 = /^[0-9a-f]{64}$/;

export const MAX_TRUST_LOCK_BYTES = 8 * 1024 * 1024;

const SafePathSchema = z.string().min(1).refine(isSafeRelativePath);
const FindingSchema = z.strictObject({
  name: z.string().min(1),
  verdict: z.string().min(1),
  code: z.string().min(1).optional(),
  detail: z.string().min(1).optional(),
  location: z
    .strictObject({ uri: z.string().min(1), startLine: z.number().int().positive().optional() })
    .optional(),
  fingerprint: z.string().min(1).optional(),
});
const TrustLockSourceSchema = z
  .strictObject({
    id: SafePathSchema,
    kind: z.enum(["local", "github"]),
    source: z.string().min(1),
    ref: z.string().min(1).optional(),
    pinnedSha: z.string().regex(LOWER_FULL_SHA).optional(),
    promotedAt: z.string().min(1),
    promotedSkills: z.array(SafePathSchema),
    analyzersRun: z.array(SafePathSchema),
    artifactHashes: z.array(
      z.strictObject({ path: SafePathSchema, sha256: z.string().regex(LOWER_SHA256) }),
    ),
    findings: z.array(FindingSchema),
  })
  .superRefine((source, context) => {
    if (
      (source.kind === "github" && (source.ref === undefined || source.pinnedSha === undefined)) ||
      (source.kind === "local" && (source.ref !== undefined || source.pinnedSha !== undefined)) ||
      new Set(source.promotedSkills).size !== source.promotedSkills.length ||
      new Set(source.analyzersRun).size !== source.analyzersRun.length ||
      new Set(source.artifactHashes.map(({ path }) => path)).size !== source.artifactHashes.length
    ) {
      context.addIssue({ code: "custom", message: "invalid trust lock source" });
    }
  });
const TrustLockSchema = z.strictObject({
  schemaVersion: z.literal(1),
  sources: z.array(TrustLockSourceSchema),
});

export type ExactTrustLockRead =
  | { state: "absent" }
  | { state: "malformed" }
  | {
      state: "valid";
      lock: TrustLock;
      sourceBytes: Buffer;
      sourceSha256: string;
      mode: number;
    };

export interface ExactTrustLockReadDeps {
  afterInspect?: () => void;
  afterOpen?: () => void;
}

function sameExactFile(left: BigIntStats, right: BigIntStats): boolean {
  return left.ino !== 0n && left.dev === right.dev && left.ino === right.ino;
}

function currentTrustLockStats(root: string, realPath: string, opened: BigIntStats): boolean {
  const currentInfo = inspectContainedRelativePath(root, TRUST_LOCK_FILE);
  if (
    currentInfo.state !== "present" ||
    currentInfo.kind !== "file" ||
    currentInfo.realPath !== realPath
  )
    return false;
  try {
    const current = lstatSync(currentInfo.realPath, { bigint: true });
    return current.isFile() && current.nlink === 1n && sameExactFile(opened, current);
  } catch {
    return false;
  }
}

export function readTrustLockExact(
  root: string,
  deps: ExactTrustLockReadDeps = {},
): ExactTrustLockRead {
  try {
    if (lstatSync(join(root, ".aih")).isSymbolicLink()) return { state: "malformed" };
  } catch {
    // The contained-path reader distinguishes an absent state below.
  }
  const inspected = inspectContainedRelativePath(root, TRUST_LOCK_FILE);
  if (inspected.state === "absent") return { state: "absent" };
  if (inspected.state !== "present" || inspected.kind !== "file") return { state: "malformed" };
  let expected: BigIntStats;
  try {
    expected = lstatSync(inspected.realPath, { bigint: true });
    deps.afterInspect?.();
  } catch {
    return { state: "malformed" };
  }
  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  let descriptor: number;
  try {
    descriptor = openSync(inspected.realPath, constants.O_RDONLY | noFollow);
  } catch {
    return { state: "malformed" };
  }
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    deps.afterOpen?.();
    if (
      !sameExactFile(expected, opened) ||
      expected.nlink !== opened.nlink ||
      expected.mode !== opened.mode ||
      expected.size !== opened.size ||
      expected.mtimeNs !== opened.mtimeNs ||
      !opened.isFile() ||
      opened.ino === 0n ||
      opened.nlink !== 1n ||
      opened.size > BigInt(MAX_TRUST_LOCK_BYTES) ||
      !currentTrustLockStats(root, inspected.realPath, opened)
    )
      return { state: "malformed" };
    const contents = readBoundedFileDescriptor(descriptor, MAX_TRUST_LOCK_BYTES);
    if (contents === undefined) return { state: "malformed" };
    const after = fstatSync(descriptor, { bigint: true });
    if (
      !sameExactFile(opened, after) ||
      after.nlink !== opened.nlink ||
      after.mode !== opened.mode ||
      after.size !== opened.size ||
      after.mtimeNs !== opened.mtimeNs ||
      !currentTrustLockStats(root, inspected.realPath, opened)
    )
      return { state: "malformed" };
    const text = new TextDecoder("utf-8", { fatal: true }).decode(contents);
    const parsed = TrustLockSchema.parse(JSON.parse(text));
    const ids = parsed.sources.map(({ id }) => id.toLowerCase());
    if (new Set(ids).size !== ids.length) return { state: "malformed" };
    for (const source of parsed.sources) {
      const paths = source.artifactHashes.map(({ path }) => path.toLowerCase());
      if (new Set(paths).size !== paths.length) return { state: "malformed" };
    }
    const sourceBytes = Buffer.from(contents);
    return {
      state: "valid",
      lock: parsed as TrustLock,
      sourceBytes,
      sourceSha256: createHash("sha256").update(sourceBytes).digest("hex"),
      mode: Number(opened.mode & 0o777n),
    };
  } catch {
    return { state: "malformed" };
  } finally {
    try {
      closeSync(descriptor);
    } catch {
      // A close failure cannot turn an authority read into valid state.
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isSafeRelativePath(value: string): boolean {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting them is the point
  if (/[\u0000-\u001f\u007f\\]/.test(value)) return false;
  if (value.startsWith("/") || /^[A-Za-z]:/.test(value)) return false;
  return value
    .split("/")
    .every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.every((item) => isNonEmptyString(item) && isSafeRelativePath(item))
  );
}

function parseOptionalString(value: unknown): string | undefined {
  return value === undefined || isNonEmptyString(value) ? value : undefined;
}

function parseOptionalPinnedSha(value: unknown): string | undefined {
  return value === undefined || (typeof value === "string" && LOWER_FULL_SHA.test(value))
    ? value
    : undefined;
}

function parseArtifactHashes(value: unknown): Array<{ path: string; sha256: string }> | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: Array<{ path: string; sha256: string }> = [];
  for (const item of value) {
    if (
      !isRecord(item) ||
      !isNonEmptyString(item.path) ||
      !isSafeRelativePath(item.path) ||
      typeof item.sha256 !== "string" ||
      !LOWER_SHA256.test(item.sha256)
    ) {
      return undefined;
    }
    out.push({ path: item.path, sha256: item.sha256 });
  }
  return out;
}

function parseFindings(value: unknown): TrustLockSource["findings"] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item) || !isNonEmptyString(item.name) || !isNonEmptyString(item.verdict)) {
      return [];
    }
    return [
      {
        name: item.name,
        verdict: item.verdict,
        code: parseOptionalString(item.code),
        detail: parseOptionalString(item.detail),
        location: item.location as Check["location"] | undefined,
        fingerprint: parseOptionalString(item.fingerprint),
      },
    ];
  });
}

export function parseTrustLockSource(value: unknown): TrustLockSource | undefined {
  if (!isRecord(value)) return undefined;
  if (
    !isNonEmptyString(value.id) ||
    !isSafeRelativePath(value.id) ||
    (value.kind !== "local" && value.kind !== "github") ||
    !isNonEmptyString(value.source) ||
    !isNonEmptyString(value.promotedAt) ||
    !isStringArray(value.promotedSkills) ||
    !isStringArray(value.analyzersRun)
  ) {
    return undefined;
  }

  const ref = parseOptionalString(value.ref);
  const pinnedSha = parseOptionalPinnedSha(value.pinnedSha);
  const artifactHashes = parseArtifactHashes(value.artifactHashes);
  if (
    (value.ref !== undefined && ref === undefined) ||
    (value.pinnedSha !== undefined && pinnedSha === undefined) ||
    artifactHashes === undefined
  ) {
    return undefined;
  }

  return {
    id: value.id,
    kind: value.kind,
    source: value.source,
    ref,
    pinnedSha,
    promotedAt: value.promotedAt,
    promotedSkills: [...value.promotedSkills],
    analyzersRun: [...value.analyzersRun],
    artifactHashes,
    findings: parseFindings(value.findings),
  };
}

function trustLockInvalidFinding(detail: string): Check {
  return {
    name: "trust lock invalid",
    verdict: "fail",
    code: "trust.source-changed",
    detail,
    location: { uri: TRUST_LOCK_FILE },
    fingerprint: `trust-lock-invalid:${detail.slice(0, 80)}`,
  };
}

export function trustLockValidationFindings(root: string): Check[] {
  const raw = readIfExists(join(root, TRUST_LOCK_FILE));
  if (raw === undefined) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [trustLockInvalidFinding(`${TRUST_LOCK_FILE} is not valid JSON`)];
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.sources)) {
    return [trustLockInvalidFinding(`${TRUST_LOCK_FILE} does not contain a sources array`)];
  }
  return parsed.sources.flatMap((source, index) =>
    parseTrustLockSource(source) === undefined
      ? [trustLockInvalidFinding(`${TRUST_LOCK_FILE} sources[${index}] is malformed or unsafe`)]
      : [],
  );
}

export function readTrustLock(root: string): TrustLock {
  const raw = readIfExists(join(root, TRUST_LOCK_FILE));
  if (raw === undefined) return { schemaVersion: 1, sources: [] };
  try {
    const parsed = JSON.parse(raw) as { sources?: unknown };
    const sources = Array.isArray(parsed.sources) ? parsed.sources : [];
    return {
      schemaVersion: 1,
      sources: sources.flatMap((source) => {
        const parsedSource = parseTrustLockSource(source);
        return parsedSource === undefined ? [] : [parsedSource];
      }),
    };
  } catch {
    return { schemaVersion: 1, sources: [] };
  }
}
