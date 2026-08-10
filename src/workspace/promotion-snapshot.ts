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
import { basename, extname, join, posix } from "node:path";
import { isProxy } from "node:util/types";
import { AihError } from "../errors.js";
import type { Check } from "../internals/verify.js";
import { readTrustFetchMetadata, safeSourceRelative, type TrustSource } from "../trust/fetch.js";
import { parseTrustLockSource, type TrustLock, type TrustLockSource } from "../trust/lock.js";

const SKIP_DIRS = new Set([".git", ".hg", ".svn", ".aih", "coverage", "dist", "node_modules"]);
const TEXT_PROMOTION_EXTENSIONS = new Set(["", ".md", ".txt", ".json", ".yaml", ".yml", ".toml"]);
const SAFE_SEGMENT = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const LOWER_SHA = /^[0-9a-f]{40}$/;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const UNSAFE_TEXT = /[\p{Cc}\p{Cf}\u2028\u2029]/u;
const INPUT_KEYS = new Set([
  "contextDir",
  "source",
  "sourceBinding",
  "selectedSkills",
  "workingTrustLock",
  "promotedAt",
  "analyzersRun",
  "findings",
]);
const REQUIRED_INPUT_KEYS = [...INPUT_KEYS].filter((key) => key !== "selectedSkills");

export const PROMOTION_SNAPSHOT_LIMITS = Object.freeze({
  maxDepth: 64,
  maxFiles: 4_096,
  maxFileBytes: 8 * 1024 * 1024,
  maxTotalBytes: 128 * 1024 * 1024,
  maxInputNodes: 100_000,
});

export interface PromotionSnapshotSourceBinding {
  id: string;
  kind: "local" | "github";
  source: string;
  ref?: string;
  pinnedSha?: string;
}

export interface SkillPromotionSnapshotInput {
  contextDir: string;
  source: TrustSource;
  sourceBinding: PromotionSnapshotSourceBinding;
  selectedSkills?: ReadonlySet<string>;
  workingTrustLock: TrustLock;
  promotedAt: string;
  analyzersRun: readonly string[];
  findings: readonly Check[];
}

export interface SkillPromotionSnapshotFile {
  sourceRel: string;
  targetRel: string;
  contents: Buffer;
  sha256: string;
}

export interface SkillPromotionSnapshot {
  files: SkillPromotionSnapshotFile[];
  promotedSkills: string[];
  artifactHashes: Array<{ path: string; sha256: string }>;
  nextTrustLock: TrustLock;
  nextTrustLockBytes: Buffer;
}

export interface SkillPromotionSnapshotDeps {
  beforeFileRead?: (path: string) => void;
  afterFileResolve?: (path: string) => void;
}

interface SourceTreeSnapshot {
  skillDirs: string[];
  files: string[];
}

class PromotionSnapshotRefusal extends AihError {
  constructor(message: string) {
    super(message, "AIH_TRUST");
  }
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function refuse(message: string): never {
  throw new PromotionSnapshotRefusal(message);
}

function safeText(value: string): string {
  return [...value]
    .slice(0, 256)
    .join("")
    .replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, "?");
}

