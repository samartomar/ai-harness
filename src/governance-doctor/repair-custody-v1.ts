import { randomUUID } from "node:crypto";
import {
  type BigIntStats,
  closeSync,
  fchmodSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join, relative } from "node:path";
import { containedPath } from "../internals/contained-path.js";
import { readRegularFileWithStats, retryTransient } from "../internals/fsxn.js";
import { resolveOwnedFileRoot } from "../internals/owned-file-transaction.js";
import { assertExactKeysV1, assertRecordV1, governanceDoctorSha256V1 } from "./capability-v1.js";
import { brandedRepairValueV1, failGovernanceDoctorRepairV1 } from "./repair-capability-v1.js";
import {
  canonicalGovernanceDoctorRepairConsentV1Bytes,
  type GovernanceDoctorRepairConsentV1,
} from "./repair-consent-v1.js";
import {
  canonicalGovernanceDoctorRepairReceiptV1Bytes,
  type GovernanceDoctorRepairReceiptV1,
} from "./repair-outcome-v1.js";
import {
  canonicalGovernanceDoctorRepairPlanV1Bytes,
  type GovernanceDoctorRepairEffectV1,
  type GovernanceDoctorRepairPlanV1,
} from "./repair-plan-v1.js";

/**
 * Plan-bound filesystem custody for the mechanical Repair executor and verifier.
 *
 * Custody is minted from exactly one branded Plan and exactly one root, and the
 * two must already agree: the root identity is re-derived here and compared with
 * the identity the Plan's own operation record carries. A root that was never
 * audited, a context directory that drifted, or a Plan minted elsewhere all fail
 * closed before any path is resolved.
 *
 * Every operation re-walks the path one segment at a time from the bound real
 * root. At each step the segment must exist as a real, non-symlink entry that
 * still canonicalizes to the exact name the Plan asked for -- so a symlink, a
 * Windows junction or reparse point, a filesystem alias, a short-name form, and a
 * mid-run swap are each refused rather than followed. The root itself is
 * re-verified on every operation, so a root replaced under a live custody stops
 * the work instead of redirecting it.
 *
 * The reachable surface is deliberately three operations: read a managed path,
 * create one declared directory, and write one managed file. Reading needs only
 * custody; both mutations need a {@link GovernanceDoctorRepairMutationGrantV1},
 * which cannot be assembled from custody alone. There is no removal operation and
 * no step of any other kind is ever staged, so arbitrary deletion has no
 * representation here.
 *
 * A read is recorded privately. The caller is handed a frozen copy, but the bytes
 * and mode a later write compares against are the ones custody kept, so editing
 * the copy cannot move what counts as unchanged.
 *
 * Both mutations are written here rather than delegated. The repository's shared
 * owned-file transaction creates missing parent directories on the way to a
 * commit, which is right for a module that owns its own tree and wrong for this
 * one: custody may touch only locations the Plan declared and the caller already
 * observed. So each mutation proves the bound parent's identity, and no step in
 * either path creates a directory that was not already there. The write sequence
 * is explicit -- prove the parent, write the whole body to an exclusively created
 * scratch, flush it, displace any prior under a private name and prove what that
 * capture took, publish, re-read, flush the directory entry, drop the private
 * names -- and every publish is a hard link, which refuses rather than replaces
 * if anything raced into the name.
 *
 * Every refusal is a closed label. The OS reports paths in its diagnostics, so
 * those errors are caught here and never propagated: a hostile tree cannot use a
 * refusal as an output channel.
 */
export interface GovernanceDoctorRepairCustodyV1 {
  readonly protocol: "GovernanceDoctorRepairCustodyV1";
}

/**
 * A one-operation, in-memory authority assembled from a branded consented
 * receipt. It is spent at the boundary of the first mutation it is handed to,
 * whether that mutation goes on to succeed or to be refused.
 *
 * It is deliberately not a replay claim. Durable single-use lives in the
 * machine-local claim store and is taken by the executor before any effect runs;
 * this module holds no such state and survives no process.
 */
export interface GovernanceDoctorRepairMutationGrantV1 {
  readonly protocol: "GovernanceDoctorRepairMutationGrantV1";
}

export type GovernanceDoctorRepairReadV1 =
  | { readonly state: "absent" }
  | { readonly state: "absent-parent" }
  | { readonly state: "directory" }
  | { readonly state: "file"; readonly bytes: Buffer; readonly mode: number }
  | { readonly state: "unsafe" };

/** Hard, non-negotiable ceilings. Every bound is a raw byte count or file mode. */
export const GOVERNANCE_DOCTOR_REPAIR_CUSTODY_V1_LIMITS = Object.freeze({
  createdDirectoryMode: 0o755,
  createdFileMode: 0o644,
  maxManagedFileBytes: 256 * 1024,
});

const CUSTODY_PROTOCOL = "GovernanceDoctorRepairCustodyV1";
const CUSTODY_LABEL = "governance doctor repair";

/**
 * The operation record's own root-identity domain, mirrored here as a literal.
 * The operational adapter is outside this authority's import closure by design, so
 * the value is duplicated rather than imported; the equality with a Plan's
 * `rootSha256` is asserted directly in the custody tests, which is what keeps the
 * two from drifting apart.
 */
const OPERATIONAL_ROOT_DOMAIN = "aih.governance-doctor-operational-root-v1";

interface CustodyBodyV1 {
  readonly effectsById: ReadonlyMap<string, GovernanceDoctorRepairEffectV1>;
  readonly expiresAtEpochMs: number;
  readonly createdAtEpochMs: number;
  readonly planSha256: string;
  readonly realRoot: string;
  readonly rootIdentity: FileIdentity;
  readonly scopePaths: ReadonlySet<string>;
}

