import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isProxy } from "node:util/types";
import type { VendorBaselineEvidenceArtifactV1 } from "../baseline-evidence/vendor-artifact-v1.js";
import {
  BASELINE_EVIDENCE_ARTIFACT_FILE_V1,
  BASELINE_EVIDENCE_ARTIFACT_LOCK_PATH_V1,
  BASELINE_EVIDENCE_ARTIFACT_SUMS_PATH_V1,
} from "../baseline-evidence/vendor-artifact-v1.js";
import { codeUnitCompare } from "../capability/package-graph/canonical.js";
import { canonicalStrictJsonBytesV1, parseStrictJsonObjectV1 } from "../contract/strict-json-v1.js";
import { AihError } from "../errors.js";
import { readRegularFile } from "../internals/fsxn.js";
import {
  ADMIN_BASELINE_EVIDENCE_CACHE_DIR_V1,
  type AdminBaselineEvidenceBootstrapV1,
} from "./admin-baseline-evidence-bootstrap-v1.js";

const PROTOCOL = "AdminBaselineEvidenceCacheRecordV1";
const ATTESTATION_LIMIT = 256 * 1024;
const ARTIFACT_FILE_LIMIT = 1024 * 1024;
const TOTAL_ARTIFACT_LIMIT = 1280 * 1024;
const CACHE_LIMIT = 1600 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;
const SECOND_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(Z|([+-])(\d{2}):(\d{2}))$/;

export const ADMIN_BASELINE_EVIDENCE_ARTIFACT_FILES_V1 = [
  BASELINE_EVIDENCE_ARTIFACT_FILE_V1,
  "evidence.json",
  `files/${BASELINE_EVIDENCE_ARTIFACT_LOCK_PATH_V1}`,
  "manifest.json",
  BASELINE_EVIDENCE_ARTIFACT_SUMS_PATH_V1,
] as const;

export interface DownloadedEvidenceV1 {
  readonly artifact: VendorBaselineEvidenceArtifactV1;
  readonly attestationBytes: Buffer;
  readonly downloadedAt: string;
}

interface DirectoryIdentity {
  readonly dev: number;
  readonly ino: number;
}
interface FileIdentity {
  readonly dev: number;
  readonly ino: number;
}

function fail(label: string): never {
  throw new AihError(`admin baseline evidence cache: ${label}`, "AIH_ADMIN_BASELINE_EVIDENCE");
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function daysInGregorianMonth(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

/** Strict, calendar-valid second timestamps for the baseline evidence trust boundary. */
export function adminBaselineEvidenceTimestampEpochV1(
  value: unknown,
  allowOffset: boolean,
): number | undefined {
  if (typeof value !== "string") return undefined;
  const match = SECOND_TIMESTAMP.exec(value);
  if (match === null || (!allowOffset && match[7] !== "Z")) return undefined;
  const [year, month, day, hour, minute, second, offsetHour, offsetMinute] = [
    match[1],
    match[2],
    match[3],
    match[4],
    match[5],
    match[6],
    match[9] ?? "0",
    match[10] ?? "0",
  ].map(Number);
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hour === undefined ||
    minute === undefined ||
    second === undefined ||
    offsetHour === undefined ||
    offsetMinute === undefined ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInGregorianMonth(year, month) ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  )
    return undefined;
  const epoch = Date.parse(value);
  return Number.isSafeInteger(epoch) ? epoch : undefined;
}

function exact(value: Record<string, unknown>, fields: readonly string[], label: string): void {
  const actual = Object.keys(value).sort(codeUnitCompare);
  const expected = [...fields].sort(codeUnitCompare);
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index]))
    fail(label);
}

function timestamp(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    adminBaselineEvidenceTimestampEpochV1(value, false) === undefined
  )
    fail(label);
  return value;
}

function base64(value: unknown, label: string, maxBytes: number): Buffer {
  if (typeof value !== "string" || value.length === 0) fail(label);
  const bytes = Buffer.from(value, "base64");
  if (bytes.length === 0 || bytes.length > maxBytes || bytes.toString("base64") !== value)
    fail(label);
  return bytes;
}

function canonicalRoot(root: string): string {
  if (typeof root !== "string" || root.length === 0 || !isAbsolute(root)) fail("root");
  try {
    const before = lstatSync(resolve(root));
    if (before.isSymbolicLink() || !before.isDirectory()) fail("root");
    const real = realpathSync.native(resolve(root));
    const after = lstatSync(real);
    if (after.isSymbolicLink() || !after.isDirectory()) fail("root");
    return real;
  } catch (error) {
    if (error instanceof AihError) throw error;
    fail("root");
  }
}