function validRelativePath(value: string): boolean {
  if (
    value.length === 0 ||
    value.includes("\\") ||
    value.includes(":") ||
    UNSAFE_TEXT.test(value)
  ) {
    return false;
  }
  return value
    .split("/")
    .every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

function sourceRoot(source: TrustSource): string {
  const candidate = source.kind === "local" ? source.root : source.treePath;
  const rootStats = lstatSync(candidate);
  if (rootStats.isSymbolicLink()) refuse("refusing symbolic-link trust source root");
  const root = realpathSync(candidate);
  if (!lstatSync(root).isDirectory()) refuse("trust source is not a directory");
  return root;
}

function snapshotTree(root: string): SourceTreeSnapshot {
  const skillDirs: string[] = [];
  const files: string[] = [];
  let totalBytes = 0;
  const recordFile = (path: string, size: number): void => {
    if (
      size > PROMOTION_SNAPSHOT_LIMITS.maxFileBytes ||
      files.length >= PROMOTION_SNAPSHOT_LIMITS.maxFiles ||
      totalBytes + size > PROMOTION_SNAPSHOT_LIMITS.maxTotalBytes
    ) {
      refuse("promotion source exceeds limits");
    }
    totalBytes += size;
    files.push(path);
  };
  const pending: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) break;
    const { path, depth } = current;
    if (depth > PROMOTION_SNAPSHOT_LIMITS.maxDepth) {
      refuse("promotion source exceeds limits");
    }
    const stats = lstatSync(path);
    if (stats.isSymbolicLink()) {
      const resolved = realpathSync(path);
      safeSourceRelative(root, resolved);
      const target = lstatSync(resolved);
      if (!target.isFile() || target.nlink > 1) {
        refuse("refusing unsafe symbolic-link promotion source entry");
      }
      recordFile(path, target.size);
      continue;
    }
    if (stats.isFile()) {
      if (stats.nlink > 1) refuse("refusing hard-linked promotion source entry");
      recordFile(path, stats.size);
      continue;
    }
    if (!stats.isDirectory()) refuse("refusing unsafe promotion source entry");
    if (path !== root && SKIP_DIRS.has(basename(path))) continue;
    const entries = readdirSync(path).sort(compareCodeUnits);
    if (entries.includes("SKILL.md")) skillDirs.push(path);
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      pending.push({ path: join(path, entries[index] as string), depth: depth + 1 });
    }
  }
  return {
    skillDirs: skillDirs.sort((left, right) =>
      compareCodeUnits(promotedSkillRel(root, left), promotedSkillRel(root, right)),
    ),
    files: files.sort((left, right) =>
      compareCodeUnits(safeSourceRelative(root, left), safeSourceRelative(root, right)),
    ),
  };
}

function promotedSkillRel(root: string, skillDir: string): string {
  if (skillDir === root) return basename(root);
  const rel = safeSourceRelative(root, skillDir);
  const parts = rel.split("/");
  const skillIndex = parts.indexOf("skills");
  const logical = skillIndex >= 0 ? parts.slice(skillIndex + 1) : parts;
  return logical.length > 0 ? logical.join("/") : basename(skillDir);
}

function assertUniqueNames(root: string, skillDirs: readonly string[]): void {
  const seen = new Set<string>();
  for (const skillDir of skillDirs) {
    const name = promotedSkillRel(root, skillDir);
    const folded = name.toLowerCase();
    if (seen.has(folded)) refuse(`duplicate promoted skill name ${safeText(folded)} collision`);
    seen.add(folded);
  }
}

function assertBinding(input: SkillPromotionSnapshotInput): void {
  const { source, sourceBinding } = input;
  const expectedSource = source.kind === "local" ? source.root : source.source;
  const metadata = source.kind === "github" ? readTrustFetchMetadata(source) : undefined;
  if (
    sourceBinding.id !== source.id ||
    sourceBinding.kind !== source.kind ||
    sourceBinding.source !== expectedSource ||
    (source.kind === "local" &&
      (sourceBinding.ref !== undefined || sourceBinding.pinnedSha !== undefined)) ||
    (source.kind === "github" &&
      (sourceBinding.ref !== source.ref ||
        sourceBinding.pinnedSha === undefined ||
        !LOWER_SHA.test(sourceBinding.pinnedSha) ||
        metadata?.kind !== "github" ||
        metadata.owner !== source.owner ||
        metadata.repo !== source.repo ||
        metadata.ref !== source.ref ||
        metadata.source !== source.source ||
        metadata.treePath !== source.treePath ||
        metadata.pinnedSha !== sourceBinding.pinnedSha ||
        (source.pin !== undefined && metadata.pinnedSha !== source.pin)))
  ) {
    refuse("promotion source binding does not match source identity");
  }
}

function selectedSkillDirs(
  root: string,
  discovered: readonly string[],
  selectedInput: ReadonlySet<string> | undefined,
): string[] {
  assertUniqueNames(root, discovered);
  if (selectedInput === undefined) return [...discovered];
  const selected = [...selectedInput].sort(compareCodeUnits);
  if (selected.length === 0) refuse("no skills selected for promotion");
  if (
    new Set(selected).size !== selected.length ||
    selected.some((name) => !validRelativePath(name))
  ) {
    refuse("invalid selected promotion skills");
  }
  const byName = new Map(discovered.map((dir) => [promotedSkillRel(root, dir), dir]));
  const missing = selected.filter((name) => !byName.has(name));
  if (missing.length > 0) {
    refuse(`pack ref ${missing.map(safeText).join(", ")} not found in source`);
  }
  const skills = selected.map((name) => byName.get(name) as string);
  for (const parent of skills) {
    const prefix = `${parent.replace(/\\/g, "/")}/`;
    const parentName = promotedSkillRel(root, parent);
    for (const child of discovered) {
      if (child.replace(/\\/g, "/").startsWith(prefix)) {
        const childName = promotedSkillRel(root, child);
        if (!selectedInput.has(childName)) {
          refuse(
            `unselected nested skill ${safeText(childName)} would ride with ${safeText(parentName)}`,
          );
        }
      }
    }
  }
  return skills;
}

