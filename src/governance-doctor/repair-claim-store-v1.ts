import {
  type BigIntStats,
  closeSync,
  type Dir,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  opendirSync,
  openSync,
  realpathSync,
  writeSync,
} from "node:fs";
import { userInfo } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { readBoundedFileDescriptor, retryTransient } from "../internals/fsxn.js";
import { assertExactKeysV1, assertRecordV1 } from "./capability-v1.js";
import { failGovernanceDoctorRepairV1 } from "./repair-capability-v1.js";
import {
  canonicalGovernanceDoctorRepairClaimV1Bytes,
  createGovernanceDoctorRepairClaimV1,
  GOVERNANCE_DOCTOR_REPAIR_CLAIM_V1_LIMITS,
  type GovernanceDoctorRepairClaimV1,
  governanceDoctorRepairClaimFileNameV1,
  governanceDoctorRepairClaimScopeSha256V1,
  governanceDoctorRepairClaimSha256V1,
  parseGovernanceDoctorRepairClaimV1,
} from "./repair-claim-v1.js";
import {
  canonicalGovernanceDoctorRepairConsentV1Bytes,
  type GovernanceDoctorRepairConsentV1,
} from "./repair-consent-v1.js";
import {
  canonicalGovernanceDoctorRepairPlanV1Bytes,
  type GovernanceDoctorRepairPlanV1,
} from "./repair-plan-v1.js";

/**
 * The durable machine-local authority home for Repair single-use claims.
 *
 * This is the effectful half of the claim contract. It owns exactly one location
 * -- `<home>/.aih/governance-doctor/repair-claims-v1/` -- and it has exactly one
 * reachable operation: claim one granted Plan, once, before that Plan is allowed
 * to change anything. There is no read-back for callers, no listing, no
 * transition, and above all no removal: a name this authority did not create is
 * never touched, and a name it did create is never taken back.
 *
 * ## Why this home and not the project's `.aih/`
 *
 * A repair claim has to outlive the run that took it, the process that took it,
 * and the working tree it was taken against. The project-local `.aih/` is
 * explicitly disposable and never a source of truth, so a claim kept there would
 * be erased by exactly the routine cleanup that invariant invites -- and an erased
 * claim reads as "never spent", which is the failure this whole module exists to
 * prevent. The machine-local home is durable, is not Git-tracked, and is not
 * disposable, so it is where the claim lives.
 *
 * ## What is authority-controlled, and what is merely resolved
 *
 * The home is the OS *account's* home, read from the account record rather than
 * from `$HOME` or `%USERPROFILE%`. Those variables are settable by anyone who can
 * start this process, so a root read from them would be a caller-controlled store
 * root: the same granted Plan relaunched under a different environment would find
 * a fresh, empty store and replay. There is no caller input and no test setter for
 * this location.
 *
 * The home directory itself is *not* claimed: this module never creates it and
 * never writes into it beyond the one segment it owns. But it is not outside the
 * mutation boundary either, and neither is the path that reaches it. POSIX puts
 * the right to remove a name in the directory holding it, so the home's own write
 * bit -- not `.aih`'s -- decides who may `unlink` or `rename` the entry `.aih`,
 * and the same is true one level further up, and the level above that. A writable
 * grandparent lets another account rename the *parent* aside and supply its own,
 * home and store included, so a bound pinned at any one level only moves the
 * attack up a step.
 *
 * The reported home is therefore required to be a real, absolute, canonical,
 * non-link directory that only this account may mutate, and its whole lexical
 * naming ancestry up to the filesystem root is proved too -- under the weaker
 * rule real systems require, since `/`, `/home`, `/Users`, and `/private` belong
 * to root and always will. The walk is bounded by depth and by the reported
 * home's length; it is not an unbounded traversal of whatever the platform hands
 * over.
 *
 * The three segments below it -- `.aih`, `governance-doctor`, `repair-claims-v1`
 * -- are authority-controlled. Each must be a real directory whose canonical path
 * is exactly the name asked for under the already-canonical parent, so a symlink,
 * a Windows junction, any other reparse point, a filesystem alias, and a
 * case-variant substitution are each refused rather than followed. Each is also
 * re-proved immediately before and immediately after the segment below it is
 * resolved, so an ancestor swapped between two proofs is refused instead of
 * having its child adopted. Nothing above that boundary is overclaimed, and
 * nothing below it is trusted.
 *
 * An ancestor is safe when it is owned by root or by this account and is not
 * group- or world-writable, or when it is sticky and names an entry owned by root
 * or by this account -- which is what makes a 01777 `/tmp` safe and a 0777 one
 * not. The home-and-ancestry proof is frozen once and then carried by every
 * controlled directory resolved under it, so it is re-proved at each segment
 * boundary *and* at the store's own -- immediately before the exclusive create
 * and again after the read-back. That matters because a substitution can carry
 * the whole subtree into the replacement: the home, the three segments, and the
 * store all keep their inodes, and only this proof can see that the entries above
 * them moved. A swap spanning any of those boundaries is refused, which is
 * bounded and deliberately not atomicity -- no syscall here is atomic with the
 * next one.
 *
 * On POSIX the resolved home and each controlled segment must additionally be
 * mutable by this account alone: group- or world-writable bits, or an owner that
 * is not this process, let another local account remove the permanent record, and
 * a removed record reads as "never claimed". The account lookup that owner rule
 * needs is itself part of the proof, so an unavailable, throwing, or malformed
 * `getuid` is a refusal rather than a rule that quietly stops applying. Windows
 * reports a mode derived from the read-only attribute rather than from an ACL and
 * reports no uid, so that bound is not asserted there and no ACL boundary is
 * invented in its place -- a recorded limitation, not a claim.
 *
 * The same rule governs the checkout the claim is scoped to: the root must be an
 * absolute existing real directory whose native canonical form is exactly the
 * spelling supplied. The scope digest binds bytes, so a spelling that merely
 * reaches the checkout -- an uppercase variant on a case-insensitive volume, a
 * symlink to it -- would otherwise open a second authority scope for a root
 * already claimed.
 *
 * ## First use has to be durable, not merely present
 *
 * Creating a directory does not commit the entry that names it; that entry lives
 * in the parent. So each segment this module creates is followed immediately by a
 * re-proof and a flush of its naming parent, before the next segment is touched.
 * Without that, first use could flush the record and the store while the ancestry
 * naming the store was still only in cache -- and a store lost that way reads as
 * "never claimed", which is the one direction this module must never fail in.
 *
 * ## What the identity re-proofs do and do not claim
 *
 * Every controlled directory is carried as its path *and* the `dev`+`ino` it had
 * when it was proved, and the store is re-proved immediately before the exclusive
 * create and again after the flushes and the read-back. Node exposes no way to
 * create a name inside an already-open directory handle, so the gap between
 * proving the store and creating a record in it is a path lookup this module
 * cannot close. What is claimed is therefore bounded and is deliberately not
 * atomicity: a substitution spanning either boundary is refused, and a
 * substitution that lands and is reverted entirely inside one syscall is outside
 * what these APIs can observe.
 *
 * ## Exclusive creation is the whole lock
 *
 * A claim file is created with `O_CREAT | O_EXCL` under a name derived only from
 * the claim's own identity digest. `EEXIST` is not an error to work around: it is
 * the answer, and the answer is that this Plan is already spent. That makes the
 * lock impossible to steal, because taking it is the same syscall as creating it,
 * and losing the race is indistinguishable from finding the record already there.
 *
 * ## An interruption spends the Plan
 *
 * Once the exclusive create succeeds, nothing removes that file -- not a short
 * write, not a failed flush, not a failed read-back, not a crash. Every one of
 * those leaves a record behind, and a record that exists at all, in any state this
 * module can or cannot parse, refuses the next attempt. That is deliberate: the
 * safe direction for an interrupted repair is "this Plan is spent, mint a new
 * one", never "try again and hope the first attempt changed nothing".
 *
 * A record that is malformed, truncated, non-canonical, oversized, hard-linked, or
 * unreadable is therefore never treated as absent. It is a refusal.
 *
 * ## Retention
 *
 * There is no reaper. Pruning a `claimed` record is the one operation that could
 * hand a spent Plan back, so this module does not implement it at any interval or
 * under any condition. The store is instead bounded: past its record ceiling it
 * fails closed and waits for an operator, rather than making room by deleting
 * evidence. The ceiling is counted through a directory handle one entry at a time
 * and stops at the ceiling, so a hostile home cannot make the bound fail open by
 * being larger than this process can hold.
 *
 * ## The Windows open-time reparse limitation
 *
 * Every descriptor this module opens asks for `O_NOFOLLOW`, which on POSIX makes
 * the open itself refuse a symlink. Windows does not define that flag, so there
 * the constant is zero and the open follows a junction or any other reparse point
 * exactly as it would a real name. The bound on Windows is therefore not the
 * open: it is the `lstat` before it and the `fstat` on the descriptor after it,
 * which together require a real, single-linked regular file whose identity is the
 * one that was proved. What is not closed there is the interval between those two
 * calls -- a reparse point substituted inside it is followed, and its target is
 * read as if it were the record. That is a recorded platform limitation of this
 * store, not a claim about Windows, and it is the same bounded-not-atomic shape
 * as every other path lookup here.
 *
 * Every refusal is a fixed label. No path, no OS diagnostic, and no record content
 * is ever interpolated, so neither the filesystem nor a hostile record can use an
 * error as an output channel.
 */

