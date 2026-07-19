import { randomBytes } from "node:crypto";
import {
  type BigIntStats,
  closeSync,
  type Dirent,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  opendirSync,
  openSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { containedPath } from "../internals/contained-path.js";
import { readRegularFileWithStats, retryTransient } from "../internals/fsxn.js";
import {
  ActivationRecordSchema,
  canonicalRecordBytes,
  DIGEST_PATTERN,
  type GenerationReceipt,
  GenerationReceiptSchema,
  IncompleteRecordSchema,
  isCanonicalProjectionTarget,
  isLockCandidateName,
  LockOwnerRecordSchema,
  MAX_GENERATED_DIRECTORIES,
  MAX_PAYLOAD_BYTES,
  MAX_PID,
  MAX_RECORD_BYTES,
  MAX_RECOVERY_RECORDS,
  MAX_TARGET_SEGMENTS,
  MAX_WALK_BYTES,
  MAX_WALK_ENTRIES,
  type ReceiptEntry,
  type RootRecord,
  RootRecordSchema,
  STORE_ID_PATTERN,
  STORE_SCHEMA_VERSION,
  StagingRecordSchema,
  type StoreFindingCode,
  type StoreRecordKind,
  sha256Bytes,
  TransactionRecordSchema,
} from "./generation-store-contract.js";

const O_NOFOLLOW = (fsConstants as Record<string, number | undefined>).O_NOFOLLOW ?? 0;
const DIRECTORY_SYNC_UNSUPPORTED = new Set(["EBADF", "EINVAL", "EISDIR", "ENOTSUP", "EPERM"]);
const TRANSACTION_FILENAME_PATTERN = /^([0-9a-f]{64})\.json$/;
const TRANSACTION_TEMP_PATTERN = /^\.([0-9a-f]{64})\.([a-z][a-z-]{0,63})\.tmp$/;
const ACTIVE_TEMP_PATTERN = /^\.active\.([0-9a-f]{64})\.tmp$/;
const LOCK_CANDIDATE_PATTERN = /^[0-9a-f]{64}(?:\.stale)?$/;
const LOCK_PENDING_CANDIDATE_PATTERN = /^[0-9a-f]{64}\.pending\.([1-9][0-9]{0,9})$/;
const LOCK_DELETING_CANDIDATE_PATTERN = /^[0-9a-f]{64}\.deleting\.([1-9][0-9]{0,9})$/;
const FIXED_ROOT_ENTRIES = new Set([
  "root.json",
  "active.json",
  "lock",
  "lock-candidates",
  "transactions",
  "staging",
  "generations",
  "trash",
]);
const APPLY_NEXT_PHASE: Readonly<Record<string, string | undefined>> = Object.freeze({
  prepared: "staged",
  staged: "generation-reserved",
  "generation-reserved": "generation-verified",
  "generation-verified": "activation-committed",
  "activation-committed": "committed",
});
const CLEAN_NEXT_PHASE: Readonly<Record<string, string | undefined>> = Object.freeze({
  prepared: "quarantined",
  quarantined: "deleting",
  deleting: "committed",
});

export type StoreLayout = Readonly<{
  projectRoot: string;
  projectDevice: string;
  root: string;
  rootRecord: string;
  active: string;
  lock: string;
  lockCandidates: string;
  transactions: string;
  staging: string;
  generations: string;
  trash: string;
}>;

export type OwnedStore = Readonly<{
  layout: StoreLayout;
  rootRecord: RootRecord;
}>;

export type FixedGenerationLayout = Readonly<{
  manifestDigest: string;
  entries: readonly string[];
}>;

export type FixedStoreLayoutInventory = Readonly<{
  activePresent: boolean;
  lockPresent: boolean;
  lockCandidates: readonly string[];
  transactions: readonly string[];
  staging: readonly string[];
  generations: readonly FixedGenerationLayout[];
  trash: readonly string[];
}>;

export type RecoveryTransactionTemporary = Readonly<{
  transactionId: string;
  phase: string;
}>;

export type RecoveryStoreLayoutInventory = FixedStoreLayoutInventory &
  Readonly<{
    activationTemporaries: readonly string[];
    transactionTemporaries: readonly RecoveryTransactionTemporary[];
  }>;

export type StoreObjectIdentity = Readonly<{
  dev: string;
  ino: string;
  mode: string;
  nlink: string;
  size: string;
  mtimeNs: string;
  ctimeNs: string;
}>;

export type VerifiedFile = Readonly<{
  relativePath: string;
  digest: string;
  bytes: number;
  identity: StoreObjectIdentity;
}>;

export type VerifiedDirectory = Readonly<{
  relativePath: string;
  identity: StoreObjectIdentity;
}>;

export type VerifiedContainerKind = "receipt" | "staging" | "incomplete";

export type VerifiedContainer = Readonly<{
  metadataKind: VerifiedContainerKind;
  metadataName: "receipt.json" | "staging.json" | "incomplete.json";
  metadataCanonical: string;
  rootId: string;
  sourceName: string;
  transactionId: string | null;
}>;

export type VerifiedTree = Readonly<{
  root: string;
  entries: readonly ReceiptEntry[];
  files: readonly VerifiedFile[];
  directories: readonly VerifiedDirectory[];
  missing: readonly string[];
  container: VerifiedContainer | null;
}>;

/** Mutable aggregate limits shared explicitly across one bounded inspection. */
export type StoreWalkBudget = {
  entries: number;
  bytes: number;
  directories: number;
};

export function createStoreWalkBudget(): StoreWalkBudget {
  return { entries: 0, bytes: 0, directories: 0 };
}

export type ExclusiveWriteResult = Readonly<{
  digest: string;
  bytes: number;
  identity: StoreObjectIdentity;
}>;

export type StoredRecordRead<T> = Readonly<{
  record: T;
  bytes: Buffer;
  identity: StoreObjectIdentity;
}>;

type RecordSchema<T> = Readonly<{ parse: (value: unknown) => T }>;

export type AtomicRecordWrite = Readonly<{
  kind: StoreRecordKind;
  targetPath: string;
  temporaryPath: string;
  record: unknown;
  mode?: "replace" | "create";
}>;

export class GenerationStoreFsError extends Error {
  readonly findingCode: StoreFindingCode;

  constructor(message: string, findingCode: StoreFindingCode = "METHODOLOGY_STORE_PATH_UNSAFE") {
    super(message);
    this.name = "GenerationStoreFsError";
    this.findingCode = findingCode;
  }
}

function fail(
  message: string,
  findingCode: StoreFindingCode = "METHODOLOGY_STORE_PATH_UNSAFE",
): never {
  throw new GenerationStoreFsError(message, findingCode);
}

function errnoCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

function missing(error: unknown): boolean {
  return errnoCode(error) === "ENOENT";
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isLockCandidateLayoutName(name: string): boolean {
  if (LOCK_CANDIDATE_PATTERN.test(name)) return true;
  const transient =
    LOCK_PENDING_CANDIDATE_PATTERN.exec(name) ?? LOCK_DELETING_CANDIDATE_PATTERN.exec(name);
  if (transient?.[1] === undefined) return false;
  const pid = Number(transient[1]);
  return Number.isSafeInteger(pid) && pid <= MAX_PID;
}

function comparablePath(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function pathsEqual(left: string, right: string): boolean {
  return comparablePath(left) === comparablePath(right);
}

function identity(stats: BigIntStats): StoreObjectIdentity {
  return Object.freeze({
    dev: stats.dev.toString(10),
    ino: stats.ino.toString(10),
    mode: stats.mode.toString(10),
    nlink: stats.nlink.toString(10),
    size: stats.size.toString(10),
    mtimeNs: stats.mtimeNs.toString(10),
    ctimeNs: stats.ctimeNs.toString(10),
  });
}

function sameIdentity(left: StoreObjectIdentity, right: StoreObjectIdentity): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function sameDirectoryObject(left: StoreObjectIdentity, right: StoreObjectIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode;
}

function lstatBigInt(absPath: string, label: string): BigIntStats {
  try {
    return lstatSync(absPath, { bigint: true });
  } catch {
    fail(`${label} is inaccessible`);
  }
}

function requireCanonicalProject(projectRoot: string): Readonly<{
  canonicalRoot: string;
  projectDevice: string;
}> {
  if (!isAbsolute(projectRoot) || !pathsEqual(projectRoot, normalize(projectRoot))) {
    fail("project root must be an absolute normalized path");
  }
  const stats = lstatBigInt(projectRoot, "project root");
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    fail("project root must be an ordinary directory");
  }
  let canonicalRoot: string;
  try {
    canonicalRoot = realpathSync(projectRoot);
  } catch {
    fail("project root realpath is inaccessible");
  }
  if (!pathsEqual(canonicalRoot, projectRoot)) {
    fail("project root must already be its canonical realpath");
  }
  return Object.freeze({
    canonicalRoot,
    projectDevice: stats.dev.toString(10),
  });
}

export function layoutForCanonicalProject(
  canonicalProjectRoot: string,
  capturedProjectDevice: string,
): StoreLayout {
  const root = resolve(canonicalProjectRoot, ".aih", "methodology", "v1");
  return Object.freeze({
    projectRoot: canonicalProjectRoot,
    projectDevice: capturedProjectDevice,
    root,
    rootRecord: join(root, "root.json"),
    active: join(root, "active.json"),
    lock: join(root, "lock"),
    lockCandidates: join(root, "lock-candidates"),
    transactions: join(root, "transactions"),
    staging: join(root, "staging"),
    generations: join(root, "generations"),
    trash: join(root, "trash"),
  });
}

function fixedAncestors(layout: StoreLayout): readonly string[] {
  return [
    join(layout.projectRoot, ".aih"),
    join(layout.projectRoot, ".aih", "methodology"),
    layout.root,
  ];
}

function validateOrdinaryDirectory(
  projectRoot: string,
  projectDevice: string,
  absPath: string,
  label: string,
  permissionPolicy: "private" | "shared" = "private",
): StoreObjectIdentity {
  const stats = lstatBigInt(absPath, label);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    fail(`${label} must be an ordinary directory`);
  }
  if (process.platform !== "win32") {
    const directoryMode = stats.mode & 0o777n;
    const unsafePermissions =
      (permissionPolicy === "private" && directoryMode !== 0o700n) ||
      (permissionPolicy === "shared" && (directoryMode & 0o022n) !== 0n);
    if (unsafePermissions) fail(`${label} has unsafe directory permissions`);
  }
  if (stats.dev.toString(10) !== projectDevice) {
    fail(`${label} changed device`);
  }
  let resolved: string;
  try {
    resolved = realpathSync(absPath);
  } catch {
    fail(`${label} realpath is inaccessible`);
  }
  if (!pathsEqual(resolved, absPath) || !containedPath(projectRoot, resolved)) {
    fail(`${label} escaped or changed realpath`);
  }
  return identity(stats);
}

function lstatIfPresent(absPath: string): BigIntStats | undefined {
  try {
    return lstatSync(absPath, { bigint: true });
  } catch (error) {
    if (missing(error)) return undefined;
    fail("filesystem object is inaccessible");
  }
}

function createOrValidateDirectory(
  projectRoot: string,
  projectDevice: string,
  absPath: string,
  permissionPolicy: "private" | "shared",
): boolean {
  let created = false;
  if (lstatIfPresent(absPath) === undefined) {
    try {
      mkdirSync(absPath, { mode: 0o700 });
      created = true;
    } catch (error) {
      if (errnoCode(error) !== "EEXIST") throw error;
    }
  }
  validateOrdinaryDirectory(
    projectRoot,
    projectDevice,
    absPath,
    "store ancestor",
    permissionPolicy,
  );
  return created;
}

function syncDirectory(absPath: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(absPath, fsConstants.O_RDONLY);
    fsyncSync(descriptor);
  } catch (error) {
    const code = errnoCode(error);
    if (code === undefined || !DIRECTORY_SYNC_UNSUPPORTED.has(code)) {
      throw error;
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function rawExclusiveWrite(absPath: string, bytes: Uint8Array): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      absPath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | O_NOFOLLOW,
      0o600,
    );
    const opened = fstatSync(descriptor, { bigint: true });
    if (
      !opened.isFile() ||
      opened.isSymbolicLink() ||
      opened.nlink !== 1n ||
      (process.platform !== "win32" && (opened.mode & 0o777n) !== 0o600n)
    ) {
      fail("exclusive write did not open a single-link regular file");
    }
    writeFileSync(descriptor, Buffer.from(bytes));
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function invalidRecordFinding(kind: StoreRecordKind): StoreFindingCode {
  switch (kind) {
    case "root":
      return "METHODOLOGY_STORE_ROOT_UNOWNED";
    case "activation":
      return "METHODOLOGY_STORE_ACTIVATION_INVALID";
    case "lock-owner":
      return "METHODOLOGY_STORE_LOCK_INVALID";
    case "receipt":
    case "incomplete":
      return "METHODOLOGY_STORE_GENERATION_INCOMPLETE";
    case "staging":
    case "transaction":
      return "METHODOLOGY_STORE_TRANSACTION_INVALID";
  }
}

function parseCanonicalRecord<T>(
  absPath: string,
  projectRoot: string,
  projectDevice: string,
  schema: RecordSchema<T>,
  kind: StoreRecordKind,
): StoredRecordRead<T> {
  const beforeStats = lstatBigInt(absPath, "record");
  if (
    beforeStats.isSymbolicLink() ||
    !beforeStats.isFile() ||
    beforeStats.nlink !== 1n ||
    (process.platform !== "win32" && (beforeStats.mode & 0o777n) !== 0o600n) ||
    beforeStats.dev.toString(10) !== projectDevice ||
    beforeStats.size > BigInt(MAX_RECORD_BYTES)
  ) {
    fail("record must be a bounded single-link regular file");
  }
  let resolved: string;
  try {
    resolved = realpathSync(absPath);
  } catch {
    fail("record realpath is inaccessible");
  }
  if (!pathsEqual(resolved, absPath) || !containedPath(projectRoot, resolved)) {
    fail("record escaped or changed realpath");
  }
  let opened: ReturnType<typeof readRegularFileWithStats>;
  try {
    opened = readRegularFileWithStats(absPath, { maxBytes: MAX_RECORD_BYTES });
  } catch {
    fail("record descriptor read failed", "METHODOLOGY_STORE_FILESYSTEM_FAILURE");
  }
  if (opened === undefined) {
    fail("record descriptor could not be opened", "METHODOLOGY_STORE_FILESYSTEM_FAILURE");
  }
  if (
    opened.stats.nlink !== 1 ||
    (process.platform !== "win32" && (opened.stats.mode & 0o777) !== 0o600) ||
    opened.stats.dev.toString(10) !== projectDevice ||
    opened.contents.byteLength !== opened.stats.size
  ) {
    fail("record descriptor validation failed");
  }
  const afterStats = lstatBigInt(absPath, "record");
  const beforeIdentity = identity(beforeStats);
  const afterIdentity = identity(afterStats);
  if (!sameIdentity(beforeIdentity, afterIdentity)) {
    fail("record identity changed while reading");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(opened.contents.toString("utf8"));
  } catch {
    fail("record JSON is malformed", invalidRecordFinding(kind));
  }
  let record: T;
  try {
    record = schema.parse(decoded);
  } catch {
    fail("record schema is invalid", invalidRecordFinding(kind));
  }
  const canonical = canonicalRecordBytes(kind, record);
  if (!canonical.equals(opened.contents)) {
    fail("record bytes are not canonical", invalidRecordFinding(kind));
  }
  return Object.freeze({
    record,
    bytes: Buffer.from(opened.contents),
    identity: afterIdentity,
  });
}

function readRootRecord(layout: StoreLayout): RootRecord {
  const read = parseCanonicalRecord(
    layout.rootRecord,
    layout.projectRoot,
    layout.projectDevice,
    RootRecordSchema,
    "root",
  );
  if (read.record.rootDevice !== layout.projectDevice) {
    fail("root marker device does not match the project");
  }
  return Object.freeze({ ...read.record });
}

function ownedStore(layout: StoreLayout, rootRecord: RootRecord): OwnedStore {
  return Object.freeze({
    layout,
    rootRecord: Object.freeze({ ...rootRecord }),
  });
}

export function openStoreForInspection(projectRoot: string): OwnedStore | undefined {
  const project = requireCanonicalProject(projectRoot);
  const layout = layoutForCanonicalProject(project.canonicalRoot, project.projectDevice);
  for (const ancestor of fixedAncestors(layout)) {
    if (lstatIfPresent(ancestor) === undefined) return undefined;
    validateOrdinaryDirectory(
      layout.projectRoot,
      layout.projectDevice,
      ancestor,
      "store ancestor",
      pathsEqual(ancestor, layout.root) ? "private" : "shared",
    );
  }
  if (lstatIfPresent(layout.rootRecord) === undefined) {
    fail("owned store is missing its root marker", "METHODOLOGY_STORE_ROOT_UNOWNED");
  }
  return ownedStore(layout, readRootRecord(layout));
}

export function createOrOpenOwnedStore(projectRoot: string): OwnedStore {
  const project = requireCanonicalProject(projectRoot);
  const layout = layoutForCanonicalProject(project.canonicalRoot, project.projectDevice);
  const ancestors = fixedAncestors(layout);
  createOrValidateDirectory(
    layout.projectRoot,
    layout.projectDevice,
    ancestors[0] as string,
    "shared",
  );
  createOrValidateDirectory(
    layout.projectRoot,
    layout.projectDevice,
    ancestors[1] as string,
    "shared",
  );
  const createdRoot = createOrValidateDirectory(
    layout.projectRoot,
    layout.projectDevice,
    layout.root,
    "private",
  );
  if (createdRoot) {
    const record: RootRecord = {
      schemaVersion: STORE_SCHEMA_VERSION,
      rootId: randomBytes(32).toString("hex"),
      rootDevice: layout.projectDevice,
    };
    try {
      rawExclusiveWrite(layout.rootRecord, canonicalRecordBytes("root", record));
      syncDirectory(layout.root);
    } catch (error) {
      if (errnoCode(error) !== "EEXIST") throw error;
    }
    return ownedStore(layout, readRootRecord(layout));
  }
  if (lstatIfPresent(layout.rootRecord) === undefined) {
    fail("an existing v1 directory is not an owned store", "METHODOLOGY_STORE_ROOT_UNOWNED");
  }
  return ownedStore(layout, readRootRecord(layout));
}

function layoutMatchesExpected(layout: StoreLayout): boolean {
  const expected = layoutForCanonicalProject(layout.projectRoot, layout.projectDevice);
  for (const key of Object.keys(expected) as (keyof StoreLayout)[]) {
    if (!pathsEqual(layout[key], expected[key])) return false;
  }
  return true;
}

export function assertOwnedStorePhase(store: OwnedStore): void {
  const project = requireCanonicalProject(store.layout.projectRoot);
  if (
    project.projectDevice !== store.layout.projectDevice ||
    !layoutMatchesExpected(store.layout) ||
    store.rootRecord.rootDevice !== store.layout.projectDevice
  ) {
    fail("owned store identity changed", "METHODOLOGY_STORE_ROOT_UNOWNED");
  }
  for (const ancestor of fixedAncestors(store.layout)) {
    validateOrdinaryDirectory(
      store.layout.projectRoot,
      store.layout.projectDevice,
      ancestor,
      "store ancestor",
      pathsEqual(ancestor, store.layout.root) ? "private" : "shared",
    );
  }
  const record = readRootRecord(store.layout);
  if (
    record.rootId !== store.rootRecord.rootId ||
    record.rootDevice !== store.rootRecord.rootDevice
  ) {
    fail("root marker identity changed", "METHODOLOGY_STORE_ROOT_UNOWNED");
  }
}

function inventoryDirectory(
  store: OwnedStore,
  absPath: string,
  label: string,
  limit = MAX_RECOVERY_RECORDS,
): readonly Dirent[] | undefined {
  if (lstatIfPresent(absPath) === undefined) return undefined;
  validateOrdinaryDirectory(store.layout.root, store.layout.projectDevice, absPath, label);
  let directory: ReturnType<typeof opendirSync>;
  try {
    directory = opendirSync(absPath);
  } catch {
    fail(`${label} is inaccessible`, "METHODOLOGY_STORE_FILESYSTEM_FAILURE");
  }
  const entries: Dirent[] = [];
  try {
    for (;;) {
      const entry = directory.readSync();
      if (entry === null) break;
      if (entries.length >= limit) {
        fail(`${label} exceeds its inventory limit`, "METHODOLOGY_STORE_RESOURCE_LIMIT");
      }
      entries.push(entry);
    }
  } catch (error) {
    if (error instanceof GenerationStoreFsError) throw error;
    fail(`${label} inventory failed`, "METHODOLOGY_STORE_FILESYSTEM_FAILURE");
  } finally {
    try {
      directory.closeSync();
    } catch {
      fail(`${label} inventory close failed`, "METHODOLOGY_STORE_FILESYSTEM_FAILURE");
    }
  }
  return Object.freeze([...entries].sort((left, right) => compareStrings(left.name, right.name)));
}

function validateInventoryRegularFile(
  store: OwnedStore,
  absPath: string,
  dirent: Dirent | undefined,
  label: string,
): void {
  const stats = lstatBigInt(absPath, label);
  if (
    dirent?.isSymbolicLink() === true ||
    stats.isSymbolicLink() ||
    (dirent !== undefined && !dirent.isFile()) ||
    !stats.isFile() ||
    stats.nlink !== 1n ||
    (process.platform !== "win32" && (stats.mode & 0o777n) !== 0o600n) ||
    stats.dev.toString(10) !== store.layout.projectDevice ||
    stats.size > BigInt(MAX_RECORD_BYTES)
  ) {
    fail(`${label} must be a bounded single-link regular file`);
  }
  let resolved: string;
  try {
    resolved = realpathSync(absPath);
  } catch {
    fail(`${label} realpath is inaccessible`);
  }
  if (!pathsEqual(resolved, absPath) || !containedPath(store.layout.root, resolved)) {
    fail(`${label} escaped or changed realpath`);
  }
}

function validateInventoryDirectory(
  store: OwnedStore,
  parent: string,
  entry: Dirent,
  label: string,
): string {
  const absPath = join(parent, entry.name);
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    fail(`${label} must be an ordinary directory`);
  }
  validateOrdinaryDirectory(store.layout.root, store.layout.projectDevice, absPath, label);
  return absPath;
}

function countInventory(total: number, count: number): number {
  const next = total + count;
  if (next > MAX_RECOVERY_RECORDS) {
    fail("fixed layout exceeds its inventory limit", "METHODOLOGY_STORE_RESOURCE_LIMIT");
  }
  return next;
}

function inspectStoreLayout(
  store: OwnedStore,
  allowRecoveryTemporaries: boolean,
): RecoveryStoreLayoutInventory {
  assertOwnedStorePhase(store);
  const rootEntries = inventoryDirectory(
    store,
    store.layout.root,
    "store root",
    MAX_RECOVERY_RECORDS + FIXED_ROOT_ENTRIES.size,
  );
  if (rootEntries === undefined) {
    fail("owned store root disappeared", "METHODOLOGY_STORE_ROOT_UNOWNED");
  }
  const activationTemporaries: string[] = [];
  for (const entry of rootEntries) {
    if (FIXED_ROOT_ENTRIES.has(entry.name)) continue;
    const temporary = allowRecoveryTemporaries ? ACTIVE_TEMP_PATTERN.exec(entry.name) : null;
    if (temporary?.[1] === undefined) fail("store root contains an unexpected entry");
    validateInventoryRegularFile(
      store,
      join(store.layout.root, entry.name),
      entry,
      "activation temporary",
    );
    activationTemporaries.push(temporary[1]);
  }

  const activePresent = lstatIfPresent(store.layout.active) !== undefined;
  if (activePresent) {
    validateInventoryRegularFile(store, store.layout.active, undefined, "activation record");
  }

  let inventoryCount = 0;
  const lockEntries = inventoryDirectory(store, store.layout.lock, "cooperative lock");
  if (lockEntries !== undefined) {
    for (const entry of lockEntries) {
      if (entry.name !== "owner.json") fail("cooperative lock contains an unexpected entry");
      validateInventoryRegularFile(
        store,
        join(store.layout.lock, entry.name),
        entry,
        "cooperative lock owner",
      );
    }
  }

  const candidateEntries = inventoryDirectory(
    store,
    store.layout.lockCandidates,
    "lock candidates",
  );
  const lockCandidates: string[] = [];
  for (const entry of candidateEntries ?? []) {
    if (!isLockCandidateLayoutName(entry.name)) fail("lock candidate name is unsafe");
    const candidateRoot = validateInventoryDirectory(
      store,
      store.layout.lockCandidates,
      entry,
      "lock candidate",
    );
    const children = inventoryDirectory(store, candidateRoot, "lock candidate");
    for (const child of children ?? []) {
      if (child.name !== "owner.json") fail("lock candidate contains an unexpected entry");
      validateInventoryRegularFile(
        store,
        join(candidateRoot, child.name),
        child,
        "lock candidate owner",
      );
    }
    lockCandidates.push(entry.name);
  }
  inventoryCount = countInventory(inventoryCount, lockCandidates.length);

  const transactionEntries = inventoryDirectory(store, store.layout.transactions, "transactions");
  const transactions: string[] = [];
  const transactionTemporaries: RecoveryTransactionTemporary[] = [];
  for (const entry of transactionEntries ?? []) {
    const match = TRANSACTION_FILENAME_PATTERN.exec(entry.name);
    const temporary = allowRecoveryTemporaries ? TRANSACTION_TEMP_PATTERN.exec(entry.name) : null;
    if (match?.[1] === undefined && (temporary?.[1] === undefined || temporary[2] === undefined)) {
      fail("transaction filename is unsafe");
    }
    validateInventoryRegularFile(
      store,
      join(store.layout.transactions, entry.name),
      entry,
      "transaction record",
    );
    if (match?.[1] !== undefined) {
      transactions.push(match[1]);
    } else if (temporary?.[1] !== undefined && temporary[2] !== undefined) {
      transactionTemporaries.push(
        Object.freeze({ transactionId: temporary[1], phase: temporary[2] }),
      );
    }
  }
  inventoryCount = countInventory(
    inventoryCount,
    transactions.length + transactionTemporaries.length + activationTemporaries.length,
  );

  const directoryIds = (absPath: string, label: string): readonly string[] => {
    const entries = inventoryDirectory(store, absPath, label);
    const ids: string[] = [];
    for (const entry of entries ?? []) {
      if (!STORE_ID_PATTERN.test(entry.name)) fail(`${label} name is unsafe`);
      validateInventoryDirectory(store, absPath, entry, label);
      ids.push(entry.name);
    }
    inventoryCount = countInventory(inventoryCount, ids.length);
    return Object.freeze(ids);
  };

  const staging = directoryIds(store.layout.staging, "staging");
  const generationEntries = inventoryDirectory(
    store,
    store.layout.generations,
    "generations",
    MAX_WALK_ENTRIES,
  );
  const generations: FixedGenerationLayout[] = [];
  for (const entry of generationEntries ?? []) {
    if (!DIGEST_PATTERN.test(entry.name)) fail("generation name is unsafe");
    const generationRoot = validateInventoryDirectory(
      store,
      store.layout.generations,
      entry,
      "generation",
    );
    const children = inventoryDirectory(store, generationRoot, "generation");
    const names: string[] = [];
    for (const child of children ?? []) {
      if (child.name === "content") {
        validateInventoryDirectory(store, generationRoot, child, "generation content");
      } else if (child.name === "receipt.json" || child.name === "incomplete.json") {
        validateInventoryRegularFile(
          store,
          join(generationRoot, child.name),
          child,
          "generation metadata",
        );
      } else {
        fail("generation contains an unexpected entry");
      }
      names.push(child.name);
    }
    generations.push(Object.freeze({ manifestDigest: entry.name, entries: Object.freeze(names) }));
    const completed = names.length === 2 && names[0] === "content" && names[1] === "receipt.json";
    if (!completed) inventoryCount = countInventory(inventoryCount, 1);
  }
  const trash = directoryIds(store.layout.trash, "trash");
  void inventoryCount;

  return Object.freeze({
    activePresent,
    lockPresent: lockEntries !== undefined,
    lockCandidates: Object.freeze(lockCandidates),
    transactions: Object.freeze(transactions),
    staging,
    generations: Object.freeze(generations),
    trash,
    activationTemporaries: Object.freeze(activationTemporaries),
    transactionTemporaries: Object.freeze(transactionTemporaries),
  });
}

/** Reads only fixed store paths. It never creates state, locks, or follows a caller path. */
export function inspectFixedStoreLayout(store: OwnedStore): FixedStoreLayoutInventory {
  const inventory = inspectStoreLayout(store, false);
  return Object.freeze({
    activePresent: inventory.activePresent,
    lockPresent: inventory.lockPresent,
    lockCandidates: inventory.lockCandidates,
    transactions: inventory.transactions,
    staging: inventory.staging,
    generations: inventory.generations,
    trash: inventory.trash,
  });
}

/** Recovery-only inventory that recognizes, but does not trust, deterministic record temporaries. */
export function inspectRecoveryStoreLayout(store: OwnedStore): RecoveryStoreLayoutInventory {
  return inspectStoreLayout(store, true);
}

function assertLexicallyOwned(store: OwnedStore, absPath: string, allowRoot = false): void {
  if (!isAbsolute(absPath) || !pathsEqual(absPath, normalize(absPath))) {
    fail("owned path must be absolute and normalized");
  }
  if (!containedPath(store.layout.root, absPath)) {
    fail("owned path escapes the generation store");
  }
  if (!allowRoot && pathsEqual(absPath, store.layout.root)) {
    fail("operation may not target the store root");
  }
}

function assertOwnedAncestors(store: OwnedStore, absPath: string): void {
  assertLexicallyOwned(store, absPath);
  const parent = dirname(absPath);
  assertLexicallyOwned(store, parent, true);
  const rel = relative(store.layout.root, parent);
  let current = store.layout.root;
  if (rel === "") return;
  for (const segment of rel.split(/[\\/]/u)) {
    if (segment.length === 0 || segment === "." || segment === "..") {
      fail("owned ancestor path is non-canonical");
    }
    current = join(current, segment);
    validateOrdinaryDirectory(
      store.layout.projectRoot,
      store.layout.projectDevice,
      current,
      "owned ancestor",
    );
  }
}

function readOwnedRegularFile(
  store: OwnedStore,
  absPath: string,
  maxBytes: number,
): Readonly<{ contents: Buffer; identity: StoreObjectIdentity }> {
  assertOwnedAncestors(store, absPath);
  const before = lstatBigInt(absPath, "owned file");
  if (
    before.isSymbolicLink() ||
    !before.isFile() ||
    before.nlink !== 1n ||
    (process.platform !== "win32" && (before.mode & 0o777n) !== 0o600n) ||
    before.dev.toString(10) !== store.layout.projectDevice ||
    before.size > BigInt(maxBytes)
  ) {
    fail("owned file is not a bounded single-link regular file");
  }
  let resolved: string;
  try {
    resolved = realpathSync(absPath);
  } catch {
    fail("owned file realpath is inaccessible");
  }
  if (!pathsEqual(resolved, absPath) || !containedPath(store.layout.root, resolved)) {
    fail("owned file escaped or changed realpath");
  }
  const opened = readRegularFileWithStats(absPath, { maxBytes });
  if (
    opened === undefined ||
    opened.stats.nlink !== 1 ||
    (process.platform !== "win32" && (opened.stats.mode & 0o777) !== 0o600) ||
    opened.stats.dev.toString(10) !== store.layout.projectDevice ||
    opened.contents.byteLength !== opened.stats.size
  ) {
    fail("owned descriptor validation failed");
  }
  const after = lstatBigInt(absPath, "owned file");
  const beforeIdentity = identity(before);
  const afterIdentity = identity(after);
  if (!sameIdentity(beforeIdentity, afterIdentity)) {
    fail("owned file identity changed while reading");
  }
  return Object.freeze({ contents: Buffer.from(opened.contents), identity: afterIdentity });
}

export function writeExclusiveRegularFile(
  store: OwnedStore,
  absPath: string,
  bytes: Uint8Array,
): ExclusiveWriteResult {
  assertOwnedStorePhase(store);
  if (bytes.byteLength > MAX_PAYLOAD_BYTES) {
    fail("exclusive write exceeds its byte limit", "METHODOLOGY_STORE_RESOURCE_LIMIT");
  }
  assertOwnedAncestors(store, absPath);
  rawExclusiveWrite(absPath, bytes);
  const opened = readOwnedRegularFile(store, absPath, bytes.byteLength);
  if (
    opened.contents.byteLength !== bytes.byteLength ||
    !opened.contents.equals(Buffer.from(bytes))
  ) {
    fail("exclusive write verification failed", "METHODOLOGY_STORE_FILESYSTEM_FAILURE");
  }
  syncDirectory(dirname(absPath));
  return Object.freeze({
    digest: sha256Bytes(opened.contents),
    bytes: opened.contents.byteLength,
    identity: opened.identity,
  });
}

export function ensureOwnedDirectory(store: OwnedStore, absPath: string): boolean {
  assertOwnedStorePhase(store);
  assertLexicallyOwned(store, absPath);
  assertOwnedAncestors(store, absPath);
  let created = false;
  try {
    mkdirSync(absPath, { mode: 0o700 });
    created = true;
  } catch (error) {
    if (errnoCode(error) !== "EEXIST") {
      fail("owned directory creation failed", "METHODOLOGY_STORE_FILESYSTEM_FAILURE");
    }
  }
  validateOrdinaryDirectory(
    store.layout.root,
    store.layout.projectDevice,
    absPath,
    "owned directory",
  );
  if (created) syncDirectory(dirname(absPath));
  return created;
}

export function createExclusiveOwnedDirectory(store: OwnedStore, absPath: string): void {
  assertOwnedStorePhase(store);
  assertLexicallyOwned(store, absPath);
  assertOwnedAncestors(store, absPath);
  try {
    mkdirSync(absPath, { mode: 0o700 });
  } catch (error) {
    if (errnoCode(error) === "EEXIST") {
      fail("exclusive owned directory already exists", "METHODOLOGY_STORE_TRANSACTION_INVALID");
    }
    fail("exclusive owned directory creation failed", "METHODOLOGY_STORE_FILESYSTEM_FAILURE");
  }
  validateOrdinaryDirectory(
    store.layout.root,
    store.layout.projectDevice,
    absPath,
    "owned directory",
  );
  syncDirectory(dirname(absPath));
}

function inferRecordKind(absPath: string): StoreRecordKind {
  const name = basename(absPath);
  if (name === "root.json") return "root";
  if (name === "active.json") return "activation";
  if (name === "receipt.json") return "receipt";
  if (name === "incomplete.json") return "incomplete";
  if (name === "staging.json") return "staging";
  if (name === "owner.json") return "lock-owner";
  if (TRANSACTION_FILENAME_PATTERN.test(name)) return "transaction";
  fail("record kind cannot be inferred");
}

export function readStoreRecord<T>(
  store: OwnedStore,
  absPath: string,
  schema: RecordSchema<T>,
  kind: StoreRecordKind = inferRecordKind(absPath),
): StoredRecordRead<T> {
  assertOwnedStorePhase(store);
  assertOwnedAncestors(store, absPath);
  const read = parseCanonicalRecord(
    absPath,
    store.layout.projectRoot,
    store.layout.projectDevice,
    schema,
    kind,
  );
  assertRecordPathBinding(store, absPath, kind, read.record);
  return read;
}

export function readRecoveryTemporaryRecord<T>(
  store: OwnedStore,
  absPath: string,
  schema: RecordSchema<T>,
  kind: "activation" | "transaction",
): StoredRecordRead<T> {
  assertOwnedStorePhase(store);
  assertOwnedAncestors(store, absPath);
  const name = basename(absPath);
  const activation = kind === "activation" ? ACTIVE_TEMP_PATTERN.exec(name) : null;
  const transaction = kind === "transaction" ? TRANSACTION_TEMP_PATTERN.exec(name) : null;
  if (
    (kind === "activation" &&
      (activation?.[1] === undefined || !pathsEqual(dirname(absPath), store.layout.root))) ||
    (kind === "transaction" &&
      (transaction?.[1] === undefined ||
        transaction[2] === undefined ||
        !pathsEqual(dirname(absPath), store.layout.transactions)))
  ) {
    fail("recovery temporary path is not canonical");
  }
  const read = parseCanonicalRecord(
    absPath,
    store.layout.projectRoot,
    store.layout.projectDevice,
    schema,
    kind,
  );
  if (kind === "transaction") {
    const parsed = TransactionRecordSchema.parse(read.record);
    if (
      transaction?.[1] !== parsed.transactionId ||
      transaction[2] !== parsed.phase ||
      parsed.rootId !== store.rootRecord.rootId
    ) {
      fail("recovery transaction temporary is not record-bound");
    }
  }
  return read;
}

export function removeExactRecoveryTemporary(
  store: OwnedStore,
  absPath: string,
  kind: "activation" | "transaction",
  expectedRecord: unknown,
): void {
  assertOwnedStorePhase(store);
  const schema: RecordSchema<unknown> =
    kind === "activation" ? ActivationRecordSchema : TransactionRecordSchema;
  let parsed: unknown;
  try {
    parsed = schema.parse(expectedRecord);
  } catch {
    fail("recovery temporary expectation is invalid", invalidRecordFinding(kind));
  }
  const expectedBytes = canonicalRecordBytes(kind, parsed);
  const current = readRecoveryTemporaryRecord(store, absPath, schema, kind);
  if (!current.bytes.equals(expectedBytes)) {
    fail("recovery temporary changed before removal", invalidRecordFinding(kind));
  }
  const finalIdentity = identity(lstatBigInt(absPath, "recovery temporary"));
  if (!sameIdentity(current.identity, finalIdentity)) {
    fail("recovery temporary identity changed before removal", invalidRecordFinding(kind));
  }
  try {
    unlinkSync(absPath);
  } catch {
    fail("recovery temporary removal failed", "METHODOLOGY_STORE_FILESYSTEM_FAILURE");
  }
  syncDirectory(dirname(absPath));
}

export function removeExactStoreRecord(
  store: OwnedStore,
  absPath: string,
  kind: Extract<StoreRecordKind, "incomplete" | "receipt" | "transaction">,
  expectedRecord: unknown,
): void {
  assertOwnedStorePhase(store);
  let parsed: unknown;
  try {
    parsed = schemaForKind(kind).parse(expectedRecord);
  } catch {
    fail("exact record expectation is invalid", invalidRecordFinding(kind));
  }
  const expectedBytes = canonicalRecordBytes(kind, parsed);
  const current = readStoreRecord(store, absPath, schemaForKind(kind), kind);
  if (!current.bytes.equals(expectedBytes)) {
    fail("exact record changed before removal", invalidRecordFinding(kind));
  }
  const finalIdentity = identity(lstatBigInt(absPath, "exact record"));
  if (!sameIdentity(current.identity, finalIdentity)) {
    fail("exact record identity changed before removal", invalidRecordFinding(kind));
  }
  try {
    unlinkSync(absPath);
  } catch {
    fail("exact record removal failed", "METHODOLOGY_STORE_FILESYSTEM_FAILURE");
  }
  syncDirectory(dirname(absPath));
}

function schemaForKind(kind: StoreRecordKind): RecordSchema<unknown> {
  switch (kind) {
    case "root":
      return RootRecordSchema;
    case "receipt":
      return GenerationReceiptSchema;
    case "activation":
      return ActivationRecordSchema;
    case "staging":
      return StagingRecordSchema;
    case "incomplete":
      return IncompleteRecordSchema;
    case "lock-owner":
      return LockOwnerRecordSchema;
    case "transaction":
      return TransactionRecordSchema;
  }
}

function assertRecordPathBinding(
  store: OwnedStore,
  absPath: string,
  kind: StoreRecordKind,
  record: unknown,
): void {
  switch (kind) {
    case "root": {
      const parsed = RootRecordSchema.parse(record);
      if (
        !pathsEqual(absPath, store.layout.rootRecord) ||
        parsed.rootId !== store.rootRecord.rootId ||
        parsed.rootDevice !== store.layout.projectDevice
      ) {
        fail("root record path or identity is not bound");
      }
      return;
    }
    case "activation":
      if (!pathsEqual(absPath, store.layout.active)) {
        fail("activation record is not at the active path");
      }
      return;
    case "receipt": {
      const parsed = GenerationReceiptSchema.parse(record);
      const generationDirectory = dirname(absPath);
      if (
        basename(absPath) !== "receipt.json" ||
        basename(generationDirectory) !== parsed.manifestDigest ||
        !pathsEqual(dirname(generationDirectory), store.layout.generations)
      ) {
        fail("receipt path is not bound to its generation");
      }
      if (parsed.rootId !== store.rootRecord.rootId) {
        fail("receipt is not owned by this store", "METHODOLOGY_STORE_ROOT_UNOWNED");
      }
      return;
    }
    case "incomplete": {
      const parsed = IncompleteRecordSchema.parse(record);
      const generationDirectory = dirname(absPath);
      if (
        basename(absPath) !== "incomplete.json" ||
        basename(generationDirectory) !== parsed.manifestDigest ||
        !pathsEqual(dirname(generationDirectory), store.layout.generations) ||
        parsed.rootId !== store.rootRecord.rootId
      ) {
        fail("incomplete marker path is not bound to its generation");
      }
      return;
    }
    case "staging": {
      const parsed = StagingRecordSchema.parse(record);
      const stagingDirectory = dirname(absPath);
      if (
        basename(absPath) !== "staging.json" ||
        basename(stagingDirectory) !== parsed.transactionId ||
        !pathsEqual(dirname(stagingDirectory), store.layout.staging) ||
        parsed.rootId !== store.rootRecord.rootId
      ) {
        fail("staging marker path is not bound to its transaction");
      }
      return;
    }
    case "lock-owner": {
      const parsed = LockOwnerRecordSchema.parse(record);
      const ownerDirectory = dirname(absPath);
      const ownerDirectoryName = basename(ownerDirectory);
      const deleting = LOCK_DELETING_CANDIDATE_PATTERN.exec(ownerDirectoryName);
      const validLivePath = pathsEqual(absPath, join(store.layout.lock, "owner.json"));
      const validCandidatePath =
        (isLockCandidateName(ownerDirectoryName, parsed.token, false) ||
          isLockCandidateName(ownerDirectoryName, parsed.token, true) ||
          (deleting?.[1] !== undefined &&
            ownerDirectoryName.startsWith(`${parsed.token}.deleting.`) &&
            Number(deleting[1]) === parsed.pid)) &&
        pathsEqual(dirname(ownerDirectory), store.layout.lockCandidates);
      if (
        basename(absPath) !== "owner.json" ||
        parsed.rootId !== store.rootRecord.rootId ||
        (!validLivePath && !validCandidatePath)
      ) {
        fail("lock owner path is not bound to its claim");
      }
      return;
    }
    case "transaction": {
      const parsed = TransactionRecordSchema.parse(record);
      const filename = TRANSACTION_FILENAME_PATTERN.exec(basename(absPath));
      if (
        filename === null ||
        filename[1] !== parsed.transactionId ||
        !pathsEqual(dirname(absPath), store.layout.transactions) ||
        parsed.rootId !== store.rootRecord.rootId
      ) {
        fail("transaction filename is not bound to its record");
      }
    }
  }
}

function transactionInvariantBytes(record: unknown): Buffer {
  const parsed = TransactionRecordSchema.parse(record);
  return canonicalRecordBytes("transaction", { ...parsed, phase: "prepared" });
}

function validateAtomicActivation(
  store: OwnedStore,
  write: AtomicRecordWrite,
  parsedRecord: unknown,
  temporary: RegExpExecArray,
): void {
  const transactionId = temporary[1];
  if (transactionId === undefined) {
    fail("activation temporary has no transaction identity");
  }
  const activation = ActivationRecordSchema.parse(parsedRecord);
  const journalPath = join(store.layout.transactions, `${transactionId}.json`);
  const journal = readStoreRecord(
    store,
    journalPath,
    TransactionRecordSchema,
    "transaction",
  ).record;
  if (
    journal.operation !== "apply" ||
    journal.phase !== "generation-verified" ||
    journal.transactionId !== transactionId ||
    journal.newActivation === null ||
    !canonicalRecordBytes("activation", journal.newActivation).equals(
      canonicalRecordBytes("activation", activation),
    )
  ) {
    fail("activation is not bound to a generation-verified apply journal");
  }
  const targetIdentity = lstatIfPresent(write.targetPath);
  if (targetIdentity === undefined) {
    if (journal.oldActivation !== null) {
      fail("activation target is absent for a non-empty prior activation");
    }
    return;
  }
  const current = readStoreRecord(
    store,
    write.targetPath,
    ActivationRecordSchema,
    "activation",
  ).record;
  if (
    journal.oldActivation === null ||
    !canonicalRecordBytes("activation", journal.oldActivation).equals(
      canonicalRecordBytes("activation", current),
    )
  ) {
    fail("activation target does not match the journal's prior activation");
  }
}

function validateAtomicTransaction(
  store: OwnedStore,
  write: AtomicRecordWrite,
  parsedRecord: unknown,
  target: RegExpExecArray,
  temporary: RegExpExecArray,
): void {
  const next = TransactionRecordSchema.parse(parsedRecord);
  if (
    target[1] !== temporary[1] ||
    target[1] !== next.transactionId ||
    temporary[2] !== next.phase
  ) {
    fail("transaction temporary is not bound to its journal and next phase");
  }
  if (write.mode === "create") {
    if (next.phase !== "prepared" || lstatIfPresent(write.targetPath) !== undefined) {
      fail("initial transaction publication must create an absent prepared journal");
    }
    return;
  }
  const current = readStoreRecord(
    store,
    write.targetPath,
    TransactionRecordSchema,
    "transaction",
  ).record;
  const transitions = current.operation === "apply" ? APPLY_NEXT_PHASE : CLEAN_NEXT_PHASE;
  if (
    current.operation !== next.operation ||
    transitions[current.phase] !== next.phase ||
    !transactionInvariantBytes(current).equals(transactionInvariantBytes(next))
  ) {
    fail("transaction record is not an allowed exact phase transition");
  }
}

function validateAtomicPaths(
  store: OwnedStore,
  write: AtomicRecordWrite,
  parsedRecord: unknown,
): void {
  assertLexicallyOwned(store, write.targetPath);
  assertLexicallyOwned(store, write.temporaryPath);
  if (!pathsEqual(dirname(write.targetPath), dirname(write.temporaryPath))) {
    fail("atomic record temporary must be a sibling");
  }
  if (write.kind === "activation") {
    const temporary = ACTIVE_TEMP_PATTERN.exec(basename(write.temporaryPath));
    if (!pathsEqual(write.targetPath, store.layout.active) || temporary === null) {
      fail("activation temporary is not transaction-bound");
    }
    validateAtomicActivation(store, write, parsedRecord, temporary);
    return;
  }
  if (write.kind !== "transaction") {
    fail("atomic replacement is limited to activation and transaction records");
  }
  const target = TRANSACTION_FILENAME_PATTERN.exec(basename(write.targetPath));
  const temporary = TRANSACTION_TEMP_PATTERN.exec(basename(write.temporaryPath));
  if (target === null || temporary === null) {
    fail("transaction temporary is not bound to its journal");
  }
  validateAtomicTransaction(store, write, parsedRecord, target, temporary);
}

export function writeAtomicRecord(
  store: OwnedStore,
  write: AtomicRecordWrite,
): ExclusiveWriteResult {
  assertOwnedStorePhase(store);
  assertOwnedAncestors(store, write.targetPath);
  assertOwnedAncestors(store, write.temporaryPath);
  let parsed: unknown;
  try {
    parsed = schemaForKind(write.kind).parse(write.record);
  } catch {
    fail("atomic record schema is invalid", invalidRecordFinding(write.kind));
  }
  assertRecordPathBinding(store, write.targetPath, write.kind, parsed);
  validateAtomicPaths(store, write, parsed);
  const bytes = canonicalRecordBytes(write.kind, parsed);
  if (bytes.byteLength > MAX_RECORD_BYTES) {
    fail("atomic record exceeds its byte limit", "METHODOLOGY_STORE_RESOURCE_LIMIT");
  }
  rawExclusiveWrite(write.temporaryPath, bytes);
  if (write.mode === "create" && lstatIfPresent(write.targetPath) !== undefined) {
    fail("atomic create target appeared before publication");
  }
  retryTransient(() => renameSync(write.temporaryPath, write.targetPath));
  const opened = readOwnedRegularFile(store, write.targetPath, MAX_RECORD_BYTES);
  if (!opened.contents.equals(bytes)) {
    fail("atomic record verification failed", "METHODOLOGY_STORE_FILESYSTEM_FAILURE");
  }
  syncDirectory(dirname(write.targetPath));
  return Object.freeze({
    digest: sha256Bytes(opened.contents),
    bytes: opened.contents.byteLength,
    identity: opened.identity,
  });
}

function validatedEntries(
  store: OwnedStore,
  entries: readonly ReceiptEntry[],
): readonly ReceiptEntry[] {
  const receipt: GenerationReceipt = GenerationReceiptSchema.parse({
    schemaVersion: STORE_SCHEMA_VERSION,
    rootId: store.rootRecord.rootId,
    manifestDigest: "0".repeat(64),
    entries,
  });
  return receipt.entries;
}

function expectedDirectories(entries: readonly ReceiptEntry[]): ReadonlySet<string> {
  const directories = new Set<string>();
  for (const entry of entries) {
    const segments = entry.target.split("/");
    let current = "";
    for (let index = 0; index < segments.length - 1; index += 1) {
      const segment = segments[index];
      if (segment === undefined) continue;
      current = current === "" ? segment : `${current}/${segment}`;
      directories.add(current);
    }
  }
  return directories;
}

function validateTreeRoot(store: OwnedStore, treeRoot: string): StoreObjectIdentity {
  assertLexicallyOwned(store, treeRoot);
  assertOwnedAncestors(store, treeRoot);
  return validateOrdinaryDirectory(
    store.layout.root,
    store.layout.projectDevice,
    treeRoot,
    "tree root",
  );
}

function assertWalkBudget(budget: StoreWalkBudget): void {
  const values: ReadonlyArray<readonly [number, number]> = [
    [budget.entries, MAX_WALK_ENTRIES],
    [budget.bytes, MAX_WALK_BYTES],
    [budget.directories, MAX_GENERATED_DIRECTORIES],
  ];
  if (
    values.some(([value, maximum]) => !Number.isSafeInteger(value) || value < 0 || value > maximum)
  ) {
    fail("tree walk budget is invalid", "METHODOLOGY_STORE_RESOURCE_LIMIT");
  }
}

function consumeWalkEntry(budget: StoreWalkBudget): void {
  assertWalkBudget(budget);
  if (budget.entries >= MAX_WALK_ENTRIES) {
    fail("tree entry count exceeds its limit", "METHODOLOGY_STORE_RESOURCE_LIMIT");
  }
  budget.entries += 1;
}

function consumeWalkDirectory(budget: StoreWalkBudget): void {
  assertWalkBudget(budget);
  if (budget.directories >= MAX_GENERATED_DIRECTORIES) {
    fail("tree directory count exceeds its limit", "METHODOLOGY_STORE_RESOURCE_LIMIT");
  }
  budget.directories += 1;
}

function consumeWalkBytes(budget: StoreWalkBudget, bytes: number): void {
  assertWalkBudget(budget);
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_WALK_BYTES - budget.bytes) {
    fail("tree byte count exceeds its limit", "METHODOLOGY_STORE_RESOURCE_LIMIT");
  }
  budget.bytes += bytes;
}

