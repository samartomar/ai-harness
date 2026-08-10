import { createHash } from "node:crypto";
import {
  type BigIntStats,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { isProxy } from "node:util/types";
import { z } from "zod";
import { projectPromotedSkillArtifacts } from "../../../skill/promoted-artifacts.js";
import type { SkillPackageGraphDiagnostic } from "../../package-graph/adapters/skills.js";
import type { DeepReadonly } from "../../package-graph/build.js";
import type { CapabilityPackageResolution } from "../resolve.js";
import { resolveSkillPackAuthorityBindings, type SkillPackAuthorityBinding } from "./skill-pack.js";

export const INSTALLED_SKILL_PACK_LIMITS = Object.freeze({
  maxTrustLockBytes: 16 * 1024 * 1024,
  maxFileBytes: 8 * 1024 * 1024,
  maxTotalBytes: 128 * 1024 * 1024,
  maxFiles: 4_096,
  maxDepth: 64,
  maxInputNodes: 100_000,
});

export type InstalledSkillPackSnapshotErrorCode =
  | "invalid-input"
  | "authority-refused"
  | "invalid-trust-lock"
  | "missing-promotion"
  | "duplicate-promotion"
  | "source-mismatch"
  | "extra-promotion"
  | "artifact-refused"
  | "installed-artifact-mismatch"
  | "unsafe-installed-artifact";

const ERROR_MESSAGES: Record<InstalledSkillPackSnapshotErrorCode, string> = {
  "invalid-input": "installed skill pack input is invalid",
  "authority-refused": "skill pack authority binding was refused",
  "invalid-trust-lock": "promotion trust lock is invalid",
  "missing-promotion": "required skill promotion is missing",
  "duplicate-promotion": "skill promotion identity is ambiguous",
  "source-mismatch": "skill promotion source identity does not match",
  "extra-promotion": "promotion receipt contains undeclared skills",
  "artifact-refused": "promotion artifact routing was refused",
  "installed-artifact-mismatch": "installed skill artifacts do not match promotion receipt",
  "unsafe-installed-artifact": "installed skill artifact shape is unsafe",
};

export class InstalledSkillPackSnapshotError extends Error {
  readonly code: InstalledSkillPackSnapshotErrorCode;

  constructor(code: InstalledSkillPackSnapshotErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = "InstalledSkillPackSnapshotError";
    this.code = code;
  }
}

export interface InstalledSkillPackFile {
  memberId: string;
  path: string;
  sha256: string;
  mode: number;
  bytes: Buffer;
}

export interface InstalledSkillPackSnapshot {
  schemaVersion: 1;
  bindings: DeepReadonly<SkillPackAuthorityBinding[]>;
  files: readonly Readonly<InstalledSkillPackFile>[];
}

interface InstalledSkillPackInput {
  root: string;
  contextDir: string;
  resolution: DeepReadonly<CapabilityPackageResolution>;
  index: unknown;
  diagnostics: readonly SkillPackageGraphDiagnostic[];
  trustLockBytes: Buffer;
}

const SHA1 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_RELATIVE = /^(?!\/)(?!.*\\)(?!.*:)(?!.*[\p{Cc}\p{Cf}\u2028\u2029])/u;
const INPUT_KEYS = new Set([
  "root",
  "contextDir",
  "resolution",
  "index",
  "diagnostics",
  "trustLockBytes",
]);

const FindingLocationSchema = z
  .object({
    uri: z.string().min(1).max(2_048),
    startLine: z.number().int().positive().optional(),
  })
  .strict();

const FindingSchema = z
  .object({
    name: z.string().min(1).max(512),
    verdict: z.string().min(1).max(80),
    code: z.string().min(1).max(160).optional(),
    detail: z.string().max(8_192).optional(),
    location: FindingLocationSchema.optional(),
    fingerprint: z.string().min(1).max(512).optional(),
  })
  .strict();

const ArtifactSchema = z
  .object({
    path: z.string().min(1).max(2_048),
    sha256: z.string().regex(SHA256),
  })
  .strict();

const TrustSourceSchema = z
  .object({
    id: z.string().min(1).max(512),
    kind: z.enum(["local", "github"]),
    source: z.string().min(1).max(2_048),
    ref: z.string().min(1).max(1_024).optional(),
    pinnedSha: z.string().regex(SHA1).optional(),
    promotedAt: z.string().min(1).max(80),
    promotedSkills: z.array(z.string().min(1).max(1_024)).max(4_096),
    analyzersRun: z.array(z.string().min(1).max(1_024)).max(4_096),
    artifactHashes: z.array(ArtifactSchema).max(INSTALLED_SKILL_PACK_LIMITS.maxFiles),
    findings: z.array(FindingSchema).max(16_384),
  })
  .strict();

const TrustLockSchema = z
  .object({
    schemaVersion: z.literal(1),
    sources: z.array(TrustSourceSchema).max(4_096),
  })
  .strict();

type StrictTrustSource = z.infer<typeof TrustSourceSchema>;

function fail(code: InstalledSkillPackSnapshotErrorCode): never {
  throw new InstalledSkillPackSnapshotError(code);
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validRelativePath(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 2_048 &&
    SAFE_RELATIVE.test(value) &&
    value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
  );
}

function guardedClone(input: unknown): unknown {
  let nodes = 0;
  const active = new Set<object>();
  const clone = (value: unknown, depth: number): unknown => {
    nodes += 1;
    if (nodes > INSTALLED_SKILL_PACK_LIMITS.maxInputNodes || depth > 64) fail("invalid-input");
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "boolean" ||
      value === undefined
    ) {
      return value;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value) || Object.is(value, -0)) fail("invalid-input");
      return value;
    }
    if (typeof value !== "object" || isProxy(value) || active.has(value)) fail("invalid-input");
    if (Buffer.isBuffer(value)) {
      if (
        Object.getPrototypeOf(value) !== Buffer.prototype ||
        value.byteLength > INSTALLED_SKILL_PACK_LIMITS.maxTrustLockBytes
      ) {
        fail("invalid-input");
      }
      return Buffer.from(value);
    }
    active.add(value);
    try {
      if (Array.isArray(value)) {
        if (
          Object.getPrototypeOf(value) !== Array.prototype ||
          Object.getOwnPropertySymbols(value).length !== 0 ||
          Object.getOwnPropertyNames(value).length !== value.length + 1
        ) {
          fail("invalid-input");
        }
        const out: unknown[] = [];
        for (let index = 0; index < value.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
          if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
            fail("invalid-input");
          }
          out.push(clone(descriptor.value, depth + 1));
        }
        return out;
      }
      const prototype = Object.getPrototypeOf(value);
      if (
        (prototype !== Object.prototype && prototype !== null) ||
        Object.getOwnPropertySymbols(value).length !== 0
      ) {
        fail("invalid-input");
      }
      const out = Object.create(null) as Record<string, unknown>;
      for (const key of Object.getOwnPropertyNames(value).sort(compareCodeUnits)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (descriptor === undefined || !descriptor.enumerable || !("value" in descriptor)) {
          fail("invalid-input");
        }
        out[key] = clone(descriptor.value, depth + 1);
      }
      return out;
    } finally {
      active.delete(value);
    }
  };
  return clone(input, 0);
}