/** Hard, non-negotiable ceilings and modes for the machine-local store. */
export const GOVERNANCE_DOCTOR_REPAIR_CLAIM_STORE_V1_LIMITS = Object.freeze({
  claimFileMode: 0o600,
  /**
   * How far the home's naming ancestry may be walked before the walk is itself a
   * refusal. The chain is lexical and strictly shortening, so it terminates on
   * every real layout long before this; the ceiling is here so a pathological or
   * hostile account home cannot turn a security proof into unbounded work.
   */
  maxHomeAncestorDepth: 64,
  /** The same bound expressed on the reported home itself, checked before any walk. */
  maxHomePathLength: 4096,
  maxStoreRecords: 4096,
  storeDirectoryMode: 0o700,
});

/**
 * The authority-controlled segments, in order, below the resolved home. This list
 * is the entire location this module owns; widening it is a reviewed edit here.
 */
export const GOVERNANCE_DOCTOR_REPAIR_CLAIM_STORE_V1_SEGMENTS: readonly string[] = Object.freeze([
  ".aih",
  "governance-doctor",
  "repair-claims-v1",
]);

const ACQUIRE_FIELDS = ["consent", "plan", "rootRealPath"] as const;

const UNAVAILABLE = "repair claim store is not available";
const NOT_CANONICAL = "repair claim scope is not a canonical managed root";
const OVER_CAPACITY = "repair claim store exceeds its bounded record count";
const UNREADABLE = "repair claim store holds a record this authority cannot read";
const ALREADY_CLAIMED = "repair plan was already claimed";
const NOT_COMMITTED = "repair claim did not commit";

const nativeRealpath = (realpathSync as unknown as { native?: (path: string) => string }).native;