function readBoundedWalkChildren(absDirectory: string, budget: StoreWalkBudget): readonly Dirent[] {
  let directory: ReturnType<typeof opendirSync>;
  try {
    directory = opendirSync(absDirectory);
  } catch {
    fail("tree directory is inaccessible");
  }
  const children: Dirent[] = [];
  try {
    for (;;) {
      const child = directory.readSync();
      if (child === null) break;
      consumeWalkEntry(budget);
      children.push(child);
    }
  } catch (error) {
    if (error instanceof GenerationStoreFsError) throw error;
    fail("tree directory inventory failed", "METHODOLOGY_STORE_FILESYSTEM_FAILURE");
  } finally {
    try {
      directory.closeSync();
    } catch {
      fail("tree directory inventory close failed", "METHODOLOGY_STORE_FILESYSTEM_FAILURE");
    }
  }
  children.sort((left, right) => compareStrings(left.name, right.name));
  return children;
}

function readFixedContainerChildren(absDirectory: string): readonly Dirent[] {
  let directory: ReturnType<typeof opendirSync>;
  try {
    directory = opendirSync(absDirectory);
  } catch {
    fail("container directory is inaccessible");
  }
  const children: Dirent[] = [];
  try {
    for (;;) {
      const child = directory.readSync();
      if (child === null) break;
      if (children.length >= 2) fail("container contains an unexpected entry");
      children.push(child);
    }
  } catch (error) {
    if (error instanceof GenerationStoreFsError) throw error;
    fail("container directory inventory failed", "METHODOLOGY_STORE_FILESYSTEM_FAILURE");
  } finally {
    try {
      directory.closeSync();
    } catch {
      fail("container directory inventory close failed", "METHODOLOGY_STORE_FILESYSTEM_FAILURE");
    }
  }
  children.sort((left, right) => compareStrings(left.name, right.name));
  return children;
}