function snapshotInput(input: unknown): InstalledSkillPackInput {
  const cloned = guardedClone(input);
  if (
    cloned === null ||
    typeof cloned !== "object" ||
    Array.isArray(cloned) ||
    Object.keys(cloned).length !== INPUT_KEYS.size ||
    Object.keys(cloned).some((key) => !INPUT_KEYS.has(key))
  ) {
    fail("invalid-input");
  }
  const candidate = cloned as Record<string, unknown>;
  if (
    typeof candidate.root !== "string" ||
    !isAbsolute(candidate.root) ||
    typeof candidate.contextDir !== "string" ||
    !validRelativePath(candidate.contextDir) ||
    !Buffer.isBuffer(candidate.trustLockBytes)
  ) {
    fail("invalid-input");
  }
  return candidate as unknown as InstalledSkillPackInput;
}

function strictTrustLock(bytes: Buffer): StrictTrustSource[] {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail("invalid-trust-lock");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch {
    fail("invalid-trust-lock");
  }
  const parsed = TrustLockSchema.safeParse(raw);
  if (!parsed.success) fail("invalid-trust-lock");
  const ids = parsed.data.sources.map(({ id }) => id);
  if (
    new Set(ids).size !== ids.length ||
    new Set(ids.map((id) => id.toLowerCase())).size !== ids.length
  ) {
    fail("duplicate-promotion");
  }
  for (const source of parsed.data.sources) {
    const skills = source.promotedSkills;
    const paths = source.artifactHashes.map(({ path }) => path);
    if (
      skills.length === 0 ||
      paths.length === 0 ||
      new Set(skills).size !== skills.length ||
      new Set(skills.map((skill) => skill.toLowerCase())).size !== skills.length ||
      new Set(paths).size !== paths.length ||
      new Set(paths.map((path) => path.toLowerCase())).size !== paths.length
    ) {
      fail("invalid-trust-lock");
    }
  }
  return parsed.data.sources;
}