function sha256(contents: Buffer): string {
  return createHash("sha256").update(contents).digest("hex");
}

function sameProvableIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.ino !== 0n && right.ino !== 0n && left.dev === right.dev && left.ino === right.ino;
}

function assertCurrentFileIdentity(
  root: string,
  sourcePath: string,
  opened: BigIntStats,
  message: string,
): void {
  const currentPath = realpathSync(sourcePath);
  safeSourceRelative(root, currentPath);
  const current = lstatSync(currentPath, { bigint: true });
  if (!current.isFile() || current.nlink > 1n || !sameProvableIdentity(opened, current)) {
    refuse(message);
  }
}

function readPromotionFile(
  root: string,
  sourcePath: string,
  deps: SkillPromotionSnapshotDeps,
): Buffer {
  deps.beforeFileRead?.(sourcePath);
  const targetPath = realpathSync(sourcePath);
  safeSourceRelative(root, targetPath);
  deps.afterFileResolve?.(sourcePath);
  const before = lstatSync(targetPath, { bigint: true });
  if (!before.isFile() || before.nlink > 1n || before.ino === 0n) {
    refuse("promotion source changed before read");
  }
  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  const descriptor = openSync(targetPath, constants.O_RDONLY | noFollow);
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    if (
      !opened.isFile() ||
      opened.nlink > 1n ||
      opened.size > BigInt(PROMOTION_SNAPSHOT_LIMITS.maxFileBytes) ||
      !sameProvableIdentity(opened, before)
    ) {
      refuse("promotion source changed before read");
    }
    assertCurrentFileIdentity(root, sourcePath, opened, "promotion source changed before read");
    const contents = Buffer.alloc(Number(opened.size));
    let offset = 0;
    while (offset < contents.byteLength) {
      const count = readSync(descriptor, contents, offset, contents.byteLength - offset, offset);
      if (count === 0) refuse("promotion source changed during read");
      offset += count;
    }
    const after = fstatSync(descriptor, { bigint: true });
    if (
      !sameProvableIdentity(opened, after) ||
      after.nlink !== opened.nlink ||
      after.size !== opened.size ||
      after.mtimeNs !== opened.mtimeNs
    ) {
      refuse("promotion source changed during read");
    }
    assertCurrentFileIdentity(root, sourcePath, opened, "promotion source changed during read");
    return contents;
  } finally {
    closeSync(descriptor);
  }
}

function snapshotFiles(
  root: string,
  contextDir: string,
  sourceId: string,
  skills: readonly string[],
  treeFiles: readonly string[],
  deps: SkillPromotionSnapshotDeps,
): SkillPromotionSnapshotFile[] {
  const files: SkillPromotionSnapshotFile[] = [];
  const targetKeys = new Set<string>();
  let totalBytes = 0;
  for (const skillDir of skills) {
    const name = promotedSkillRel(root, skillDir);
    const prefix = `${skillDir.replace(/\\/g, "/")}/`;
    const selectedFiles = treeFiles.filter(
      (file) =>
        file.replace(/\\/g, "/").startsWith(prefix) &&
        TEXT_PROMOTION_EXTENSIONS.has(extname(file).toLowerCase()),
    );
    if (selectedFiles.length === 0) refuse("selected skill has no promotion files");
    for (const sourcePath of selectedFiles) {
      const sourceRel = safeSourceRelative(root, sourcePath);
      const fileRel = safeSourceRelative(skillDir, sourcePath);
      const targetRel = posix.join(contextDir, "skills", sourceId, name, fileRel);
      if (!validRelativePath(sourceRel) || !validRelativePath(targetRel)) {
        refuse("unsafe promotion source shape");
      }
      const targetKey = targetRel.toLowerCase();
      if (targetKeys.has(targetKey)) {
        const duplicate = files.find((file) => file.targetRel.toLowerCase() === targetKey);
        if (duplicate?.sourceRel === sourceRel) continue;
        refuse("promotion destination collision");
      }
      targetKeys.add(targetKey);
      const contents = readPromotionFile(root, sourcePath, deps);
      totalBytes += contents.byteLength;
      if (totalBytes > PROMOTION_SNAPSHOT_LIMITS.maxTotalBytes) {
        refuse("promotion source exceeds limits");
      }
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(contents);
      } catch {
        refuse("unsupported non-UTF-8 promotion file");
      }
      files.push({ sourceRel, targetRel, contents, sha256: sha256(contents) });
    }
  }
  return files.sort(
    (left, right) =>
      compareCodeUnits(left.targetRel, right.targetRel) ||
      compareCodeUnits(left.sourceRel, right.sourceRel),
  );
}

