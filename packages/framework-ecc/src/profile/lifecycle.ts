import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import {
  type Action,
  AihError,
  beginMarker,
  endMarker,
  inspectContainedRelativePath,
  type Plan,
  plan,
  readRegularFileWithStats,
  remove,
  removeManagedBlock,
  upsertTextBlock,
  type WriteAction,
  z,
} from "@aihq/core/framework-host";
import { assertPortableSourcePath } from "./index.js";
import type { EccProjection, RenderedProjectionFile } from "./render.js";

const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
export const ECC_PROFILE_MANAGED_SCOPE = "ecc-profile";
const MANAGED_SCOPE = ECC_PROFILE_MANAGED_SCOPE;
const MAX_PROJECTED_FILES = 2_000;
const MAX_PROJECTED_FILE_BYTES = 4 * 1024 * 1024;
const MAX_PROJECTED_BYTES = 64 * 1024 * 1024;
const MAX_RECEIPT_BYTES = 96 * 1024 * 1024;
const DESTINATION_PREFIXES = [".agents/", ".claude/", ".codex/"] as const;

export const ECC_PROFILE_OWNERSHIP_PATH = ".aih/ecc-profile/ownership-v1.json";

const hashSchema = z.string().regex(SHA256);
const sourceFields = {
  repository: z.literal("affaan-m/ECC"),
  commit: z.string().regex(COMMIT),
  sourceClosureId: z.string().min(1).max(256),
  sourceClosureSha256: hashSchema,
  projectionSha256: hashSchema,
};
/**
 * Recovery identities are versioned by what `projectionSha256` binds. Version 1
 * (unversioned, recorded by earlier releases) binds destination, content and
 * mode; version 2 also binds each file's merge strategy, the write semantic a
 * recovery replays.
 */
const sourceSchema = z.union([
  z.object({ recoveryIdentityVersion: z.literal(2), ...sourceFields }).strict(),
  z.object(sourceFields).strict(),
]);
const ownershipFileSchema = z
  .object({
    destination: z.string().min(1).max(1_024),
    sourcePin: z.string().regex(COMMIT),
    sourcePaths: z.array(z.string().min(1).max(1_024)).min(1),
    normalizedHash: hashSchema,
    installedHash: hashSchema,
    managedBlockHash: hashSchema.nullable(),
    previousHash: hashSchema.nullable(),
    owner: z.literal("aih"),
    capabilityOwner: z.enum(["upstream", "aih-adaptation"]),
    mergeStrategy: z.enum(["replace", "toml-merge"]),
    mode: z.enum(["100644", "100755"]),
    content: z.string().max(MAX_PROJECTED_FILE_BYTES),
  })
  .strict();
const rollbackFileSchema = ownershipFileSchema;
const rollbackSchema = z
  .object({ source: sourceSchema, files: z.array(rollbackFileSchema).max(MAX_PROJECTED_FILES) })
  .strict();
const ownershipSchema = z
  .object({
    schemaVersion: z.literal(1),
    state: z.literal("active"),
    canonicalRoot: z.string().min(1).max(4_096),
    source: sourceSchema,
    files: z.array(ownershipFileSchema).max(MAX_PROJECTED_FILES),
    rollback: rollbackSchema.optional(),
  })
  .strict();

export type EccProfileOwnership = z.infer<typeof ownershipSchema>;
export type EccProfileInstalledSourceTrust = EccProfileOwnership["source"];
type OwnershipFile = EccProfileOwnership["files"][number];
type RollbackFile = NonNullable<EccProfileOwnership["rollback"]>["files"][number];
export type EccProfileLifecycleOperation =
  | "install"
  | "update"
  | "repair"
  | "uninstall"
  | "rollback";
export type EccProfileInstalledLifecycleOperation = Extract<
  EccProfileLifecycleOperation,
  "repair" | "uninstall" | "rollback"
>;

/**
 * A recovery (repair, rollback, uninstall) whose installed identity is not
 * independently anchored: the ownership receipt is operator-writable state, so
 * its self-declared source and projection digest never authorize a write.
 */
export class EccProfileRecoveryRefusalError extends AihError {
  readonly reason = "framework-profile-recovery-unanchored";
  readonly label: string;
  readonly nextRoute: string;

  constructor(label: string, nextRoute: string) {
    super(
      `framework-profile-recovery-unanchored: ${label}. Next: ${nextRoute}`,
      "AIH_FRAMEWORK_PLUGIN",
    );
    this.label = label;
    this.nextRoute = nextRoute;
  }
}

const RECOVERY_NEXT_ROUTE =
  "use an @aihq/core package version whose append-only ECC profile installation trust record names this exact ECC pin and projection digest";

type RecoveryIdentityVersion = 1 | 2;

function recoveryIdentityVersion(source: EccProfileInstalledSourceTrust): RecoveryIdentityVersion {
  return "recoveryIdentityVersion" in source ? source.recoveryIdentityVersion : 1;
}

interface RecoveryDigestEntry {
  destination: string;
  normalizedHash: string;
  mode: string;
  mergeStrategy: string;
}