function assertCanonicalWalkRelativePath(relativePath: string): void {
  if (relativePath.split("/").length > MAX_TARGET_SEGMENTS) {
    fail("tree depth exceeds its limit", "METHODOLOGY_STORE_RESOURCE_LIMIT");
  }
  if (!isCanonicalProjectionTarget(relativePath)) {
    fail("tree contains a non-canonical path");
  }
}

function verifyTree(
  store: OwnedStore,
  treeRoot: string,
  rawEntries: readonly ReceiptEntry[],
  allowMissing: boolean,
  budget: StoreWalkBudget,
): VerifiedTree {
  assertOwnedStorePhase(store);
  assertWalkBudget(budget);
  const entries = validatedEntries(store, rawEntries);
  const expectedFiles = new Map(entries.map((entry) => [entry.target, entry]));
  const allowedDirectories = expectedDirectories(entries);
  const seenFiles = new Set<string>();
  const files: VerifiedFile[] = [];
  const directories: VerifiedDirectory[] = [
    Object.freeze({ relativePath: "", identity: validateTreeRoot(store, treeRoot) }),
  ];
  const visit = (absDirectory: string, relativeDirectory: string, depth: number): void => {
    if (depth > MAX_TARGET_SEGMENTS) {
      fail("tree depth exceeds its limit", "METHODOLOGY_STORE_RESOURCE_LIMIT");
    }
    const children = readBoundedWalkChildren(absDirectory, budget);
    for (const child of children) {
      const relativePath =
        relativeDirectory === "" ? child.name : `${relativeDirectory}/${child.name}`;
      const absPath = join(absDirectory, child.name);
      const childStats = lstatBigInt(absPath, "tree entry");
      if (child.isSymbolicLink() || childStats.isSymbolicLink()) {
        fail("tree contains a linked entry");
      }
      if (childStats.dev.toString(10) !== store.layout.projectDevice) {
        fail("tree entry changed device");
      }
      if (child.isDirectory() && childStats.isDirectory()) {
        const directoryIdentity = validateOrdinaryDirectory(
          store.layout.root,
          store.layout.projectDevice,
          absPath,
          "tree directory",
        );
        assertCanonicalWalkRelativePath(relativePath);
        if (!allowedDirectories.has(relativePath)) {
          consumeWalkDirectory(budget);
          verifyBoundedOwnedTreeSafetyAt(store, absPath, budget, relativePath, depth + 1);
          fail("tree contains an unexpected directory", "METHODOLOGY_STORE_GENERATION_DRIFT");
        }
        consumeWalkDirectory(budget);
        directories.push(Object.freeze({ relativePath, identity: directoryIdentity }));
        visit(absPath, relativePath, depth + 1);
        continue;
      }
      if (!child.isFile() || !childStats.isFile()) {
        fail("tree contains a non-regular entry");
      }
      const opened = readOwnedRegularFile(store, absPath, MAX_PAYLOAD_BYTES);
      consumeWalkBytes(budget, opened.contents.byteLength);
      assertCanonicalWalkRelativePath(relativePath);
      const expected = expectedFiles.get(relativePath);
      if (expected === undefined) {
        fail("tree contains an unexpected file", "METHODOLOGY_STORE_GENERATION_DRIFT");
      }
      const digest = sha256Bytes(opened.contents);
      if (opened.contents.byteLength !== expected.bytes || digest !== expected.contentDigest) {
        fail("tree content drifted", "METHODOLOGY_STORE_GENERATION_DRIFT");
      }
      seenFiles.add(relativePath);
      files.push(
        Object.freeze({
          relativePath,
          digest,
          bytes: opened.contents.byteLength,
          identity: opened.identity,
        }),
      );
    }
  };
  visit(treeRoot, "", 0);

  const missingFiles = [...expectedFiles.keys()]
    .filter((target) => !seenFiles.has(target))
    .sort(compareStrings);
  if (!allowMissing && missingFiles.length > 0) {
    fail("tree is missing expected files", "METHODOLOGY_STORE_GENERATION_INCOMPLETE");
  }
  files.sort((left, right) => compareStrings(left.relativePath, right.relativePath));
  directories.sort((left, right) => compareStrings(left.relativePath, right.relativePath));
  return Object.freeze({
    root: treeRoot,
    entries: Object.freeze(entries.map((entry) => Object.freeze({ ...entry }))),
    files: Object.freeze(files),
    directories: Object.freeze(directories),
    missing: Object.freeze(missingFiles),
    container: null,
  });
}