function cloneFinding(finding: Check): TrustLockSource["findings"][number] {
  return {
    name: finding.name,
    verdict: finding.verdict,
    ...(finding.code === undefined ? {} : { code: finding.code }),
    ...(finding.detail === undefined ? {} : { detail: finding.detail }),
    ...(finding.location === undefined ? {} : { location: structuredClone(finding.location) }),
    ...(finding.fingerprint === undefined ? {} : { fingerprint: finding.fingerprint }),
  };
}

function cloneWorkingLock(lock: TrustLock): TrustLock {
  if (lock.schemaVersion !== 1 || !Array.isArray(lock.sources))
    refuse("invalid working trust lock");
  const sources = lock.sources.map((source) => parseTrustLockSource(source));
  if (sources.some((source) => source === undefined)) refuse("invalid working trust lock");
  const parsed = sources as TrustLockSource[];
  if (new Set(parsed.map(({ id }) => id)).size !== parsed.length) {
    refuse("ambiguous working trust lock source identity");
  }
  return {
    schemaVersion: 1,
    sources: parsed.map(canonicalSource),
  };
}

function canonicalSource(source: TrustLockSource): TrustLockSource {
  const artifactHashes = source.artifactHashes
    .map((artifact) => ({ ...artifact }))
    .sort(
      (left, right) =>
        compareCodeUnits(left.path, right.path) || compareCodeUnits(left.sha256, right.sha256),
    );
  if (new Set(artifactHashes.map(({ path }) => path)).size !== artifactHashes.length) {
    refuse("duplicate working trust lock artifact path");
  }
  return {
    id: source.id,
    kind: source.kind,
    source: source.source,
    ...(source.ref === undefined ? {} : { ref: source.ref }),
    ...(source.pinnedSha === undefined ? {} : { pinnedSha: source.pinnedSha }),
    promotedAt: source.promotedAt,
    promotedSkills: [...new Set(source.promotedSkills)].sort(compareCodeUnits),
    analyzersRun: [...new Set(source.analyzersRun)].sort(compareCodeUnits),
    artifactHashes,
    findings: source.findings.map((finding) => structuredClone(finding)),
  };
}

function mergedEntry(
  existing: TrustLockSource | undefined,
  entry: TrustLockSource,
  subset: boolean,
): TrustLockSource {
  const sameOrigin =
    existing !== undefined &&
    existing.kind === entry.kind &&
    existing.source === entry.source &&
    (entry.kind !== "github" ||
      (existing.pinnedSha !== undefined && existing.pinnedSha === entry.pinnedSha));
  if (!subset || !sameOrigin || existing === undefined) return canonicalSource(entry);
  const replacedPaths = new Set(entry.artifactHashes.map(({ path }) => path));
  return canonicalSource({
    ...entry,
    promotedSkills: [...existing.promotedSkills, ...entry.promotedSkills],
    artifactHashes: [
      ...existing.artifactHashes.filter(({ path }) => !replacedPaths.has(path)),
      ...entry.artifactHashes,
    ],
  });
}