function recoveryDigest(
  version: RecoveryIdentityVersion,
  entries: readonly RecoveryDigestEntry[],
): string {
  return sha256(
    [...entries]
      .sort(comparePaths)
      .map((entry) =>
        version === 1
          ? `${entry.destination}\0${entry.normalizedHash}\0${entry.mode}`
          : `${entry.destination}\0${entry.normalizedHash}\0${entry.mode}\0${entry.mergeStrategy}`,
      )
      .join("\n"),
  );
}

function projectionDigestEntries(files: readonly RenderedProjectionFile[]): RecoveryDigestEntry[] {
  return files.map((file) => ({
    destination: file.destination,
    normalizedHash: file.normalizedSha256,
    mode: file.mode,
    mergeStrategy: file.mergeStrategy,
  }));
}

/**
 * The recorded identity must equal an anchor under its own version. A version-1
 * identity names no write semantics, so its files must also match a version-2
 * anchor at the same pin: a changed merge strategy never replays.
 */
function assertAnchored(
  source: EccProfileInstalledSourceTrust,
  files: readonly OwnershipFile[],
  anchors: readonly EccProfileInstalledSourceTrust[],
  label: string,
): void {
  const identity = `${source.repository}@${source.commit}, projection ${source.projectionSha256}`;
  if (!anchors.some((anchor) => sameSource(anchor, source)))
    throw new EccProfileRecoveryRefusalError(
      `${label} (${identity}) is not an anchored recovery identity`,
      RECOVERY_NEXT_ROUTE,
    );
  if (recoveryIdentityVersion(source) !== 1) return;
  const semantics = writeSemanticsIdentity(source, files);
  if (!anchors.some((anchor) => sameSource(anchor, semantics)))
    throw new EccProfileRecoveryRefusalError(
      `${label} (${identity}) is a version-1 recovery identity whose write semantics no version-2 anchor authenticates`,
      RECOVERY_NEXT_ROUTE,
    );
}

function assertRollbackAnchored(
  receipt: EccProfileOwnership,
  anchors: readonly EccProfileInstalledSourceTrust[],
): void {
  if (!receipt.rollback) throw new Error("ECC profile ownership receipt has no rollback snapshot");
  assertAnchored(
    receipt.rollback.source,
    receipt.rollback.files,
    anchors,
    "ECC profile rollback snapshot",
  );
}

/** Same repository, commit and source closure: two renders of one pin. */
function samePin(
  left: EccProfileInstalledSourceTrust,
  right: EccProfileInstalledSourceTrust,
): boolean {
  return (
    left.repository === right.repository &&
    left.commit === right.commit &&
    left.sourceClosureId === right.sourceClosureId &&
    left.sourceClosureSha256 === right.sourceClosureSha256
  );
}

/** The version-2 identity of an installation, whichever version it recorded. */
function writeSemanticsIdentity(
  source: EccProfileInstalledSourceTrust,
  files: readonly OwnershipFile[],
): EccProfileInstalledSourceTrust {
  if (recoveryIdentityVersion(source) === 2) return source;
  return {
    recoveryIdentityVersion: 2,
    repository: source.repository,
    commit: source.commit,
    sourceClosureId: source.sourceClosureId,
    sourceClosureSha256: source.sourceClosureSha256,
    projectionSha256: recoveryDigest(2, files),
  };
}

/**
 * Core appends the anchor of a later render of an already anchored pin after
 * the earlier ones. An installation of the earlier render is superseded: its
 * receipt can carry payloads the current render withholds, and repair would
 * restore them. Update migrates it instead.
 */
function assertNotSuperseded(
  receipt: EccProfileOwnership,
  anchors: readonly EccProfileInstalledSourceTrust[],
): void {
  const installed = writeSemanticsIdentity(receipt.source, receipt.files);
  const index = anchors.findIndex((anchor) => sameSource(anchor, installed));
  if (index < 0) return;
  const later = anchors
    .slice(index + 1)
    .find(
      (anchor) =>
        recoveryIdentityVersion(anchor) === 2 &&
        samePin(anchor, installed) &&
        anchor.projectionSha256 !== installed.projectionSha256,
    );
  if (later !== undefined)
    throw new Error(
      `ECC profile repair: the installed projection ${installed.projectionSha256} of ${installed.repository}@${installed.commit} is superseded by the anchored projection ${later.projectionSha256} of the same pin, and repair would restore what that render withholds. Next: run aih ecc --lifecycle update to migrate; rollback to the installed projection stays available`,
    );
}

/**
 * An update within one pin changes only the projection: both the installed
 * and the new identity must be anchored in Core's installation trust record,
 * at the same source closure. Anything else at the installed pin refuses.
 */
function assertSamePinMigration(
  receipt: EccProfileOwnership,
  projection: EccProjection,
  anchors: readonly EccProfileInstalledSourceTrust[],
): void {
  const next = eccProfileRecoveryIdentity(projection);
  if (
    !samePin(receipt.source, next) ||
    sameSource(writeSemanticsIdentity(receipt.source, receipt.files), next)
  )
    throw new Error(
      "ECC profile update requires an exact new source pin or an anchored new projection of the installed pin",
    );
  assertAnchored(
    receipt.source,
    receipt.files,
    anchors,
    "ECC profile update within the installed pin: the installed source identity",
  );
  if (!anchors.some((anchor) => sameSource(anchor, next)))
    throw new EccProfileRecoveryRefusalError(
      `ECC profile update within the installed pin: the new projection (${next.repository}@${next.commit}, projection ${next.projectionSha256}) is not an anchored recovery identity`,
      RECOVERY_NEXT_ROUTE,
    );
}

