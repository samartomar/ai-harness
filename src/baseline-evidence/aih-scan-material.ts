import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  type BigIntStats,
  chmodSync,
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { codeUnitCompare } from "../capability/package-graph/canonical.js";
import {
  assertSafeRelativePosixPathV1,
  canonicalStrictJsonBytesV1,
  canonicalStrictJsonSha256V1,
  parseStrictJsonObjectV1,
} from "../contract/strict-json-v1.js";
import {
  assertAcquiredGithubSourceMaterialPathsV1,
  assertAcquiredGithubSourceRootV1,
  readAcquiredGithubSourceFileV1,
} from "../internals/bounded-github-source-archive.js";
import { readBoundedFileDescriptor } from "../internals/fsxn.js";
import { hermeticGitEnv } from "../internals/git-env.js";
import { mcpEntryFor } from "../mcp/render.js";
import type { PolicyAuthoringCatalog } from "../org-policy/catalog.js";
import {
  type CompiledBuiltInCatalogV1,
  compileBuiltInCatalogV1,
} from "../org-policy/workbench/compilers/built-in.js";
import { usageRecorderScript } from "../usage/capture.js";
import { type BaselineCatalog, defineBaselineCatalog } from "./catalog.js";
import { type BaselineHashedFile, hashComponentTree, hashSourceTree } from "./hash.js";

const CORE_ASSET_PREFIX = "aih/";
const CORE_REVISION = /^[0-9a-f]{40}$/;
const PACK_MANIFEST_PATH = "aih-packs.json";
const CORE_OWNER = "samartomar";
const CORE_REPOSITORY = "ai-harness";
const MAX_PINNED_SOURCE_BYTES = 16 * 1024 * 1024;
const MAX_PINNED_SOURCE_GIT_BATCH_FILES = 128;
const MAX_PINNED_SOURCE_GIT_BATCH_BYTES = 64 * 1024 * 1024;
const MAX_PINNED_SOURCE_GIT_BATCH_PATH_BYTES = 1_024;
const MAX_PINNED_SOURCE_GIT_BATCH_WIRE_BYTES =
  MAX_PINNED_SOURCE_GIT_BATCH_BYTES +
  MAX_PINNED_SOURCE_GIT_BATCH_FILES * (MAX_PINNED_SOURCE_GIT_BATCH_PATH_BYTES + 96) +
  1;

export interface AihScanMaterialCoreRevisionV1 {
  /** Reviewed Git revision of the disposable Core checkout. */
  readonly pinnedSha: string;
}

export interface MaterializeAihScanSubjectsV1Input {
  /** Repository/package root containing the reviewed packs and pack manifest. */
  readonly packageRoot: string;
  /** Existing, real directory beneath which this function creates a fresh output tree. */
  readonly outputParent?: string;
  /** Never infer this from the mutable package version. */
  readonly coreRevision: AihScanMaterialCoreRevisionV1;
  readonly catalog: PolicyAuthoringCatalog;
  readonly compiled: CompiledBuiltInCatalogV1;
}

export interface AihScanMaterialCoverageComponentV1 {
  readonly componentId: string;
  readonly componentTreeSha256: string;
  readonly paths: readonly string[];
  readonly files: readonly Readonly<{ path: string; digest: string }>[];
  readonly subject: Readonly<{
    readonly assetId: string;
    readonly sourceId: string;
    readonly sourceRevisionId: string;
    readonly contentDigest: string;
  }>;
}

/** Non-authoritative compiler/source joins; Scanner evidence must still be independently verified. */
export interface AihScanMaterialCoverageV1 {
  readonly version: "workbench-scanner-coverage/v1";
  readonly authority: "none";
  readonly scope: "declared-source-files";
  readonly compilerInputDigest: string;
  readonly source: CompiledBuiltInCatalogV1["source"];
  readonly repository: string;
  readonly pinnedCommit: string;
  readonly sourceTreeSha256: string;
  readonly components: readonly AihScanMaterialCoverageComponentV1[];
  readonly unmappedDerivedAssets: readonly string[];
}

