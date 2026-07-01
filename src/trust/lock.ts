import { join } from "node:path";
import { readIfExists } from "../internals/fsxn.js";
import type { Check } from "../internals/verify.js";

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isNonEmptyString);
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
    if (!isRecord(item) || !isNonEmptyString(item.path) || !isNonEmptyString(item.sha256)) {
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

export function readTrustLock(root: string): TrustLock {
  const raw = readIfExists(join(root, ".aih", "trust-lock.json"));
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