function slotKey(bootstrap: AdminBaselineEvidenceBootstrapV1): string {
  return sha256(
    Buffer.concat([
      Buffer.from("AIH_ADMIN_BASELINE_EVIDENCE_CACHE_SLOT_V1\0", "utf8"),
      canonicalStrictJsonBytesV1(bootstrap),
    ]),
  );
}

export function adminBaselineEvidenceCacheSlotPathV1(
  root: string,
  bootstrap: AdminBaselineEvidenceBootstrapV1,
): string {
  return join(
    canonicalRoot(root),
    ADMIN_BASELINE_EVIDENCE_CACHE_DIR_V1,
    `${slotKey(bootstrap)}.json`,
  );
}

function safeCacheDirectory(root: string, directory: string, createMissing: boolean): boolean {
  const relativeDirectory = relative(root, directory);
  if (
    relativeDirectory.length === 0 ||
    relativeDirectory.startsWith("..") ||
    isAbsolute(relativeDirectory) ||
    relativeDirectory.split(sep).includes("..")
  )
    return false;
  let current = root;
  try {
    const rootInfo = lstatSync(current);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) return false;
    for (const segment of relativeDirectory.split(sep)) {
      if (segment.length === 0 || segment === ".") return false;
      current = join(current, segment);
      try {
        const info = lstatSync(current);
        if (info.isSymbolicLink() || !info.isDirectory()) return false;
      } catch {
        if (!createMissing) return true;
        mkdirSync(current, { mode: 0o700 });
        const created = lstatSync(current);
        if (created.isSymbolicLink() || !created.isDirectory()) return false;
      }
      if (process.platform !== "win32") chmodSync(current, 0o700);
    }
    return true;
  } catch {
    return false;
  }
}

function directoryIdentity(path: string): DirectoryIdentity | undefined {
  try {
    const info = lstatSync(path);
    return info.isSymbolicLink() || !info.isDirectory()
      ? undefined
      : { dev: info.dev, ino: info.ino };
  } catch {
    return undefined;
  }
}

function sameDirectory(path: string, expected: DirectoryIdentity): boolean {
  const current = directoryIdentity(path);
  return current !== undefined && current.dev === expected.dev && current.ino === expected.ino;
}

function fileIdentity(path: string): FileIdentity | undefined {
  try {
    const info = lstatSync(path);
    return info.isSymbolicLink() || !info.isFile() ? undefined : { dev: info.dev, ino: info.ino };
  } catch {
    return undefined;
  }
}

function sameFile(path: string, expected: FileIdentity): boolean {
  const current = fileIdentity(path);
  return current !== undefined && current.dev === expected.dev && current.ino === expected.ino;
}

function releaseLock(path: string, identity: FileIdentity): boolean {
  try {
    if (!sameFile(path, identity)) return false;
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

function artifactFrom(value: unknown): VendorBaselineEvidenceArtifactV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail("artifact");
  const item = value as Record<string, unknown>;
  exact(item, ["files", "subject"], "artifact");
  if (
    !Array.isArray(item.files) ||
    item.files.length !== ADMIN_BASELINE_EVIDENCE_ARTIFACT_FILES_V1.length
  )
    fail("artifact");
  const files = item.files.map((value, index) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) fail("artifact file");
    const file = value as Record<string, unknown>;
    exact(file, ["bytes", "path"], "artifact file");
    if (
      file.path !== ADMIN_BASELINE_EVIDENCE_ARTIFACT_FILES_V1[index] ||
      !Buffer.isBuffer(file.bytes) ||
      file.bytes.length === 0 ||
      file.bytes.length > ARTIFACT_FILE_LIMIT
    )
      fail("artifact file");
    return { path: file.path, bytes: Buffer.from(file.bytes) };
  });
  const total = files.reduce((sum, file) => sum + file.bytes.length, 0);
  if (total > TOTAL_ARTIFACT_LIMIT) fail("artifact bounds");
  if (typeof item.subject !== "object" || item.subject === null || Array.isArray(item.subject))
    fail("subject");
  const subject = item.subject as Record<string, unknown>;
  exact(subject, ["bytes", "path", "sha256"], "subject");
  if (
    subject.path !== ADMIN_BASELINE_EVIDENCE_ARTIFACT_FILES_V1.at(-1) ||
    !Buffer.isBuffer(subject.bytes) ||
    subject.bytes.length === 0 ||
    typeof subject.sha256 !== "string" ||
    !SHA256.test(subject.sha256) ||
    sha256(subject.bytes) !== subject.sha256 ||
    files.at(-1)?.bytes.compare(subject.bytes) !== 0
  )
    fail("subject");
  return {
    files: files.map((file) => ({ bytes: file.bytes, path: file.path as string })),
    subject: {
      bytes: Buffer.from(subject.bytes),
      path: BASELINE_EVIDENCE_ARTIFACT_SUMS_PATH_V1,
      sha256: subject.sha256,
    },
  };
}

