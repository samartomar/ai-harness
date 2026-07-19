import { randomBytes } from "node:crypto";
import {
  type BigIntStats,
  closeSync,
  constants as fsConstants,
  fsyncSync,
  lstatSync,
  mkdirSync,
  opendirSync,
  openSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { containedPath } from "../internals/contained-path.js";
import { retryTransient } from "../internals/fsxn.js";
import {
  canonicalRecordBytes,
  type LockOwnerRecord,
  LockOwnerRecordSchema,
  MAX_PID,
  MAX_RECORD_BYTES,
  MAX_RECOVERY_RECORDS,
  STORE_ID_PATTERN,
} from "./generation-store-contract.js";
import {
  assertOwnedStorePhase,
  GenerationStoreFsError,
  type OwnedStore,
  readStoreRecord,
  writeExclusiveRegularFile,
} from "./generation-store-fs.js";

const CANDIDATE_NAME_PATTERN = /^([0-9a-f]{64})(\.stale)?$/;
const PENDING_CANDIDATE_NAME_PATTERN = /^([0-9a-f]{64})\.pending\.([1-9][0-9]{0,9})$/;
const DELETING_CANDIDATE_NAME_PATTERN = /^([0-9a-f]{64})\.deleting\.([1-9][0-9]{0,9})$/;
const DIRECTORY_SYNC_UNSUPPORTED = new Set(["EBADF", "EINVAL", "EISDIR", "ENOTSUP", "EPERM"]);

export type PidState = "alive" | "absent" | "indeterminate";

export type LockRuntime = Readonly<{
  pid: number;
  randomToken: () => string;
  pidState: (pid: number) => PidState;
}>;

export type HeldStoreLock = Readonly<LockOwnerRecord>;

type DirectoryIdentity = Readonly<{
  dev: string;
  ino: string;
  mode: string;
}>;

type ExactClaimDirectory = Readonly<{
  claim: HeldStoreLock;
  identity: DirectoryIdentity;
}>;

type LiveLockState =
  | Readonly<{ state: "absent" }>
  | Readonly<{
      state: "held";
      claim: HeldStoreLock;
      identity: DirectoryIdentity;
    }>
  | Readonly<{
      state: "dead";
      claim: HeldStoreLock;
      identity: DirectoryIdentity;
    }>;

function fail(
  message: string,
  findingCode:
    | "METHODOLOGY_STORE_LOCK_HELD"
    | "METHODOLOGY_STORE_LOCK_INVALID"
    | "METHODOLOGY_STORE_RESOURCE_LIMIT"
    | "METHODOLOGY_STORE_FILESYSTEM_FAILURE" = "METHODOLOGY_STORE_LOCK_INVALID",
): never {
  throw new GenerationStoreFsError(message, findingCode);
}

function errnoCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

function pathsEqual(left: string, right: string): boolean {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function identityForDirectory(absPath: string): DirectoryIdentity {
  let stats: BigIntStats;
  try {
    stats = lstatSync(absPath, { bigint: true });
  } catch {
    fail("lock directory is inaccessible", "METHODOLOGY_STORE_FILESYSTEM_FAILURE");
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    fail("lock path is not an ordinary directory");
  }
  return Object.freeze({
    dev: stats.dev.toString(10),
    ino: stats.ino.toString(10),
    mode: stats.mode.toString(10),
  });
}

function sameDirectoryIdentity(left: DirectoryIdentity, right: DirectoryIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode;
}

function privateDirectoryIdentity(value: DirectoryIdentity): boolean {
  return process.platform === "win32" || (BigInt(value.mode) & 0o777n) === 0o700n;
}

function requireOwnedDirectory(store: OwnedStore, absPath: string): DirectoryIdentity {
  const identity = identityForDirectory(absPath);
  let resolved: string;
  try {
    resolved = realpathSync(absPath);
  } catch {
    fail("lock directory realpath is inaccessible", "METHODOLOGY_STORE_FILESYSTEM_FAILURE");
  }
  if (
    !pathsEqual(resolved, absPath) ||
    !containedPath(store.layout.root, resolved) ||
    identity.dev !== store.layout.projectDevice
  ) {
    fail("lock directory is outside the owned store");
  }
  return identity;
}

function syncDirectory(absPath: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(absPath, fsConstants.O_RDONLY);
    fsyncSync(descriptor);
  } catch (error) {
    const code = errnoCode(error);
    if (code === undefined || !DIRECTORY_SYNC_UNSUPPORTED.has(code)) {
      fail("lock directory sync failed", "METHODOLOGY_STORE_FILESYSTEM_FAILURE");
    }
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {
        fail("lock directory close failed", "METHODOLOGY_STORE_FILESYSTEM_FAILURE");
      }
    }
  }
}