export function verifyExpectedTree(
  store: OwnedStore,
  treeRoot: string,
  entries: readonly ReceiptEntry[],
  budget: StoreWalkBudget = createStoreWalkBudget(),
): VerifiedTree {
  return verifyTree(store, treeRoot, entries, false, budget);
}

export function verifyPartialOwnedTree(
  store: OwnedStore,
  treeRoot: string,
  entries: readonly ReceiptEntry[],
  budget: StoreWalkBudget = createStoreWalkBudget(),
): VerifiedTree {
  return verifyTree(store, treeRoot, entries, true, budget);
}

/**
 * Establishes only bounded filesystem safety when no trustworthy expected-entry
 * set exists. Ordinary unknown content is observed; links and aliases fail closed.
 */
function verifyBoundedOwnedTreeSafetyAt(
  store: OwnedStore,
  treeRoot: string,
  budget: StoreWalkBudget,
  relativePrefix: string,
  baseDepth: number,
): VerifiedTree {
  assertOwnedStorePhase(store);
  assertWalkBudget(budget);
  if (!Number.isSafeInteger(baseDepth) || baseDepth < 0 || baseDepth > MAX_TARGET_SEGMENTS) {
    fail("tree depth exceeds its limit", "METHODOLOGY_STORE_RESOURCE_LIMIT");
  }
  if (relativePrefix !== "") assertCanonicalWalkRelativePath(relativePrefix);
  const files: VerifiedFile[] = [];
  const directories: VerifiedDirectory[] = [
    Object.freeze({ relativePath: relativePrefix, identity: validateTreeRoot(store, treeRoot) }),
  ];

  const visit = (absDirectory: string, relativeDirectory: string, depth: number): void => {
    if (depth > MAX_TARGET_SEGMENTS) {
      fail("tree depth exceeds its limit", "METHODOLOGY_STORE_RESOURCE_LIMIT");
    }
    for (const child of readBoundedWalkChildren(absDirectory, budget)) {
      const relativePath =
        relativeDirectory === "" ? child.name : `${relativeDirectory}/${child.name}`;
      const absPath = join(absDirectory, child.name);
      const childStats = lstatBigInt(absPath, "tree entry");
      if (child.isSymbolicLink() || childStats.isSymbolicLink()) {
        fail("tree contains a linked entry");
      }
      if (childStats.dev.toString(10) !== store.layout.projectDevice) {
        fail("tree entry changed device");
      }
      if (child.isDirectory() && childStats.isDirectory()) {
        const directoryIdentity = validateOrdinaryDirectory(
          store.layout.root,
          store.layout.projectDevice,
          absPath,
          "tree directory",
        );
        assertCanonicalWalkRelativePath(relativePath);
        consumeWalkDirectory(budget);
        directories.push(Object.freeze({ relativePath, identity: directoryIdentity }));
        visit(absPath, relativePath, depth + 1);
        continue;
      }
      if (!child.isFile() || !childStats.isFile()) {
        fail("tree contains a non-regular entry");
      }
      const opened = readOwnedRegularFile(store, absPath, MAX_PAYLOAD_BYTES);
      consumeWalkBytes(budget, opened.contents.byteLength);
      assertCanonicalWalkRelativePath(relativePath);
      files.push(
        Object.freeze({
          relativePath,
          digest: sha256Bytes(opened.contents),
          bytes: opened.contents.byteLength,
          identity: opened.identity,
        }),
      );
    }
  };
  visit(treeRoot, relativePrefix, baseDepth);

  files.sort((left, right) => compareStrings(left.relativePath, right.relativePath));
  directories.sort((left, right) => compareStrings(left.relativePath, right.relativePath));
  return Object.freeze({
    root: treeRoot,
    entries: Object.freeze([]),
    files: Object.freeze(files),
    directories: Object.freeze(directories),
    missing: Object.freeze([]),
    container: null,
  });
}

