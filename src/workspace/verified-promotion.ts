export interface VerifiedPromotionSource {
  id: string;
  kind: "github";
  repository: string;
  ref: string;
  pinnedSha: string;
}

export interface VerifiedPromotionFile {
  sourceRel: string;
  targetRel: string;
  contents: Buffer;
  sha256: string;
}

export type VerifiedPromotionTrustLockPreimage =
  | { state: "absent" }
  | { state: "present"; sourceBytes: Buffer; sourceSha256: string; mode?: number };

export interface VerifiedPromotionAuthorityPreimage {
  sourceBytes: Buffer;
  sourceSha256: string;
  mode?: number;
}

export interface VerifiedPromotionSnapshot {
  source: VerifiedPromotionSource;
  selectedSkills: string[];
  files: VerifiedPromotionFile[];
  artifactHashes: Array<{ path: string; sha256: string }>;
  nextTrustLockBytes: Buffer;
  trustLockPreimage: VerifiedPromotionTrustLockPreimage;
  approvalLockPreimage: VerifiedPromotionAuthorityPreimage;
}

declare const verifiedPromotionHandleBrand: unique symbol;
export interface VerifiedPromotionHandle {
  readonly [verifiedPromotionHandleBrand]: never;
}

const SHA256 = /^[0-9a-f]{64}$/;
const SHA1 = /^[0-9a-f]{40}$/;
const REPOSITORY = /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/;
const SAFE_PATH = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const MAX_BYTES = 128 * 1024 * 1024;

function invalid(): never {
  throw new Error("invalid verified promotion snapshot");
}

function dataRecord(
  value: unknown,
  keys: readonly string[],
  optionalKeys: readonly string[] = [],
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || isProxy(value) || Array.isArray(value))
    invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid();
  if (Object.getOwnPropertySymbols(value).length !== 0) invalid();
  const names = Object.getOwnPropertyNames(value);
  const allowedKeys = [...keys, ...optionalKeys];
  if (keys.some((key) => !names.includes(key)) || names.some((name) => !allowedKeys.includes(name)))
    invalid();
  const out = Object.create(null) as Record<string, unknown>;
  for (const key of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) invalid();
    out[key] = descriptor.value;
  }
  return out;
}

function denseArray(value: unknown, max: number): unknown[] {
  if (typeof value !== "object" || value === null || isProxy(value) || !Array.isArray(value))
    invalid();
  if (Object.getPrototypeOf(value) !== Array.prototype || value.length > max) invalid();
  const names = Object.getOwnPropertyNames(value);
  if (Object.getOwnPropertySymbols(value).length !== 0 || names.length !== value.length + 1)
    invalid();
  const out: unknown[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) invalid();
    out.push(descriptor.value);
  }
  return out;
}

function text(value: unknown, pattern?: RegExp): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) invalid();
  if (pattern !== undefined && !pattern.test(value)) invalid();
  return value;
}

function path(value: unknown): string {
  const result = text(value, SAFE_PATH);
  if (
    result.includes(":") ||
    result.includes("//") ||
    result.split("/").some((part) => part.length === 0 || part === "." || part === "..")
  )
    invalid();
  return result;
}

function bytes(value: unknown): Buffer {
  if (
    typeof value !== "object" ||
    value === null ||
    isProxy(value) ||
    !Buffer.isBuffer(value) ||
    Object.getPrototypeOf(value) !== Buffer.prototype
  )
    invalid();
  if (value.byteLength > MAX_BYTES) invalid();
  return Buffer.from(value);
}

function digest(value: unknown): string {
  return text(value, SHA256);
}