export interface MaterializedAihScanSubjectV1 {
  readonly componentId: string;
  readonly assetId: string;
  readonly paths: readonly string[];
  /** Recomputed from the fresh, read-only materialization, never caller supplied. */
  readonly files: readonly BaselineHashedFile[];
}

export interface MaterializedAihScanSubjectsV1 {
  readonly sourceRoot: string;
  readonly catalog: BaselineCatalog;
  readonly coverage: AihScanMaterialCoverageV1;
  readonly coverageDigest: string;
  readonly subjects: readonly MaterializedAihScanSubjectV1[];
}

interface SubjectPlan {
  readonly asset: CompiledBuiltInCatalogV1["declarations"][number]["declaration"];
  readonly paths: readonly string[];
  readonly skillContent?: true;
}

interface OwnedMaterializedSourceRoot {
  readonly root: string;
  readonly dev: bigint;
  readonly ino: bigint;
}

const ownedMaterializedRoots = new WeakMap<
  MaterializedAihScanSubjectsV1,
  OwnedMaterializedSourceRoot
>();

function fail(message: string): never {
  throw new TypeError(`AIH scan material: ${message}`);
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function componentId(assetId: string): string {
  return `asset:${sha256(assetId)}`;
}

function ownData(value: object, key: string, label: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !("value" in descriptor)) fail(label);
  return descriptor.value;
}

function exactRecord(
  value: unknown,
  keys: readonly string[],
  required: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) ||
    Reflect.ownKeys(value).some((key) => typeof key !== "string" || !keys.includes(key)) ||
    required.some((key) => !Object.hasOwn(value, key))
  )
    fail(label);
  for (const key of Object.keys(value)) ownData(value, key, label);
}

function realDirectory(path: string, label: string): string {
  try {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail(label);
    return realpathSync(path);
  } catch (error) {
    if (error instanceof TypeError && error.message.startsWith("AIH scan material:")) throw error;
    fail(label);
  }
}

function contained(root: string, path: string): boolean {
  const value = relative(root, path);
  return value.length > 0 && !value.startsWith("..") && !isAbsolute(value) && !value.includes("..");
}

function assertPinnedCheckout(packageRoot: string, pinnedSha: string): void {
  let head: string;
  try {
    head = execFileSync("git", ["-C", packageRoot, "rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
      env: hermeticGitEnv(),
    }).trim();
  } catch {
    fail("Core checkout revision");
  }
  if (head !== pinnedSha) fail("Core checkout revision");
}

function sourcePath(root: string, path: string): string {
  assertSafeRelativePosixPathV1(path, "source path");
  const target = resolve(root, ...path.split("/"));
  if (!contained(root, target)) fail("source path escapes package root");
  return target;
}

function sourceFiles(root: string, path: string): readonly string[] {
  const start = sourcePath(root, path);
  const walk = (target: string): string[] => {
    const stat = lstatSync(target);
    if (stat.isSymbolicLink()) fail("source contains a link");
    if (stat.isFile()) {
      if (stat.nlink > 1) fail("source contains a hard-linked file");
      return [target];
    }
    if (!stat.isDirectory()) fail("source has unsupported entry");
    return readdirSync(target)
      .sort(codeUnitCompare)
      .flatMap((child) => walk(join(target, child)));
  };
  return walk(start);
}

function assertPublicMaterialPath(path: string): void {
  const parts = path.split("/");
  if (parts.some((part) => part === "secrets" || part === ".env" || part.startsWith(".env.")))
    fail("materialized source must not include private configuration");
}

function sameFileIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs
  );
}