const O_NOFOLLOW = (fsConstants as Record<string, number | undefined>).O_NOFOLLOW ?? 0;
const O_NONBLOCK = (fsConstants as Record<string, number | undefined>).O_NONBLOCK ?? 0;
const O_DIRECTORY = (fsConstants as Record<string, number | undefined>).O_DIRECTORY ?? 0;

interface FileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

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

/** The canonical real path, or nothing. The OS diagnostic never escapes. */
function canonicalPath(path: string): string | null {
  if (typeof nativeRealpath !== "function") return null;
  try {
    return retryTransient(() => nativeRealpath(path));
  } catch {
    return null;
  }
}

/** Closes one descriptor; the fixed refusal already reached stays the diagnostic. */
function closeQuietly(fd: number | undefined): void {
  if (fd === undefined) return;
  try {
    closeSync(fd);
  } catch {
    // A descriptor that cannot be closed changes no verdict already reached.
  }
}

/**
 * One directory this authority has proved, carried as the path it was proved at
 * and the `dev`+`ino` it had at that moment.
 *
 * A path is not a handle. Every later syscall re-resolves it, so a directory
 * renamed away and replaced would be addressed as if it were the proved one.
 * Carrying the identity is what lets each later boundary ask whether the name
 * still leads to the same object rather than merely to some object.
 */
interface ControlledDirectoryV1 {
  /**
   * The frozen proof of the resolved account home and its naming ancestry.
   *
   * It is carried by the home *and by every controlled directory resolved under
   * it*, so the chain can be re-proved at every later boundary rather than only
   * while the first segment is being resolved. Dropping it after `.aih` left the
   * deeper segments and the store with nothing to re-prove, and an ancestor
   * substituted after that window kept every identity below it intact -- so the
   * record was created under a chain this authority no longer controlled.
   *
   * `undefined` means the rule is not asserted on this platform, which is Windows
   * and only Windows.
   */
  readonly ancestry?: ProvenAncestryV1;
  readonly identity: FileIdentity;
  readonly path: string;
}

/**
 * One frozen proof of where the store's authority is rooted: the resolved account
 * home, and the lexical naming ancestry above it, nearest first.
 *
 * The home is carried alongside the ancestors because a substitution can move the
 * home itself -- an attacker who renames an ancestor can carry the whole subtree
 * into the replacement, which leaves every descendant identity untouched and
 * changes only the entries above them.
 */
interface ProvenAncestryV1 {
  readonly ancestors: readonly ControlledDirectoryV1[];
  readonly home: ControlledDirectoryV1;
}

/**
 * Whether one proved directory is mutable only by the account this authority runs
 * as.
 *
 * The store's whole guarantee is a record that exists and is never removed, so a
 * directory some other local account can write into is a directory in which that
 * account can remove the record -- and a removed record reads as "never claimed",
 * which hands a spent Plan straight back. Group- and world-writable bits are
 * therefore refused, and so is a directory owned by another account: an owner can
 * widen the mode at any later instant, so ownership is the bound that mode bits
 * alone would only appear to give.
 *
 * This applies to the resolved account home as well as to the segments below it,
 * because POSIX puts the right to remove a name in the directory that *holds* the
 * name, not in the named object. A 0700 `.aih` says nothing about who may
 * `unlink` or `rename` the entry `.aih`; that is the home's write bit. A writable
 * home is therefore refused outright rather than accepted on a sticky-bit rule
 * this store does not separately prove. The ancestry *above* the home is governed
 * by {@link isSafeAncestor}, which is deliberately a weaker rule: it has to admit
 * the root-owned directories every real layout is installed under.
 *
 * Windows is exempt, and deliberately so. The mode it reports is derived from the
 * read-only attribute rather than from an ACL, and there is no uid to compare, so
 * asserting on either would refuse every Windows run while proving nothing. No
 * ACL boundary is invented in its place. That gap is a recorded platform
 * limitation of this store: on Windows the store's privacy is exactly whatever
 * the account profile's own ACLs already give it.
 */
function isPrivateToOwner(stats: BigIntStats): boolean {
  if (process.platform === "win32") return true;
  if ((stats.mode & 0o022n) !== 0n) return false;
  const uid = runningAccountUid();
  return uid !== undefined && stats.uid === uid;
}

/**
 * The uid this process runs as, or nothing.
 *
 * On a non-Windows host this is half of a security proof, so every way the lookup
 * can fail resolves to `undefined` and every caller reads that as a refusal: an
 * absent `getuid`, a thrown one, and any value that is not a non-negative safe
 * integer. Handing an unvalidated value to `BigInt` would turn a bad one into a
 * raw platform error rather than this module's own fixed label, which is an
 * output channel as well as a hole.
 */
function runningAccountUid(): bigint | undefined {
  let uid: unknown;
  try {
    uid = process.getuid?.();
  } catch {
    // An account this platform cannot name is an account this proof cannot make.
  }
  if (typeof uid !== "number" || !Number.isSafeInteger(uid) || uid < 0) return undefined;
  return BigInt(uid);
}

/**
 * Whether one naming ancestor of the home is one no other local account can
 * rename through.
 *
 * This is weaker than {@link isPrivateToOwner} and has to be. Every real account
 * home is installed under directories this account does not own and cannot
 * restrict -- `/`, `/home`, `/Users`, `/private` -- so demanding sole ownership
 * there would refuse every ordinary system while protecting nothing. Two shapes
 * are safe instead:
 *
 * - owned by root or by this account, and not group- or world-writable, so only
 *   root can rename through it; an account that already has root does not need
 *   this hole.
 * - sticky and naming an entry that belongs to root or to this account. On a
 *   sticky directory only the entry's owner, the directory's owner, and root may
 *   rename or remove that entry, so the write bit stops meaning what it usually
 *   means. This is exactly `/tmp` at 01777, and refusing it would refuse every
 *   temporary-directory layout for no gain.
 *
 * `child` is the entry this ancestor names, which is what the sticky rule turns
 * on. It is the home for the nearest ancestor and the previous ancestor above
 * that, so the chain's own ownership rule already constrains it -- the check is
 * stated here anyway rather than inferred, because a rule that is only true by
 * argument is a rule that stops being true when the argument moves.
 */