export function verifyBoundedOwnedTreeSafety(
  store: OwnedStore,
  treeRoot: string,
  budget: StoreWalkBudget = createStoreWalkBudget(),
): VerifiedTree {
  return verifyBoundedOwnedTreeSafetyAt(store, treeRoot, budget, "", 0);
}

function containerMetadataName(kind: VerifiedContainerKind): VerifiedContainer["metadataName"] {
  switch (kind) {
    case "receipt":
      return "receipt.json";
    case "staging":
      return "staging.json";
    case "incomplete":
      return "incomplete.json";
  }
}

function containerDescriptor(
  store: OwnedStore,
  kind: VerifiedContainerKind,
  metadataRecord: unknown,
  entries: readonly ReceiptEntry[],
): Readonly<{ container: VerifiedContainer; entries: readonly ReceiptEntry[] }> {
  const normalizedEntries = validatedEntries(store, entries);
  let parsed: unknown;
  try {
    parsed = schemaForKind(kind).parse(metadataRecord);
  } catch {
    fail("container metadata schema is invalid", invalidRecordFinding(kind));
  }
  const metadataBytes = canonicalRecordBytes(kind, parsed);
  if (metadataBytes.byteLength > MAX_RECORD_BYTES) {
    fail("container metadata exceeds its byte limit", "METHODOLOGY_STORE_RESOURCE_LIMIT");
  }
  let rootId: string;
  let sourceName: string;
  let transactionId: string | null;
  switch (kind) {
    case "receipt": {
      const receipt = GenerationReceiptSchema.parse(parsed);
      const expected = canonicalRecordBytes("receipt", {
        ...receipt,
        entries: normalizedEntries,
      });
      if (!expected.equals(metadataBytes)) {
        fail("container receipt does not bind the expected content");
      }
      rootId = receipt.rootId;
      sourceName = receipt.manifestDigest;
      transactionId = null;
      break;
    }
    case "staging": {
      const staging = StagingRecordSchema.parse(parsed);
      rootId = staging.rootId;
      sourceName = staging.transactionId;
      transactionId = staging.transactionId;
      break;
    }
    case "incomplete": {
      const incomplete = IncompleteRecordSchema.parse(parsed);
      rootId = incomplete.rootId;
      sourceName = incomplete.manifestDigest;
      transactionId = incomplete.transactionId;
      break;
    }
  }
  if (rootId !== store.rootRecord.rootId) {
    fail("container metadata is not owned by this store");
  }
  return Object.freeze({
    container: Object.freeze({
      metadataKind: kind,
      metadataName: containerMetadataName(kind),
      metadataCanonical: metadataBytes.toString("utf8"),
      rootId,
      sourceName,
      transactionId,
    }),
    entries: normalizedEntries,
  });
}