function readPinnedSourceFile(source: string, expectedLength: number): Buffer {
  if (
    !Number.isSafeInteger(expectedLength) ||
    expectedLength < 0 ||
    expectedLength > MAX_PINNED_SOURCE_BYTES
  )
    fail("source exceeds maximum size");
  const noFollow = (constants as Record<string, number | undefined>).O_NOFOLLOW ?? 0;
  const nonblock = (constants as Record<string, number | undefined>).O_NONBLOCK ?? 0;
  try {
    const descriptor = openSync(source, constants.O_RDONLY | noFollow | nonblock);
    try {
      const opened = fstatSync(descriptor, { bigint: true });
      const named = lstatSync(source, { bigint: true });
      if (
        opened.isSymbolicLink() ||
        !opened.isFile() ||
        opened.nlink > 1n ||
        named.isSymbolicLink() ||
        !named.isFile() ||
        !sameFileIdentity(opened, named)
      )
        fail("source has unsafe file shape");
      if (opened.size !== BigInt(expectedLength)) fail("source differs from pinned Core revision");
      const actual = readBoundedFileDescriptor(descriptor, expectedLength);
      const after = fstatSync(descriptor, { bigint: true });
      const namedAfter = lstatSync(source, { bigint: true });
      if (
        actual === undefined ||
        actual.length !== expectedLength ||
        !sameFileIdentity(opened, after) ||
        !sameFileIdentity(opened, namedAfter)
      )
        fail("source changed during read");
      return actual;
    } finally {
      closeSync(descriptor);
    }
  } catch (error) {
    if (error instanceof TypeError && error.message.startsWith("AIH scan material:")) throw error;
    fail("source has unsafe file shape");
  }
}

/** Read a bounded set of exact pinned blobs in one hermetic Git process. */
function pinnedGitBlobBytes(
  root: string,
  sources: readonly string[],
  pinnedSha: string,
): ReadonlyMap<string, Buffer> {
  const paths = new Set<string>();
  for (const source of sources) {
    const rel = relative(root, source).replaceAll("\\", "/");
    assertSafeRelativePosixPathV1(rel, "materialized source path");
    if (
      rel.includes(":") ||
      Buffer.byteLength(rel, "utf8") > MAX_PINNED_SOURCE_GIT_BATCH_PATH_BYTES
    )
      fail("materialized source path");
    paths.add(rel);
  }
  if (paths.size === 0 || paths.size > MAX_PINNED_SOURCE_GIT_BATCH_FILES)
    fail("pinned Git batch bounds");
  const input = Buffer.from(
    [...paths.keys()].map((path) => `contents ${pinnedSha}:${path}\n`).join(""),
    "utf8",
  );
  let output: Buffer;
  try {
    output = execFileSync("git", ["-C", root, "cat-file", "--batch-command", "--buffer"], {
      input,
      encoding: "buffer",
      maxBuffer: MAX_PINNED_SOURCE_GIT_BATCH_WIRE_BYTES,
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
      env: hermeticGitEnv(),
    });
  } catch {
    fail("source is absent from pinned Core revision");
  }
  const expected = new Map<string, Buffer>();
  let offset = 0;
  let total = 0;
  for (const path of paths.keys()) {
    const ending = output.indexOf(0x0a, offset);
    if (ending < offset) fail("pinned Git batch framing");
    const header = output.subarray(offset, ending).toString("ascii");
    const match = /^([0-9a-f]{40}|[0-9a-f]{64}) blob ([0-9]+)$/u.exec(header);
    if (match?.[2] === undefined) fail("pinned Git batch framing");
    const size = Number(match[2]);
    if (
      !Number.isSafeInteger(size) ||
      size < 0 ||
      size > MAX_PINNED_SOURCE_BYTES ||
      total > MAX_PINNED_SOURCE_GIT_BATCH_BYTES - size
    )
      fail("source exceeds maximum size");
    const contentStart = ending + 1;
    const contentEnd = contentStart + size;
    if (contentEnd >= output.length || output[contentEnd] !== 0x0a)
      fail("pinned Git batch framing");
    expected.set(path, Buffer.from(output.subarray(contentStart, contentEnd)));
    offset = contentEnd + 1;
    total += size;
  }
  if (offset !== output.length) fail("pinned Git batch framing");
  return expected;
}

function acquiredSourceBytes(root: string, relativePath: string, pinnedSha: string): Buffer {
  const bytes = readAcquiredGithubSourceFileV1(
    root,
    `${CORE_OWNER}/${CORE_REPOSITORY}`,
    pinnedSha,
    relativePath,
  );
  if (bytes === undefined) fail("source differs from acquired Core archive");
  return bytes;
}