interface CurrentFile {
  contents: string;
  sha256: string;
  mode: "100644" | "100755";
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function comparePaths(left: { destination: string }, right: { destination: string }): number {
  return left.destination < right.destination ? -1 : left.destination > right.destination ? 1 : 0;
}

function sourcePaths(file: RenderedProjectionFile): string[] {
  return (
    file.provenance.kind === "pinned-file"
      ? [file.provenance.path]
      : file.provenance.inputs.map((input) => input.path)
  ).sort();
}

/** The version-2 recovery identity an install or update of `projection` records. */
export function eccProfileRecoveryIdentity(
  projection: EccProjection,
): EccProfileInstalledSourceTrust {
  return {
    recoveryIdentityVersion: 2,
    repository: projection.source.repository,
    commit: projection.source.commit,
    sourceClosureId: projection.sourceClosure.id,
    sourceClosureSha256: projection.sourceClosure.aggregateSha256,
    projectionSha256: recoveryDigest(2, projectionDigestEntries(projection.files)),
  };
}

/** A recorded identity of either version names exactly this projection. */
function identifiesProjection(
  source: EccProfileInstalledSourceTrust,
  projection: EccProjection,
): boolean {
  return (
    source.repository === projection.source.repository &&
    source.commit === projection.source.commit &&
    source.sourceClosureId === projection.sourceClosure.id &&
    source.sourceClosureSha256 === projection.sourceClosure.aggregateSha256 &&
    source.projectionSha256 ===
      recoveryDigest(recoveryIdentityVersion(source), projectionDigestEntries(projection.files))
  );
}

function assertDestination(root: string, destination: string, allowReceipt = false): void {
  assertPortableSourcePath(destination);
  if (
    !DESTINATION_PREFIXES.some((prefix) => destination.startsWith(prefix)) &&
    !(allowReceipt && destination === ECC_PROFILE_OWNERSHIP_PATH)
  ) {
    throw new Error(
      `ECC profile destination is outside the managed client namespaces: ${destination}`,
    );
  }
  const rootReal = realpathSync(root);
  let current = rootReal;
  const segments = destination.split("/");
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    if (segment === undefined) throw new Error(`invalid ECC profile destination: ${destination}`);
    current = resolve(current, segment);
    let stats: ReturnType<typeof lstatSync>;
    try {
      stats = lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new Error(`ECC profile destination parent is inaccessible: ${destination}`);
    }
    if (stats.isSymbolicLink())
      throw new Error(`ECC profile destination uses a symlinked parent: ${destination}`);
    if (!stats.isDirectory())
      throw new Error(`ECC profile destination parent is not a directory: ${destination}`);
    const canonical = realpathSync(current);
    const rel = relative(rootReal, canonical);
    if (rel === ".." || rel.startsWith("../") || rel.startsWith("..\\") || isAbsolute(rel))
      throw new Error(`ECC profile destination escapes its root: ${destination}`);
    current = canonical;
  }
}

function readCurrent(
  root: string,
  destination: string,
  maxBytes = MAX_PROJECTED_FILE_BYTES,
  allowReceipt = false,
): CurrentFile | undefined {
  assertDestination(root, destination, allowReceipt);
  const inspected = inspectContainedRelativePath(root, destination);
  if (inspected.state === "absent") return undefined;
  if (inspected.state === "unsafe" || inspected.kind !== "file")
    throw new Error(`ECC profile destination is unsafe: ${destination}`);
  const opened = readRegularFileWithStats(inspected.realPath, { maxBytes });
  if (!opened || opened.stats.nlink > 1)
    throw new Error(
      `ECC profile destination is not a bounded unambiguous regular file: ${destination}`,
    );
  const contents = opened.contents.toString("utf8");
  return {
    contents,
    sha256: sha256(opened.contents),
    mode: (opened.stats.mode & 0o111) === 0 ? "100644" : "100755",
  };
}

function managedBlock(contents: string): string | undefined {
  const begin = beginMarker(MANAGED_SCOPE);
  const end = endMarker(MANAGED_SCOPE);
  const start = contents.indexOf(begin);
  if (start < 0) return undefined;
  if (contents.indexOf(begin, start + begin.length) >= 0)
    throw new Error("ECC profile TOML contains duplicate managed blocks");
  const finish = contents.indexOf(end, start + begin.length);
  if (finish < 0 || contents.indexOf(end, finish + end.length) >= 0)
    throw new Error("ECC profile TOML contains a malformed managed block");
  return contents.slice(start, finish + end.length);
}

function managedBody(contents: string): string | undefined {
  const block = managedBlock(contents);
  if (block === undefined) return undefined;
  const begin = beginMarker(MANAGED_SCOPE);
  const end = endMarker(MANAGED_SCOPE);
  return block
    .slice(begin.length, block.length - end.length)
    .replace(/^\r?\n/, "")
    .replace(/\r?\n$/, "")
    .replace(/\r\n/g, "\n");
}