function mode(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 0o777) invalid();
  return value as number;
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function copySnapshot(input: unknown): VerifiedPromotionSnapshot {
  const snapshot = dataRecord(input, [
    "source",
    "selectedSkills",
    "files",
    "artifactHashes",
    "nextTrustLockBytes",
    "trustLockPreimage",
    "approvalLockPreimage",
  ]);
  const source = dataRecord(snapshot.source, ["id", "kind", "repository", "ref", "pinnedSha"]);
  if (source.kind !== "github") invalid();
  const selectedSkills = denseArray(snapshot.selectedSkills, 4096).map(path);
  if (selectedSkills.length === 0 || new Set(selectedSkills).size !== selectedSkills.length)
    invalid();
  const files = denseArray(snapshot.files, 4096).map((entry): VerifiedPromotionFile => {
    const file = dataRecord(entry, ["sourceRel", "targetRel", "contents", "sha256"]);
    const contents = bytes(file.contents);
    const expected = digest(file.sha256);
    if (sha256(contents) !== expected) invalid();
    return {
      sourceRel: path(file.sourceRel),
      targetRel: path(file.targetRel),
      contents,
      sha256: expected,
    };
  });
  const artifactHashes = denseArray(snapshot.artifactHashes, 4096).map((entry) => {
    const artifact = dataRecord(entry, ["path", "sha256"]);
    return { path: path(artifact.path), sha256: digest(artifact.sha256) };
  });
  if (
    files.length !== artifactHashes.length ||
    files.some(
      (file, index) =>
        file.sourceRel !== artifactHashes[index]?.path ||
        file.sha256 !== artifactHashes[index]?.sha256,
    )
  )
    invalid();
  const selectedRoutes = selectedSkills.map((name) => `/${source.id}/${name}/`);
  if (
    selectedRoutes.some((route) => !files.some(({ targetRel }) => targetRel.includes(route))) ||
    files.some(({ targetRel }) => !selectedRoutes.some((route) => targetRel.includes(route)))
  )
    invalid();
  const nextTrustLockBytes = bytes(snapshot.nextTrustLockBytes);
  const trustValue = snapshot.trustLockPreimage;
  if (
    typeof trustValue !== "object" ||
    trustValue === null ||
    isProxy(trustValue) ||
    Array.isArray(trustValue)
  )
    invalid();
  const stateDescriptor = Object.getOwnPropertyDescriptor(trustValue, "state");
  if (stateDescriptor === undefined || !("value" in stateDescriptor) || !stateDescriptor.enumerable)
    invalid();
  const trust = dataRecord(
    trustValue,
    stateDescriptor.value === "absent" ? ["state"] : ["state", "sourceBytes", "sourceSha256"],
    stateDescriptor.value === "absent" ? [] : ["mode"],
  );
  let trustLockPreimage: VerifiedPromotionTrustLockPreimage;
  if (trust.state === "absent") {
    trustLockPreimage = { state: "absent" };
  } else {
    if (trust.state !== "present") invalid();
    const sourceBytes = bytes(trust.sourceBytes);
    const sourceSha256 = digest(trust.sourceSha256);
    if (sha256(sourceBytes) !== sourceSha256) invalid();
    trustLockPreimage = { state: "present", sourceBytes, sourceSha256, mode: mode(trust.mode) };
  }
  const approval = dataRecord(
    snapshot.approvalLockPreimage,
    ["sourceBytes", "sourceSha256"],
    ["mode"],
  );
  const approvalBytes = bytes(approval.sourceBytes);
  const approvalSha = digest(approval.sourceSha256);
  if (sha256(approvalBytes) !== approvalSha) invalid();
  let nextLock: unknown;
  try {
    nextLock = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(nextTrustLockBytes));
  } catch {
    invalid();
  }
  if (typeof nextLock !== "object" || nextLock === null || Array.isArray(nextLock)) invalid();
  const nextSources = (nextLock as { sources?: unknown }).sources;
  if (!Array.isArray(nextSources)) invalid();
  const matching = nextSources.filter(
    (entry): entry is Record<string, unknown> =>
      typeof entry === "object" &&
      entry !== null &&
      !Array.isArray(entry) &&
      (entry as { id?: unknown }).id === source.id,
  );
  if (matching.length !== 1) invalid();
  const nextSource = matching[0] as Record<string, unknown>;
  const nextSkills = nextSource.promotedSkills;
  const nextArtifacts = nextSource.artifactHashes;
  if (
    nextSource.kind !== "github" ||
    typeof nextSource.source !== "string" ||
    nextSource.source.toLowerCase() !== source.repository ||
    nextSource.ref !== source.ref ||
    nextSource.pinnedSha !== source.pinnedSha ||
    !Array.isArray(nextSkills) ||
    nextSkills.length !== selectedSkills.length ||
    selectedSkills.some((name, index) => name !== nextSkills[index]) ||
    !Array.isArray(nextArtifacts) ||
    nextArtifacts.length !== artifactHashes.length ||
    artifactHashes.some((artifact, index) => {
      const candidate = nextArtifacts[index] as Record<string, unknown> | undefined;
      return candidate?.path !== artifact.path || candidate.sha256 !== artifact.sha256;
    })
  )
    invalid();
  return {
    source: {
      id: path(source.id),
      kind: "github",
      repository: text(source.repository, REPOSITORY),
      ref: text(source.ref),
      pinnedSha: text(source.pinnedSha, SHA1),
    },
    selectedSkills,
    files,
    artifactHashes,
    nextTrustLockBytes,
    trustLockPreimage,
    approvalLockPreimage: {
      sourceBytes: approvalBytes,
      sourceSha256: approvalSha,
      mode: mode(approval.mode),
    },
  };
}

function freezeSnapshot(snapshot: VerifiedPromotionSnapshot): VerifiedPromotionSnapshot {
  Object.freeze(snapshot.source);
  Object.freeze(snapshot.selectedSkills);
  for (const file of snapshot.files) Object.freeze(file);
  Object.freeze(snapshot.files);
  for (const artifact of snapshot.artifactHashes) Object.freeze(artifact);
  Object.freeze(snapshot.artifactHashes);
  Object.freeze(snapshot.trustLockPreimage);
  Object.freeze(snapshot.approvalLockPreimage);
  return Object.freeze(snapshot);
}

export interface VerifiedPromotionChannel {
  issue(snapshot: unknown): VerifiedPromotionHandle;
  read(candidate: unknown): VerifiedPromotionSnapshot | undefined;
}

export function createVerifiedPromotionChannel(): VerifiedPromotionChannel {
  const issued = new WeakMap<object, VerifiedPromotionSnapshot>();
  return Object.freeze({
    issue(snapshot: unknown): VerifiedPromotionHandle {
      const handle = Object.freeze(Object.create(null)) as VerifiedPromotionHandle;
      issued.set(handle, freezeSnapshot(copySnapshot(snapshot)));
      return handle;
    },
    read(candidate: unknown): VerifiedPromotionSnapshot | undefined {
      if (
        (typeof candidate !== "object" && typeof candidate !== "function") ||
        candidate === null
      ) {
        return undefined;
      }
      const snapshot = issued.get(candidate);
      return snapshot === undefined ? undefined : freezeSnapshot(copySnapshot(snapshot));
    },
  });
}

import { createHash } from "node:crypto";
import { isProxy } from "node:util/types";