function record(value: DownloadedEvidenceV1): {
  readonly attestationBase64: string;
  readonly downloadedAt: string;
  readonly files: readonly { readonly bytesBase64: string; readonly path: string }[];
  readonly protocol: typeof PROTOCOL;
  readonly subject: { readonly path: string; readonly sha256: string };
} {
  const artifact = artifactFrom(value.artifact);
  if (
    !Buffer.isBuffer(value.attestationBytes) ||
    value.attestationBytes.length === 0 ||
    value.attestationBytes.length > ATTESTATION_LIMIT
  )
    fail("attestation");
  return {
    attestationBase64: Buffer.from(value.attestationBytes).toString("base64"),
    downloadedAt: timestamp(value.downloadedAt, "download time"),
    files: artifact.files.map((file) => ({
      bytesBase64: file.bytes.toString("base64"),
      path: file.path,
    })),
    protocol: PROTOCOL,
    subject: { path: artifact.subject.path, sha256: artifact.subject.sha256 },
  };
}

export function createAdminBaselineEvidenceCacheRecordV1(value: DownloadedEvidenceV1): Buffer {
  return canonicalStrictJsonBytesV1(record(value));
}

export function parseAdminBaselineEvidenceCacheRecordV1Json(value: unknown): DownloadedEvidenceV1 {
  if (isProxy(value) || (!Buffer.isBuffer(value) && !(value instanceof Uint8Array))) fail("bytes");
  const bytes = Buffer.from(value);
  if (bytes.length === 0 || bytes.length > CACHE_LIMIT) fail("bytes");
  let raw: Record<string, unknown>;
  try {
    raw = parseStrictJsonObjectV1(new TextDecoder("utf-8", { fatal: true }).decode(bytes), "cache");
  } catch {
    fail("bytes");
  }
  exact(raw, ["attestationBase64", "downloadedAt", "files", "protocol", "subject"], "fields");
  if (
    raw.protocol !== PROTOCOL ||
    !Array.isArray(raw.files) ||
    raw.files.length !== ADMIN_BASELINE_EVIDENCE_ARTIFACT_FILES_V1.length
  )
    fail("fields");
  const files = raw.files.map((value, index) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) fail("artifact file");
    const file = value as Record<string, unknown>;
    exact(file, ["bytesBase64", "path"], "artifact file");
    if (file.path !== ADMIN_BASELINE_EVIDENCE_ARTIFACT_FILES_V1[index]) fail("artifact file");
    return {
      bytes: base64(file.bytesBase64, "artifact file", ARTIFACT_FILE_LIMIT),
      path: file.path,
    };
  });
  if (files.reduce((sum, file) => sum + file.bytes.length, 0) > TOTAL_ARTIFACT_LIMIT)
    fail("artifact bounds");
  if (typeof raw.subject !== "object" || raw.subject === null || Array.isArray(raw.subject))
    fail("subject");
  const subject = raw.subject as Record<string, unknown>;
  exact(subject, ["path", "sha256"], "subject");
  const subjectBytes = files.at(-1)?.bytes;
  if (
    subject.path !== ADMIN_BASELINE_EVIDENCE_ARTIFACT_FILES_V1.at(-1) ||
    typeof subject.sha256 !== "string" ||
    !SHA256.test(subject.sha256) ||
    subjectBytes === undefined ||
    sha256(subjectBytes) !== subject.sha256
  )
    fail("subject");
  const result: DownloadedEvidenceV1 = {
    artifact: {
      files: files.map((file) => ({ bytes: Buffer.from(file.bytes), path: file.path as string })),
      subject: {
        bytes: Buffer.from(subjectBytes),
        path: BASELINE_EVIDENCE_ARTIFACT_SUMS_PATH_V1,
        sha256: subject.sha256,
      },
    },
    attestationBytes: base64(raw.attestationBase64, "attestation", ATTESTATION_LIMIT),
    downloadedAt: timestamp(raw.downloadedAt, "download time"),
  };
  if (canonicalStrictJsonBytesV1(record(result)).compare(bytes) !== 0) fail("noncanonical bytes");
  return result;
}