function validateProjection(root: string, projection: EccProjection): RenderedProjectionFile[] {
  if (projection.version !== 1 || projection.source.repository !== "affaan-m/ECC")
    throw new Error("invalid ECC profile projection identity");
  if (!COMMIT.test(projection.source.commit)) throw new Error("invalid ECC profile source commit");
  if (
    projection.sourceClosure.id.length === 0 ||
    projection.sourceClosure.id.length > 256 ||
    !SHA256.test(projection.sourceClosure.aggregateSha256) ||
    !Number.isSafeInteger(projection.sourceClosure.fileCount) ||
    projection.sourceClosure.fileCount < 1 ||
    !Number.isSafeInteger(projection.sourceClosure.totalBytes) ||
    projection.sourceClosure.totalBytes < 1
  ) {
    throw new Error("invalid ECC profile source closure identity");
  }
  if (
    projection.source.reviewReceipt.sourceCommit !== projection.source.commit ||
    !SHA256.test(projection.source.reviewReceipt.evidenceSha256)
  ) {
    throw new Error("invalid ECC profile review receipt identity");
  }
  assertPortableSourcePath(projection.source.reviewReceipt.evidencePath);
  if (projection.files.length === 0 || projection.files.length > MAX_PROJECTED_FILES)
    throw new Error("ECC profile projection file count exceeds the lifecycle boundary");
  let total = 0;
  const destinations = new Set<string>();
  const files = [...projection.files].sort(comparePaths);
  for (const file of files) {
    assertDestination(root, file.destination);
    const identity = file.destination.toLowerCase();
    if (destinations.has(identity))
      throw new Error(`ambiguous ECC profile destination: ${file.destination}`);
    destinations.add(identity);
    const bytes = Buffer.byteLength(file.content, "utf8");
    total += bytes;
    if (bytes > MAX_PROJECTED_FILE_BYTES || total > MAX_PROJECTED_BYTES)
      throw new Error("ECC profile projected bytes exceed the lifecycle boundary");
    if (file.owner !== "aih")
      throw new Error(`ECC profile file has ambiguous owner: ${file.destination}`);
    if (file.provenance.sourcePin !== projection.source.commit)
      throw new Error(`ECC profile source pin contradicts projection: ${file.destination}`);
    if (file.normalizedSha256 !== sha256(file.content))
      throw new Error(`ECC profile normalized hash contradicts content: ${file.destination}`);
    for (const path of sourcePaths(file)) assertPortableSourcePath(path);
  }
  return files;
}

function ownershipEntry(
  file: RenderedProjectionFile,
  installed: string,
  previousHash: string | null,
): OwnershipFile {
  const block = file.mergeStrategy === "toml-merge" ? managedBlock(installed) : undefined;
  if (file.mergeStrategy === "toml-merge" && block === undefined)
    throw new Error(`ECC profile TOML merge produced no managed block: ${file.destination}`);
  return {
    destination: file.destination,
    sourcePin: file.provenance.sourcePin,
    sourcePaths: sourcePaths(file),
    normalizedHash: file.normalizedSha256,
    installedHash: sha256(installed),
    managedBlockHash: block === undefined ? null : sha256(block),
    previousHash,
    owner: "aih",
    capabilityOwner: file.capabilityOwner,
    mergeStrategy: file.mergeStrategy,
    mode: file.mode,
    content: file.content,
  };
}

function pinnedWrite(
  destination: string,
  contents: string,
  mode: "100644" | "100755",
  current: CurrentFile | undefined,
  describe: string,
): WriteAction {
  return {
    kind: "write",
    path: destination,
    describe,
    contents,
    mode: mode === "100755" ? 0o755 : 0o644,
    expect: current === undefined ? { absent: true } : { sha256: current.sha256 },
  };
}

function receiptWrite(
  receipt: EccProfileOwnership,
  currentReceipt: CurrentFile | undefined,
): WriteAction {
  const contents = `${JSON.stringify(receipt, null, 2)}\n`;
  if (Buffer.byteLength(contents, "utf8") > MAX_RECEIPT_BYTES)
    throw new Error("ECC profile ownership receipt exceeds its size limit");
  return pinnedWrite(
    ECC_PROFILE_OWNERSHIP_PATH,
    contents,
    "100644",
    currentReceipt,
    "record AIH-owned ECC profile lifecycle ownership",
  );
}

function assertOwnedCurrent(root: string, entry: OwnershipFile): CurrentFile | undefined {
  const current = readCurrent(root, entry.destination);
  if (current === undefined) return undefined;
  if (entry.mergeStrategy === "replace") {
    if (current.sha256 !== entry.installedHash)
      throw new Error(`modified owned ECC profile destination: ${entry.destination}`);
    return current;
  }
  const block = managedBlock(current.contents);
  if (block === undefined || sha256(block) !== entry.managedBlockHash)
    throw new Error(`modified owned ECC profile managed block: ${entry.destination}`);
  return current;
}