interface MutationGrantBodyV1 {
  readonly body: CustodyBodyV1;
  readonly effect: GovernanceDoctorRepairEffectV1;
  /** Exclusive upper bound: the Plan's own expiry. */
  readonly expiresAtEpochMs: number;
  /** Inclusive lower bound: the later of plan creation and the consent instant. */
  readonly notBeforeEpochMs: number;
  readonly receipt: GovernanceDoctorRepairReceiptV1;
}

/** Anti-forgery brand: a structurally identical plain object is not custody. */
const custodyBodies = new WeakMap<object, CustodyBodyV1>();
const readSnapshots = new WeakMap<object, ReadSnapshot>();
const mutationGrants = new WeakMap<object, MutationGrantBodyV1>();

const nativeRealpath = (realpathSync as unknown as { native?: (path: string) => string }).native;

interface FileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

/**
 * Custody's own private record of one read. The `bytes` and `mode` here are the
 * exact values custody observed, held where no caller can reach them: the copy
 * handed back is a different Buffer, so a caller that edits what it was given --
 * including editing it to agree with a state some other writer raced in -- changes
 * nothing this module later compares against.
 */
interface ReadSnapshot {
  readonly body: CustodyBodyV1;
  readonly bytes?: Buffer;
  readonly identities: readonly FileIdentity[];
  readonly mode?: number;
  readonly path: string;
  readonly state: "absent" | "file";
}

const O_NOFOLLOW = (fsConstants as Record<string, number | undefined>).O_NOFOLLOW ?? 0;
const O_NONBLOCK = (fsConstants as Record<string, number | undefined>).O_NONBLOCK ?? 0;
const O_DIRECTORY = (fsConstants as Record<string, number | undefined>).O_DIRECTORY ?? 0;