function nextLock(
  input: SkillPromotionSnapshotInput,
  files: readonly SkillPromotionSnapshotFile[],
  promotedSkills: readonly string[],
): TrustLock {
  const working = cloneWorkingLock(input.workingTrustLock);
  const entry: TrustLockSource = {
    id: input.sourceBinding.id,
    kind: input.sourceBinding.kind,
    source: input.sourceBinding.source,
    ...(input.sourceBinding.ref === undefined ? {} : { ref: input.sourceBinding.ref }),
    ...(input.sourceBinding.pinnedSha === undefined
      ? {}
      : { pinnedSha: input.sourceBinding.pinnedSha }),
    promotedAt: input.promotedAt,
    promotedSkills: [...promotedSkills],
    analyzersRun: [...input.analyzersRun],
    artifactHashes: files.map(({ sourceRel: path, sha256: value }) => ({ path, sha256: value })),
    findings: input.findings.map(cloneFinding),
  };
  const existing = working.sources.find(({ id }) => id === entry.id);
  return {
    schemaVersion: 1,
    sources: [
      ...working.sources.filter(({ id }) => id !== entry.id),
      mergedEntry(existing, entry, input.selectedSkills !== undefined),
    ].sort(
      (left, right) =>
        compareCodeUnits(left.id, right.id) ||
        compareCodeUnits(left.kind, right.kind) ||
        compareCodeUnits(left.source, right.source),
    ),
  };
}

function cloneBoundary(input: unknown): unknown {
  let nodes = 0;
  const active = new Set<object>();
  const clone = (value: unknown, depth: number): unknown => {
    nodes += 1;
    if (
      nodes > PROMOTION_SNAPSHOT_LIMITS.maxInputNodes ||
      depth > PROMOTION_SNAPSHOT_LIMITS.maxDepth
    ) {
      refuse("invalid promotion snapshot input");
    }
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "boolean" ||
      value === undefined
    ) {
      return value;
    }
    if (typeof value === "number") {
      if (!Number.isFinite(value) || Object.is(value, -0)) {
        refuse("invalid promotion snapshot input");
      }
      return value;
    }
    if (typeof value !== "object" || isProxy(value)) {
      refuse("invalid promotion snapshot input");
    }
    if (active.has(value)) refuse("invalid promotion snapshot input");
    active.add(value);
    try {
      if (value instanceof Set) {
        if (Object.getPrototypeOf(value) !== Set.prototype || Reflect.ownKeys(value).length !== 0) {
          refuse("invalid promotion snapshot input");
        }
        const out = new Set<unknown>();
        for (const entry of Set.prototype.values.call(value) as SetIterator<unknown>) {
          out.add(clone(entry, depth + 1));
        }
        return out;
      }
      if (Array.isArray(value)) {
        if (Object.getPrototypeOf(value) !== Array.prototype) {
          refuse("invalid promotion snapshot input");
        }
        const names = Object.getOwnPropertyNames(value);
        if (
          Object.getOwnPropertySymbols(value).length !== 0 ||
          names.length !== value.length + 1 ||
          !names.includes("length")
        ) {
          refuse("invalid promotion snapshot input");
        }
        const out: unknown[] = [];
        for (let index = 0; index < value.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
          if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
            refuse("invalid promotion snapshot input");
          }
          out.push(clone(descriptor.value, depth + 1));
        }
        return out;
      }
      const prototype = Object.getPrototypeOf(value);
      if (prototype !== Object.prototype && prototype !== null) {
        refuse("invalid promotion snapshot input");
      }
      if (Object.getOwnPropertySymbols(value).length !== 0) {
        refuse("invalid promotion snapshot input");
      }
      const out = Object.create(null) as Record<string, unknown>;
      for (const name of Object.getOwnPropertyNames(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, name);
        if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
          refuse("invalid promotion snapshot input");
        }
        out[name] = clone(descriptor.value, depth + 1);
      }
      return out;
    } finally {
      active.delete(value);
    }
  };
  return clone(input, 0);
}

function snapshotInput(input: unknown): SkillPromotionSnapshotInput {
  const cloned = cloneBoundary(input);
  if (
    cloned === null ||
    typeof cloned !== "object" ||
    Array.isArray(cloned) ||
    Object.keys(cloned).some((key) => !INPUT_KEYS.has(key)) ||
    REQUIRED_INPUT_KEYS.some((key) => !Object.hasOwn(cloned, key))
  ) {
    refuse("invalid promotion snapshot input");
  }
  return cloned as SkillPromotionSnapshotInput;
}

function jsonArray(values: unknown[]): unknown[] {
  Object.defineProperty(values, "toJSON", { value: undefined });
  return values;
}