function isSafeAncestor(stats: BigIntStats, child: BigIntStats): boolean {
  const uid = runningAccountUid();
  if (uid === undefined) return false;
  const ownedSafely = (owner: bigint): boolean => owner === 0n || owner === uid;
  if (!ownedSafely(stats.uid)) return false;
  if ((stats.mode & 0o022n) === 0n) return true;
  return (stats.mode & 0o1000n) !== 0n && ownedSafely(child.uid);
}

/**
 * Proves that one path is, right now, a real directory whose canonical form is
 * exactly this name, and captures its identity.
 *
 * Every directory this module proves -- the resolved account home and the three
 * segments below it -- must also be mutable by this account alone, because each
 * one holds the name of the next. The home's own naming ancestry is proved
 * separately by {@link provenHomeAncestryV1}, under the weaker rule that has to
 * admit the root-owned directories real systems install accounts under.
 *
 * `null` is the only failure form: the OS diagnostic never escapes, and the fixed
 * label is chosen by the caller, because the same failed proof means "store is not
 * available" before the record exists and "claim did not commit" after it does.
 *
 * The canonical check is what refuses a symlink, a Windows junction, any other
 * reparse point, a filesystem alias, and a case-variant substitution on a
 * case-insensitive volume -- none of which `lstat` alone would report. A directory
 * whose `ino` the platform does not report is refused rather than trusted, because
 * an identity of zero would compare equal to every substitute.
 */
function provenDirectory(path: string): ControlledDirectoryV1 | null {
  const stats = lstatSafe(path);
  if (stats === "absent" || stats === "unsafe" || stats.isSymbolicLink() || !stats.isDirectory())
    return null;
  if (!isPrivateToOwner(stats)) return null;
  const identity = identityOf(stats);
  if (identity === undefined) return null;
  if (canonicalPath(path) !== path) return null;
  return { identity, path };
}

/**
 * Re-proves that one already-proved directory is still the same object, under the
 * fixed "store is not available" label.
 *
 * Identity is what this adds; the shape, canonical spelling, and mutation bounds
 * are re-proved too, because they are what `provenDirectory` proves about any
 * directory. A parent that was private when it was first proved and is not
 * private now is a parent this authority can no longer stand on.
 */
function reprovedParent(parent: ControlledDirectoryV1): ControlledDirectoryV1 {
  const now = provenDirectory(parent.path);
  if (now === null || !sameIdentity(now.identity, parent.identity))
    return failGovernanceDoctorRepairV1(UNAVAILABLE);
  reprovedAncestry(parent.ancestry, UNAVAILABLE);
  return parent.ancestry === undefined ? now : { ...now, ancestry: parent.ancestry };
}

/**
 * Proves the home's whole lexical naming ancestry, nearest first, from the home
 * to the filesystem root.
 *
 * One level is not enough. The rule that puts removal rights in the holding
 * directory applies at every step: a writable grandparent lets another account
 * rename the *parent* aside and supply its own -- bringing its own home, and its
 * own store -- so a bound pinned at one level only moves the same attack up one
 * step. Each ancestor must therefore be a real, canonical, non-link directory
 * that {@link isSafeAncestor} accepts.
 *
 * The walk is lexical and strictly shortening, so it terminates at the root on
 * every real layout; it is bounded by depth and by the reported home's length
 * anyway, so a pathological account home is a refusal rather than unbounded work.
 *
 * `undefined` means the rule is not asserted on this platform, which is Windows
 * and only Windows: the mode there is derived from the read-only attribute rather
 * than from an ACL and there is no uid to compare, so no ancestry claim is made
 * and none is invented.
 *
 * Every refusal here carries the *caller's* label rather than one of its own,
 * because the same failed walk means different things at different points in the
 * transaction. During initial resolution nothing has been created and the answer
 * is "the store is not available"; from a re-proof after the record exists the
 * answer must be "the claim did not commit", since "not available" invites a
 * retry and a retry of a spent Plan is the replay this module refuses. The
 * default keeps initial resolution reading exactly as it did.
 */
function provenHomeAncestryV1(
  homePath: string,
  label: string = UNAVAILABLE,
): readonly ControlledDirectoryV1[] | undefined {
  if (process.platform === "win32") return undefined;
  const limits = GOVERNANCE_DOCTOR_REPAIR_CLAIM_STORE_V1_LIMITS;
  if (homePath.length > limits.maxHomePathLength) failGovernanceDoctorRepairV1(label);
  const home = lstatSafe(homePath);
  if (home === "absent" || home === "unsafe") return failGovernanceDoctorRepairV1(label);
  const proved: ControlledDirectoryV1[] = [];
  let childStats: BigIntStats = home;
  let child = homePath;
  let path = dirname(child);
  while (path !== child) {
    if (proved.length >= limits.maxHomeAncestorDepth) failGovernanceDoctorRepairV1(label);
    const stats = lstatSafe(path);
    if (stats === "absent" || stats === "unsafe" || stats.isSymbolicLink() || !stats.isDirectory())
      failGovernanceDoctorRepairV1(label);
    if (!isSafeAncestor(stats, childStats)) failGovernanceDoctorRepairV1(label);
    const identity = identityOf(stats);
    if (identity === undefined) failGovernanceDoctorRepairV1(label);
    if (canonicalPath(path) !== path) failGovernanceDoctorRepairV1(label);
    proved.push({ identity, path });
    childStats = stats;
    child = path;
    path = dirname(path);
  }
  return Object.freeze(proved);
}