function pathAbsent(absPath: string): boolean {
  try {
    lstatSync(absPath);
    return false;
  } catch (error) {
    if (errnoCode(error) === "ENOENT") return true;
    fail("lock path absence is uncertain", "METHODOLOGY_STORE_FILESYSTEM_FAILURE");
  }
}

function ensureCandidateDirectory(store: OwnedStore): void {
  assertOwnedStorePhase(store);
  let created = false;
  try {
    mkdirSync(store.layout.lockCandidates, { mode: 0o700 });
    created = true;
  } catch (error) {
    if (errnoCode(error) !== "EEXIST") {
      fail(
        "lock-candidates directory could not be created",
        "METHODOLOGY_STORE_FILESYSTEM_FAILURE",
      );
    }
  }
  requireOwnedDirectory(store, store.layout.lockCandidates);
  if (created) syncDirectory(store.layout.root);
}

function inventoryCandidateNames(store: OwnedStore, requireCapacity: boolean): readonly string[] {
  ensureCandidateDirectory(store);
  const names: string[] = [];
  let directory: ReturnType<typeof opendirSync>;
  try {
    directory = opendirSync(store.layout.lockCandidates);
  } catch {
    fail("lock-candidates inventory is inaccessible", "METHODOLOGY_STORE_FILESYSTEM_FAILURE");
  }
  try {
    for (;;) {
      const entry = directory.readSync();
      if (entry === null) break;
      if (names.length === MAX_RECOVERY_RECORDS) {
        fail("lock-candidates inventory exceeds its limit", "METHODOLOGY_STORE_RESOURCE_LIMIT");
      }
      names.push(entry.name);
      const match = CANDIDATE_NAME_PATTERN.exec(entry.name);
      const pending = PENDING_CANDIDATE_NAME_PATTERN.exec(entry.name);
      const deleting = DELETING_CANDIDATE_NAME_PATTERN.exec(entry.name);
      const pendingPid = pending?.[2] === undefined ? undefined : Number(pending[2]);
      const deletingPid = deleting?.[2] === undefined ? undefined : Number(deleting[2]);
      if (
        (match === null &&
          (pending === null ||
            !Number.isSafeInteger(pendingPid) ||
            (pendingPid as number) > MAX_PID) &&
          (deleting === null ||
            !Number.isSafeInteger(deletingPid) ||
            (deletingPid as number) > MAX_PID)) ||
        entry.isSymbolicLink() ||
        !entry.isDirectory()
      ) {
        fail("lock-candidates inventory contains an invalid entry");
      }
      requireOwnedDirectory(store, join(store.layout.lockCandidates, entry.name));
    }
  } catch (error) {
    if (error instanceof GenerationStoreFsError) throw error;
    fail("lock-candidates inventory failed", "METHODOLOGY_STORE_FILESYSTEM_FAILURE");
  } finally {
    try {
      directory.closeSync();
    } catch {
      fail("lock-candidates inventory close failed", "METHODOLOGY_STORE_FILESYSTEM_FAILURE");
    }
  }
  if (requireCapacity && names.length >= MAX_RECOVERY_RECORDS) {
    fail("no capacity remains for a lock candidate", "METHODOLOGY_STORE_RESOURCE_LIMIT");
  }
  names.sort();
  return Object.freeze(names);
}