function canonicalRoot(root: string): string {
  try {
    const stats = lstatSync(root);
    if (stats.isSymbolicLink() || !stats.isDirectory()) fail("invalid-input");
    return realpathSync(root);
  } catch (error) {
    if (error instanceof InstalledSkillPackSnapshotError) throw error;
    fail("invalid-input");
  }
}

function assertContained(root: string, path: string): void {
  const rel = relative(root, path);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return;
  fail("unsafe-installed-artifact");
}

function sameIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.ino !== 0n && right.ino !== 0n && left.dev === right.dev && left.ino === right.ino;
}

function currentIdentity(root: string, path: string, opened: BigIntStats): void {
  let resolved: string;
  try {
    resolved = realpathSync(path);
  } catch {
    fail("installed-artifact-mismatch");
  }
  assertContained(root, resolved);
  let current: BigIntStats;
  try {
    current = lstatSync(resolved, { bigint: true });
  } catch {
    fail("unsafe-installed-artifact");
  }
  if (!current.isFile() || current.nlink !== 1n || !sameIdentity(opened, current)) {
    fail("unsafe-installed-artifact");
  }
}

function readInstalledFile(root: string, relPath: string): { bytes: Buffer; mode: number } {
  const lexical = join(root, ...relPath.split("/"));
  let entry: BigIntStats;
  try {
    entry = lstatSync(lexical, { bigint: true });
  } catch {
    fail("installed-artifact-mismatch");
  }
  if (
    entry.isSymbolicLink() ||
    !entry.isFile() ||
    entry.nlink !== 1n ||
    entry.ino === 0n ||
    entry.size > BigInt(INSTALLED_SKILL_PACK_LIMITS.maxFileBytes)
  ) {
    fail("unsafe-installed-artifact");
  }
  let resolved: string;
  try {
    resolved = realpathSync(lexical);
  } catch {
    fail("installed-artifact-mismatch");
  }
  assertContained(root, resolved);
  let descriptor: number;
  try {
    descriptor = openSync(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    fail("unsafe-installed-artifact");
  }
  try {
    let opened: BigIntStats;
    try {
      opened = fstatSync(descriptor, { bigint: true });
    } catch {
      fail("unsafe-installed-artifact");
    }
    if (
      !opened.isFile() ||
      opened.nlink !== 1n ||
      opened.size > BigInt(INSTALLED_SKILL_PACK_LIMITS.maxFileBytes) ||
      !sameIdentity(entry, opened)
    ) {
      fail("unsafe-installed-artifact");
    }
    currentIdentity(root, lexical, opened);
    const bytes = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < bytes.byteLength) {
      let read: number;
      try {
        read = readSync(descriptor, bytes, offset, bytes.byteLength - offset, offset);
      } catch {
        fail("unsafe-installed-artifact");
      }
      if (read === 0) fail("unsafe-installed-artifact");
      offset += read;
    }
    let after: BigIntStats;
    try {
      after = fstatSync(descriptor, { bigint: true });
    } catch {
      fail("unsafe-installed-artifact");
    }
    if (
      !sameIdentity(opened, after) ||
      opened.size !== after.size ||
      opened.nlink !== after.nlink ||
      opened.mtimeNs !== after.mtimeNs
    ) {
      fail("unsafe-installed-artifact");
    }
    currentIdentity(root, lexical, opened);
    return { bytes, mode: Number(opened.mode & 0o777n) };
  } finally {
    try {
      closeSync(descriptor);
    } catch {
      fail("unsafe-installed-artifact");
    }
  }
}