/**
 * Re-proves one recorded home-and-ancestry proof at any of this module's security
 * boundaries: same home, same chain, same order, same paths, same `dev`+`ino`,
 * and the rule still holding at every step.
 *
 * The home is re-proved alongside the ancestors on purpose. A substitution can
 * carry the whole subtree into the replacement, which leaves the home, the three
 * controlled segments, and the store all holding their original inodes; only the
 * entries above them moved, so only this proof can see it.
 *
 * The label is the caller's, because the same failed proof means different things
 * at different points in the transaction: "the store is not available" while the
 * name is still free, and "the claim did not commit" once the record exists. Both
 * are fixed strings -- no path, no OS diagnostic, and no identity is interpolated.
 *
 * What this bounds is a substitution that spans a boundary: an ancestor renamed
 * away and replaced between two proofs is refused rather than carried forward. It
 * is deliberately not atomicity, and no syscall here is atomic with the next one.
 * Node exposes no way to hold an ancestor open and resolve through that handle,
 * so the interval between a proof and the following path lookup stays a lookup
 * this module cannot close, and a substitution that lands and is reverted
 * entirely inside one syscall is outside what these APIs can observe. That is not
 * claimed.
 */
function reprovedAncestry(ancestry: ProvenAncestryV1 | undefined, label: string): void {
  if (ancestry === undefined) return;
  const home = provenDirectory(ancestry.home.path);
  if (home === null || !sameIdentity(home.identity, ancestry.home.identity))
    failGovernanceDoctorRepairV1(label);
  const now = provenHomeAncestryV1(ancestry.home.path, label);
  if (now === undefined || now.length !== ancestry.ancestors.length)
    failGovernanceDoctorRepairV1(label);
  for (const [index, ancestor] of ancestry.ancestors.entries()) {
    const actual = now[index];
    if (
      actual === undefined ||
      actual.path !== ancestor.path ||
      !sameIdentity(actual.identity, ancestor.identity)
    )
      failGovernanceDoctorRepairV1(label);
  }
}

/**
 * Makes one directory's own entries durable, and refuses if the name no longer
 * leads to the directory that was proved.
 *
 * Windows exposes no directory handle, so there the entry's durability is the
 * filesystem's own. That is a recorded platform limitation of this store rather
 * than something papered over: the identity re-proof around it still runs on both
 * platform families, only the flush does not.
 */
function syncDirectoryEntry(directory: ControlledDirectoryV1): boolean {
  if (process.platform === "win32" || O_DIRECTORY === 0) return true;
  let fd: number | undefined;
  let flushed = false;
  try {
    fd = openSync(directory.path, fsConstants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_DIRECTORY);
    const stats = fstatSync(fd, { bigint: true });
    const actual = identityOf(stats);
    if (stats.isDirectory() && actual !== undefined && sameIdentity(actual, directory.identity)) {
      fsyncSync(fd);
      flushed = true;
    }
  } catch {
    // The fixed refusal at the call site is the whole diagnostic.
  } finally {
    closeQuietly(fd);
  }
  return flushed;
}

/**
 * Proves one authority-controlled segment, creating it only when nothing occupies
 * the name at all.
 *
 * A concurrent creator is not an error -- the proof below is the only verdict --
 * but anything that is not a real directory canonicalizing to exactly this name
 * under its already-canonical parent is refused rather than replaced. Nothing here
 * removes, renames, or writes over an existing object, so a home directory that
 * already holds something at one of these names is left exactly as it was found.
 *
 * A segment this call created is not durable merely because it exists. The entry
 * that *names* it lives in the parent directory, so the parent is re-proved and
 * flushed before the next segment is touched. Skipping that left a hole on first
 * use: the record and the store directory could both be flushed while the ancestry
 * naming the store was still only in cache, and a store lost that way reads as
 * "never claimed" -- the one direction this module must never fail in.
 *
 * The parent is re-proved on every call, not only when this one created the
 * child. An earlier call proved that parent and handed this one a *path*, and
 * every syscall since has re-resolved it, so a parent renamed away and replaced
 * by a real directory that already holds this segment's name would have its child
 * adopted outright -- a claim written into a tree the operator does not control,
 * which is a spent record somebody else can simply remove. Re-proving only the
 * created case left exactly that open.
 */
function controlledDirectory(
  parent: ControlledDirectoryV1,
  segment: string,
): ControlledDirectoryV1 {
  // Before the candidate is even addressed: the name below a parent this
  // authority can no longer prove is not this authority's name to resolve.
  reprovedParent(parent);
  const candidate = join(parent.path, segment);
  let created = false;
  if (lstatSafe(candidate) === "absent") {
    try {
      retryTransient(() =>
        mkdirSync(candidate, {
          mode: GOVERNANCE_DOCTOR_REPAIR_CLAIM_STORE_V1_LIMITS.storeDirectoryMode,
          recursive: false,
        }),
      );
      created = true;
    } catch {
      // A concurrent creator, or a refusal; either way the proof below decides.
    }
  }
  const proven = provenDirectory(candidate);
  if (proven === null) return failGovernanceDoctorRepairV1(UNAVAILABLE);
  // ...and again, as close to the child's own proof as a check can be taken, so a
  // substitution spanning that proof is refused rather than carried forward. This
  // is also the proof a created segment needs: the parent has to still be the same
  // directory for flushing it to say anything about the entry naming the child.
  const naming = reprovedParent(parent);
  if (created && !syncDirectoryEntry(naming)) failGovernanceDoctorRepairV1(UNAVAILABLE);
  // The home-and-ancestry proof travels down with every segment, so the store
  // this returns can re-prove the chain that names it right up to the moment the
  // record is created. Dropping it here left everything below `.aih` unable to.
  return parent.ancestry === undefined ? proven : { ...proven, ancestry: parent.ancestry };
}