export function readAdminBaselineEvidenceCacheV1(
  root: string,
  bootstrap: AdminBaselineEvidenceBootstrapV1,
): DownloadedEvidenceV1 | undefined {
  const slot = adminBaselineEvidenceCacheSlotPathV1(root, bootstrap);
  const canonical = canonicalRoot(root);
  if (!safeCacheDirectory(canonical, dirname(slot), false)) fail("cache directory");
  try {
    const info = lstatSync(slot);
    if (info.isSymbolicLink() || !info.isFile()) fail("cache slot");
  } catch (error) {
    if (error instanceof AihError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    fail("cache slot");
  }
  const rootIdentity = directoryIdentity(canonical);
  const cacheIdentity = directoryIdentity(dirname(slot));
  if (rootIdentity === undefined || cacheIdentity === undefined) fail("cache directory");
  const bytes = readRegularFile(slot, { maxBytes: CACHE_LIMIT });
  if (bytes === undefined) fail("cache slot");
  if (!sameDirectory(canonical, rootIdentity) || !sameDirectory(dirname(slot), cacheIdentity))
    fail("cache changed");
  return parseAdminBaselineEvidenceCacheRecordV1Json(bytes);
}

export function commitAdminBaselineEvidenceCacheV1(
  root: string,
  bootstrap: AdminBaselineEvidenceBootstrapV1,
  evidence: DownloadedEvidenceV1,
): boolean {
  let temporary: string | undefined;
  let lockPath: string | undefined;
  let lockIdentity: FileIdentity | undefined;
  try {
    const canonical = canonicalRoot(root);
    const slot = adminBaselineEvidenceCacheSlotPathV1(canonical, bootstrap);
    const directory = dirname(slot);
    const bytes = createAdminBaselineEvidenceCacheRecordV1(evidence);
    if (!safeCacheDirectory(canonical, directory, true)) return false;
    const rootIdentity = directoryIdentity(canonical);
    const cacheIdentity = directoryIdentity(directory);
    if (rootIdentity === undefined || cacheIdentity === undefined) return false;
    lockPath = `${slot}.lock`;
    let lockDescriptor: number | undefined;
    try {
      lockDescriptor = openSync(lockPath, "wx", 0o600);
      const lockInfo = fstatSync(lockDescriptor);
      if (!lockInfo.isFile()) return false;
      lockIdentity = { dev: lockInfo.dev, ino: lockInfo.ino };
      const lockBytes = Buffer.from("AIH_ADMIN_BASELINE_EVIDENCE_CACHE_LOCK_V1\n");
      if (writeSync(lockDescriptor, lockBytes) !== lockBytes.length) return false;
    } finally {
      if (lockDescriptor !== undefined) closeSync(lockDescriptor);
    }
    chmodSync(lockPath, 0o600);
    try {
      const existing = lstatSync(slot);
      if (existing.isSymbolicLink() || !existing.isFile()) return false;
    } catch {
      // An absent slot is valid; the exclusive sidecar claim is already held.
    }
    temporary = join(directory, `.${randomBytes(12).toString("hex")}.tmp`);
    writeFileSync(temporary, bytes, { flag: "wx", mode: 0o600 });
    chmodSync(temporary, 0o600);
    if (
      !safeCacheDirectory(canonical, directory, false) ||
      !sameDirectory(canonical, rootIdentity) ||
      !sameDirectory(directory, cacheIdentity) ||
      !sameFile(lockPath, lockIdentity)
    )
      return false;
    try {
      const live = lstatSync(slot);
      if (live.isSymbolicLink() || !live.isFile()) return false;
    } catch {
      // Still absent: the held sidecar claim protects the replacement below.
    }
    renameSync(temporary, slot);
    temporary = undefined;
    if (!releaseLock(lockPath, lockIdentity)) return false;
    lockPath = undefined;
    lockIdentity = undefined;
    return true;
  } catch {
    return false;
  } finally {
    if (lockPath !== undefined && lockIdentity !== undefined) {
      try {
        releaseLock(lockPath, lockIdentity);
      } catch {
        // The successful/failed replacement result is already fixed above.
      }
    }
    if (temporary !== undefined) {
      try {
        rmSync(temporary, { force: true });
      } catch {
        // The successful/failed replacement result is already fixed above.
      }
    }
  }
}