function canonicalRoot(root: string): string {
  const canonical = realpathSync(root);
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

function parseReceipt(contents: string, root: string): EccProfileOwnership {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw new Error("invalid ECC profile ownership receipt JSON");
  }
  const receipt = ownershipSchema.parse(parsed);
  if (receipt.canonicalRoot !== canonicalRoot(root))
    throw new Error("invalid ECC profile ownership receipt: foreign worktree root");
  validateReceiptFiles(receipt.files, receipt.source.commit, "active");
  if (
    recoveryDigest(recoveryIdentityVersion(receipt.source), receipt.files) !==
    receipt.source.projectionSha256
  )
    throw new Error("invalid ECC profile ownership receipt: active projection digest mismatch");
  if (receipt.rollback !== undefined) {
    validateReceiptFiles(receipt.rollback.files, receipt.rollback.source.commit, "rollback");
    if (
      recoveryDigest(recoveryIdentityVersion(receipt.rollback.source), receipt.rollback.files) !==
      receipt.rollback.source.projectionSha256
    )
      throw new Error("invalid ECC profile ownership receipt: rollback projection digest mismatch");
  }
  return receipt;
}

function validateReceiptFiles(
  files: ReadonlyArray<OwnershipFile | RollbackFile>,
  sourceCommit: string,
  label: string,
): void {
  const destinations = files.map((file) => file.destination.toLowerCase());
  if (new Set(destinations).size !== destinations.length)
    throw new Error(`invalid ECC profile ownership receipt: ambiguous ${label} destinations`);
  for (const file of files) {
    assertPortableSourcePath(file.destination);
    if (!DESTINATION_PREFIXES.some((prefix) => file.destination.startsWith(prefix)))
      throw new Error(`invalid ECC profile ownership receipt: unmanaged ${label} destination`);
    const paths = file.sourcePaths.map((path) => {
      assertPortableSourcePath(path);
      return path.toLowerCase();
    });
    if (new Set(paths).size !== paths.length)
      throw new Error(`invalid ECC profile ownership receipt: ambiguous ${label} source paths`);
    if (file.sourcePin !== sourceCommit)
      throw new Error("invalid ECC profile ownership receipt: contradictory source pin");
    if (
      (file.mergeStrategy === "replace" && file.managedBlockHash !== null) ||
      (file.mergeStrategy === "toml-merge" && file.managedBlockHash === null)
    )
      throw new Error("invalid ECC profile ownership receipt: contradictory merge metadata");
    if (
      Buffer.byteLength(file.content, "utf8") > MAX_PROJECTED_FILE_BYTES ||
      sha256(file.content) !== file.normalizedHash
    ) {
      throw new Error(`invalid ECC profile ${label} content hash`);
    }
    if (file.mergeStrategy === "replace" && sha256(file.content) !== file.installedHash)
      throw new Error(`invalid ECC profile ${label} installed hash`);
    if (file.mergeStrategy === "toml-merge") {
      const block = managedBlock(upsertTextBlock("", MANAGED_SCOPE, file.content));
      if (block === undefined || sha256(block) !== file.managedBlockHash)
        throw new Error(`invalid ECC profile ${label} managed-block hash`);
    }
  }
}

function assertReceiptMatchesProjection(
  receipt: EccProfileOwnership,
  files: ReadonlyArray<RenderedProjectionFile>,
): void {
  if (receipt.files.length !== files.length)
    throw new Error("ECC profile ownership receipt does not close over the pinned projection");
  const projected = new Map(files.map((file) => [file.destination, file]));
  for (const entry of receipt.files) {
    const file = projected.get(entry.destination);
    if (
      file === undefined ||
      entry.sourcePin !== file.provenance.sourcePin ||
      entry.normalizedHash !== file.normalizedSha256 ||
      entry.capabilityOwner !== file.capabilityOwner ||
      entry.mergeStrategy !== file.mergeStrategy ||
      entry.mode !== file.mode ||
      entry.content !== file.content ||
      JSON.stringify(entry.sourcePaths) !== JSON.stringify(sourcePaths(file))
    )
      throw new Error(`ECC profile ownership receipt contradicts ${entry.destination}`);
  }
}

function readReceiptFile(
  root: string,
): { receipt: EccProfileOwnership; current: CurrentFile } | undefined {
  const current = readCurrent(root, ECC_PROFILE_OWNERSHIP_PATH, MAX_RECEIPT_BYTES, true);
  if (current === undefined) return undefined;
  if (Buffer.byteLength(current.contents, "utf8") > MAX_RECEIPT_BYTES)
    throw new Error("invalid ECC profile ownership receipt: oversized");
  return { receipt: parseReceipt(current.contents, root), current };
}

export function readEccProfileOwnership(root: string): EccProfileOwnership | undefined {
  return readReceiptFile(root)?.receipt;
}

function sameSource(
  left: EccProfileInstalledSourceTrust,
  right: EccProfileInstalledSourceTrust,
): boolean {
  return (
    recoveryIdentityVersion(left) === recoveryIdentityVersion(right) &&
    left.repository === right.repository &&
    left.commit === right.commit &&
    left.sourceClosureId === right.sourceClosureId &&
    left.sourceClosureSha256 === right.sourceClosureSha256 &&
    left.projectionSha256 === right.projectionSha256
  );
}

function activeReceipt(
  root: string,
  projection: EccProjection,
  files: OwnershipFile[],
  rollback?: EccProfileOwnership["rollback"],
): EccProfileOwnership {
  return {
    schemaVersion: 1,
    state: "active",
    canonicalRoot: canonicalRoot(root),
    source: eccProfileRecoveryIdentity(projection),
    files: [...files].sort(comparePaths),
    ...(rollback === undefined ? {} : { rollback }),
  };
}