function assertSafeDirectoryPath(root: string, relPath: string): string {
  let current = root;
  for (const segment of relPath.split("/")) {
    current = join(current, segment);
    let stats: BigIntStats;
    try {
      stats = lstatSync(current, { bigint: true });
    } catch {
      fail("installed-artifact-mismatch");
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) fail("unsafe-installed-artifact");
  }
  let resolved: string;
  try {
    resolved = realpathSync(current);
  } catch {
    fail("unsafe-installed-artifact");
  }
  assertContained(root, resolved);
  return resolved;
}

interface InstalledDirectorySnapshot {
  rel: string;
  dev: bigint;
  ino: bigint;
  entries: readonly string[];
}

interface InstalledMemberScan {
  files: readonly string[];
  directories: readonly InstalledDirectorySnapshot[];
}

function scanInstalledMember(
  root: string,
  memberRoot: string,
  state: { nodes: number },
): InstalledMemberScan {
  const lexicalRoot = assertSafeDirectoryPath(root, memberRoot);
  let rootStats: BigIntStats;
  try {
    rootStats = lstatSync(lexicalRoot, { bigint: true });
  } catch {
    fail("installed-artifact-mismatch");
  }
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory()) fail("unsafe-installed-artifact");
  const pending: Array<{ path: string; rel: string; depth: number }> = [
    { path: lexicalRoot, rel: memberRoot, depth: 0 },
  ];
  const files: string[] = [];
  const directories: InstalledDirectorySnapshot[] = [];
  const folded = new Set<string>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    if (current.depth > INSTALLED_SKILL_PACK_LIMITS.maxDepth) {
      fail("unsafe-installed-artifact");
    }
    let beforeDirectory: string;
    try {
      beforeDirectory = realpathSync(current.path);
    } catch {
      fail("unsafe-installed-artifact");
    }
    assertContained(root, beforeDirectory);
    let entries: string[];
    try {
      entries = readdirSync(current.path).sort(compareCodeUnits);
    } catch {
      fail("unsafe-installed-artifact");
    }
    let afterDirectory: string;
    try {
      afterDirectory = realpathSync(current.path);
    } catch {
      fail("unsafe-installed-artifact");
    }
    assertContained(root, afterDirectory);
    if (afterDirectory !== beforeDirectory) fail("unsafe-installed-artifact");
    let directoryStats: BigIntStats;
    try {
      directoryStats = lstatSync(afterDirectory, { bigint: true });
    } catch {
      fail("unsafe-installed-artifact");
    }
    if (
      !directoryStats.isDirectory() ||
      directoryStats.isSymbolicLink() ||
      directoryStats.ino === 0n
    ) {
      fail("unsafe-installed-artifact");
    }
    directories.push({
      rel: current.rel,
      dev: directoryStats.dev,
      ino: directoryStats.ino,
      entries: [...entries],
    });
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      state.nodes += 1;
      if (state.nodes > INSTALLED_SKILL_PACK_LIMITS.maxFiles) {
        fail("unsafe-installed-artifact");
      }
      const name = entries[index] as string;
      const path = join(current.path, name);
      const rel = `${current.rel}/${name}`;
      if (!validRelativePath(rel)) fail("unsafe-installed-artifact");
      const key = rel.toLowerCase();
      if (folded.has(key)) fail("unsafe-installed-artifact");
      folded.add(key);
      let stats: BigIntStats;
      try {
        stats = lstatSync(path, { bigint: true });
      } catch {
        fail("unsafe-installed-artifact");
      }
      if (stats.isSymbolicLink()) fail("unsafe-installed-artifact");
      let resolved: string;
      try {
        resolved = realpathSync(path);
      } catch {
        fail("unsafe-installed-artifact");
      }
      assertContained(root, resolved);
      if (stats.isDirectory()) {
        pending.push({ path: resolved, rel, depth: current.depth + 1 });
      } else if (
        stats.isFile() &&
        stats.nlink === 1n &&
        stats.ino !== 0n &&
        stats.size <= BigInt(INSTALLED_SKILL_PACK_LIMITS.maxFileBytes)
      ) {
        files.push(rel);
        if (files.length > INSTALLED_SKILL_PACK_LIMITS.maxFiles) {
          fail("unsafe-installed-artifact");
        }
      } else {
        fail("unsafe-installed-artifact");
      }
    }
  }
  return {
    files: files.sort(compareCodeUnits),
    directories: directories.sort((left, right) => compareCodeUnits(left.rel, right.rel)),
  };
}