/**
 * The home of the OS account this process runs as, read from the account itself
 * rather than from the environment.
 *
 * `os.homedir()` prefers `$HOME` on POSIX and `%USERPROFILE%` on Windows, and
 * both are settable by anyone who can start this process. A store root read from
 * them is therefore a caller-controlled store root in everything but name:
 * relaunch the same granted Plan under a different environment and the lookup
 * lands in a fresh, empty store, where a spent Plan reads as never claimed. That
 * is exactly the replay this module exists to refuse, so the environment is not
 * consulted at all.
 *
 * `os.userInfo()` reads the account record instead -- `getpwuid` on POSIX, the
 * process token's profile directory on Windows -- which no environment variable
 * redirects. It is still not a caller input and still not a test setter: the
 * value comes from the account this process runs as, and from nothing else.
 *
 * An account that reports no home, an empty one, or a relative one is a store
 * that is not available. Nothing is guessed and no fallback location is invented,
 * because a second location is a second store.
 */
function accountHomeDirectory(): string {
  let home: unknown;
  try {
    home = userInfo().homedir;
  } catch {
    // An account this platform cannot describe is a store that is not available.
  }
  if (typeof home !== "string" || home.length === 0 || !isAbsolute(home))
    failGovernanceDoctorRepairV1(UNAVAILABLE);
  return home as string;
}

/**
 * Resolves the authority root, creating only the segments this module owns.
 *
 * The home is not canonicalized and then trusted. The spelling the account
 * reports has to *be* the directory: it is proved as it was reported, so a
 * symlink, a Windows junction, or any other reparse point standing where the home
 * should be is refused rather than resolved through. Canonicalizing first would
 * follow such a link wherever it led, which would hand the choice of store to
 * whoever could re-point it.
 *
 * Aliases and permissions above the home are not "the operator's own layout" and
 * are not passed over. On POSIX the home's whole lexical naming ancestry is
 * proved to the filesystem root by {@link provenHomeAncestryV1} -- each ancestor a
 * real canonical non-link directory that no other local account can rename
 * through -- and that chain is re-proved at the same boundaries the controlled
 * segments are, so an ancestor substituted between two proofs is refused. The
 * walk is bounded by depth and by the reported home's length. On Windows no such
 * bound is asserted and none is invented: the mode there describes the read-only
 * attribute rather than an ACL and there is no uid to compare, so the ancestry is
 * a recorded gap on that platform.
 *
 * Every segment below the home is proved, and every segment this run creates has
 * its naming parent flushed before the next one.
 */
function resolveClaimStoreDirectory(): ControlledDirectoryV1 {
  // The spelling the account reports has to *be* the directory. Canonicalizing it
  // first and proving the result would follow a symlink or a reparse point
  // wherever it led, so whoever could re-point it would choose the store -- the
  // same defect as reading `HOME`, reached by a different route.
  const home = provenDirectory(accountHomeDirectory());
  if (home === null) return failGovernanceDoctorRepairV1(UNAVAILABLE);
  const ancestors = provenHomeAncestryV1(home.path);
  let current: ControlledDirectoryV1 =
    ancestors === undefined ? home : { ...home, ancestry: Object.freeze({ ancestors, home }) };
  for (const segment of GOVERNANCE_DOCTOR_REPAIR_CLAIM_STORE_V1_SEGMENTS)
    current = controlledDirectory(current, segment);
  return current;
}

/** Closes one directory handle; the verdict already reached stays the diagnostic. */
function closeDirQuietly(handle: Dir | undefined): void {
  if (handle === undefined) return;
  try {
    handle.closeSync();
  } catch {
    // A handle that cannot be closed changes no verdict already reached.
  }
}

/**
 * Refuses a store that has grown past its ceiling. The refusal is the whole
 * remedy: making room would mean deleting a record that spends a Plan, so an
 * operator decides that, not this module.
 *
 * The count is taken through an OS directory handle, one entry at a time, and
 * stops the moment the ceiling is reached. Materializing the listing first made
 * the ceiling fail open: a hostile home could hand over a directory with more
 * entries than this process has memory, and the array would be built before the
 * refusal that was supposed to bound it. The handle is closed on every path.
 */
function assertBoundedStore(directory: string): void {
  const ceiling = GOVERNANCE_DOCTOR_REPAIR_CLAIM_STORE_V1_LIMITS.maxStoreRecords;
  let handle: Dir | undefined;
  let counted = 0;
  let unreadable = false;
  try {
    handle = retryTransient(() => opendirSync(directory));
    while (counted < ceiling && handle.readSync() !== null) counted += 1;
  } catch {
    unreadable = true;
  } finally {
    closeDirQuietly(handle);
  }
  if (unreadable) failGovernanceDoctorRepairV1(UNAVAILABLE);
  if (counted >= ceiling) failGovernanceDoctorRepairV1(OVER_CAPACITY);
}

/**
 * Reads one existing claim record in full, or reports that the name holds nothing
 * this authority is willing to read. `undefined` means "unreadable", never
 * "absent": absence is settled by the caller before this is ever reached.
 */
