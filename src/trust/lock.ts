import { join } from "node:path";
import { readIfExists } from "../internals/fsxn.js";
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