function sourceBytes(
  root: string,
  source: string,
  pinnedSha: string,
  acquiredArchive: boolean,
  pinnedBlobs?: ReadonlyMap<string, Buffer>,
): Buffer {
  const relativePath = relative(root, source).replaceAll("\\", "/");
  assertSafeRelativePosixPathV1(relativePath, "materialized source path");
  if (relativePath.includes(":")) fail("materialized source path");
  if (acquiredArchive) return acquiredSourceBytes(root, relativePath, pinnedSha);
  const expected = pinnedBlobs?.get(relativePath);
  if (expected === undefined) fail("source is absent from pinned Core revision");
  const actual = readPinnedSourceFile(source, expected.length);
  if (!actual.equals(expected)) fail("source differs from pinned Core revision");
  return actual;
}

function copyFile(
  root: string,
  destination: string,
  source: string,
  pinnedSha: string,
  acquiredArchive: boolean,
  pinnedBlobs?: ReadonlyMap<string, Buffer>,
): void {
  const rel = relative(root, source).replaceAll("\\", "/");
  assertSafeRelativePosixPathV1(rel, "materialized source path");
  assertPublicMaterialPath(rel);
  const target = resolve(destination, ...rel.split("/"));
  if (!contained(destination, target)) fail("materialized path escapes output root");
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  writeFileSync(target, sourceBytes(root, source, pinnedSha, acquiredArchive, pinnedBlobs), {
    flag: "wx",
    mode: 0o400,
  });
}

function writeMaterial(destination: string, path: string, bytes: Buffer): void {
  assertSafeRelativePosixPathV1(path, "materialized path");
  const target = resolve(destination, ...path.split("/"));
  if (!contained(destination, target)) fail("materialized path escapes output root");
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  writeFileSync(target, bytes, { flag: "wx", mode: 0o400 });
}

function lockDownDirectories(root: string): void {
  const walk = (path: string): void => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) fail("materialized output contains a link");
    if (!stat.isDirectory()) return;
    for (const child of readdirSync(path)) walk(join(path, child));
    chmodSync(path, 0o500);
  };
  walk(root);
}