function boundedNames(absPath: string, maximum: number): readonly string[] {
  let directory: ReturnType<typeof opendirSync>;
  try {
    directory = opendirSync(absPath);
  } catch {
    fail("claim directory is inaccessible", "METHODOLOGY_STORE_FILESYSTEM_FAILURE");
  }
  const names: string[] = [];
  try {
    for (;;) {
      const entry = directory.readSync();
      if (entry === null) break;
      if (names.length === maximum) {
        fail("claim directory has unexpected descendants");
      }
      names.push(entry.name);
    }
  } catch (error) {
    if (error instanceof GenerationStoreFsError) throw error;
    fail("claim directory inventory failed", "METHODOLOGY_STORE_FILESYSTEM_FAILURE");
  } finally {
    try {
      directory.closeSync();
    } catch {
      fail("claim directory close failed", "METHODOLOGY_STORE_FILESYSTEM_FAILURE");
    }
  }
  names.sort();
  return Object.freeze(names);
}

function sameClaim(left: HeldStoreLock, right: HeldStoreLock): boolean {
  return (
    left.rootId === right.rootId &&
    left.token === right.token &&
    left.pid === right.pid &&
    left.transactionId === right.transactionId
  );
}

function readExactClaimDirectory(store: OwnedStore, directoryPath: string): ExactClaimDirectory {
  const identity = requireOwnedDirectory(store, directoryPath);
  const names = boundedNames(directoryPath, 1);
  if (names.length !== 1 || names[0] !== "owner.json") {
    fail("claim directory must contain only owner.json");
  }
  let claim: HeldStoreLock;
  try {
    claim = readStoreRecord(
      store,
      join(directoryPath, "owner.json"),
      LockOwnerRecordSchema,
      "lock-owner",
    ).record;
  } catch (error) {
    if (
      error instanceof GenerationStoreFsError &&
      error.findingCode === "METHODOLOGY_STORE_FILESYSTEM_FAILURE"
    ) {
      throw error;
    }
    if (error instanceof GenerationStoreFsError)
      fail("lock owner is malformed, linked, or unbound");
    fail("lock owner read failed", "METHODOLOGY_STORE_FILESYSTEM_FAILURE");
  }
  return Object.freeze({ claim: Object.freeze({ ...claim }), identity });
}

function safePidState(runtime: LockRuntime, pid: number): PidState {
  try {
    const state = runtime.pidState(pid);
    return state === "alive" || state === "absent" || state === "indeterminate"
      ? state
      : "indeterminate";
  } catch {
    return "indeterminate";
  }
}

function inspectLiveLock(store: OwnedStore, runtime: LockRuntime): LiveLockState {
  if (pathAbsent(store.layout.lock)) return Object.freeze({ state: "absent" });
  const exact = readExactClaimDirectory(store, store.layout.lock);
  const pidState = safePidState(runtime, exact.claim.pid);
  return Object.freeze({
    state: pidState === "absent" ? "dead" : "held",
    claim: exact.claim,
    identity: exact.identity,
  });
}

function removeExactClaimDirectory(
  store: OwnedStore,
  directoryPath: string,
  expectedClaim: HeldStoreLock,
  expectedIdentity: DirectoryIdentity,
): void {
  const current = readExactClaimDirectory(store, directoryPath);
  if (
    !sameClaim(current.claim, expectedClaim) ||
    !sameDirectoryIdentity(current.identity, expectedIdentity) ||
    !privateDirectoryIdentity(current.identity)
  ) {
    fail("claim changed before exact removal");
  }
  const deletingPath = join(
    store.layout.lockCandidates,
    `${expectedClaim.token}.deleting.${expectedClaim.pid.toString(10)}`,
  );
  if (!pathAbsent(deletingPath)) fail("exact claim cleanup state already exists");
  renameAndVerifyClaim(store, directoryPath, deletingPath, expectedClaim, expectedIdentity);
  removeDeletingCandidate(store, deletingPath, expectedClaim);
}