function installPlan(
  root: string,
  projection: EccProjection,
  files: RenderedProjectionFile[],
): Plan {
  const receiptFile = readReceiptFile(root);
  if (receiptFile !== undefined) {
    if (!identifiesProjection(receiptFile.receipt.source, projection))
      throw new Error("ECC profile is already owned at a different pin or projection; use update");
    assertReceiptMatchesProjection(receiptFile.receipt, files);
    for (const entry of receiptFile.receipt.files) assertOwnedCurrent(root, entry);
    return plan("ecc-profile: install");
  }
  const actions: Action[] = [];
  const entries: OwnershipFile[] = [];
  for (const file of files) {
    const current = readCurrent(root, file.destination);
    if (file.mergeStrategy === "replace") {
      if (current !== undefined)
        throw new Error(
          `refusing to claim existing unowned ECC profile destination: ${file.destination}`,
        );
      actions.push(
        pinnedWrite(
          file.destination,
          file.content,
          file.mode,
          undefined,
          `install ECC profile ${file.destination}`,
        ),
      );
      entries.push(ownershipEntry(file, file.content, null));
      continue;
    }
    if (current !== undefined && managedBlock(current.contents) !== undefined)
      throw new Error(`refusing ambiguous existing ECC profile managed block: ${file.destination}`);
    const merged = upsertTextBlock(current?.contents ?? "", MANAGED_SCOPE, file.content);
    actions.push(
      pinnedWrite(
        file.destination,
        merged,
        file.mode,
        current,
        `merge ECC profile ${file.destination}`,
      ),
    );
    entries.push(ownershipEntry(file, merged, current?.sha256 ?? null));
  }
  actions.push(receiptWrite(activeReceipt(root, projection, entries), undefined));
  return plan("ecc-profile: install", ...actions);
}

function rollbackSnapshot(
  root: string,
  receipt: EccProfileOwnership,
  allowMissing: boolean,
): RollbackFile[] {
  return receipt.files.map((entry) => {
    const current = assertOwnedCurrent(root, entry);
    // Within an anchored pin the receipt entry is authenticated content, and a
    // superseded installation cannot be repaired first.
    if (current === undefined && allowMissing) return { ...entry };
    if (current === undefined)
      throw new Error(
        `owned ECC profile destination is missing; repair before update: ${entry.destination}`,
      );
    const currentProjected =
      entry.mergeStrategy === "replace" ? current.contents : managedBody(current.contents);
    if (currentProjected === undefined)
      throw new Error(`owned ECC profile managed block is missing: ${entry.destination}`);
    if (currentProjected !== entry.content)
      throw new Error(`owned ECC profile content contradicts receipt: ${entry.destination}`);
    return { ...entry };
  });
}

function updatePlan(
  root: string,
  projection: EccProjection,
  files: RenderedProjectionFile[],
  anchors: readonly EccProfileInstalledSourceTrust[],
): Plan {
  const receiptFile = readReceiptFile(root);
  if (receiptFile === undefined)
    throw new Error("ECC profile update requires an ownership receipt");
  const { receipt, current: currentReceipt } = receiptFile;
  const samePinMigration = receipt.source.commit === projection.source.commit;
  if (samePinMigration) assertSamePinMigration(receipt, projection, anchors);
  const snapshot = rollbackSnapshot(root, receipt, samePinMigration);
  const prior = new Map(receipt.files.map((entry) => [entry.destination, entry]));
  const priorFolded = new Map(
    receipt.files.map((entry) => [entry.destination.toLowerCase(), entry]),
  );
  const nextDestinations = new Set(files.map((file) => file.destination));
  const actions: Action[] = [];
  const entries: OwnershipFile[] = [];

  for (const file of files) {
    const foldedPrevious = priorFolded.get(file.destination.toLowerCase());
    if (foldedPrevious !== undefined && foldedPrevious.destination !== file.destination)
      throw new Error(`ambiguous case-only ECC profile destination update: ${file.destination}`);
    const previous = prior.get(file.destination);
    const current = previous
      ? assertOwnedCurrent(root, previous)
      : readCurrent(root, file.destination);
    if (previous === undefined && file.mergeStrategy === "replace" && current !== undefined)
      throw new Error(
        `refusing to claim existing unowned ECC profile destination: ${file.destination}`,
      );
    if (
      previous === undefined &&
      file.mergeStrategy === "toml-merge" &&
      managedBlock(current?.contents ?? "")
    )
      throw new Error(`refusing ambiguous existing ECC profile managed block: ${file.destination}`);
    const installed =
      file.mergeStrategy === "replace"
        ? file.content
        : upsertTextBlock(current?.contents ?? "", MANAGED_SCOPE, file.content);
    if (current?.contents !== installed) {
      actions.push(
        pinnedWrite(
          file.destination,
          installed,
          file.mode,
          current,
          `update ECC profile ${file.destination}`,
        ),
      );
    }
    entries.push(
      ownershipEntry(
        file,
        installed,
        previous === undefined ? (current?.sha256 ?? null) : previous.previousHash,
      ),
    );
  }

  for (const entry of receipt.files) {
    if (nextDestinations.has(entry.destination)) continue;
    const current = assertOwnedCurrent(root, entry);
    if (current === undefined) continue;
    if (entry.mergeStrategy === "replace") {
      actions.push(
        remove(entry.destination, `remove superseded ECC profile ${entry.destination}`, {
          expect: { sha256: entry.installedHash },
        }),
      );
    } else {
      actions.push(...planManagedBlockRemoval(entry, current, "remove superseded"));
    }
  }

  actions.push(
    receiptWrite(
      activeReceipt(root, projection, entries, { source: receipt.source, files: snapshot }),
      currentReceipt,
    ),
  );
  return plan("ecc-profile: update", ...actions);
}

