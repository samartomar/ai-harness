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
import { dirname, join } from "node:path";
import { containedPath } from "../internals/contained-path.js";
import { retryTransient } from "../internals/fsxn.js";
import {
  canonicalRecordBytes,
  type LockOwnerRecord,
  LockOwnerRecordSchema,
  MAX_PID,
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
      if (match === null || entry.isSymbolicLink() || !entry.isDirectory()) {
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
    !sameDirectoryIdentity(current.identity, expectedIdentity)
  ) {
    fail("claim changed before exact removal");
  }
  try {
    unlinkSync(join(directoryPath, "owner.json"));
    rmdirSync(directoryPath);
  } catch {
    fail("exact claim removal failed", "METHODOLOGY_STORE_FILESYSTEM_FAILURE");
  }
  syncDirectory(dirname(directoryPath));
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
): Readonly<{ path: string; identity: DirectoryIdentity }> {
  const inventory = inventoryCandidateNames(store, true);
  if (inventory.includes(`${claim.token}.stale`)) {
    fail("lock token has an existing stale fence");
  }
  const candidatePath = join(store.layout.lockCandidates, claim.token);
  try {
    mkdirSync(candidatePath, { mode: 0o700 });
  } catch (error) {
    if (errnoCode(error) === "EEXIST") {
      fail("lock candidate already exists");
    }
    fail("lock candidate could not be created", "METHODOLOGY_STORE_FILESYSTEM_FAILURE");
  }
  const identity = requireOwnedDirectory(store, candidatePath);
  try {
    writeExclusiveRegularFile(
      store,
      join(candidatePath, "owner.json"),
      canonicalRecordBytes("lock-owner", claim),
    );
  } catch (error) {
    try {
      if (boundedNames(candidatePath, 1).length === 0) rmdirSync(candidatePath);
    } catch {
      // Retain uncertain candidate state.
    }
    if (error instanceof GenerationStoreFsError) throw error;
    fail("lock candidate owner could not be written", "METHODOLOGY_STORE_FILESYSTEM_FAILURE");
  }
  const exact = readExactClaimDirectory(store, candidatePath);
  if (!sameClaim(exact.claim, claim) || !sameDirectoryIdentity(exact.identity, identity)) {
    fail("lock candidate verification failed");
  }
  return Object.freeze({ path: candidatePath, identity });
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

  let recoveredStalePath: string | undefined;
  let recoveredStale: Extract<LiveLockState, { state: "dead" }> | undefined;
  if (before.state === "dead") {
    recoveredStale = before;
    try {
      quarantineDeadLock(store, before);
      recoveredStalePath = join(store.layout.lockCandidates, `${before.claim.token}.stale`);
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

  if (recoveredStalePath !== undefined && recoveredStale !== undefined) {
    try {
      const candidates = inventoryCandidateNames(store, false);
      const contenderMayHoldOldObservation = candidates.some((name) => !name.endsWith(".stale"));
      if (!contenderMayHoldOldObservation) {
        const stale = readExactClaimDirectory(store, recoveredStalePath);
        if (
          sameClaim(stale.claim, recoveredStale.claim) &&
          sameDirectoryIdentity(stale.identity, recoveredStale.identity) &&
          safePidState(runtime, stale.claim.pid) === "absent"
        ) {
          removeExactClaimDirectory(store, recoveredStalePath, stale.claim, stale.identity);
        }
      }
    } catch {
      // Retain the exact ABA fence whenever quiescence or cleanup is uncertain.
    }
  }
}

export function acquireStoreLockInternal(
  store: OwnedStore,
  transactionId: string,
  runtime: LockRuntime,
): HeldStoreLock {
  const claim = validateRuntimeIdentity(store, transactionId, runtime);
  assertOwnedStorePhase(store);
  const candidate = createCandidate(store, claim);
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

  if (pathAbsent(store.layout.lock)) {
    inventoryCandidateNames(store, false);
    if (pathAbsent(candidatePath)) {
      fail("live lock and release candidate are both absent");
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
  staleFenceRequiresQuiescence: true,
  providerRead: false,
  providerExecution: false,
  hostExecution: false,
  network: false,
  packageManager: false,
  native: false,
});