function cleanupOwnCandidate(
  store: OwnedStore,
  candidatePath: string,
  claim: HeldStoreLock,
  identity: DirectoryIdentity,
): void {
  if (pathAbsent(candidatePath)) return;
  removeExactClaimDirectory(store, candidatePath, claim, identity);
}

function sameFileIdentity(left: BigIntStats, right: BigIntStats): boolean {
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

function removeDeletingCandidate(
  store: OwnedStore,
  deletingPath: string,
  expectedClaim?: HeldStoreLock,
): void {
  const name = basename(deletingPath);
  const match = DELETING_CANDIDATE_NAME_PATTERN.exec(name);
  const token = match?.[1];
  const pid = match?.[2] === undefined ? undefined : Number(match[2]);
  if (
    token === undefined ||
    pid === undefined ||
    !Number.isSafeInteger(pid) ||
    pid > MAX_PID ||
    (expectedClaim !== undefined && (expectedClaim.token !== token || expectedClaim.pid !== pid))
  ) {
    fail("deleting lock candidate identity is invalid");
  }
  const identity = requireOwnedDirectory(store, deletingPath);
  if (!privateDirectoryIdentity(identity)) {
    fail("deleting lock candidate permissions are not private");
  }
  const names = boundedNames(deletingPath, 1);
  if (names.length === 1) {
    if (names[0] !== "owner.json") fail("deleting lock candidate has an unexpected entry");
    const exact = readExactClaimDirectory(store, deletingPath);
    if (
      exact.claim.rootId !== store.rootRecord.rootId ||
      exact.claim.token !== token ||
      exact.claim.pid !== pid ||
      (expectedClaim !== undefined && !sameClaim(exact.claim, expectedClaim)) ||
      !sameDirectoryIdentity(identity, exact.identity)
    ) {
      fail("deleting lock candidate changed before removal");
    }
    try {
      unlinkSync(join(deletingPath, "owner.json"));
    } catch {
      fail("deleting lock owner removal failed", "METHODOLOGY_STORE_FILESYSTEM_FAILURE");
    }
  }
  const currentIdentity = requireOwnedDirectory(store, deletingPath);
  if (
    !privateDirectoryIdentity(currentIdentity) ||
    !sameDirectoryIdentity(identity, currentIdentity) ||
    boundedNames(deletingPath, 1).length !== 0
  ) {
    fail("deleting lock candidate changed before directory removal");
  }
  try {
    rmdirSync(deletingPath);
  } catch {
    fail("deleting lock candidate removal failed", "METHODOLOGY_STORE_FILESYSTEM_FAILURE");
  }
  syncDirectory(dirname(deletingPath));
}

function removePendingCandidate(store: OwnedStore, pendingPath: string): void {
  const directoryIdentity = requireOwnedDirectory(store, pendingPath);
  if (!privateDirectoryIdentity(directoryIdentity)) {
    fail("pending lock candidate permissions are not private");
  }
  const names = boundedNames(pendingPath, 1);
  if (names.length === 1) {
    if (names[0] !== "owner.json") fail("pending lock candidate has an unexpected entry");
    const ownerPath = join(pendingPath, "owner.json");
    let before: BigIntStats;
    let after: BigIntStats;
    try {
      before = lstatSync(ownerPath, { bigint: true });
      const resolved = realpathSync(ownerPath);
      after = lstatSync(ownerPath, { bigint: true });
      if (
        before.isSymbolicLink() ||
        !before.isFile() ||
        before.nlink !== 1n ||
        before.dev.toString(10) !== store.layout.projectDevice ||
        before.size > BigInt(MAX_RECORD_BYTES) ||
        (process.platform !== "win32" && (before.mode & 0o777n) !== 0o600n) ||
        !pathsEqual(resolved, ownerPath) ||
        !containedPath(store.layout.root, resolved) ||
        !sameFileIdentity(before, after)
      ) {
        fail("pending lock owner is not a bounded private regular file");
      }
      unlinkSync(ownerPath);
    } catch (error) {
      if (error instanceof GenerationStoreFsError) throw error;
      fail("pending lock owner removal failed", "METHODOLOGY_STORE_FILESYSTEM_FAILURE");
    }
  }
  const currentIdentity = requireOwnedDirectory(store, pendingPath);
  if (
    !privateDirectoryIdentity(currentIdentity) ||
    !sameDirectoryIdentity(directoryIdentity, currentIdentity)
  ) {
    fail("pending lock candidate changed before removal");
  }
  try {
    rmdirSync(pendingPath);
  } catch {
    fail("pending lock candidate removal failed", "METHODOLOGY_STORE_FILESYSTEM_FAILURE");
  }
  syncDirectory(dirname(pendingPath));
}

function prepareCandidateInventory(store: OwnedStore, runtime: LockRuntime): readonly string[] {
  const initial = inventoryCandidateNames(store, false);
  for (const name of initial) {
    const deleting = DELETING_CANDIDATE_NAME_PATTERN.exec(name);
    if (deleting?.[2] !== undefined) {
      const pid = Number(deleting[2]);
      if (Number.isSafeInteger(pid) && pid <= MAX_PID && safePidState(runtime, pid) === "absent") {
        removeDeletingCandidate(store, join(store.layout.lockCandidates, name));
      }
      continue;
    }
    const pending = PENDING_CANDIDATE_NAME_PATTERN.exec(name);
    if (pending?.[2] !== undefined) {
      const pid = Number(pending[2]);
      if (Number.isSafeInteger(pid) && pid <= MAX_PID && safePidState(runtime, pid) === "absent") {
        removePendingCandidate(store, join(store.layout.lockCandidates, name));
      }
      continue;
    }
    const complete = CANDIDATE_NAME_PATTERN.exec(name);
    if (complete?.[1] === undefined || complete[2] !== undefined) continue;
    try {
      const candidatePath = join(store.layout.lockCandidates, name);
      const exact = readExactClaimDirectory(store, candidatePath);
      if (
        privateDirectoryIdentity(exact.identity) &&
        safePidState(runtime, exact.claim.pid) === "absent"
      ) {
        removeExactClaimDirectory(store, candidatePath, exact.claim, exact.identity);
      }
    } catch (error) {
      if (
        error instanceof GenerationStoreFsError &&
        error.findingCode === "METHODOLOGY_STORE_FILESYSTEM_FAILURE"
      ) {
        throw error;
      }
      // Ambiguous candidates remain visible and fail later preflight checks.
    }
  }
  // A takeover needs one candidate slot and, while quarantining a dead lock,
  // one stale-fence slot. Reap exact absent-owner fences only at that threshold
  // and only if the inventory is otherwise quiescent.
  if (initial.length >= MAX_RECOVERY_RECORDS - 1) {
    reapQuiescentStaleFences(store, runtime);
  }
  return inventoryCandidateNames(store, true);
}

function validateRuntimeIdentity(
  store: OwnedStore,
  transactionId: string,
  runtime: LockRuntime,
): HeldStoreLock {
  if (!STORE_ID_PATTERN.test(transactionId)) {
    fail("lock transaction identity is invalid");
  }
  if (!Number.isInteger(runtime.pid) || runtime.pid < 1 || runtime.pid > MAX_PID) {
    fail("lock runtime PID is invalid");
  }
  let token: string;
  try {
    token = runtime.randomToken();
  } catch {
    fail("lock token generation failed");
  }
  if (!STORE_ID_PATTERN.test(token)) {
    fail("lock token is invalid");
  }
  return Object.freeze(
    LockOwnerRecordSchema.parse({
      schemaVersion: 1,
      rootId: store.rootRecord.rootId,
      token,
      pid: runtime.pid,
      transactionId,
    }),
  );
}

function createCandidate(
  store: OwnedStore,
  claim: HeldStoreLock,
  runtime: LockRuntime,
): Readonly<{ path: string; identity: DirectoryIdentity }> {
  const inventory = prepareCandidateInventory(store, runtime);
  if (inventory.includes(`${claim.token}.stale`)) {
    fail("lock token has an existing stale fence");
  }
  const candidatePath = join(store.layout.lockCandidates, claim.token);
  if (!pathAbsent(candidatePath)) {
    fail("lock candidate already exists");
  }
  const pendingPath = join(
    store.layout.lockCandidates,
    `${claim.token}.pending.${claim.pid.toString(10)}`,
  );
  let identity: DirectoryIdentity | undefined;
  try {
    mkdirSync(pendingPath, { mode: 0o700 });
  } catch (error) {
    if (errnoCode(error) === "EEXIST") {
      fail("lock candidate already exists");
    }
    fail("lock candidate could not be created", "METHODOLOGY_STORE_FILESYSTEM_FAILURE");
  }
  try {
    identity = requireOwnedDirectory(store, pendingPath);
    writeExclusiveRegularFile(
      store,
      join(pendingPath, "owner.json"),
      canonicalRecordBytes("lock-owner", claim),
    );
    const exact = renameAndVerifyClaim(store, pendingPath, candidatePath, claim, identity);
    return Object.freeze({ path: candidatePath, identity: exact.identity });
  } catch (error) {
    try {
      if (identity !== undefined && !pathAbsent(candidatePath)) {
        cleanupOwnCandidate(store, candidatePath, claim, identity);
      }
    } catch {
      // Retain uncertain candidate state.
    }
    try {
      if (!pathAbsent(pendingPath)) removePendingCandidate(store, pendingPath);
    } catch {
      // Retain uncertain pending state while preserving the original failure.
    }
    if (error instanceof GenerationStoreFsError) throw error;
    fail("lock candidate owner could not be written", "METHODOLOGY_STORE_FILESYSTEM_FAILURE");
  }
}

function renameAndVerifyClaim(
  store: OwnedStore,
  sourcePath: string,
  destinationPath: string,
  claim: HeldStoreLock,
  identity: DirectoryIdentity,
): ExactClaimDirectory {
  if (!pathAbsent(destinationPath)) {
    fail("claim rename destination already exists");
  }
  try {
    retryTransient(() => renameSync(sourcePath, destinationPath));
  } catch (error) {
    if (error instanceof GenerationStoreFsError) throw error;
    fail("claim rename failed", "METHODOLOGY_STORE_FILESYSTEM_FAILURE");
  }
  syncDirectory(dirname(sourcePath));
  if (!pathsEqual(dirname(sourcePath), dirname(destinationPath))) {
    syncDirectory(dirname(destinationPath));
  }
  const moved = readExactClaimDirectory(store, destinationPath);
  if (!sameClaim(moved.claim, claim) || !sameDirectoryIdentity(moved.identity, identity)) {
    fail("renamed claim changed identity");
  }
  return moved;
}

function rollbackOwnPublication(
  store: OwnedStore,
  candidate: Readonly<{ path: string; identity: DirectoryIdentity }>,
  claim: HeldStoreLock,
): boolean {
  try {
    if (!pathAbsent(candidate.path)) return false;
    retryTransient(() => renameSync(store.layout.lock, candidate.path));
    const moved = readExactClaimDirectory(store, candidate.path);
    if (
      !sameClaim(moved.claim, claim) ||
      !sameDirectoryIdentity(moved.identity, candidate.identity)
    ) {
      return false;
    }
    removeExactClaimDirectory(store, candidate.path, claim, moved.identity);
    syncDirectory(store.layout.root);
    return true;
  } catch {
    return false;
  }
}

function quarantineDeadLock(
  store: OwnedStore,
  dead: Extract<LiveLockState, { state: "dead" }>,
): void {
  inventoryCandidateNames(store, true);
  const stalePath = join(store.layout.lockCandidates, `${dead.claim.token}.stale`);
  renameAndVerifyClaim(store, store.layout.lock, stalePath, dead.claim, dead.identity);
}

function reapQuiescentStaleFences(store: OwnedStore, runtime: LockRuntime): void {
  try {
    const candidates = inventoryCandidateNames(store, false);
    if (candidates.some((name) => !name.endsWith(".stale"))) return;
    for (const name of candidates) {
      const match = CANDIDATE_NAME_PATTERN.exec(name);
      if (match?.[1] === undefined || match[2] === undefined) continue;
      const stalePath = join(store.layout.lockCandidates, name);
      const stale = readExactClaimDirectory(store, stalePath);
      if (
        name === `${stale.claim.token}.stale` &&
        privateDirectoryIdentity(stale.identity) &&
        safePidState(runtime, stale.claim.pid) === "absent"
      ) {
        removeExactClaimDirectory(store, stalePath, stale.claim, stale.identity);
      }
    }
  } catch {
    // Retain every uncertain ABA fence; later store preflight remains fail-closed.
  }
}

function claimCandidate(
  store: OwnedStore,
  candidate: Readonly<{ path: string; identity: DirectoryIdentity }>,
  claim: HeldStoreLock,
  runtime: LockRuntime,
): void {
  let before: LiveLockState;
  try {
    before = inspectLiveLock(store, runtime);
  } catch (error) {
    cleanupOwnCandidate(store, candidate.path, claim, candidate.identity);
    throw error;
  }
  if (before.state === "held") {
    cleanupOwnCandidate(store, candidate.path, claim, candidate.identity);
    fail("generation store lock is held", "METHODOLOGY_STORE_LOCK_HELD");
  }

  if (before.state === "dead") {
    try {
      quarantineDeadLock(store, before);
    } catch (error) {
      cleanupOwnCandidate(store, candidate.path, claim, candidate.identity);
      throw error;
    }
  }

  try {
    renameAndVerifyClaim(store, candidate.path, store.layout.lock, claim, candidate.identity);
  } catch (error) {
    let observed: LiveLockState;
    try {
      observed = inspectLiveLock(store, runtime);
    } catch {
      cleanupOwnCandidate(store, candidate.path, claim, candidate.identity);
      fail("lock claim destination became invalid");
    }
    if (
      observed.state !== "absent" &&
      sameClaim(observed.claim, claim) &&
      sameDirectoryIdentity(observed.identity, candidate.identity)
    ) {
      rollbackOwnPublication(store, candidate, claim);
      try {
        cleanupOwnCandidate(store, candidate.path, claim, candidate.identity);
      } catch {
        // Retain uncertain rollback state while preserving the original failure.
      }
      if (error instanceof GenerationStoreFsError) throw error;
      fail("own lock publication failed", "METHODOLOGY_STORE_FILESYSTEM_FAILURE");
    }
    cleanupOwnCandidate(store, candidate.path, claim, candidate.identity);
    if (observed.state === "held") {
      fail("generation store lock is held", "METHODOLOGY_STORE_LOCK_HELD");
    }
    if (observed.state === "dead") {
      fail("a different dead lock appeared during claim");
    }
    if (error instanceof GenerationStoreFsError) throw error;
    fail("lock claim rename failed", "METHODOLOGY_STORE_FILESYSTEM_FAILURE");
  }

  reapQuiescentStaleFences(store, runtime);
}

export function acquireStoreLockInternal(
  store: OwnedStore,
  transactionId: string,
  runtime: LockRuntime,
): HeldStoreLock {
  const claim = validateRuntimeIdentity(store, transactionId, runtime);
  assertOwnedStorePhase(store);
  const candidate = createCandidate(store, claim, runtime);
  claimCandidate(store, candidate, claim, runtime);
  return claim;
}

function productionPidState(pid: number): PidState {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    const code = errnoCode(error);
    return code === "ESRCH" ? "absent" : "indeterminate";
  }
}