function identityOf(stats: Pick<BigIntStats, "dev" | "ino">): FileIdentity | undefined {
  if (stats.ino === 0n) return undefined;
  return { dev: stats.dev, ino: stats.ino };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function lstatSafe(path: string): BigIntStats | "absent" | "unsafe" {
  try {
    return retryTransient(() => lstatSync(path, { bigint: true }));
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unsafe";
  }
}

/**
 * Registers one read against custody's private record and returns the caller's
 * own frozen view of it. A file read is copied twice on purpose -- once for the
 * record and once for the caller -- so the two can never alias.
 */
function snapshot(
  body: CustodyBodyV1,
  path: string,
  observed: { readonly state: "absent" } | { readonly bytes: Buffer; readonly mode: number },
  identities: readonly FileIdentity[],
): GovernanceDoctorRepairReadV1 {
  const result = Object.freeze(
    "bytes" in observed
      ? { state: "file" as const, bytes: Buffer.from(observed.bytes), mode: observed.mode }
      : { state: "absent" as const },
  );
  readSnapshots.set(result, {
    body,
    identities: Object.freeze([...identities]),
    path,
    ...("bytes" in observed
      ? { bytes: Buffer.from(observed.bytes), mode: observed.mode, state: "file" as const }
      : { state: "absent" as const }),
  });
  return result;
}

function canonicalPath(path: string): string | null {
  if (typeof nativeRealpath !== "function") return null;
  try {
    return retryTransient(() => nativeRealpath(path));
  } catch {
    return null;
  }
}

/** Closes one descriptor; the fixed commit failure stays the only diagnostic. */
function closeQuietly(fd: number | undefined): void {
  if (fd === undefined) return;
  try {
    closeSync(fd);
  } catch {
    // A descriptor that cannot be closed changes no verdict already reached.
  }
}

/**
 * Proves one directory is still exactly the directory a read already bound, and
 * hands back nothing: the caller works from the path it already holds. Nothing
 * here creates anything, which is what lets the mutation paths below state that a
 * missing parent is refused rather than brought into being.
 */
function isBoundDirectory(path: string, identity: FileIdentity): boolean {
  const stats = lstatSafe(path);
  if (stats === "absent" || stats === "unsafe" || stats.isSymbolicLink() || !stats.isDirectory())
    return false;
  const actual = identityOf(stats);
  return actual !== undefined && sameIdentity(actual, identity);
}

function assertBoundDirectory(path: string, identity: FileIdentity): void {
  if (!isBoundDirectory(path, identity))
    failGovernanceDoctorRepairV1("repair managed destination changed before commit");
}

/**
 * Writes one scratch file in full and flushes it before it has any published
 * name.
 *
 * The scratch is created exclusively, so it can never adopt a file some other
 * writer left behind, and `writeSync` is driven to completion rather than trusted
 * to consume the whole buffer in one call -- a short write must not publish as a
 * truncated file. "Driven to completion" is bounded by progress, not by patience:
 * a report of nothing consumed, of a negative or non-integer count, or of more
 * than was handed ends the write rather than repeating it, which is what stops a
 * stalled descriptor from spinning a run that then neither publishes nor returns.
 * The flush happens while the scratch is still anonymous, so the
 * directory entry that later names these bytes can never become durable ahead of
 * the bytes themselves; that ordering is exactly what `writeFileSync` plus a bare
 * rename does not give.
 *
 * This is the same write / flush / publish / flush-directory sequence the
 * repository already uses for a durable promotion in
 * `src/org-policy/developer-seat-catalog-operations-v1.ts`. That module is outside
 * this authority's import closure by design, so the sequence is re-expressed here
 * rather than imported.
 */
function writeScratchDurably(
  scratch: string,
  bytes: Buffer,
  mode: number,
  record: (identity: FileIdentity) => void,
): void {
  let fd: number | undefined;
  try {
    fd = openSync(scratch, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, mode);
    // The kernel filters a create mode through the process umask, and the mode
    // here is the one custody's own read observed -- so it is restated on the
    // descriptor, or a repair under a restrictive umask would silently strip
    // group and other access from the file it restored.
    fchmodSync(fd, mode);
    // Recorded before a single byte is written, so a write that fails part way
    // still leaves the recovery below able to name what it has to clean up.
    const created = fstatSync(fd, { bigint: true });
    const identity = identityOf(created);
    if (!created.isFile() || created.nlink !== 1n || identity === undefined)
      failGovernanceDoctorRepairV1("repair managed write did not commit");
    record(identity);
    // Driven to completion, but bounded by progress rather than by patience. A
    // `writeSync` that reports nothing consumed, a negative or non-integer count,
    // or more consumed than it was handed is a refusal, not a reason to go round
    // again: looping on a descriptor that never advances is the one outcome worse
    // than refusing, because the run then neither publishes nor returns, and a
    // count that cannot be believed must not be believed even when the bytes it
    // claims to have written happen to be there.
    let written = 0;
    while (written < bytes.length) {
      const remaining = bytes.length - written;
      const progress = writeSync(fd, bytes, written, remaining);
      if (!Number.isSafeInteger(progress) || progress <= 0 || progress > remaining)
        failGovernanceDoctorRepairV1("repair managed write did not commit");
      written += progress;
    }
    const stats = fstatSync(fd, { bigint: true });
    if (!stats.isFile() || stats.nlink !== 1n || stats.size !== BigInt(bytes.length))
      failGovernanceDoctorRepairV1("repair managed write did not commit");
    fsyncSync(fd);
  } finally {
    closeQuietly(fd);
  }
}

/**
 * The exact facts that make one object this transaction's to remove.
 *
 * `bytes` is optional on purpose. A private name created here under a fresh
 * random name cannot have been written into by anyone else, so identity alone
 * settles ownership there -- and it has to, because a write that failed part way
 * leaves content nobody can predict. A published name is the opposite case: it is
 * reachable, so the content is part of ownership, and an inode somebody else
 * rewrote in place is no longer this transaction's to unlink.
 *
 * `permittedLinks` is optional for a related reason. Where a link count is part of
 * what the contract promises -- a managed file is single-linked -- it is checked.
 * Where it is not, it must not be: a second name somebody else added takes nothing
 * away, and removing one name of an object that has others destroys nothing at
 * all, so an unexpected count is no reason to leave this transaction's own name
 * lying around.
 */
interface OwnedObjectV1 {
  readonly bytes?: Buffer;
  readonly identity: FileIdentity;
  readonly permittedLinks?: readonly bigint[];
}

/** One private, unguessable name inside the bound parent. */
function privateName(kind: "displaced" | "retired" | "tmp"): string {
  return `.aih-repair.${process.pid}.${randomUUID()}.${kind}`;
}

/** True only when nothing at all occupies this name. */
function isAbsent(path: string): boolean {
  return lstatSafe(path) === "absent";
}

/**
 * Proves one name still holds exactly the object recorded here.
 *
 * A symlink, a reparse point, a directory, an unexpected link count, a different
 * inode, and -- where content is part of ownership -- a single byte that moved
 * are each enough to say this is no longer the object in hand. Everything that
 * answers `false` here is something the recovery below must leave exactly where
 * it is rather than clean up.
 */
function isOwnedObject(path: string, owned: OwnedObjectV1): boolean {
  const stats = lstatSafe(path);
  if (stats === "absent" || stats === "unsafe" || stats.isSymbolicLink() || !stats.isFile())
    return false;
  if (owned.permittedLinks !== undefined && !owned.permittedLinks.includes(stats.nlink))
    return false;
  const actual = identityOf(stats);
  if (actual === undefined || !sameIdentity(actual, owned.identity)) return false;
  if (owned.bytes === undefined) return true;
  const opened = readRegularFileWithStats(path, {
    maxBytes: GOVERNANCE_DOCTOR_REPAIR_CUSTODY_V1_LIMITS.maxManagedFileBytes,
  });
  if (opened === undefined || !opened.contents.equals(owned.bytes)) return false;
  const after = lstatSafe(path);
  const afterIdentity = after === "absent" || after === "unsafe" ? undefined : identityOf(after);
  return afterIdentity !== undefined && sameIdentity(afterIdentity, owned.identity);
}

/**
 * Puts a captured object back into the name it came from, and only into a name
 * nothing else has taken.
 *
 * The restore is a hard link, so it can never overwrite whatever won the name in
 * the meantime. The private name is dropped only once that link has succeeded,
 * which means the object stays reachable under at least one name at every
 * instant, whoever it belongs to.
 */
function restoreCapturedObject(captured: string, original: string): boolean {
  if (!isAbsent(original)) return false;
  try {
    retryTransient(() => linkSync(captured, original));
  } catch {
    return false;
  }
  try {
    retryTransient(() => unlinkSync(captured));
  } catch {
    // The object is safe under the restored name; a second name for it is not
    // worth an unlink that could race something else.
  }
  return true;
}

/**
 * Removes one object this transaction owns, and refuses to remove anything else.
 *
 * The removal is a capture first: the name is renamed to a fresh private one, and
 * only an object that then proves to be exactly the one recorded is unlinked.
 * Anything else goes straight back into the name it came from -- and if that name
 * has meanwhile been taken, it stays parked under the private name rather than
 * being destroyed. A stray private name is the one outcome preferable to deleting
 * bytes this transaction did not create.
 *
 * This is the retirement half of the same owned-file transaction the repository
 * already uses for a durable promotion in
 * `src/org-policy/developer-seat-catalog-operations-v1.ts`. That module is outside
 * this authority's import closure by design, so the sequence is re-expressed here
 * rather than imported.
 */
function retireOwnedObject(
  parent: string,
  parentIdentity: FileIdentity,
  path: string,
  owned: OwnedObjectV1,
): boolean {
  if (!isBoundDirectory(parent, parentIdentity)) return false;
  const tombstone = join(parent, privateName("retired"));
  try {
    retryTransient(() => renameSync(path, tombstone));
  } catch {
    return false;
  }
  if (!isOwnedObject(tombstone, owned)) {
    restoreCapturedObject(tombstone, path);
    return false;
  }
  try {
    retryTransient(() => unlinkSync(tombstone));
    return true;
  } catch {
    return false;
  }
}

/**
 * Makes the publication itself durable where the platform exposes a directory
 * handle. The handle is opened without following links and re-proved against the
 * exact parent identity the read snapshot already bound, so a directory swapped
 * in after the commit is refused rather than flushed.
 */
function syncPublishedDirectory(parent: string, identity: FileIdentity): void {
  if (process.platform === "win32" || O_DIRECTORY === 0) return;
  let fd: number | undefined;
  try {
    fd = openSync(parent, fsConstants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_DIRECTORY);
    const stats = fstatSync(fd, { bigint: true });
    const actual = identityOf(stats);
    if (!stats.isDirectory() || actual === undefined || !sameIdentity(actual, identity))
      failGovernanceDoctorRepairV1("repair managed write did not commit");
    fsyncSync(fd);
  } finally {
    closeQuietly(fd);
  }
}

/** The plan's declared root identity, derived from the same facts the run recorded. */
export function governanceDoctorRepairRootSha256V1(input: unknown): string {
  const record = assertRecordV1(input, "repair root binding");
  assertExactKeysV1(record, ["contextDir", "root"], "repair root binding");
  if (typeof record.contextDir !== "string" || typeof record.root !== "string")
    failGovernanceDoctorRepairV1("repair root binding must name a context directory and a root");
  return governanceDoctorSha256V1(OPERATIONAL_ROOT_DOMAIN, {
    contextDir: record.contextDir,
    root: record.root,
  });
}

/**
 * Validates one plan-and-root pairing and mints branded, frozen custody. The root
 * identity join happens before the root is ever resolved on disk, so a mismatched
 * pairing never touches the filesystem at all.
 */
export function createGovernanceDoctorRepairCustodyV1(
  input: unknown,
): GovernanceDoctorRepairCustodyV1 {
  const request = assertRecordV1(input, "repair custody request");
  assertExactKeysV1(request, ["contextDir", "plan", "root"], "repair custody request");
  canonicalGovernanceDoctorRepairPlanV1Bytes(request.plan);
  const plan = request.plan as GovernanceDoctorRepairPlanV1;
  if (
    governanceDoctorRepairRootSha256V1({ contextDir: request.contextDir, root: request.root }) !==
    plan.rootSha256
  )
    failGovernanceDoctorRepairV1("repair custody root is not the planned root");

  const scopePaths = new Set(plan.scope.paths);
  let realRoot: string;
  let rootIdentity: FileIdentity;
  try {
    realRoot = resolveOwnedFileRoot(request.root as string, CUSTODY_LABEL);
    const rootStats = lstatSafe(realRoot);
    if (
      rootStats === "absent" ||
      rootStats === "unsafe" ||
      rootStats.isSymbolicLink() ||
      !rootStats.isDirectory()
    )
      failGovernanceDoctorRepairV1("repair custody root is not a usable managed root");
    const identity = identityOf(rootStats);
    if (identity === undefined)
      failGovernanceDoctorRepairV1("repair custody root is not a usable managed root");
    rootIdentity = identity;
  } catch {
    return failGovernanceDoctorRepairV1("repair custody root is not a usable managed root");
  }
  const custody = Object.freeze({ protocol: CUSTODY_PROTOCOL as typeof CUSTODY_PROTOCOL });
  custodyBodies.set(custody, {
    createdAtEpochMs: plan.createdAtEpochMs,
    effectsById: new Map(plan.effects.map((effect) => [effect.effectId, effect])),
    expiresAtEpochMs: plan.expiresAtEpochMs,
    planSha256: plan.planSha256,
    realRoot,
    rootIdentity,
    scopePaths,
  });
  return custody;
}

/**
 * The half-open authority window, read from the platform clock and never from
 * caller input: `notBefore <= now < expiresAt`. Both bounds are facts the branded
 * Plan and Consent already carry, so no caller can widen either one.
 */
function withinAuthorityWindow(notBeforeEpochMs: number, expiresAtEpochMs: number): boolean {
  const now = Date.now();
  return now >= notBeforeEpochMs && now < expiresAtEpochMs;
}

/**
 * Re-reads the wall clock at the last moment before an effect is applied. A grant
 * minted inside the window but spent after it has closed is refused here, so the
 * window bounds the mutation rather than merely the paperwork that authorizes it.
 */
function assertAuthorityWindowV1(authorized: MutationGrantBodyV1): void {
  if (!withinAuthorityWindow(authorized.notBeforeEpochMs, authorized.expiresAtEpochMs))
    failGovernanceDoctorRepairV1("repair mutation grant is not authorized");
}

/**
 * The live authority window for one custody and its granted consent, checked
 * without minting anything.
 *
 * The grant below is the bound on a *write*, and for a long time it was the only
 * bound there was. An effect whose goal already holds takes no grant, so it read
 * no clock: it applied nothing, but it still reported `applied` on a plan whose
 * authority had already closed, and a Receipt saying work was done under expired
 * authority is a false audit trail even when the work was zero. The window bounds
 * the attempt, so it is checked before every effect and the grant checks it again
 * before every write -- the same rule read twice, because the second read is the
 * one that happens after the branches between them have run.
 */
export function assertGovernanceDoctorRepairAuthorityWindowV1(input: unknown): void {
  const request = assertRecordV1(input, "repair authority window request");
  assertExactKeysV1(request, ["consent", "custody"], "repair authority window request");
  const body = brandedRepairValueV1(custodyBodies, request.custody, "repair custody");
  canonicalGovernanceDoctorRepairConsentV1Bytes(request.consent);
  const consent = request.consent as GovernanceDoctorRepairConsentV1;
  if (
    consent.decision !== "granted" ||
    !withinAuthorityWindow(
      Math.max(body.createdAtEpochMs, consent.consentedAtEpochMs),
      body.expiresAtEpochMs,
    )
  )
    failGovernanceDoctorRepairV1("repair authority window is not open");
}

/**
 * Creates the narrow capability required to apply one declared effect. A plain
 * Plan/root custody cannot mint this: the exact branded granted consent and its
 * branded preflight receipt must agree with the custody, and the wall clock is
 * checked again at the authority boundary.
 */
export function createGovernanceDoctorRepairMutationGrantV1(
  input: unknown,
): GovernanceDoctorRepairMutationGrantV1 {
  const request = assertRecordV1(input, "repair mutation grant request");
  assertExactKeysV1(
    request,
    ["consent", "custody", "effectId", "receipt"],
    "repair mutation grant request",
  );
  const body = brandedRepairValueV1(custodyBodies, request.custody, "repair custody");
  canonicalGovernanceDoctorRepairConsentV1Bytes(request.consent);
  canonicalGovernanceDoctorRepairReceiptV1Bytes(request.receipt);
  const consent = request.consent as GovernanceDoctorRepairConsentV1;
  const receipt = request.receipt as GovernanceDoctorRepairReceiptV1;
  // The authority window opens at the later of the two facts that create it: a
  // Plan that exists but has not been consented to is not yet authority, so the
  // consent instant -- not merely plan creation -- is the inclusive lower bound.
  const notBeforeEpochMs = Math.max(body.createdAtEpochMs, consent.consentedAtEpochMs);
  if (
    typeof request.effectId !== "string" ||
    consent.decision !== "granted" ||
    receipt.planSha256 !== body.planSha256 ||
    receipt.consentSha256 !== consent.consentSha256 ||
    !withinAuthorityWindow(notBeforeEpochMs, body.expiresAtEpochMs)
  )
    failGovernanceDoctorRepairV1("repair mutation grant is not authorized");
  const effect = body.effectsById.get(request.effectId);
  if (
    effect === undefined ||
    !receipt.effects.some(
      (entry) => entry.effectId === effect.effectId && entry.effectSha256 === effect.effectSha256,
    )
  )
    failGovernanceDoctorRepairV1("repair mutation grant is not authorized");
  const grant = Object.freeze({
    protocol: "GovernanceDoctorRepairMutationGrantV1" as const,
  });
  mutationGrants.set(grant, {
    body,
    effect,
    expiresAtEpochMs: body.expiresAtEpochMs,
    notBeforeEpochMs,
    receipt,
  });
  return grant;
}

/**
 * Spends one grant. The brand is removed before the authority is handed back, so
 * the grant object is authority exactly once: a reuse after a successful mutation
 * and a reuse after a refused one are both unbranded and refused identically.
 *
 * This makes the in-memory grant object one-shot. It is deliberately NOT a
 * durable single-use consent claim: a caller that still holds the Consent and the
 * Receipt can mint a fresh grant, and nothing here survives the process. Durable
 * replay refusal is the machine-local claim store's job, and the executor takes
 * that claim before it mints the first grant of a run.
 */
function consumeMutationGrant(value: unknown): MutationGrantBodyV1 {
  const authorized = brandedRepairValueV1(mutationGrants, value, "repair mutation grant");
  mutationGrants.delete(value as object);
  return authorized;
}

/** The plan identity this custody was minted for. */
export function governanceDoctorRepairCustodyPlanSha256V1(custody: unknown): string {
  return brandedRepairValueV1(custodyBodies, custody, "repair custody").planSha256;
}

/**
 * The canonical real path of the root this custody is bound to, re-proved at the
 * moment it is read.
 *
 * This exists for exactly one caller: the durable claim scope, which has to bind
 * the checkout itself rather than whatever spelling of it a Plan was minted from.
 * It confers no new capability -- custody already reads and writes under this
 * root -- but it does hand out an absolute path, so it is reachable only from the
 * one module the capability boundary names.
 */
export function governanceDoctorRepairCustodyRootRealPathV1(custody: unknown): string {
  const body = brandedRepairValueV1(custodyBodies, custody, "repair custody");
  if (!rootIsIntact(body))
    failGovernanceDoctorRepairV1("repair custody root is not the bound managed root");
  return body.realRoot;
}

/** The bound real root is still exactly the directory custody was minted against. */
function rootIsIntact(body: CustodyBodyV1): boolean {
  const stats = lstatSafe(body.realRoot);
  if (stats === "absent" || stats === "unsafe" || stats.isSymbolicLink() || !stats.isDirectory())
    return false;
  const identity = identityOf(stats);
  return (
    identity !== undefined &&
    sameIdentity(identity, body.rootIdentity) &&
    canonicalPath(body.realRoot) === body.realRoot
  );
}

/**
 * Walks one plan-declared relative path from the bound real root, one segment at a
 * time, and reports the exact live state. Every intermediate segment must be a real
 * directory that canonicalizes to the name it was asked for; the leaf must be a
 * real directory or an unambiguous, bounded, single-linked regular file.
 */
function walk(body: CustodyBodyV1, path: string): GovernanceDoctorRepairReadV1 {
  if (!body.scopePaths.has(path) || !rootIsIntact(body)) return { state: "unsafe" };
  const segments = path.split("/");
  let current = body.realRoot;
  const identities: FileIdentity[] = [body.rootIdentity];
  for (let index = 0; index < segments.length; index += 1) {
    const isLeaf = index === segments.length - 1;
    const candidate = join(current, segments[index] as string);
    const stats = lstatSafe(candidate);
    if (stats === "unsafe") return { state: "unsafe" };
    if (stats === "absent")
      return isLeaf
        ? snapshot(body, path, { state: "absent" }, identities)
        : { state: "absent-parent" };
    if (stats.isSymbolicLink()) return { state: "unsafe" };
    const identity = identityOf(stats);
    if (identity === undefined) return { state: "unsafe" };
    const canonical = canonicalPath(candidate);
    if (canonical === null || !containedPath(body.realRoot, canonical)) return { state: "unsafe" };
    const resolved = relative(body.realRoot, canonical)
      .split(/[\\/]/)
      .filter((segment) => segment.length > 0);
    const wanted = segments.slice(0, index + 1);
    if (resolved.length !== wanted.length || resolved.some((s, i) => s !== wanted[i]))
      return { state: "unsafe" };
    if (!isLeaf) {
      if (!stats.isDirectory()) return { state: "unsafe" };
      identities.push(identity);
      current = canonical;
      continue;
    }
    if (stats.isDirectory()) return { state: "directory" };
    if (!stats.isFile()) return { state: "unsafe" };
    const opened = readRegularFileWithStats(canonical, {
      maxBytes: GOVERNANCE_DOCTOR_REPAIR_CUSTODY_V1_LIMITS.maxManagedFileBytes,
    });
    const after = lstatSafe(canonical);
    const afterIdentity = after === "absent" || after === "unsafe" ? undefined : identityOf(after);
    if (
      opened === undefined ||
      opened.stats.nlink > 1 ||
      after === "absent" ||
      after === "unsafe" ||
      afterIdentity === undefined ||
      !sameIdentity(identity, afterIdentity)
    )
      return { state: "unsafe" };
    return snapshot(
      body,
      path,
      { bytes: Buffer.from(opened.contents), mode: opened.stats.mode & 0o777 },
      [...identities, identity],
    );
  }
  return { state: "unsafe" };
}

/** The live state of one plan-declared managed path. Never throws, never mutates. */
export function governanceDoctorRepairReadV1(
  custody: unknown,
  path: unknown,
): GovernanceDoctorRepairReadV1 {
  const body = brandedRepairValueV1(custodyBodies, custody, "repair custody");
  return typeof path === "string" ? walk(body, path) : { state: "unsafe" };
}

/**
 * Creates exactly one declared directory, inside the exact parent the preceding
 * read already bound.
 *
 * Parents are never created: `recursive` is false and the parent's identity is
 * re-proved first, so an absent parent and a parent swapped after the read are
 * both refusals rather than something brought into being. A concurrent creator
 * racing the same directory into place is not an error -- the re-walk afterwards
 * is the only verdict, so the operation is idempotent under a race as well as on
 * a second call. The new entry is then made durable where the platform exposes a
 * directory handle.
 */
export function governanceDoctorRepairCreateDirectoryV1(grant: unknown): boolean {
  const authorized = consumeMutationGrant(grant);
  assertAuthorityWindowV1(authorized);
  const { body, effect } = authorized;
  if (effect.effectKind !== "create-managed-directory")
    failGovernanceDoctorRepairV1("repair managed path is not plan-declared");
  const path = effect.arguments.path;
  if (path === undefined || !body.scopePaths.has(path))
    failGovernanceDoctorRepairV1("repair managed path is not plan-declared");
  const live = walk(body, path);
  if (live.state === "directory") return false;
  const observed = readSnapshots.get(live);
  if (live.state !== "absent" || observed === undefined)
    failGovernanceDoctorRepairV1("repair managed directory destination is not available");
  const segments = path.split("/");
  const parent = join(body.realRoot, ...segments.slice(0, -1));
  const parentIdentity = observed.identities[segments.length - 1] as FileIdentity;
  assertBoundDirectory(parent, parentIdentity);
  const leaf = join(parent, segments[segments.length - 1] as string);
  let created = false;
  try {
    retryTransient(() =>
      mkdirSync(leaf, {
        recursive: false,
        mode: GOVERNANCE_DOCTOR_REPAIR_CUSTODY_V1_LIMITS.createdDirectoryMode,
      }),
    );
    created = true;
  } catch {
    // A concurrent creator is not an error; the re-walk below is the only verdict.
  }
  if (walk(body, path).state !== "directory")
    failGovernanceDoctorRepairV1("repair managed directory was not created");
  try {
    syncPublishedDirectory(parent, parentIdentity);
  } catch {
    // The flush can surface a raw OS error, and a refusal is never an output
    // channel: it collapses into the closed label here exactly as it does on
    // the write path. An entry whose durability cannot be proved is not a
    // created directory -- and a refusal must not leave the tree mutated under
    // a plan that is already durably spent, so the one directory this call
    // itself created is taken back where that is still safely possible: only
    // when this call's own mkdir succeeded, and only while the directory is
    // empty, so nothing anyone else raced into it can ever be destroyed.
    if (created) {
      try {
        retryTransient(() => rmdirSync(leaf));
      } catch {
        // Occupied or raced away: the stray stays, exactly like every other
        // recovery in this module that cannot prove its target.
      }
    }
    failGovernanceDoctorRepairV1("repair managed directory was not created");
  }
  // `created` is a fact about this exact mkdir call. A concurrent creator that
  // won the race produces a valid directory but not a mutation attributable to
  // this Repair attempt.
  return created;
}

/**
 * One managed publication, expressed so that no failure path can destroy an
 * object this transaction did not create.
 *
 * The order is fixed. Write the whole body to an exclusively created scratch and
 * flush it, then re-prove the bound parent the moment the scratch exists --
 * every syscall here is path-based, so a proof can never be welded to a use, and
 * the answer is to re-prove at each irreversible boundary instead. Free the
 * managed name by capturing whatever holds it under a private name --
 * atomically, so nothing can be substituted between the last check and the
 * moment the name frees -- and only then prove what the capture actually took.
 * Re-prove the reading and the parent once more, publish by hard link, which
 * refuses rather than replaces, retire the scratch, re-prove the published
 * object, let the caller confirm the managed reading, and flush the directory
 * entry. A parent that fails any of those re-proofs costs at most a stray
 * private scratch inside the substituted tree; it can never receive a
 * publication.
 *
 * Every recovery works from the same two rules. An object is removed only while
 * the name still holds exactly the object recorded for it -- identity, link count,
 * and, for the published name, its exact bytes -- so an inode somebody rewrote in
 * place is preserved rather than unlinked. And anything the transaction captured
 * goes back into the name it came from whenever that name is free; when it is not,
 * the capture stays parked under its private name, prior and foreign alike,
 * because a stray name costs less than bytes nobody can recover. A displaced prior
 * is cleared only once the write that supersedes it has actually landed.
 *
 * A parent it can no longer prove ends the recovery rather than steering it: a
 * directory somebody else installed is not a place to clean up in.
 */
interface ManagedPublicationV1 {
  readonly bytes: Buffer;
  /** Re-reads the managed path and refuses unless it now reads as the new bytes. */
  readonly confirmCommitted: () => void;
  /** Re-proves the pre-write reading and its bound directory chain, as late as a check can be taken. */
  readonly confirmUnchanged: () => void;
  readonly mode: number;
  readonly parent: string;
  readonly parentIdentity: FileIdentity;
  readonly prior: { readonly bytes: Buffer; readonly identity: FileIdentity } | undefined;
  readonly target: string;
}

function publishManagedFileV1(publication: ManagedPublicationV1): void {
  const { bytes, parent, parentIdentity, prior, target } = publication;
  const scratch = join(parent, privateName("tmp"));
  const captured = join(parent, privateName("displaced"));
  const priorOwned: OwnedObjectV1 | undefined =
    prior === undefined
      ? undefined
      : { bytes: prior.bytes, identity: prior.identity, permittedLinks: [1n] };
  let scratchOwned: OwnedObjectV1 | undefined;
  let publishedIdentity: FileIdentity | undefined;
  let capturedKind: "foreign" | "none" | "prior" = "none";

  const rollback = (): void => {
    if (!isBoundDirectory(parent, parentIdentity)) return;
    // The published object first, and only while the managed name still holds
    // exactly it. A foreign replacement -- including one written into the very
    // inode this transaction published -- fails that proof and is left alone.
    if (publishedIdentity !== undefined) {
      const owned: OwnedObjectV1 = { bytes, identity: publishedIdentity };
      if (isOwnedObject(target, owned)) retireOwnedObject(parent, parentIdentity, target, owned);
    }
    if (scratchOwned !== undefined)
      retireOwnedObject(parent, parentIdentity, scratch, scratchOwned);
    // Whatever the capture took goes back into the name it came from whenever that
    // name is free. When it is not -- something else won the name while this
    // transaction held the object -- the capture stays parked under its private
    // name, prior and foreign alike. A publication that failed leaves nothing
    // behind it can offer in exchange, so no pre-existing object is ever unlinked
    // here merely because its original name is now occupied.
    if (capturedKind !== "none") restoreCapturedObject(captured, target);
    // Every path above can have retired an owned name, so the directory entries the
    // recovery moved are made durable on all of them, capture or none. A rollback
    // that only removed what this transaction published is exactly the case that
    // needs it: leaving that removal unflushed lets a crash resurrect a file from
    // an operation that already reported failure.
    syncPublishedDirectory(parent, parentIdentity);
  };

  try {
    writeScratchDurably(scratch, bytes, publication.mode, (identity) => {
      scratchOwned = { identity };
    });
    if (scratchOwned === undefined)
      failGovernanceDoctorRepairV1("repair managed write did not commit");
    const scratchIdentity = scratchOwned.identity;
    // The scratch was reached by path, so the parent is re-proved the moment the
    // scratch exists, and the scratch must sit on the proved parent's own
    // device. A directory swapped in behind the path -- a fresh directory or a
    // link out of the root -- captures at most a stray private scratch and never
    // a publication.
    assertBoundDirectory(parent, parentIdentity);
    if (scratchIdentity.dev !== parentIdentity.dev)
      failGovernanceDoctorRepairV1("repair managed write did not commit");
    if (priorOwned !== undefined) {
      publication.confirmUnchanged();
      retryTransient(() => renameSync(target, captured));
      capturedKind = isOwnedObject(captured, priorOwned) ? "prior" : "foreign";
      if (capturedKind === "foreign")
        failGovernanceDoctorRepairV1("repair managed destination changed before commit");
    } else {
      // No capture step runs on an absent destination, so this branch takes the
      // same late re-proof of the reading and the bound directory chain.
      publication.confirmUnchanged();
    }
    // As late as a path-based check can be taken: the parent is proved once more
    // immediately before the one call that gives the new bytes a reachable name.
    assertBoundDirectory(parent, parentIdentity);
    // Atomic and non-replacing: anything now at the name refuses the publish
    // rather than being written over.
    retryTransient(() => linkSync(scratch, target));
    publishedIdentity = scratchIdentity;
    // The published file carries two names until this one goes, and a managed file
    // must be single-linked, so the scratch is retired before the re-read.
    if (!retireOwnedObject(parent, parentIdentity, scratch, { identity: scratchIdentity }))
      failGovernanceDoctorRepairV1("repair managed write did not commit");
    scratchOwned = undefined;
    if (!isOwnedObject(target, { bytes, identity: scratchIdentity, permittedLinks: [1n] }))
      failGovernanceDoctorRepairV1("repair managed write did not commit");
    publication.confirmCommitted();
    // The content was flushed before it was published, so only the directory entry
    // that names it still has to be made durable.
    syncPublishedDirectory(parent, parentIdentity);
    // The write has landed, so the prior is superseded and this transaction's to
    // clear. A private name that no longer holds it is left alone.
    if (capturedKind === "prior" && priorOwned !== undefined)
      retireOwnedObject(parent, parentIdentity, captured, priorOwned);
  } catch {
    // Every failure collapses into the one closed label, so neither the OS nor a
    // hostile tree can speak through this path. The recovery runs first, and is
    // itself allowed to fail without changing the verdict already reached.
    try {
      rollback();
    } catch {
      // A recovery that could not complete leaves the tree it could not prove
      // untouched; the refusal below is still the whole outcome.
    }
    failGovernanceDoctorRepairV1("repair managed write did not commit");
  }
}

/**
 * Writes one managed file, refusing to commit unless the live tree is still
 * exactly the tree the caller's read observed.
 *
 * `live` is that earlier read. It is used as a token, never as data: the bytes and
 * mode this function compares and writes come from custody's own private record of
 * that read, so a caller that edits the Buffer it was handed -- including editing
 * it to agree with a state another writer raced in -- cannot move what counts as
 * unchanged.
 *
 * The publication itself is {@link publishManagedFileV1}, which owns the ordering
 * and the recovery. What stays here is the authority join: the grant, the declared
 * effect kind, the plan-declared path, the bounded body, the branded read, and the
 * whole chain of directory identities that read bound.
 *
 * No step here creates a directory. A parent that disappeared after the read is a
 * refusal, not something to rebuild, so this path can never bring into being a
 * location the Plan did not declare and the caller did not already observe.
 */
export function governanceDoctorRepairWriteFileV1(
  grant: unknown,
  bytes: unknown,
  live: unknown,
): void {
  const authorized = consumeMutationGrant(grant);
  assertAuthorityWindowV1(authorized);
  const { body, effect } = authorized;
  if (
    ![
      "normalize-managed-line-endings",
      "restore-managed-file-content",
      "rewrite-managed-marker-block",
    ].includes(effect.effectKind)
  )
    failGovernanceDoctorRepairV1("repair managed path is not plan-declared");
  const path = effect.arguments.path;
  if (path === undefined || !body.scopePaths.has(path))
    failGovernanceDoctorRepairV1("repair managed path is not plan-declared");
  if (
    !Buffer.isBuffer(bytes) ||
    bytes.length > GOVERNANCE_DOCTOR_REPAIR_CUSTODY_V1_LIMITS.maxManagedFileBytes
  )
    failGovernanceDoctorRepairV1("repair managed content is outside its bounded byte length");
  if (typeof live !== "object" || live === null)
    failGovernanceDoctorRepairV1("repair managed destination is not writable");
  const observed = readSnapshots.get(live as object);
  if (observed === undefined || observed.body !== body || observed.path !== path)
    failGovernanceDoctorRepairV1("repair managed destination is not writable");

  const assertChainBound = (): void => {
    if (
      !rootIsIntact(body) ||
      observed.identities.some((identity, index) => {
        const prefix =
          index === 0 ? body.realRoot : join(body.realRoot, ...path.split("/").slice(0, index));
        const actual = lstatSafe(prefix);
        const actualIdentity =
          actual === "absent" || actual === "unsafe" ? undefined : identityOf(actual);
        return actualIdentity === undefined || !sameIdentity(actualIdentity, identity);
      })
    )
      failGovernanceDoctorRepairV1("repair managed destination changed before commit");
  };
  assertChainBound();

  // Every comparison below reads custody's private record, never the caller's copy.
  // The reading and the whole bound directory chain are re-proved together: a
  // walk alone accepts any real directory at each segment, so without the
  // identity comparison a substituted parent holding an identical-bytes file
  // would still read as unchanged.
  const assertUnchanged = (): void => {
    assertChainBound();
    const current = walk(body, path);
    if (
      current.state !== observed.state ||
      (current.state === "file" &&
        observed.bytes !== undefined &&
        !current.bytes.equals(observed.bytes))
    )
      failGovernanceDoctorRepairV1("repair managed destination changed before commit");
  };
  assertUnchanged();
  const segments = path.split("/");
  const parent = join(body.realRoot, ...segments.slice(0, -1));
  const parentIdentity = observed.identities[segments.length - 1] as FileIdentity;
  assertBoundDirectory(parent, parentIdentity);
  const content = Buffer.from(bytes);
  publishManagedFileV1({
    bytes: content,
    confirmCommitted: () => {
      const committed = walk(body, path);
      if (committed.state !== "file" || !committed.bytes.equals(content))
        failGovernanceDoctorRepairV1("repair managed write did not commit");
    },
    confirmUnchanged: assertUnchanged,
    mode: observed.mode ?? GOVERNANCE_DOCTOR_REPAIR_CUSTODY_V1_LIMITS.createdFileMode,
    parent,
    parentIdentity,
    prior:
      observed.state === "file" && observed.bytes !== undefined
        ? {
            bytes: observed.bytes,
            identity: observed.identities[segments.length] as FileIdentity,
          }
        : undefined,
    target: join(parent, segments[segments.length - 1] as string),
  });
}