function sameMemberScan(left: InstalledMemberScan, right: InstalledMemberScan): boolean {
  if (
    left.files.length !== right.files.length ||
    left.directories.length !== right.directories.length
  ) {
    return false;
  }
  if (left.files.some((path, index) => path !== right.files[index])) return false;
  return left.directories.every((directory, index) => {
    const other = right.directories[index];
    return (
      other !== undefined &&
      directory.rel === other.rel &&
      directory.dev === other.dev &&
      directory.ino === other.ino &&
      directory.entries.length === other.entries.length &&
      directory.entries.every((entry, entryIndex) => entry === other.entries[entryIndex])
    );
  });
}

function installedFile(
  identity: Omit<InstalledSkillPackFile, "bytes">,
  sourceBytes: Buffer,
): InstalledSkillPackFile {
  const snapshot = Buffer.from(sourceBytes);
  return Object.freeze({
    ...identity,
    get bytes(): Buffer {
      return Buffer.from(snapshot);
    },
  });
}

function deepFreeze<T>(value: T): DeepReadonly<T> {
  if (Buffer.isBuffer(value)) return value as DeepReadonly<T>;
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor !== undefined && "value" in descriptor) deepFreeze(descriptor.value);
    }
    Object.freeze(value);
  }
  return value as DeepReadonly<T>;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Prove current repo-local skill-pack bytes against exact authority and promotion receipts.
 * This is a read-only snapshot and makes no ownership or installation mutation claim.
 */