const PRODUCTION_RUNTIME: LockRuntime = Object.freeze({
  pid: process.pid,
  randomToken: () => randomBytes(32).toString("hex"),
  pidState: productionPidState,
});

export function acquireStoreLock(store: OwnedStore, transactionId: string): HeldStoreLock {
  return acquireStoreLockInternal(store, transactionId, PRODUCTION_RUNTIME);
}

export function assertHeldStoreLock(store: OwnedStore, rawClaim: HeldStoreLock): HeldStoreLock {
  let claim: HeldStoreLock;
  try {
    claim = Object.freeze(LockOwnerRecordSchema.parse(rawClaim));
  } catch {
    fail("held lock claim is invalid");
  }
  if (claim.rootId !== store.rootRecord.rootId) {
    fail("held lock claim belongs to another store");
  }
  assertOwnedStorePhase(store);
  if (pathAbsent(store.layout.lock)) {
    fail("held lock disappeared");
  }
  const live = readExactClaimDirectory(store, store.layout.lock);
  if (!sameClaim(live.claim, claim)) {
    fail("live lock does not match the held claim");
  }
  return claim;
}

export function releaseStoreLock(store: OwnedStore, rawClaim: HeldStoreLock): void {
  let claim: HeldStoreLock;
  try {
    claim = Object.freeze(LockOwnerRecordSchema.parse(rawClaim));
  } catch {
    fail("release claim is invalid");
  }
  if (claim.rootId !== store.rootRecord.rootId) {
    fail("release claim belongs to another store");
  }
  assertOwnedStorePhase(store);
  ensureCandidateDirectory(store);
  const candidatePath = join(store.layout.lockCandidates, claim.token);
  const deletingPath = join(
    store.layout.lockCandidates,
    `${claim.token}.deleting.${claim.pid.toString(10)}`,
  );

  if (pathAbsent(store.layout.lock)) {
    inventoryCandidateNames(store, false);
    if (pathAbsent(candidatePath)) {
      if (pathAbsent(deletingPath)) {
        fail("live lock and release candidate are both absent");
      }
      removeDeletingCandidate(store, deletingPath, claim);
      return;
    }
    const interrupted = readExactClaimDirectory(store, candidatePath);
    if (!sameClaim(interrupted.claim, claim)) {
      fail("release candidate does not match the held claim");
    }
    removeExactClaimDirectory(store, candidatePath, claim, interrupted.identity);
    return;
  }

  inventoryCandidateNames(store, true);
  const live = readExactClaimDirectory(store, store.layout.lock);
  if (!sameClaim(live.claim, claim)) {
    fail("live lock does not match the held claim");
  }
  const moved = renameAndVerifyClaim(store, store.layout.lock, candidatePath, claim, live.identity);
  removeExactClaimDirectory(store, candidatePath, claim, moved.identity);
}

export const GENERATION_STORE_LOCK_BOUNDARY = Object.freeze({
  cooperativeOnly: true,
  sameUserTamperProof: false,
  candidateInventoryScanLimit: MAX_RECOVERY_RECORDS,
  concurrentCandidateHardCap: false,
  ambiguousCandidateAutoRepair: false,
  destructiveCleanupRecoverable: true,
  staleFenceRequiresQuiescence: true,
  providerRead: false,
  providerExecution: false,
  hostExecution: false,
  network: false,
  packageManager: false,
  native: false,
});