function repairPlan(
  root: string,
  projection: EccProjection,
  files: RenderedProjectionFile[],
  anchors: readonly EccProfileInstalledSourceTrust[],
): Plan {
  const receiptFile = readReceiptFile(root);
  if (receiptFile === undefined)
    throw new Error("ECC profile repair requires an ownership receipt");
  if (!identifiesProjection(receiptFile.receipt.source, projection))
    throw new Error("ECC profile repair projection contradicts the ownership receipt");
  assertReceiptMatchesProjection(receiptFile.receipt, files);
  assertNotSuperseded(receiptFile.receipt, anchors);
  return repairInstalledPlan(root, receiptFile);
}

function repairInstalledPlan(
  root: string,
  receiptFile: { receipt: EccProfileOwnership; current: CurrentFile },
): Plan {
  const actions: Action[] = [];
  for (const entry of receiptFile.receipt.files) {
    const current = readCurrent(root, entry.destination);
    if (current === undefined) {
      const repaired =
        entry.mergeStrategy === "replace"
          ? entry.content
          : upsertTextBlock("", MANAGED_SCOPE, entry.content);
      actions.push(
        pinnedWrite(
          entry.destination,
          repaired,
          entry.mode,
          undefined,
          `repair ECC profile ${entry.destination}`,
        ),
      );
      continue;
    }
    assertOwnedCurrent(root, entry);
    if (current.mode !== entry.mode && entry.mergeStrategy === "replace") {
      actions.push(
        pinnedWrite(
          entry.destination,
          current.contents,
          entry.mode,
          current,
          `repair ECC profile mode ${entry.destination}`,
        ),
      );
    }
  }
  if (actions.length > 0) {
    actions.push({
      ...pinnedWrite(
        ECC_PROFILE_OWNERSHIP_PATH,
        receiptFile.current.contents,
        "100644",
        receiptFile.current,
        "ECC profile ownership receipt",
      ),
      assertUnchanged: true,
    });
  }
  return plan("ecc-profile: repair", ...actions);
}

function uninstallPlan(
  root: string,
  projection: EccProjection,
  files: RenderedProjectionFile[],
): Plan {
  const receiptFile = readReceiptFile(root);
  if (receiptFile === undefined) return plan("ecc-profile: uninstall");
  if (!identifiesProjection(receiptFile.receipt.source, projection))
    throw new Error("ECC profile uninstall projection contradicts the ownership receipt");
  assertReceiptMatchesProjection(receiptFile.receipt, files);
  return uninstallInstalledPlan(root, receiptFile);
}

function uninstallInstalledPlan(
  root: string,
  receiptFile: { receipt: EccProfileOwnership; current: CurrentFile },
): Plan {
  const actions: Action[] = [];
  for (const entry of receiptFile.receipt.files) {
    const current = assertOwnedCurrent(root, entry);
    if (current === undefined) continue;
    if (entry.mergeStrategy === "replace") {
      actions.push(
        remove(entry.destination, `uninstall ECC profile ${entry.destination}`, {
          expect: { sha256: entry.installedHash },
        }),
      );
      continue;
    }
    actions.push(...planManagedBlockRemoval(entry, current, "uninstall"));
  }
  actions.push(
    remove(ECC_PROFILE_OWNERSHIP_PATH, "remove ECC profile ownership receipt", {
      expect: { sha256: receiptFile.current.sha256 },
    }),
  );
  return plan("ecc-profile: uninstall", ...actions);
}

/**
 * Strip the managed block and keep the destination. A merge destination may
 * hold operator bytes aih never owned, and nothing independently authenticates
 * that aih created the whole file: `previousHash` is per-installation receipt
 * state outside every recovery anchor. So the file is never deleted, even when
 * only whitespace remains, and the write says so.
 */
function planManagedBlockRemoval(
  entry: OwnershipFile,
  current: CurrentFile,
  verb: string,
): Action[] {
  const stripped = removeManagedBlock(current.contents, MANAGED_SCOPE);
  const describe =
    stripped.trim().length === 0
      ? `${verb} ECC profile block ${entry.destination}; kept ${entry.destination}, now only whitespace, because aih cannot prove it created the whole file: remove it by hand if nothing uses it`
      : `${verb} ECC profile block ${entry.destination}`;
  return [pinnedWrite(entry.destination, stripped, entry.mode, current, describe)];
}

function rollbackPlan(
  root: string,
  projection: EccProjection,
  files: RenderedProjectionFile[],
  recoveryAnchors: readonly EccProfileInstalledSourceTrust[],
): Plan {
  const receiptFile = readReceiptFile(root);
  if (receiptFile === undefined)
    throw new Error("ECC profile rollback requires an ownership receipt");
  const { receipt } = receiptFile;
  if (!identifiesProjection(receipt.source, projection))
    throw new Error("ECC profile rollback projection contradicts the ownership receipt");
  assertReceiptMatchesProjection(receipt, files);
  assertRollbackAnchored(receipt, recoveryAnchors);
  return rollbackInstalledPlan(root, receiptFile);
}