export function resolveInstalledSkillPackSnapshot(
  input: unknown,
): DeepReadonly<InstalledSkillPackSnapshot> {
  const snapshot = snapshotInput(input);
  let bindings: DeepReadonly<SkillPackAuthorityBinding[]>;
  try {
    bindings = resolveSkillPackAuthorityBindings({
      resolution: snapshot.resolution,
      index: snapshot.index as never,
      diagnostics: snapshot.diagnostics,
    });
  } catch {
    fail("authority-refused");
  }
  const trustSources = strictTrustLock(snapshot.trustLockBytes);
  const expectedMembers = bindings
    .flatMap(({ members }) => members)
    .sort((left, right) => compareCodeUnits(left.id, right.id));
  const memberIds = expectedMembers.map(({ id }) => id);
  if (new Set(memberIds).size !== memberIds.length) fail("authority-refused");

  const sourceByMember = new Map<string, StrictTrustSource>();
  for (const member of expectedMembers) {
    if (
      member.source.provider !== "github" ||
      member.sourceDigest.algorithm !== "git-sha1" ||
      !SHA1.test(member.sourceDigest.value)
    ) {
      fail("source-mismatch");
    }
    const skill = member.id.slice("skill:".length);
    const containing = trustSources.filter(({ promotedSkills }) => promotedSkills.includes(skill));
    if (containing.length === 0) fail("missing-promotion");
    if (containing.length !== 1) fail("duplicate-promotion");
    const source = containing[0] as StrictTrustSource;
    if (
      source.kind !== "github" ||
      source.source.toLowerCase() !== member.source.repository.toLowerCase() ||
      source.pinnedSha !== member.sourceDigest.value
    ) {
      fail("source-mismatch");
    }
    sourceByMember.set(member.id, source);
  }

  const expectedSkillsBySource = new Map<string, Set<string>>();
  for (const [memberId, source] of sourceByMember) {
    const skills = expectedSkillsBySource.get(source.id) ?? new Set<string>();
    skills.add(memberId.slice("skill:".length));
    expectedSkillsBySource.set(source.id, skills);
  }
  for (const source of new Set(sourceByMember.values())) {
    const expected = expectedSkillsBySource.get(source.id) ?? new Set<string>();
    if (
      source.promotedSkills.length !== expected.size ||
      source.promotedSkills.some((skill) => !expected.has(skill))
    ) {
      fail("extra-promotion");
    }
  }

  const root = canonicalRoot(snapshot.root);
  const projected: Array<{
    memberId: string;
    path: string;
    sha256: string;
    sourceId: string;
    skill: string;
  }> = [];
  for (const source of new Set(sourceByMember.values())) {
    const projection = projectPromotedSkillArtifacts(snapshot.contextDir, source);
    if (projection.status === "refused") fail("artifact-refused");
    for (const target of projection.targets) {
      const memberId = `skill:${target.skill}`;
      if (!sourceByMember.has(memberId)) fail("extra-promotion");
      projected.push({
        memberId,
        path: target.targetPath,
        sha256: target.sha256,
        sourceId: source.id,
        skill: target.skill,
      });
    }
  }
  projected.sort(
    (left, right) =>
      compareCodeUnits(left.path, right.path) || compareCodeUnits(left.memberId, right.memberId),
  );
  if (
    projected.length === 0 ||
    projected.length > INSTALLED_SKILL_PACK_LIMITS.maxFiles ||
    new Set(projected.map(({ path }) => path.toLowerCase())).size !== projected.length
  ) {
    fail("artifact-refused");
  }
  for (const memberId of memberIds) {
    if (
      !projected.some((target) => target.memberId === memberId && target.path.endsWith("/SKILL.md"))
    ) {
      fail("artifact-refused");
    }
  }

  const expectedPaths = new Set(projected.map(({ path }) => path));
  const memberRoots = new Set(
    projected.map(({ sourceId, skill }) => `${snapshot.contextDir}/skills/${sourceId}/${skill}`),
  );
  const initialScans = new Map<string, InstalledMemberScan>();
  const scanState = { nodes: 0 };
  for (const memberRoot of [...memberRoots].sort(compareCodeUnits)) {
    const scan = scanInstalledMember(root, memberRoot, scanState);
    initialScans.set(memberRoot, scan);
    for (const path of scan.files) {
      if (!expectedPaths.has(path)) fail("installed-artifact-mismatch");
    }
  }

  let totalBytes = 0;
  const files: InstalledSkillPackFile[] = projected.map((target) => {
    const installed = readInstalledFile(root, target.path);
    totalBytes += installed.bytes.byteLength;
    if (totalBytes > INSTALLED_SKILL_PACK_LIMITS.maxTotalBytes) {
      fail("unsafe-installed-artifact");
    }
    if (sha256(installed.bytes) !== target.sha256) fail("installed-artifact-mismatch");
    return installedFile(
      {
        memberId: target.memberId,
        path: target.path,
        sha256: target.sha256,
        mode: installed.mode,
      },
      installed.bytes,
    );
  });
  const verificationState = { nodes: 0 };
  for (const memberRoot of [...memberRoots].sort(compareCodeUnits)) {
    const initial = initialScans.get(memberRoot);
    const current = scanInstalledMember(root, memberRoot, verificationState);
    if (initial === undefined || !sameMemberScan(initial, current)) {
      fail("installed-artifact-mismatch");
    }
  }
  let verificationBytes = 0;
  for (let index = 0; index < projected.length; index += 1) {
    const target = projected[index];
    const snapshotFile = files[index];
    if (target === undefined || snapshotFile === undefined) fail("installed-artifact-mismatch");
    const current = readInstalledFile(root, target.path);
    verificationBytes += current.bytes.byteLength;
    if (
      verificationBytes > INSTALLED_SKILL_PACK_LIMITS.maxTotalBytes ||
      current.mode !== snapshotFile.mode ||
      sha256(current.bytes) !== target.sha256 ||
      !current.bytes.equals(snapshotFile.bytes)
    ) {
      fail("installed-artifact-mismatch");
    }
  }
  const output: InstalledSkillPackSnapshot = {
    schemaVersion: 1,
    bindings: structuredClone(bindings),
    files,
  };
  return deepFreeze(output);
}