function verifyContainerAt(
  store: OwnedStore,
  treeRoot: string,
  entries: readonly ReceiptEntry[],
  claimedContainer: VerifiedContainer,
  allowMissing: boolean,
  budget: StoreWalkBudget = createStoreWalkBudget(),
): VerifiedTree {
  assertOwnedStorePhase(store);
  assertWalkBudget(budget);
  let metadataRecord: unknown;
  try {
    metadataRecord = JSON.parse(claimedContainer.metadataCanonical);
  } catch {
    fail("verified container metadata is not canonical JSON");
  }
  const rebound = containerDescriptor(
    store,
    claimedContainer.metadataKind,
    metadataRecord,
    entries,
  );
  const container = rebound.container;
  if (
    claimedContainer.metadataKind !== container.metadataKind ||
    claimedContainer.metadataName !== container.metadataName ||
    claimedContainer.metadataCanonical !== container.metadataCanonical ||
    claimedContainer.rootId !== container.rootId ||
    claimedContainer.sourceName !== container.sourceName ||
    claimedContainer.transactionId !== container.transactionId
  ) {
    fail("verified container descriptor is not semantically bound");
  }
  const normalizedEntries = rebound.entries;
  const rootIdentity = validateTreeRoot(store, treeRoot);
  const children = readFixedContainerChildren(treeRoot);
  for (const child of children) {
    if (child.name !== "content" && child.name !== container.metadataName) {
      fail("container contains an unexpected entry");
    }
  }

  const files: VerifiedFile[] = [];
  const directories: VerifiedDirectory[] = [
    Object.freeze({ relativePath: "", identity: rootIdentity }),
  ];
  const missingEntries: string[] = [];
  const metadataChild = children.find(({ name }) => name === container.metadataName);
  if (metadataChild === undefined) {
    missingEntries.push(container.metadataName);
  } else {
    const metadataPath = join(treeRoot, container.metadataName);
    const metadataStats = lstatBigInt(metadataPath, "container metadata");
    if (
      metadataChild.isSymbolicLink() ||
      metadataStats.isSymbolicLink() ||
      !metadataChild.isFile() ||
      !metadataStats.isFile()
    ) {
      fail("container metadata is not an ordinary regular file");
    }
    const opened = readOwnedRegularFile(store, metadataPath, MAX_RECORD_BYTES);
    const expectedBytes = Buffer.from(container.metadataCanonical, "utf8");
    if (!opened.contents.equals(expectedBytes)) {
      fail("container metadata drifted", "METHODOLOGY_STORE_GENERATION_DRIFT");
    }
    files.push(
      Object.freeze({
        relativePath: container.metadataName,
        digest: sha256Bytes(opened.contents),
        bytes: opened.contents.byteLength,
        identity: opened.identity,
      }),
    );
  }

  const contentChild = children.find(({ name }) => name === "content");
  if (contentChild === undefined) {
    for (const entry of normalizedEntries) {
      missingEntries.push(`content/${entry.target}`);
    }
  } else {
    const contentPath = join(treeRoot, "content");
    const contentStats = lstatBigInt(contentPath, "container content");
    if (
      contentChild.isSymbolicLink() ||
      contentStats.isSymbolicLink() ||
      !contentChild.isDirectory() ||
      !contentStats.isDirectory()
    ) {
      fail("container content is not an ordinary directory");
    }
    const content = verifyTree(store, contentPath, normalizedEntries, allowMissing, budget);
    for (const file of content.files) {
      files.push(
        Object.freeze({
          ...file,
          relativePath: `content/${file.relativePath}`,
        }),
      );
    }
    for (const directory of content.directories) {
      directories.push(
        Object.freeze({
          ...directory,
          relativePath:
            directory.relativePath === "" ? "content" : `content/${directory.relativePath}`,
        }),
      );
    }
    for (const missingEntry of content.missing) {
      missingEntries.push(`content/${missingEntry}`);
    }
  }

  if (!allowMissing && missingEntries.length > 0) {
    fail("container is missing an expected entry", "METHODOLOGY_STORE_GENERATION_INCOMPLETE");
  }
  files.sort((left, right) => compareStrings(left.relativePath, right.relativePath));
  directories.sort((left, right) => compareStrings(left.relativePath, right.relativePath));
  missingEntries.sort(compareStrings);
  return Object.freeze({
    root: treeRoot,
    entries: Object.freeze(normalizedEntries.map((entry) => Object.freeze({ ...entry }))),
    files: Object.freeze(files),
    directories: Object.freeze(directories),
    missing: Object.freeze(missingEntries),
    container,
  });
}