function readClaimBytes(path: string): Buffer | undefined {
  let fd: number | undefined;
  let bytes: Buffer | undefined;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    const stats = fstatSync(fd, { bigint: true });
    // A single-linked regular file, and nothing else. A second name for a claim
    // record is a substitution route, so an unexpected link count is a refusal.
    if (stats.isFile() && stats.nlink === 1n)
      bytes = readBoundedFileDescriptor(fd, GOVERNANCE_DOCTOR_REPAIR_CLAIM_V1_LIMITS.maxClaimBytes);
  } catch {
    // The fixed refusal at the call site is the whole diagnostic.
  } finally {
    closeQuietly(fd);
  }
  return bytes;
}

/**
 * Settles whether this Plan may still be claimed, and refuses on anything that is
 * not a clean absence.
 *
 * A record that parses is a spent Plan whatever state it carries. A record that
 * does not parse -- truncated by an interrupted write, re-encoded, re-ordered,
 * oversized, hard-linked, or holding some other claim's identity -- is refused
 * rather than read as absent, because "I cannot read this" and "there is nothing
 * here" must never collapse into the same answer.
 */
function assertUnclaimed(path: string, claimSha256: string): void {
  const stats = lstatSafe(path);
  if (stats === "absent") return;
  if (stats === "unsafe" || stats.isSymbolicLink() || !stats.isFile() || stats.nlink !== 1n)
    failGovernanceDoctorRepairV1(UNREADABLE);
  const bytes = readClaimBytes(path);
  if (bytes === undefined) failGovernanceDoctorRepairV1(UNREADABLE);
  // The parser's own diagnostics name JSON offsets. They are closed labels for a
  // record the caller supplied, but not for one a hostile home left here, so the
  // refusal is collapsed into this module's own fixed label instead.
  let claim: GovernanceDoctorRepairClaimV1;
  try {
    claim = parseGovernanceDoctorRepairClaimV1(bytes);
  } catch {
    failGovernanceDoctorRepairV1(UNREADABLE);
  }
  if (claim.claimSha256 !== claimSha256) failGovernanceDoctorRepairV1(UNREADABLE);
  failGovernanceDoctorRepairV1(ALREADY_CLAIMED);
}

/**
 * Re-proves that the store is still the directory this run proved, under the fixed
 * label the caller's position in the transaction calls for.
 */
function assertStoreIdentity(store: ControlledDirectoryV1, label: string): void {
  const now = provenDirectory(store.path);
  if (now === null || !sameIdentity(now.identity, store.identity))
    failGovernanceDoctorRepairV1(label);
  // The store's own inode surviving is not enough. A substitution above the home
  // carries the whole subtree along, so the store keeps its identity while the
  // chain that names it becomes somebody else's. The chain is therefore re-proved
  // here too: immediately before the name is claimed, and again after the
  // read-back, under whichever fixed label this position calls for.
  reprovedAncestry(store.ancestry, label);
}

/**
 * Creates the claim exclusively, writes it in full, and flushes it.
 *
 * The identity of the file this call created is captured from its own descriptor
 * before a single byte is written and re-proved after, so a name swapped
 * underneath the write is refused rather than reported as committed. The write is
 * driven to completion because a short write must never publish as a truncated
 * record.
 *
 * "Driven to completion" is bounded by progress, not by patience. A `writeSync`
 * that reports nothing consumed, a negative or non-integer count, or more consumed
 * than it was handed is a refusal, not a reason to go round again: looping on a
 * descriptor that never advances is the one outcome worse than refusing, because
 * the run then neither commits nor returns.
 *
 * Nothing here removes the file on failure. Once the exclusive create has
 * succeeded the Plan is spent, and every later refusal leaves that fact standing.
 */
function createClaimExclusively(path: string, bytes: Buffer): FileIdentity {
  let fd: number | undefined;
  try {
    fd = openSync(
      path,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | O_NOFOLLOW,
      GOVERNANCE_DOCTOR_REPAIR_CLAIM_STORE_V1_LIMITS.claimFileMode,
    );
  } catch (error) {
    // The name is already held. Taking it is the same syscall as creating it, so
    // there is no held lock to steal and nothing to fall back to.
    return (error as NodeJS.ErrnoException).code === "EEXIST"
      ? failGovernanceDoctorRepairV1(ALREADY_CLAIMED)
      : failGovernanceDoctorRepairV1(UNAVAILABLE);
  }
  let created: FileIdentity | undefined;
  try {
    const before = fstatSync(fd, { bigint: true });
    const identity = identityOf(before);
    if (before.isFile() && before.nlink === 1n && identity !== undefined) {
      let written = 0;
      let stalled = false;
      while (written < bytes.length && !stalled) {
        const remaining = bytes.length - written;
        const progress = writeSync(fd, bytes, written, remaining);
        if (!Number.isSafeInteger(progress) || progress <= 0 || progress > remaining)
          stalled = true;
        else written += progress;
      }
      const after = fstatSync(fd, { bigint: true });
      const afterIdentity = identityOf(after);
      if (
        !stalled &&
        after.isFile() &&
        after.nlink === 1n &&
        after.size === BigInt(bytes.length) &&
        afterIdentity !== undefined &&
        sameIdentity(identity, afterIdentity)
      ) {
        fsyncSync(fd);
        created = identity;
      }
    }
  } catch {
    // The fixed refusal below is the whole diagnostic.
  } finally {
    closeQuietly(fd);
  }
  if (created === undefined) failGovernanceDoctorRepairV1(NOT_COMMITTED);
  return created;
}