function jsonObject(entries: Array<[string, unknown]>): Record<string, unknown> {
  const value = Object.create(null) as Record<string, unknown>;
  for (const [key, entry] of entries) value[key] = entry;
  return value;
}

function serializeTrustLock(lock: TrustLock): Buffer {
  const sources = lock.sources.map((source) =>
    jsonObject([
      ["id", source.id],
      ["kind", source.kind],
      ["source", source.source],
      ...(source.ref === undefined ? [] : ([["ref", source.ref]] as Array<[string, unknown]>)),
      ...(source.pinnedSha === undefined
        ? []
        : ([["pinnedSha", source.pinnedSha]] as Array<[string, unknown]>)),
      ["promotedAt", source.promotedAt],
      ["promotedSkills", jsonArray([...source.promotedSkills])],
      ["analyzersRun", jsonArray([...source.analyzersRun])],
      [
        "artifactHashes",
        jsonArray(
          source.artifactHashes.map((artifact) =>
            jsonObject([
              ["path", artifact.path],
              ["sha256", artifact.sha256],
            ]),
          ),
        ),
      ],
      [
        "findings",
        jsonArray(
          source.findings.map((finding) =>
            jsonObject([
              ["name", finding.name],
              ["verdict", finding.verdict],
              ...(finding.code === undefined
                ? []
                : ([["code", finding.code]] as Array<[string, unknown]>)),
              ...(finding.detail === undefined
                ? []
                : ([["detail", finding.detail]] as Array<[string, unknown]>)),
              ...(finding.location === undefined
                ? []
                : ([
                    [
                      "location",
                      jsonObject([
                        ["uri", finding.location.uri],
                        ...(finding.location.startLine === undefined
                          ? []
                          : ([["startLine", finding.location.startLine]] as Array<
                              [string, unknown]
                            >)),
                      ]),
                    ],
                  ] as Array<[string, unknown]>)),
              ...(finding.fingerprint === undefined
                ? []
                : ([["fingerprint", finding.fingerprint]] as Array<[string, unknown]>)),
            ]),
          ),
        ),
      ],
    ]),
  );
  const safe = jsonObject([
    ["schemaVersion", 1],
    ["sources", jsonArray(sources)],
  ]);
  return Buffer.from(`${JSON.stringify(safe, null, 2)}\n`, "utf8");
}

/** Read and derive one repo-local skill promotion snapshot without performing effects. */
export function snapshotSkillPromotion(
  input: unknown,
  deps: SkillPromotionSnapshotDeps = {},
): SkillPromotionSnapshot {
  try {
    const snapshot = snapshotInput(input);
    assertBinding(snapshot);
    if (
      !validRelativePath(snapshot.contextDir) ||
      !SAFE_SEGMENT.test(snapshot.source.id) ||
      !ISO_TIMESTAMP.test(snapshot.promotedAt) ||
      new Date(snapshot.promotedAt).toISOString() !== snapshot.promotedAt
    ) {
      refuse("invalid promotion snapshot input");
    }
    const root = sourceRoot(snapshot.source);
    const tree = snapshotTree(root);
    if (tree.skillDirs.length === 0) refuse("no SKILL.md files found in trust source");
    const skills = selectedSkillDirs(root, tree.skillDirs, snapshot.selectedSkills);
    const files = snapshotFiles(
      root,
      snapshot.contextDir,
      snapshot.source.id,
      skills,
      tree.files,
      deps,
    );
    const promotedSkills = skills.map((dir) => promotedSkillRel(root, dir)).sort(compareCodeUnits);
    const artifactHashes = files
      .map(({ sourceRel: path, sha256: value }) => ({ path, sha256: value }))
      .sort((left, right) => compareCodeUnits(left.path, right.path));
    const nextTrustLock = nextLock(snapshot, files, promotedSkills);
    const nextTrustLockBytes = serializeTrustLock(nextTrustLock);
    return {
      files: files.map((file) => ({ ...file, contents: Buffer.from(file.contents) })),
      promotedSkills: [...promotedSkills],
      artifactHashes: artifactHashes.map((artifact) => ({ ...artifact })),
      nextTrustLock: structuredClone(nextTrustLock),
      nextTrustLockBytes: Buffer.from(nextTrustLockBytes),
    };
  } catch (error) {
    if (error instanceof PromotionSnapshotRefusal) throw error;
    refuse("unable to snapshot unsafe promotion source");
  }
}