export function verifyExpectedContainer(
  store: OwnedStore,
  treeRoot: string,
  kind: VerifiedContainerKind,
  metadataRecord: unknown,
  entries: readonly ReceiptEntry[],
  budget: StoreWalkBudget = createStoreWalkBudget(),
): VerifiedTree {
  const expected = containerDescriptor(store, kind, metadataRecord, entries);
  const metadataPath = join(treeRoot, expected.container.metadataName);
  const stored = readStoreRecord(store, metadataPath, schemaForKind(kind), kind);
  if (stored.bytes.toString("utf8") !== expected.container.metadataCanonical) {
    fail("stored container metadata is not the expected canonical record");
  }
  return verifyContainerAt(store, treeRoot, expected.entries, expected.container, false, budget);
}

export function verifyPartialSourceContainer(
  store: OwnedStore,
  treeRoot: string,
  kind: Exclude<VerifiedContainerKind, "receipt">,
  metadataRecord: unknown,
  entries: readonly ReceiptEntry[],
  budget: StoreWalkBudget = createStoreWalkBudget(),
): VerifiedTree {
  const expected = containerDescriptor(store, kind, metadataRecord, entries);
  const metadataPath = join(treeRoot, expected.container.metadataName);
  const stored = readStoreRecord(store, metadataPath, schemaForKind(kind), kind);
  if (stored.bytes.toString("utf8") !== expected.container.metadataCanonical) {
    fail("stored partial-container metadata is not the expected canonical record");
  }
  return verifyContainerAt(store, treeRoot, expected.entries, expected.container, true, budget);
}

export function verifyPartialOwnedContainer(
  store: OwnedStore,
  treeRoot: string,
  kind: VerifiedContainerKind,
  metadataRecord: unknown,
  entries: readonly ReceiptEntry[],
  budget: StoreWalkBudget = createStoreWalkBudget(),
): VerifiedTree {
  assertBoundTrashRoot(store, treeRoot);
  const expected = containerDescriptor(store, kind, metadataRecord, entries);
  if (
    kind === "staging" &&
    StagingRecordSchema.parse(metadataRecord).transactionId !== basename(treeRoot)
  ) {
    fail("staging trash identity is not transaction-bound");
  }
  if (
    kind === "incomplete" &&
    IncompleteRecordSchema.parse(metadataRecord).transactionId !== basename(treeRoot)
  ) {
    fail("incomplete trash identity is not transaction-bound");
  }
  return verifyContainerAt(store, treeRoot, expected.entries, expected.container, true, budget);
}

function identityByRelative<T extends { relativePath: string; identity: StoreObjectIdentity }>(
  values: readonly T[],
): Map<string, StoreObjectIdentity> {
  return new Map(values.map((value) => [value.relativePath, value.identity]));
}

function requireSameContainerDescriptor(previous: VerifiedTree, current: VerifiedTree): void {
  if (
    previous.container === null ||
    current.container === null ||
    previous.container.metadataKind !== current.container.metadataKind ||
    previous.container.metadataName !== current.container.metadataName ||
    previous.container.metadataCanonical !== current.container.metadataCanonical ||
    previous.container.rootId !== current.container.rootId ||
    previous.container.sourceName !== current.container.sourceName ||
    previous.container.transactionId !== current.container.transactionId
  ) {
    fail("verified container description changed", "METHODOLOGY_STORE_GENERATION_DRIFT");
  }
}

function requireSameVerifiedTree(previous: VerifiedTree, current: VerifiedTree): void {
  requireSameContainerDescriptor(previous, current);
  if (
    previous.files.length !== current.files.length ||
    previous.directories.length !== current.directories.length ||
    previous.missing.length !== current.missing.length ||
    previous.missing.some((entry, index) => current.missing[index] !== entry)
  ) {
    fail("verified tree changed before mutation", "METHODOLOGY_STORE_GENERATION_DRIFT");
  }
  const previousFiles = identityByRelative(previous.files);
  const previousDirectories = identityByRelative(previous.directories);
  for (const file of current.files) {
    const expected = previousFiles.get(file.relativePath);
    if (expected === undefined || !sameIdentity(expected, file.identity)) {
      fail("verified file identity changed", "METHODOLOGY_STORE_GENERATION_DRIFT");
    }
  }
  for (const directory of current.directories) {
    const expected = previousDirectories.get(directory.relativePath);
    if (expected === undefined || !sameIdentity(expected, directory.identity)) {
      fail("verified directory identity changed", "METHODOLOGY_STORE_GENERATION_DRIFT");
    }
  }
}

function requireSamePublishedTree(previous: VerifiedTree, current: VerifiedTree): void {
  requireSameContainerDescriptor(previous, current);
  if (
    previous.files.length !== current.files.length ||
    previous.directories.length !== current.directories.length ||
    previous.missing.length !== current.missing.length
  ) {
    fail("published tree shape changed");
  }
  const previousFiles = identityByRelative(previous.files);
  const previousDirectories = identityByRelative(previous.directories);
  for (const file of current.files) {
    const expected = previousFiles.get(file.relativePath);
    if (expected === undefined || !sameIdentity(expected, file.identity)) {
      fail("published file identity changed");
    }
  }
  for (const directory of current.directories) {
    const expected = previousDirectories.get(directory.relativePath);
    if (
      expected === undefined ||
      (directory.relativePath === ""
        ? !sameDirectoryObject(expected, directory.identity)
        : !sameIdentity(expected, directory.identity))
    ) {
      fail("published directory identity changed");
    }
  }
}

function requireSameUnclaimedTree(previous: VerifiedTree, current: VerifiedTree): void {
  if (
    previous.container !== null ||
    current.container !== null ||
    previous.files.length !== current.files.length ||
    previous.directories.length !== current.directories.length
  ) {
    fail("unpublished scratch tree changed before mutation");
  }
  const previousFiles = new Map(previous.files.map((file) => [file.relativePath, file]));
  const previousDirectories = identityByRelative(previous.directories);
  for (const file of current.files) {
    const expected = previousFiles.get(file.relativePath);
    if (
      expected === undefined ||
      expected.digest !== file.digest ||
      expected.bytes !== file.bytes ||
      !sameIdentity(expected.identity, file.identity)
    ) {
      fail("unpublished scratch file changed before mutation");
    }
  }
  for (const directory of current.directories) {
    const expected = previousDirectories.get(directory.relativePath);
    if (expected === undefined || !sameIdentity(expected, directory.identity)) {
      fail("unpublished scratch directory changed before mutation");
    }
  }
}

function requireSameVerifiedSubset(previous: VerifiedTree, current: VerifiedTree): void {
  requireSameContainerDescriptor(previous, current);
  const previousFiles = identityByRelative(previous.files);
  const previousDirectories = identityByRelative(previous.directories);
  for (const file of current.files) {
    const expected = previousFiles.get(file.relativePath);
    if (expected === undefined || !sameIdentity(expected, file.identity)) {
      fail("verified file identity changed", "METHODOLOGY_STORE_GENERATION_DRIFT");
    }
  }
  for (const directory of current.directories) {
    const expected = previousDirectories.get(directory.relativePath);
    if (expected === undefined || !sameIdentity(expected, directory.identity)) {
      fail("verified directory identity changed", "METHODOLOGY_STORE_GENERATION_DRIFT");
    }
  }
}

