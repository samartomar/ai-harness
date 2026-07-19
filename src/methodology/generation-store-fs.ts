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
  MAX_RECORD_BYTES,
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
): StoreObjectIdentity {
  const stats = lstatBigInt(absPath, label);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    fail(`${label} must be an ordinary directory`);
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
  validateOrdinaryDirectory(projectRoot, projectDevice, absPath, "store ancestor");
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
    if (!opened.isFile() || opened.isSymbolicLink() || opened.nlink !== 1n) {
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
  const opened = readRegularFileWithStats(absPath, { maxBytes: MAX_RECORD_BYTES });
  if (
    opened === undefined ||
    opened.stats.nlink !== 1 ||
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
    validateOrdinaryDirectory(layout.projectRoot, layout.projectDevice, ancestor, "store ancestor");
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
  createOrValidateDirectory(layout.projectRoot, layout.projectDevice, ancestors[0] as string);
  createOrValidateDirectory(layout.projectRoot, layout.projectDevice, ancestors[1] as string);
  const createdRoot = createOrValidateDirectory(
    layout.projectRoot,
    layout.projectDevice,
    layout.root,
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
        !pathsEqual(dirname(generationDirectory), store.layout.generations) ||
        parsed.rootId !== store.rootRecord.rootId
      ) {
        fail("receipt path is not bound to its generation");
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
      const validLivePath = pathsEqual(absPath, join(store.layout.lock, "owner.json"));
      const validCandidatePath =
        (isLockCandidateName(basename(ownerDirectory), parsed.token, false) ||
          isLockCandidateName(basename(ownerDirectory), parsed.token, true)) &&
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

function verifyTree(
  store: OwnedStore,
  treeRoot: string,
  rawEntries: readonly ReceiptEntry[],
  allowMissing: boolean,
): VerifiedTree {
  assertOwnedStorePhase(store);
  const entries = validatedEntries(store, rawEntries);
  const expectedFiles = new Map(entries.map((entry) => [entry.target, entry]));
  const allowedDirectories = expectedDirectories(entries);
  const seenFiles = new Set<string>();
  const files: VerifiedFile[] = [];
  const directories: VerifiedDirectory[] = [
    Object.freeze({ relativePath: "", identity: validateTreeRoot(store, treeRoot) }),
  ];
  let walkedEntries = 0;
  let walkedBytes = 0;
  let walkedDirectories = 0;

  const visit = (absDirectory: string, relativeDirectory: string, depth: number): void => {
    if (depth > MAX_TARGET_SEGMENTS) {
      fail("tree depth exceeds its limit", "METHODOLOGY_STORE_RESOURCE_LIMIT");
    }
    let children: Dirent[];
    try {
      children = readdirSync(absDirectory, { withFileTypes: true }).sort((left, right) =>
        compareStrings(left.name, right.name),
      );
    } catch {
      fail("tree directory is inaccessible");
    }
    for (const child of children) {
      walkedEntries += 1;
      if (walkedEntries > MAX_WALK_ENTRIES) {
        fail("tree entry count exceeds its limit", "METHODOLOGY_STORE_RESOURCE_LIMIT");
      }
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
        if (!allowedDirectories.has(relativePath)) {
          fail("tree contains an unexpected directory");
        }
        walkedDirectories += 1;
        if (walkedDirectories > MAX_GENERATED_DIRECTORIES) {
          fail("tree directory count exceeds its limit", "METHODOLOGY_STORE_RESOURCE_LIMIT");
        }
        const directoryIdentity = validateOrdinaryDirectory(
          store.layout.root,
          store.layout.projectDevice,
          absPath,
          "tree directory",
        );
        directories.push(Object.freeze({ relativePath, identity: directoryIdentity }));
        visit(absPath, relativePath, depth + 1);
        continue;
      }
      if (!child.isFile() || !childStats.isFile()) {
        fail("tree contains a non-regular entry");
      }
      const expected = expectedFiles.get(relativePath);
      if (expected === undefined || !isCanonicalProjectionTarget(relativePath)) {
        fail("tree contains an unexpected file");
      }
      const opened = readOwnedRegularFile(store, absPath, MAX_PAYLOAD_BYTES);
      walkedBytes += opened.contents.byteLength;
      if (walkedBytes > MAX_WALK_BYTES) {
        fail("tree byte count exceeds its limit", "METHODOLOGY_STORE_RESOURCE_LIMIT");
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
): VerifiedTree {
  return verifyTree(store, treeRoot, entries, false);
}

export function verifyPartialOwnedTree(
  store: OwnedStore,
  treeRoot: string,
  entries: readonly ReceiptEntry[],
): VerifiedTree {
  return verifyTree(store, treeRoot, entries, true);
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
): VerifiedTree {
  assertOwnedStorePhase(store);
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
  let children: Dirent[];
  try {
    children = readdirSync(treeRoot, { withFileTypes: true }).sort((left, right) =>
      compareStrings(left.name, right.name),
    );
  } catch {
    fail("container directory is inaccessible");
  }
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
    const content = verifyTree(store, contentPath, normalizedEntries, allowMissing);
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
): VerifiedTree {
  const expected = containerDescriptor(store, kind, metadataRecord, entries);
  const metadataPath = join(treeRoot, expected.container.metadataName);
  const stored = readStoreRecord(store, metadataPath, schemaForKind(kind), kind);
  if (stored.bytes.toString("utf8") !== expected.container.metadataCanonical) {
    fail("stored container metadata is not the expected canonical record");
  }
  return verifyContainerAt(store, treeRoot, expected.entries, expected.container, false);
}

export function verifyPartialSourceContainer(
  store: OwnedStore,
  treeRoot: string,
  kind: Exclude<VerifiedContainerKind, "receipt">,
  metadataRecord: unknown,
  entries: readonly ReceiptEntry[],
): VerifiedTree {
  const expected = containerDescriptor(store, kind, metadataRecord, entries);
  const metadataPath = join(treeRoot, expected.container.metadataName);
  const stored = readStoreRecord(store, metadataPath, schemaForKind(kind), kind);
  if (stored.bytes.toString("utf8") !== expected.container.metadataCanonical) {
    fail("stored partial-container metadata is not the expected canonical record");
  }
  return verifyContainerAt(store, treeRoot, expected.entries, expected.container, true);
}

export function verifyPartialOwnedContainer(
  store: OwnedStore,
  treeRoot: string,
  kind: VerifiedContainerKind,
  metadataRecord: unknown,
  entries: readonly ReceiptEntry[],
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
  return verifyContainerAt(store, treeRoot, expected.entries, expected.container, true);
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

function revalidateFileForRemoval(store: OwnedStore, root: string, file: VerifiedFile): void {
  const absPath = join(root, ...file.relativePath.split("/"));
  const current = readOwnedRegularFile(store, absPath, MAX_PAYLOAD_BYTES);
  if (
    !sameIdentity(file.identity, current.identity) ||
    current.contents.byteLength !== file.bytes ||
    sha256Bytes(current.contents) !== file.digest
  ) {
    fail("verified file changed before deletion", "METHODOLOGY_STORE_GENERATION_DRIFT");
  }
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

export function removeVerifiedTree(store: OwnedStore, verified: VerifiedTree): void {
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