/**
 * Re-reads the published name and refuses unless it still holds exactly the object
 * this call created, byte for byte, and unless those bytes still parse as exactly
 * this claim.
 */
function confirmPublishedClaim(path: string, identity: FileIdentity, bytes: Buffer): void {
  let read: Buffer | undefined;
  let fd: number | undefined;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    const stats = fstatSync(fd, { bigint: true });
    const actual = identityOf(stats);
    if (
      stats.isFile() &&
      stats.nlink === 1n &&
      actual !== undefined &&
      sameIdentity(actual, identity)
    )
      read = readBoundedFileDescriptor(fd, GOVERNANCE_DOCTOR_REPAIR_CLAIM_V1_LIMITS.maxClaimBytes);
  } catch {
    // The fixed refusal below is the whole diagnostic.
  } finally {
    closeQuietly(fd);
  }
  if (read === undefined || !read.equals(bytes)) failGovernanceDoctorRepairV1(NOT_COMMITTED);
  // Strict canonical reparse of what the store now holds, not of what was minted.
  try {
    parseGovernanceDoctorRepairClaimV1(read);
  } catch {
    failGovernanceDoctorRepairV1(NOT_COMMITTED);
  }
}

/**
 * The one root spelling this authority will bind a scope to: an absolute path that
 * exists, is a real directory, and whose native canonical form is exactly the
 * string supplied -- case included.
 *
 * The scope digest binds bytes, so without this any spelling that merely *reaches*
 * a checkout would open a second authority scope for it. On a case-insensitive
 * volume an uppercase variant of a claimed root resolves to the same directory but
 * digests differently, which would let one spent Plan be claimed again under a
 * second name. That is the single-use rule made opt-out, so the fake spelling is
 * refused here rather than re-scoped.
 *
 * The executor never composes this string; it comes from branded custody, which
 * already re-proves the bound root at the moment it hands the path over.
 */
function assertCanonicalRootRealPath(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || !isAbsolute(value))
    failGovernanceDoctorRepairV1(NOT_CANONICAL);
  const supplied = value as string;
  const stats = lstatSafe(supplied);
  if (stats === "absent" || stats === "unsafe" || stats.isSymbolicLink() || !stats.isDirectory())
    failGovernanceDoctorRepairV1(NOT_CANONICAL);
  if (canonicalPath(supplied) !== supplied) failGovernanceDoctorRepairV1(NOT_CANONICAL);
  return supplied;
}

/**
 * Durably spends one granted Plan under one canonical root, exactly once, and
 * hands back the record that spent it.
 *
 * Both records must already be branded: a plain object shaped like a Plan or a
 * Consent cannot reach this, so a caller cannot vouch for its own replay state.
 * The instant is read from the platform clock here and is never supplied.
 *
 * The consent authorizes the claim and is recorded in it, but it is not part of
 * the claim's identity. One Plan under one canonical root has exactly one name,
 * whichever granted consent brought the run here, so a second consent finds the
 * spent record rather than a fresh name.
 *
 * A returned claim means the record is on disk, has been read back, and the store
 * it is in is still the store this run proved. Every other outcome is a refusal,
 * and a refusal after the exclusive create still leaves the Plan spent.
 */
export function acquireGovernanceDoctorRepairClaimV1(
  input: unknown,
): GovernanceDoctorRepairClaimV1 {
  const request = assertRecordV1(input, "repair claim acquisition request");
  assertExactKeysV1(request, ACQUIRE_FIELDS, "repair claim acquisition request");
  canonicalGovernanceDoctorRepairConsentV1Bytes(request.consent);
  canonicalGovernanceDoctorRepairPlanV1Bytes(request.plan);
  const consent = request.consent as GovernanceDoctorRepairConsentV1;
  const plan = request.plan as GovernanceDoctorRepairPlanV1;
  if (consent.decision !== "granted")
    failGovernanceDoctorRepairV1("repair claim requires a granted consent");
  if (consent.planSha256 !== plan.planSha256)
    failGovernanceDoctorRepairV1("repair claim consent is not this plan's consent");

  const scopeSha256 = governanceDoctorRepairClaimScopeSha256V1({
    realPath: assertCanonicalRootRealPath(request.rootRealPath),
  });
  const claimSha256 = governanceDoctorRepairClaimSha256V1({
    planSha256: plan.planSha256,
    scopeSha256,
  });

  const store = resolveClaimStoreDirectory();
  assertBoundedStore(store.path);
  const path = join(store.path, governanceDoctorRepairClaimFileNameV1(claimSha256));
  assertUnclaimed(path, claimSha256);

  const claim = createGovernanceDoctorRepairClaimV1({
    claimedAtEpochMs: Date.now(),
    consentSha256: consent.consentSha256,
    planSha256: plan.planSha256,
    scopeSha256,
    state: "claimed",
  });
  const bytes = canonicalGovernanceDoctorRepairClaimV1Bytes(claim);
  // Last look before the name is taken. Everything above addressed the store by
  // path, and a path is re-resolved on every syscall, so the store has to still be
  // the directory this run proved before a record is created in it. Nothing has
  // been created yet, so this is still an "unavailable" refusal.
  assertStoreIdentity(store, UNAVAILABLE);
  const identity = createClaimExclusively(path, bytes);
  // From here the record exists and the Plan is spent, so every remaining refusal
  // is "did not commit" rather than "unavailable".
  if (!syncDirectoryEntry(store)) failGovernanceDoctorRepairV1(NOT_COMMITTED);
  confirmPublishedClaim(path, identity, bytes);
  assertStoreIdentity(store, NOT_COMMITTED);
  return claim;
}