function makeOwnedMaterialPathWritable(path: string, expected: BigIntStats, mode: number): void {
  const noFollow = (constants as Record<string, number | undefined>).O_NOFOLLOW ?? 0;
  const nonblock = (constants as Record<string, number | undefined>).O_NONBLOCK ?? 0;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY | noFollow | nonblock);
    const opened = fstatSync(descriptor, { bigint: true });
    const named = lstatSync(path, { bigint: true });
    if (
      opened.isSymbolicLink() ||
      named.isSymbolicLink() ||
      !sameFileIdentity(expected, opened) ||
      !sameFileIdentity(expected, named)
    )
      fail("materialized source custody");
    // Windows does not permit fchmod on directory handles and does not enforce
    // the POSIX directory mode that protects Unix unlink operations.
    if (!opened.isDirectory() || process.platform !== "win32") fchmodSync(descriptor, mode);
    const after = fstatSync(descriptor, { bigint: true });
    const namedAfter = lstatSync(path, { bigint: true });
    if (!sameFileIdentity(opened, after) || !sameFileIdentity(opened, namedAfter))
      fail("materialized source custody");
  } catch (error) {
    if (error instanceof TypeError && error.message.startsWith("AIH scan material:")) throw error;
    fail("materialized source custody");
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function unlockOwnedMaterializedSourceRoot(root: OwnedMaterializedSourceRoot): void {
  const rootStat = lstatSync(root.root, { bigint: true });
  if (
    rootStat.isSymbolicLink() ||
    !rootStat.isDirectory() ||
    rootStat.dev !== root.dev ||
    rootStat.ino !== root.ino
  )
    fail("materialized source custody");
  const unlock = (path: string, known?: BigIntStats): void => {
    const stat = known ?? lstatSync(path, { bigint: true });
    if (stat.isSymbolicLink()) fail("materialized source custody");
    if (stat.isDirectory()) {
      makeOwnedMaterialPathWritable(path, stat, 0o700);
      for (const child of readdirSync(path)) {
        const nested = join(path, child);
        if (!contained(root.root, nested)) fail("materialized source custody");
        unlock(nested);
      }
      return;
    }
    if (!stat.isFile()) fail("materialized source custody");
    makeOwnedMaterialPathWritable(path, stat, 0o600);
  };
  unlock(root.root, rootStat);
  rmSync(root.root, { recursive: true, force: false, maxRetries: 2, retryDelay: 20 });
}

/**
 * Remove only a source tree created by this process's materializer. The
 * ownership handle prevents a caller from using cleanup to remove a checkout
 * or another caller-owned path.
 */
export function removeMaterializedAihScanSubjectsV1(
  materialized: MaterializedAihScanSubjectsV1,
): void {
  const owned = ownedMaterializedRoots.get(materialized);
  if (owned === undefined || materialized.sourceRoot !== owned.root)
    fail("materialized source custody");
  unlockOwnedMaterializedSourceRoot(owned);
  ownedMaterializedRoots.delete(materialized);
}

/**
 * Compare freshly generated release materials with the scanned checkout's
 * materials. Git revisions remain separate provenance; every other coverage
 * fact must agree. This proves equivalence, not a scan or qualification.
 */
export function assertAihScanMaterialEquivalenceV1(
  scanned: MaterializedAihScanSubjectsV1,
  release: MaterializedAihScanSubjectsV1,
): Readonly<{
  authority: "none";
  scannedCommit: string;
  releaseCommit: string;
  materialDigest: string;
}> {
  for (const materialized of [scanned, release]) {
    const owned = ownedMaterializedRoots.get(materialized);
    if (owned === undefined || materialized.sourceRoot !== owned.root)
      fail("material equivalence custody");
    const stat = lstatSync(owned.root, { bigint: true });
    if (
      stat.isSymbolicLink() ||
      !stat.isDirectory() ||
      stat.dev !== owned.dev ||
      stat.ino !== owned.ino ||
      hashSourceTree(owned.root).treeSha256 !== materialized.coverage.sourceTreeSha256
    )
      fail("material equivalence source changed");
  }
  const { pinnedCommit: scannedCommit, ...scannedMaterial } = scanned.coverage;
  const { pinnedCommit: releaseCommit, ...releaseMaterial } = release.coverage;
  const digest = canonicalStrictJsonSha256V1(scannedMaterial);
  if (digest !== canonicalStrictJsonSha256V1(releaseMaterial))
    fail("release material differs from scanned material");
  return Object.freeze({
    authority: "none",
    scannedCommit,
    releaseCommit,
    materialDigest: `sha256:${digest}`,
  });
}

function packDeclarations(
  input: MaterializeAihScanSubjectsV1Input,
  manifestBytes: Buffer,
): ReadonlyMap<string, { readonly path: string }> {
  const manifest = parseStrictJsonObjectV1(manifestBytes.toString("utf8"), "AIH pack manifest");
  const packs = ownData(manifest, "packs", "AIH pack manifest");
  if (!Array.isArray(packs)) fail("AIH pack manifest");
  const available = [...input.catalog.aihSkills, ...input.catalog.aihAgents];
  if (available.length !== 3 || packs.length !== available.length) fail("AIH pack inventory");
  const result = new Map<string, { path: string }>();
  for (const pack of available) {
    const manifestPack = packs.find(
      (value): value is Record<string, unknown> =>
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        Object.getPrototypeOf(value) === Object.prototype &&
        Object.hasOwn(value, "name") &&
        ownData(value, "name", "AIH pack manifest") === pack.pack,
    );
    if (manifestPack === undefined) fail(`missing pack manifest entry: ${pack.pack}`);
    exactRecord(
      manifestPack,
      ["name", "description", "skills"],
      ["name", "skills"],
      "AIH pack manifest",
    );
    const skills = ownData(manifestPack, "skills", "AIH pack manifest");
    if (!Array.isArray(skills) || skills.length !== pack.sources.length)
      fail("AIH pack manifest skills");
    const source = pack.sources[0];
    if (source === undefined || pack.sources.length !== 1 || source.manifestIdentity !== "local")
      fail("AIH pack source identity");
    const manifestSkill = skills[0];
    exactRecord(
      manifestSkill,
      ["name", "source", "commit"],
      ["name", "source", "commit"],
      "AIH pack manifest skill",
    );
    if (
      ownData(manifestSkill, "name", "AIH pack manifest skill") !== source.skill ||
      ownData(manifestSkill, "source", "AIH pack manifest skill") !== source.path ||
      ownData(manifestSkill, "commit", "AIH pack manifest skill") !== "local"
    )
      fail("AIH pack manifest/source mismatch");
    const assetId = `${CORE_ASSET_PREFIX}${pack.id}`;
    if (result.has(assetId)) fail("duplicate pack asset");
    result.set(assetId, { path: source.path });
  }
  return result;
}

function mcpDeclarations(
  catalog: MaterializeAihScanSubjectsV1Input["catalog"],
): ReadonlyMap<string, Buffer> {
  const entries = [
    ...catalog.mcp.map(({ id, server }) => ({ id, server })),
    ...catalog.unavailableMcp.map(({ id, server }) => ({ id, server })),
    ...catalog.nonProjectableMcp.map(({ id, server }) => ({ id, server })),
  ];
  if (entries.length !== 6 || new Set(entries.map((entry) => entry.id)).size !== entries.length)
    fail("AIH MCP declaration inventory");
  return new Map(
    entries.map(({ id, server }) => [
      `${CORE_ASSET_PREFIX}${id}`,
      canonicalStrictJsonBytesV1({
        version: "aih-mcp-client-declaration/v1",
        client: "claude",
        scope: "project",
        config: { mcpServers: { [id]: mcpEntryFor("claude", server) } },
      }),
    ]),
  );
}

function assertInput(input: MaterializeAihScanSubjectsV1Input): void {
  exactRecord(
    input,
    ["packageRoot", "outputParent", "coreRevision", "catalog", "compiled"],
    ["packageRoot", "coreRevision", "catalog", "compiled"],
    "input",
  );
  if (typeof ownData(input, "packageRoot", "input") !== "string") fail("package root");
  if (
    Object.hasOwn(input, "outputParent") &&
    typeof ownData(input, "outputParent", "input") !== "string"
  )
    fail("output parent");
  const revision = ownData(input, "coreRevision", "input");
  exactRecord(revision, ["pinnedSha"], ["pinnedSha"], "core revision");
  const pinnedSha = ownData(revision, "pinnedSha", "core revision");
  if (typeof pinnedSha !== "string" || !CORE_REVISION.test(pinnedSha)) fail("core revision");
}

/**
 * Materialize the actual bounded AIH delivery subjects into a new, read-only
 * source tree. This is a preparation boundary only: it runs no scanner and
 * accepts neither scanned evidence nor caller-provided coverage.
 */
export function materializeAihScanSubjectsV1(
  input: MaterializeAihScanSubjectsV1Input,
): MaterializedAihScanSubjectsV1 {
  assertInput(input);
  const packageRoot = realDirectory(input.packageRoot, "package root");
  const outputParent = realDirectory(input.outputParent ?? tmpdir(), "output parent");
  if (outputParent === packageRoot || contained(packageRoot, outputParent))
    fail("output parent must be outside Core checkout");
  const acquiredArchive = assertAcquiredGithubSourceRootV1(
    packageRoot,
    `${CORE_OWNER}/${CORE_REPOSITORY}`,
    input.coreRevision.pinnedSha,
  );
  if (!acquiredArchive) assertPinnedCheckout(packageRoot, input.coreRevision.pinnedSha);
  const expectedCompiled = compileBuiltInCatalogV1(input.catalog);
  if (canonicalStrictJsonSha256V1(input.compiled) !== canonicalStrictJsonSha256V1(expectedCompiled))
    fail("compiled AIH catalog differs from canonical compiler output");
  const manifestPath = sourcePath(packageRoot, PACK_MANIFEST_PATH);
  const manifestBlobs = acquiredArchive
    ? undefined
    : pinnedGitBlobBytes(packageRoot, [manifestPath], input.coreRevision.pinnedSha);
  const packAssets = packDeclarations(
    input,
    sourceBytes(
      packageRoot,
      manifestPath,
      input.coreRevision.pinnedSha,
      acquiredArchive,
      manifestBlobs,
    ),
  );
  if (
    acquiredArchive &&
    !assertAcquiredGithubSourceMaterialPathsV1(
      packageRoot,
      `${CORE_OWNER}/${CORE_REPOSITORY}`,
      input.coreRevision.pinnedSha,
      [PACK_MANIFEST_PATH, ...[...packAssets.values()].map((entry) => entry.path)],
    )
  )
    fail("acquired Core archive omits a covered source path");
  const mcpAssets = mcpDeclarations(input.catalog);
  const declared = new Map(
    input.compiled.declarations.map(({ declaration }) => [declaration.id, declaration]),
  );
  if (declared.size !== input.compiled.declarations.length || declared.size !== 10)
    fail("compiled AIH asset inventory");

  const destination = mkdtempSync(join(outputParent, "aih-scan-material-"));
  const packFiles = [...packAssets.values()].flatMap((pack) => sourceFiles(packageRoot, pack.path));
  const packBlobs = acquiredArchive
    ? undefined
    : pinnedGitBlobBytes(packageRoot, packFiles, input.coreRevision.pinnedSha);
  copyFile(
    packageRoot,
    destination,
    manifestPath,
    input.coreRevision.pinnedSha,
    acquiredArchive,
    manifestBlobs,
  );
  for (const file of packFiles)
    copyFile(
      packageRoot,
      destination,
      file,
      input.coreRevision.pinnedSha,
      acquiredArchive,
      packBlobs,
    );
  const hookBytes = Buffer.from(usageRecorderScript(), "utf8");
  const hook = input.catalog.hooks.find((entry) => entry.id === "usage-metering");
  if (
    input.catalog.hooks.length !== 1 ||
    hook?.control.source.type !== "hook" ||
    hook.control.source.handler !== "usage-metering" ||
    hook.control.source.scriptDigest !== `sha256:${sha256(hookBytes)}`
  )
    fail("usage hook delivery identity");
  writeMaterial(destination, "generated/usage-metering/usage-record.mjs", hookBytes);
  for (const [assetId, bytes] of mcpAssets) {
    const name = assetId.slice(CORE_ASSET_PREFIX.length);
    writeMaterial(destination, `declarations/claude/project/${name}.json`, bytes);
  }

  const plans: SubjectPlan[] = input.compiled.declarations.map(({ declaration }) => {
    if (
      declaration.sourceId !== input.compiled.source.id ||
      declaration.sourceRevisionId !== input.compiled.source.revisionId
    )
      fail(`compiled source identity mismatch: ${declaration.id}`);
    const pack = packAssets.get(declaration.id);
    if (pack !== undefined) {
      if (
        declaration.originalPath !== pack.path ||
        (declaration.kind !== "skill" && declaration.kind !== "agent")
      )
        fail(`compiled pack declaration mismatch: ${declaration.id}`);
      return {
        asset: declaration,
        paths: [PACK_MANIFEST_PATH, pack.path].sort(codeUnitCompare),
        skillContent: true,
      };
    }
    if (declaration.id === "aih/usage-metering") {
      if (declaration.kind !== "hook" || declaration.originalPath !== "core-control/usage-metering")
        fail("compiled usage hook declaration mismatch");
      return {
        asset: declaration,
        paths: ["generated/usage-metering/usage-record.mjs"],
        skillContent: true,
      };
    }
    if (mcpAssets.has(declaration.id)) {
      const name = declaration.id.slice(CORE_ASSET_PREFIX.length);
      if (declaration.kind !== "mcp") fail(`compiled MCP declaration mismatch: ${declaration.id}`);
      return {
        asset: declaration,
        paths: [`declarations/claude/project/${name}.json`],
      };
    }
    return fail(`unmaterialized compiled AIH asset: ${declaration.id}`);
  });
  if (plans.length !== 10 || plans.some((plan) => !declared.has(plan.asset.id)))
    fail("compiled/materialized asset join");
  const planIds = new Set(plans.map((plan) => plan.asset.id));
  if (
    planIds.size !== plans.length ||
    [...packAssets.keys()].some((id) => !planIds.has(id)) ||
    [...mcpAssets.keys()].some((id) => !planIds.has(id))
  )
    fail("materialized asset closure");
  lockDownDirectories(destination);

  const components = plans
    .map((plan) => {
      const id = componentId(plan.asset.id);
      const hashed = hashComponentTree(destination, plan.paths);
      return {
        componentId: id,
        componentTreeSha256: hashed.treeSha256,
        paths: Object.freeze([...plan.paths]),
        subject: Object.freeze({
          assetId: plan.asset.id,
          sourceId: plan.asset.sourceId,
          sourceRevisionId: plan.asset.sourceRevisionId,
          contentDigest: plan.asset.contentDigest,
        }),
        files: Object.freeze(hashed.files.map((file) => Object.freeze({ ...file }))),
        skillContent: plan.skillContent,
      };
    })
    .sort((left, right) => codeUnitCompare(left.componentId, right.componentId));
  if (new Set(components.map((component) => component.componentId)).size !== components.length)
    fail("duplicate materialized component");
  const sourceTreeSha256 = hashSourceTree(destination).treeSha256;
  const catalog = defineBaselineCatalog({
    id: "aih",
    owner: CORE_OWNER,
    repo: CORE_REPOSITORY,
    pinnedSha: input.coreRevision.pinnedSha,
    components: components.map((component) => ({
      id: component.componentId,
      paths: [...component.paths],
      ...(component.skillContent === true ? { skillContent: true as const } : {}),
    })),
  });
  const compilerInputDigest = `sha256:${canonicalStrictJsonSha256V1({
    source: input.compiled.source,
    declarations: input.compiled.declarations.map(({ declaration }) => declaration),
  })}`;
  const coverage: AihScanMaterialCoverageV1 = Object.freeze({
    version: "workbench-scanner-coverage/v1",
    authority: "none",
    scope: "declared-source-files",
    compilerInputDigest,
    source: Object.freeze({ ...input.compiled.source }),
    repository: `${CORE_OWNER}/${CORE_REPOSITORY}`,
    pinnedCommit: input.coreRevision.pinnedSha,
    sourceTreeSha256,
    components: Object.freeze(
      components.map(({ files, skillContent: _, ...component }) =>
        Object.freeze({
          ...component,
          files: Object.freeze(
            files.map((file) =>
              Object.freeze({ path: file.path, digest: `sha256:${file.sha256}` }),
            ),
          ),
        }),
      ),
    ),
    unmappedDerivedAssets: Object.freeze(
      input.compiled.declarations
        .filter(({ declaration }) => declaration.derivation !== "built-in")
        .map(({ declaration }) => declaration.id)
        .sort(codeUnitCompare),
    ),
  });
  const materialized = Object.freeze({
    sourceRoot: destination,
    catalog,
    coverage,
    coverageDigest: `sha256:${canonicalStrictJsonSha256V1(coverage)}`,
    subjects: Object.freeze(
      components.map(({ componentId, paths, files, subject }) =>
        Object.freeze({ componentId, assetId: subject.assetId, paths, files }),
      ),
    ),
  });
  const destinationStat = lstatSync(destination, { bigint: true });
  if (destinationStat.isSymbolicLink() || !destinationStat.isDirectory())
    fail("materialized source custody");
  ownedMaterializedRoots.set(materialized, {
    root: destination,
    dev: destinationStat.dev,
    ino: destinationStat.ino,
  });
  return materialized;
}