function assertBoundTrashRoot(store: OwnedStore, treeRoot: string): void {
  if (
    !pathsEqual(dirname(treeRoot), store.layout.trash) ||
    !STORE_ID_PATTERN.test(basename(treeRoot))
  ) {
    fail("deletion root is not a transaction-bound trash directory");
  }
}

function destinationAbsent(absPath: string): void {
  try {
    lstatSync(absPath);
  } catch (error) {
    if (missing(error)) return;
    fail("quarantine destination is inaccessible");
  }
  fail("quarantine destination already exists");
}

function quarantineSourceBoundToTransaction(
  store: OwnedStore,
  verified: VerifiedTree,
  transactionId: string,
): boolean {
  if (verified.container === null) return false;
  const sourceParent = dirname(verified.root);
  const sourceName = basename(verified.root);
  return (
    (pathsEqual(sourceParent, store.layout.generations) &&
      DIGEST_PATTERN.test(sourceName) &&
      verified.container.sourceName === sourceName &&
      (verified.container.metadataKind === "receipt" ||
        (verified.container.metadataKind === "incomplete" &&
          verified.container.transactionId === transactionId))) ||
    (pathsEqual(sourceParent, store.layout.staging) &&
      sourceName === transactionId &&
      verified.container.metadataKind === "staging" &&
      verified.container.sourceName === sourceName &&
      verified.container.transactionId === transactionId)
  );
}

export function quarantineExactDirectory(
  store: OwnedStore,
  verified: VerifiedTree,
  transactionId: string,
): VerifiedTree {
  assertOwnedStorePhase(store);
  const container = verified.container;
  if (
    !STORE_ID_PATTERN.test(transactionId) ||
    container === null ||
    verified.missing.includes(container.metadataName) ||
    (container.metadataKind === "receipt" && verified.missing.length !== 0) ||
    !quarantineSourceBoundToTransaction(store, verified, transactionId)
  ) {
    fail("quarantine source is not transaction-bound");
  }
  const allowMissing = container.metadataKind !== "receipt";
  const current = verifyContainerAt(
    store,
    verified.root,
    verified.entries,
    container,
    allowMissing,
  );
  requireSameVerifiedTree(verified, current);
  const destination = join(store.layout.trash, transactionId);
  assertOwnedAncestors(store, destination);
  destinationAbsent(destination);
  retryTransient(() => renameSync(verified.root, destination));
  const moved = verifyContainerAt(store, destination, verified.entries, container, allowMissing);
  const expectedRoot = verified.directories.find(({ relativePath }) => relativePath === "");
  const movedRoot = moved.directories.find(({ relativePath }) => relativePath === "");
  if (
    expectedRoot === undefined ||
    movedRoot === undefined ||
    !sameDirectoryObject(expectedRoot.identity, movedRoot.identity)
  ) {
    fail("quarantined directory identity changed");
  }
  syncDirectory(dirname(verified.root));
  syncDirectory(dirname(destination));
  return moved;
}

export function publishVerifiedScratchDirectory(
  store: OwnedStore,
  verified: VerifiedTree,
  transactionId: string,
  destination: string,
): VerifiedTree {
  assertOwnedStorePhase(store);
  assertBoundTrashRoot(store, verified.root);
  const container = verified.container;
  if (
    !STORE_ID_PATTERN.test(transactionId) ||
    basename(verified.root) !== transactionId ||
    container === null ||
    verified.missing.length !== 0 ||
    (container.metadataKind !== "staging" && container.metadataKind !== "receipt")
  ) {
    fail("scratch publication is not transaction-bound and complete");
  }
  const expectedDestination =
    container.metadataKind === "staging"
      ? join(store.layout.staging, transactionId)
      : join(store.layout.generations, container.sourceName);
  if (!pathsEqual(destination, expectedDestination)) {
    fail("scratch publication destination is not container-bound");
  }
  const current = verifyContainerAt(store, verified.root, verified.entries, container, false);
  requireSameVerifiedTree(verified, current);
  assertOwnedAncestors(store, destination);
  destinationAbsent(destination);
  retryTransient(() => renameSync(verified.root, destination));
  const moved = verifyContainerAt(store, destination, verified.entries, container, false);
  requireSamePublishedTree(current, moved);
  syncDirectory(dirname(verified.root));
  syncDirectory(dirname(destination));
  return moved;
}

export function removeVerifiedScratchTree(
  store: OwnedStore,
  verified: VerifiedTree,
  transactionId: string,
): void {
  assertOwnedStorePhase(store);
  assertBoundTrashRoot(store, verified.root);
  if (
    !STORE_ID_PATTERN.test(transactionId) ||
    basename(verified.root) !== transactionId ||
    verified.container !== null
  ) {
    fail("scratch removal is not transaction-bound");
  }
  const current = verifyBoundedOwnedTreeSafety(store, verified.root);
  requireSameUnclaimedTree(verified, current);
  const files = [...current.files].sort((left, right) =>
    compareStrings(right.relativePath, left.relativePath),
  );
  for (const file of files) {
    revalidateFileForRemoval(store, current.root, file);
    unlinkSync(join(current.root, ...file.relativePath.split("/")));
  }
  const directories = [...current.directories].sort((left, right) => {
    const depthDifference =
      right.relativePath.split("/").length - left.relativePath.split("/").length;
    return depthDifference === 0
      ? compareStrings(right.relativePath, left.relativePath)
      : depthDifference;
  });
  for (const directory of directories) {
    rmdirSync(revalidateDirectoryForRemoval(store, current.root, directory));
  }
  syncDirectory(dirname(current.root));
}

export function removeBoundedRecoveryTemporary(store: OwnedStore, absPath: string): void {
  assertOwnedStorePhase(store);
  const name = basename(absPath);
  const allowed =
    (pathsEqual(dirname(absPath), store.layout.root) && ACTIVE_TEMP_PATTERN.test(name)) ||
    (pathsEqual(dirname(absPath), store.layout.transactions) &&
      TRANSACTION_TEMP_PATTERN.test(name));
  if (!allowed) fail("recovery temporary path is not recognized");
  assertOwnedAncestors(store, absPath);
  const before = readOwnedRegularFile(store, absPath, MAX_RECORD_BYTES);
  const current = readOwnedRegularFile(store, absPath, MAX_RECORD_BYTES);
  if (
    !sameIdentity(before.identity, current.identity) ||
    !before.contents.equals(current.contents)
  ) {
    fail("recovery temporary changed before removal");
  }
  unlinkSync(absPath);
  syncDirectory(dirname(absPath));
}

function revalidateFileForRemoval(store: OwnedStore, root: string, file: VerifiedFile): Buffer {
  const absPath = join(root, ...file.relativePath.split("/"));
  const current = readOwnedRegularFile(store, absPath, MAX_PAYLOAD_BYTES);
  if (
    !sameIdentity(file.identity, current.identity) ||
    current.contents.byteLength !== file.bytes ||
    sha256Bytes(current.contents) !== file.digest
  ) {
    fail("verified file changed before deletion", "METHODOLOGY_STORE_GENERATION_DRIFT");
  }
  return current.contents;
}

export function copyVerifiedFileToExclusivePath(
  store: OwnedStore,
  verified: VerifiedTree,
  relativePath: string,
  destinationRoot: string,
): ExclusiveWriteResult {
  if (!isCanonicalProjectionTarget(relativePath)) {
    fail("verified copy path is not canonical");
  }
  const file = verified.files.find((candidate) => candidate.relativePath === relativePath);
  if (file === undefined) {
    fail("verified copy source is absent", "METHODOLOGY_STORE_GENERATION_INCOMPLETE");
  }
  const bytes = revalidateFileForRemoval(store, verified.root, file);
  const destination = join(destinationRoot, ...relativePath.split("/"));
  return writeExclusiveRegularFile(store, destination, bytes);
}

function revalidateDirectoryForRemoval(
  store: OwnedStore,
  root: string,
  directory: VerifiedDirectory,
): string {
  const absPath =
    directory.relativePath === "" ? root : join(root, ...directory.relativePath.split("/"));
  const current = validateOrdinaryDirectory(
    store.layout.root,
    store.layout.projectDevice,
    absPath,
    "verified directory",
  );
  if (!sameDirectoryObject(directory.identity, current)) {
    fail("verified directory identity changed before deletion");
  }
  let remaining: string[];
  try {
    remaining = readdirSync(absPath);
  } catch {
    fail("verified directory is inaccessible before deletion");
  }
  if (remaining.length !== 0) {
    fail("verified directory is not empty before deletion");
  }
  return absPath;
}

export function removeVerifiedTree(
  store: OwnedStore,
  verified: VerifiedTree,
  afterFileRemoved?: (relativePath: string) => void,
): void {
  assertOwnedStorePhase(store);
  assertBoundTrashRoot(store, verified.root);
  if (verified.container === null) {
    fail("deletion requires a verified owned container");
  }
  const current = verifyContainerAt(
    store,
    verified.root,
    verified.entries,
    verified.container,
    true,
  );
  requireSameVerifiedSubset(verified, current);
  const metadataName = verified.container.metadataName;
  const files = [...current.files].sort((left, right) => {
    const leftIsMetadata = left.relativePath === metadataName;
    const rightIsMetadata = right.relativePath === metadataName;
    if (leftIsMetadata !== rightIsMetadata) {
      return leftIsMetadata ? 1 : -1;
    }
    return compareStrings(right.relativePath, left.relativePath);
  });
  for (const file of files) {
    revalidateFileForRemoval(store, current.root, file);
    unlinkSync(join(current.root, ...file.relativePath.split("/")));
    afterFileRemoved?.(file.relativePath);
  }
  const directories = [...current.directories].sort((left, right) => {
    const depthDifference =
      right.relativePath.split("/").length - left.relativePath.split("/").length;
    return depthDifference === 0
      ? compareStrings(right.relativePath, left.relativePath)
      : depthDifference;
  });
  for (const directory of directories) {
    const absPath = revalidateDirectoryForRemoval(store, current.root, directory);
    rmdirSync(absPath);
  }
  syncDirectory(dirname(current.root));
}

export const GENERATION_STORE_RECORD_SCHEMAS = Object.freeze({
  root: RootRecordSchema,
  receipt: GenerationReceiptSchema,
  activation: ActivationRecordSchema,
  staging: StagingRecordSchema,
  incomplete: IncompleteRecordSchema,
  "lock-owner": LockOwnerRecordSchema,
  transaction: TransactionRecordSchema,
});

export const GENERATION_STORE_FS_BOUNDARY = Object.freeze({
  projectScoped: true,
  providerRead: false,
  providerExecution: false,
  hostExecution: false,
  network: false,
  packageManager: false,
  native: false,
  sameUserTamperProof: false,
});

export function isGenerationDigest(value: string): boolean {
  return DIGEST_PATTERN.test(value);
}

export function isStoreObjectId(value: string): boolean {
  return STORE_ID_PATTERN.test(value);
}