function rollbackInstalledPlan(
  root: string,
  receiptFile: { receipt: EccProfileOwnership; current: CurrentFile },
): Plan {
  const { receipt, current: currentReceipt } = receiptFile;
  if (!receipt.rollback) throw new Error("ECC profile ownership receipt has no rollback snapshot");
  const currentEntries = new Map(receipt.files.map((entry) => [entry.destination, entry]));
  const previousEntries = new Map(
    receipt.rollback.files.map((entry) => [entry.destination, entry]),
  );
  const actions: Action[] = [];
  const restored: OwnershipFile[] = [];

  for (const entry of receipt.files) {
    if (previousEntries.has(entry.destination)) continue;
    const current = assertOwnedCurrent(root, entry);
    if (current === undefined) continue;
    if (entry.mergeStrategy === "replace") {
      actions.push(
        remove(entry.destination, `roll back new ECC profile ${entry.destination}`, {
          expect: { sha256: entry.installedHash },
        }),
      );
    } else {
      actions.push(...planManagedBlockRemoval(entry, current, "roll back"));
    }
  }

  for (const previous of receipt.rollback.files) {
    const currentEntry = currentEntries.get(previous.destination);
    const current = currentEntry
      ? assertOwnedCurrent(root, currentEntry)
      : readCurrent(root, previous.destination);
    if (currentEntry === undefined && previous.mergeStrategy === "replace" && current !== undefined)
      throw new Error(
        `refusing to restore over unowned ECC profile destination: ${previous.destination}`,
      );
    const installed =
      previous.mergeStrategy === "replace"
        ? previous.content
        : upsertTextBlock(current?.contents ?? "", MANAGED_SCOPE, previous.content);
    if (current?.contents !== installed) {
      actions.push(
        pinnedWrite(
          previous.destination,
          installed,
          previous.mode,
          current,
          `roll back ECC profile ${previous.destination}`,
        ),
      );
    }
    restored.push({
      ...previous,
      installedHash: sha256(installed),
      managedBlockHash:
        previous.mergeStrategy === "toml-merge" ? sha256(managedBlock(installed) ?? "") : null,
    });
  }

  const restoredReceipt: EccProfileOwnership = {
    schemaVersion: 1,
    state: "active",
    canonicalRoot: receipt.canonicalRoot,
    source: receipt.rollback.source,
    files: restored.sort(comparePaths),
  };
  actions.push(receiptWrite(restoredReceipt, currentReceipt));
  return plan("ecc-profile: rollback", ...actions);
}

/**
 * Plan a lifecycle operation bound to an authenticated projection. The
 * projection authenticates the active installation only; a rollback snapshot
 * must also equal one of the independently anchored `recoveryAnchors`, and so
 * must both identities of an update within the installed pin.
 */
export function planEccProfileLifecycle(
  root: string,
  projection: EccProjection,
  operation: EccProfileLifecycleOperation,
  recoveryAnchors: readonly EccProfileInstalledSourceTrust[] = [],
): Plan {
  assertLifecycleRoot(root);
  const files = validateProjection(root, projection);
  switch (operation) {
    case "install":
      return installPlan(root, projection, files);
    case "update":
      return updatePlan(root, projection, files, recoveryAnchors);
    case "repair":
      return repairPlan(root, projection, files, recoveryAnchors);
    case "uninstall":
      return uninstallPlan(root, projection, files);
    case "rollback":
      return rollbackPlan(root, projection, files, recoveryAnchors);
  }
}

function assertLifecycleRoot(root: string): void {
  if (!isAbsolute(root)) throw new Error("ECC profile lifecycle root must be absolute");
  const rootStats = lstatSync(root);
  if (rootStats.isSymbolicLink() || !rootStats.isDirectory())
    throw new Error("ECC profile lifecycle root must be a real directory");
}

/**
 * Recover or remove the exact installed projection. The bounded ownership
 * receipt is checked against `trustedSources`, the append-only anchored
 * identities: the active source always, and a rollback snapshot as well, before
 * any write is planned.
 */
export function planInstalledEccProfileLifecycle(
  root: string,
  operation: EccProfileInstalledLifecycleOperation,
  trustedSources: readonly EccProfileInstalledSourceTrust[],
): Plan {
  assertLifecycleRoot(root);
  const receiptFile = readReceiptFile(root);
  if (operation === "uninstall" && receiptFile === undefined) return plan("ecc-profile: uninstall");
  if (receiptFile === undefined)
    throw new Error(`ECC profile ${operation} requires an ownership receipt`);
  assertAnchored(
    receiptFile.receipt.source,
    receiptFile.receipt.files,
    trustedSources,
    `ECC profile ${operation}: the installed source identity`,
  );
  if (operation === "rollback") assertRollbackAnchored(receiptFile.receipt, trustedSources);
  if (operation === "repair") assertNotSuperseded(receiptFile.receipt, trustedSources);
  switch (operation) {
    case "repair":
      return repairInstalledPlan(root, receiptFile);
    case "uninstall":
      return uninstallInstalledPlan(root, receiptFile);
    case "rollback":
      return rollbackInstalledPlan(root, receiptFile);
  }
}
