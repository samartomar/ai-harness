import { randomBytes } from "node:crypto";
import {
  type BigIntStats,
  closeSync,
  constants as fsConstants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  renameSync,
  rmSync,
  writeSync,
} from "node:fs";
import { isAbsolute, join, resolve as resolvePath } from "node:path";
import { isProxy } from "node:util/types";
import { AihError } from "../errors.js";
import { readBoundedFileDescriptor, retryTransient } from "../internals/fsxn.js";
import {
  type DeveloperSeatCatalogConsumptionV1Result,
  resolveDeveloperSeatCatalogConsumptionV1,
} from "./developer-seat-catalog-consumption-v1.js";

/**
 * Operational developer-seat catalog custody V1.
 *
 * Everything effectful happens HERE, wrapped around the shipped pure foundation.
 * The two fixed slots under the authority-controlled root are read under strict
 * byte and identity bounds, handed to `resolveDeveloperSeatCatalogConsumptionV1`
 * exactly as they were found, and — only when that foundation resolves the
 * CURRENT slot — the very bytes it verified are copied to the last-good slot.
 *
 * The caller chooses the authority root and nothing else. The slot names are
 * fixed constants precisely BECAUSE they are not the caller's to pick: no
 * relative path, digest, channel, or identity ever reaches a path segment here.
 *
 * Custody never invents a verdict and never launders material. A slot that is
 * truly absent is reported to the foundation as the literal one-key unavailable;
 * a slot that is PRESENT but inadmissible — a link, junction, directory, FIFO,
 * hard-linked alias, empty file, over-ceiling file, or a file changing under the
 * read — is a hard refusal, never a silent downgrade to unavailable. Bytes are
 * forwarded verbatim; every codec, signature, continuity, age, and compatibility
 * judgment stays with the foundation, whose frozen result is returned unchanged.
 *
 * A resolved CURRENT result is returned only after promotion succeeds. A held
 * lock, custody failure, concurrent slot change, or root replacement is a fixed
 * adapter failure. The current slot is only ever read.
 */

/** Fixed slot names under the authority root; never caller-supplied. */
const CURRENT_SLOT = "current.json";
const LAST_GOOD_SLOT = "last-good.json";
const LOCK_SLOT = ".promote.lock";
/** The foundation's own transport ceiling, enforced here before it ever parses. */
const MAX_TRANSPORT_BYTES = 96 * 1024;
const MAX_ROOT_LENGTH = 4096;

/** `O_NOFOLLOW` where the platform has it (absent at runtime on Windows). */
const O_NOFOLLOW = (fsConstants as Record<string, number | undefined>).O_NOFOLLOW ?? 0;
/** `O_NONBLOCK` where exposed; a no-op for regular files, prompt refusal for FIFOs. */
const O_NONBLOCK = (fsConstants as Record<string, number | undefined>).O_NONBLOCK ?? 0;
/** `O_DIRECTORY` where exposed; required for a POSIX directory durability handle. */
const O_DIRECTORY = (fsConstants as Record<string, number | undefined>).O_DIRECTORY ?? 0;
const EXCLUSIVE_CREATE = fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY;

/** Sorted: the closed-input check compares against it position by position. */
const INPUT_FIELDS = [
  "expectedAdminSignerIdentity",
  "expectedAdminSignerRootSha256",
  "expectedEffectVersion",
  "expectedHeadSignerRootSha256",
  "expectedSchemaVersion",
  "maxAgeSeconds",
  "now",
  "seatRoot",
  "verifyCanonicalPae",
] as const;

/** The exact one-key shape the foundation accepts for a genuinely absent slot. */
const UNAVAILABLE = Object.freeze({ kind: "unavailable" });

/**
 * The closed caller input. Only the authority root is ours; every other field is
 * a trusted Core fact forwarded verbatim, so the foundation — not custody —
 * decides whether it is well formed.
 */
export interface ResolveOperationalDeveloperSeatCatalogV1Input {
  readonly expectedAdminSignerIdentity: string;
  readonly expectedAdminSignerRootSha256: string;
  readonly expectedEffectVersion: string;
  readonly expectedHeadSignerRootSha256: string;
  readonly expectedSchemaVersion: string;
  readonly maxAgeSeconds: number;
  /** Wall clock, UTC second precision. Never defaulted from the host clock. */
  readonly now: string;
  /** Absolute, already-normalized authority root holding the two fixed slots. */
  readonly seatRoot: string;
  readonly verifyCanonicalPae: (request: unknown) => unknown;
}

interface FileIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

type DirectoryIdentity = FileIdentity;

interface SlotRead {
  readonly bytes: Buffer;
  readonly identity: FileIdentity;
}

/**
 * Every custody diagnostic is one of these fixed labels. A filesystem path, root,
 * or slot name is never interpolated into a message.
 */
function fail(label: string): never {
  throw new AihError(`developer seat catalog: ${label}`, "AIH_DEVELOPER_SEAT_CATALOG");
}

function rejectProxy(value: unknown, label: string): void {
  if (isProxy(value)) fail(label);
}

/**
 * A closed, non-proxy, plain-object input whose own keys are exactly
 * {@link INPUT_FIELDS} and are all data properties. Proxies are refused before
 * any property is touched and accessors are refused without being invoked, so a
 * hostile input runs no code and causes no effect.
 */
function parseClosedInput(value: unknown): Record<string, unknown> {
  rejectProxy(value, "input");
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail("input");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail("input");
  const names: string[] = [];
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") fail("input fields");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !Object.hasOwn(descriptor, "value")) fail("input fields");
    names.push(key);
  }
  names.sort();
  if (
    names.length !== INPUT_FIELDS.length ||
    names.some((key, index) => key !== INPUT_FIELDS[index])
  )
    fail("input fields");
  return value as Record<string, unknown>;
}

function hasAsciiControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/**
 * An absolute, already-normalized, unpadded, control-free root. Every check is
 * pure string work, so a hostile root is rejected before any filesystem call and
 * therefore causes no effect at all.
 */
function parseAuthorityRoot(value: unknown): string {
  rejectProxy(value, "authority root");
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_ROOT_LENGTH)
    fail("authority root");
  if (value.trim() !== value || hasAsciiControl(value)) fail("authority root");
  if (!isAbsolute(value) || resolvePath(value) !== value) fail("authority root");
  return value;
}

function identityOf(stats: Pick<BigIntStats, "dev" | "ino">): FileIdentity | undefined {
  if (stats.ino === 0n) return undefined;
  return { dev: stats.dev, ino: stats.ino };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

/** The supplied authority-root entry itself is a real directory, never a link or reparse point. */
function directoryIdentity(path: string): DirectoryIdentity | undefined {
  try {
    const info = lstatSync(path, { bigint: true });
    if (info.isSymbolicLink() || !info.isDirectory()) return undefined;
    return identityOf(info);
  } catch {
    return undefined;
  }
}

function sameDirectory(path: string, expected: DirectoryIdentity): boolean {
  const actual = directoryIdentity(path);
  return actual !== undefined && sameIdentity(actual, expected);
}

/** Absent means ENOENT and nothing else; any other stat failure is a refusal. */
function statSlot(path: string, label: string): BigIntStats | undefined {
  try {
    return lstatSync(path, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    fail(label);
  }
}

function openSlot(path: string, label: string): number {
  try {
    return retryTransient(() =>
      openSync(path, fsConstants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK, 0o600),
    );
  } catch {
    fail(label);
  }
}

/**
 * Read one slot as exact bytes, or report it genuinely absent. The pre-open
 * `lstat` keeps a directory or FIFO from ever being opened, the descriptor is
 * re-checked against that same inode so a swap mid-call cannot slip through, and
 * a size or mtime that moves across the read is treated as a racy slot.
 */
function readSlot(path: string, label: string): SlotRead | undefined {
  const info = statSlot(path, label);
  if (info === undefined) return undefined;
  const expectedIdentity = identityOf(info);
  if (
    info.isSymbolicLink() ||
    !info.isFile() ||
    info.nlink !== 1n ||
    expectedIdentity === undefined
  )
    fail(label);
  if (info.size === 0n || info.size > BigInt(MAX_TRANSPORT_BYTES)) fail(label);

  const fd = openSlot(path, label);
  let closed = false;
  try {
    const opened = fstatSync(fd, { bigint: true });
    const openedIdentity = identityOf(opened);
    if (
      !opened.isFile() ||
      opened.nlink !== 1n ||
      openedIdentity === undefined ||
      !sameIdentity(openedIdentity, expectedIdentity) ||
      opened.size !== info.size ||
      opened.size === 0n ||
      opened.size > BigInt(MAX_TRANSPORT_BYTES)
    )
      fail(label);
    const bytes = readBoundedFileDescriptor(fd, MAX_TRANSPORT_BYTES);
    if (bytes === undefined || BigInt(bytes.length) !== opened.size) fail(label);
    const after = fstatSync(fd, { bigint: true });
    const afterIdentity = identityOf(after);
    if (
      afterIdentity === undefined ||
      !sameIdentity(afterIdentity, openedIdentity) ||
      after.size !== opened.size ||
      after.mtimeNs !== opened.mtimeNs ||
      after.ctimeNs !== opened.ctimeNs
    )
      fail(label);
    closeSync(fd);
    closed = true;
    return { bytes, identity: openedIdentity };
  } catch (error) {
    if (!closed)
      try {
        closeSync(fd);
      } catch {
        // The surrounding fixed failure is more specific than the platform error.
      }
    if (error instanceof AihError) throw error;
    fail(label);
  }
}

/** True only when the slot still holds exactly the bytes custody snapshotted. */
function slotUnchanged(path: string, snapshot: Buffer | undefined): boolean {
  let actual: SlotRead | undefined;
  try {
    actual = readSlot(path, "slot");
  } catch {
    return false; // present but no longer admissible is itself a concurrent change
  }
  if (snapshot === undefined) return actual === undefined;
  return actual?.bytes.equals(snapshot) === true;
}

/** Exclusive create, so a lock held by anyone else is never broken or stolen. */
function acquireLock(path: string, markOwned: (identity: FileIdentity) => void): void {
  let fd: number;
  try {
    fd = openSync(path, EXCLUSIVE_CREATE, 0o600);
  } catch {
    fail("promotion");
  }
  try {
    const info = fstatSync(fd, { bigint: true });
    const identity = identityOf(info);
    if (!info.isFile() || info.nlink !== 1n || identity === undefined) fail("promotion");
    markOwned(identity);
  } catch (error) {
    try {
      closeSync(fd);
    } catch {
      // The owned lock is retired by the caller if it was recorded.
    }
    if (error instanceof AihError) throw error;
    fail("promotion");
  }
  try {
    closeSync(fd);
  } catch {
    try {
      closeSync(fd);
    } catch {
      // The lock is cleaned only when the original root remains proven below.
    }
    fail("promotion");
  }
}

function hasExpectedFile(path: string, expected: FileIdentity, links = 1n): boolean {
  try {
    const info = lstatSync(path, { bigint: true });
    const identity = identityOf(info);
    return (
      !info.isSymbolicLink() &&
      info.isFile() &&
      info.nlink === links &&
      identity !== undefined &&
      sameIdentity(identity, expected)
    );
  } catch {
    return false;
  }
}

function isAbsent(path: string): boolean {
  try {
    lstatSync(path, { bigint: true });
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

/**
 * Retire a known owned file through a random private name. If the source name
 * was replaced, restore the displaced object only into an absent original name;
 * never unlink or overwrite a foreign replacement.
 */
function discardOwnedFile(
  root: string,
  rootIdentity: DirectoryIdentity,
  path: string,
  expected: FileIdentity,
  links = 1n,
): boolean {
  if (!sameDirectory(root, rootIdentity)) return false;
  const tombstone = join(root, `.${randomBytes(16).toString("hex")}.retired`);
  try {
    retryTransient(() => renameSync(path, tombstone));
  } catch {
    return false;
  }
  if (!hasExpectedFile(tombstone, expected, links)) {
    let restored = false;
    try {
      linkSync(tombstone, path);
      restored = true;
    } catch {
      // A concurrent replacement owns the original name; preserve both objects.
    }
    if (restored)
      try {
        retryTransient(() => rmSync(tombstone));
      } catch {
        // The foreign object remains preserved at the original path.
      }
    return false;
  }
  try {
    retryTransient(() => rmSync(tombstone));
    return true;
  } catch {
    return false;
  }
}

/** Owner-only regular file, flushed to disk before it is renamed into place. */
function writeDurableFile(path: string, bytes: Buffer): FileIdentity {
  let fd: number;
  try {
    fd = openSync(path, EXCLUSIVE_CREATE, 0o600);
  } catch {
    fail("promotion");
  }
  let closed = false;
  try {
    let offset = 0;
    while (offset < bytes.length) {
      const written = writeSync(fd, bytes, offset, bytes.length - offset);
      if (!Number.isInteger(written) || written <= 0) fail("promotion");
      offset += written;
    }
    fsyncSync(fd);
    const writtenStats = fstatSync(fd, { bigint: true });
    const identity = identityOf(writtenStats);
    if (
      !writtenStats.isFile() ||
      writtenStats.nlink !== 1n ||
      writtenStats.size !== BigInt(bytes.length) ||
      identity === undefined
    )
      fail("promotion");
    closeSync(fd);
    closed = true;
    return identity;
  } catch (error) {
    if (!closed)
      try {
        closeSync(fd);
      } catch {
        // The promotion itself fails below with a fixed diagnostic.
      }
    if (error instanceof AihError) throw error;
    fail("promotion");
  }
}

/** Re-open the scratch with no-follow and prove it is still our exact durable bytes. */
function verifyScratch(path: string, expected: FileIdentity, bytes: Buffer, links = 1n): void {
  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK, 0o600);
  } catch {
    fail("promotion");
  }
  let closed = false;
  try {
    const before = fstatSync(fd, { bigint: true });
    const identity = identityOf(before);
    if (
      !before.isFile() ||
      before.nlink !== links ||
      identity === undefined ||
      !sameIdentity(identity, expected) ||
      before.size !== BigInt(bytes.length)
    )
      fail("promotion");
    const actual = readBoundedFileDescriptor(fd, MAX_TRANSPORT_BYTES);
    const after = fstatSync(fd, { bigint: true });
    const afterIdentity = identityOf(after);
    const named = lstatSync(path, { bigint: true });
    const namedIdentity = identityOf(named);
    if (
      actual === undefined ||
      !actual.equals(bytes) ||
      !after.isFile() ||
      after.nlink !== links ||
      afterIdentity === undefined ||
      !sameIdentity(afterIdentity, expected) ||
      after.size !== before.size ||
      named.isSymbolicLink() ||
      !named.isFile() ||
      named.nlink !== links ||
      namedIdentity === undefined ||
      !sameIdentity(namedIdentity, expected) ||
      named.size !== before.size
    )
      fail("promotion");
    closeSync(fd);
    closed = true;
  } catch (error) {
    if (!closed)
      try {
        closeSync(fd);
      } catch {
        // The fixed promotion diagnostic is deliberately the only surface.
      }
    if (error instanceof AihError) throw error;
    fail("promotion");
  }
}

/** Make the rename durable where the platform supports directory fsync. */
function syncDirectory(path: string, expected: DirectoryIdentity): void {
  if (process.platform === "win32") return;
  let fd: number;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_DIRECTORY);
  } catch {
    fail("promotion");
  }
  let closed = false;
  try {
    const opened = fstatSync(fd, { bigint: true });
    const openedIdentity = identityOf(opened);
    if (
      !opened.isDirectory() ||
      openedIdentity === undefined ||
      !sameIdentity(openedIdentity, expected)
    )
      fail("promotion");
    fsyncSync(fd);
    const after = fstatSync(fd, { bigint: true });
    const afterIdentity = identityOf(after);
    if (
      !after.isDirectory() ||
      afterIdentity === undefined ||
      !sameIdentity(afterIdentity, expected)
    )
      fail("promotion");
    closeSync(fd);
    closed = true;
  } catch (error) {
    if (!closed)
      try {
        closeSync(fd);
      } catch {
        // The promotion itself fails below with a fixed diagnostic.
      }
    if (error instanceof AihError) throw error;
    fail("promotion");
  }
}

function snapshotsUnchanged(
  root: string,
  rootIdentity: DirectoryIdentity,
  current: Buffer | undefined,
  lastGood: Buffer | undefined,
): boolean {
  if (!sameDirectory(root, rootIdentity)) return false;
  const currentUnchanged = slotUnchanged(join(root, CURRENT_SLOT), current);
  const lastGoodUnchanged = slotUnchanged(join(root, LAST_GOOD_SLOT), lastGood);
  return currentUnchanged && lastGoodUnchanged && sameDirectory(root, rootIdentity);
}

interface OwnedFile {
  readonly identity: FileIdentity;
  readonly path: string;
  permittedLinks: readonly bigint[];
  retired: boolean;
}

interface PublishedPrior {
  readonly bytes: Buffer;
  readonly file: OwnedFile;
}

interface Publication {
  readonly prior: PublishedPrior | undefined;
  readonly target: OwnedFile;
  settled: boolean;
}

function ownedFile(
  path: string,
  identity: FileIdentity,
  permittedLinks: readonly bigint[] = [1n],
): OwnedFile {
  return { identity, path, permittedLinks, retired: false };
}

function retireOwnedFile(root: string, rootIdentity: DirectoryIdentity, file: OwnedFile): boolean {
  if (file.retired) return true;
  for (const links of file.permittedLinks) {
    if (discardOwnedFile(root, rootIdentity, file.path, file.identity, links)) {
      file.retired = true;
      return true;
    }
  }
  return false;
}

/**
 * Link the verified scratch into the fixed target only while that target is
 * absent. A concurrent target wins the name; it is never overwritten.
 */
function publishScratchNoClobber(
  root: string,
  rootIdentity: DirectoryIdentity,
  scratch: OwnedFile,
  current: Buffer,
  lastGood: SlotRead | undefined,
): Publication {
  const target = join(root, LAST_GOOD_SLOT);
  let displaced: PublishedPrior | undefined;
  try {
    if (lastGood !== undefined) {
      const path = join(root, `.${randomBytes(16).toString("hex")}.displaced`);
      try {
        retryTransient(() => renameSync(target, path));
      } catch {
        fail("promotion");
      }
      displaced = { bytes: lastGood.bytes, file: ownedFile(path, lastGood.identity) };
      let displacedVerified = hasExpectedFile(path, lastGood.identity);
      if (displacedVerified)
        try {
          verifyScratch(path, lastGood.identity, lastGood.bytes);
        } catch {
          displacedVerified = false;
        }
      if (!displacedVerified) {
        try {
          linkSync(path, target);
          displaced.file.permittedLinks = [2n, 1n];
          retryTransient(() => rmSync(path));
          displaced.file.retired = true;
        } catch {
          // A concurrent replacement owns the target name or remains recoverable.
        }
        fail("promotion");
      }
    }
    try {
      linkSync(scratch.path, target);
    } catch {
      fail("promotion");
    }
    scratch.permittedLinks = [2n, 1n];
    verifyScratch(target, scratch.identity, current, 2n);
    if (!retireOwnedFile(root, rootIdentity, scratch)) fail("promotion");
    verifyScratch(target, scratch.identity, current);
    return { prior: displaced, settled: false, target: ownedFile(target, scratch.identity) };
  } catch (error) {
    const scratchRetired = retireOwnedFile(root, rootIdentity, scratch);
    const displacedRetired =
      displaced === undefined || retireOwnedFile(root, rootIdentity, displaced.file);
    if (!scratchRetired || !displacedRetired) fail("promotion");
    if (error instanceof AihError) throw error;
    fail("promotion");
  }
}

function publicationStable(
  root: string,
  rootIdentity: DirectoryIdentity,
  publication: Publication,
  current: Buffer,
): boolean {
  if (!sameDirectory(root, rootIdentity)) return false;
  if (!slotUnchanged(join(root, CURRENT_SLOT), current)) return false;
  try {
    verifyScratch(join(root, LAST_GOOD_SLOT), publication.target.identity, current);
  } catch {
    return false;
  }
  return sameDirectory(root, rootIdentity);
}

/** Restore the prior only into an absent fixed target; an existing foreign target wins. */
function rollbackPublication(
  root: string,
  rootIdentity: DirectoryIdentity,
  publication: Publication,
): boolean {
  if (publication.settled || !sameDirectory(root, rootIdentity)) return false;
  const target = publication.target.path;
  if (hasExpectedFile(target, publication.target.identity)) {
    if (!retireOwnedFile(root, rootIdentity, publication.target)) return false;
  }
  const prior = publication.prior;
  if (prior !== undefined) {
    let restoredPrior = false;
    if (isAbsent(target)) {
      try {
        linkSync(prior.file.path, target);
      } catch {
        return false;
      }
      prior.file.permittedLinks = [2n, 1n];
      try {
        verifyScratch(target, prior.file.identity, prior.bytes, 2n);
      } catch {
        return false;
      }
      restoredPrior = true;
    }
    if (!retireOwnedFile(root, rootIdentity, prior.file)) return false;
    if (restoredPrior)
      try {
        verifyScratch(target, prior.file.identity, prior.bytes);
      } catch {
        return false;
      }
  }
  try {
    syncDirectory(root, rootIdentity);
  } catch {
    return false;
  }
  publication.settled = true;
  return true;
}

function finalizePublication(
  root: string,
  rootIdentity: DirectoryIdentity,
  publication: Publication,
  current: Buffer,
): boolean {
  publication.settled = true;
  if (
    publication.prior !== undefined &&
    !retireOwnedFile(root, rootIdentity, publication.prior.file)
  )
    return false;
  try {
    syncDirectory(root, rootIdentity);
    verifyScratch(publication.target.path, publication.target.identity, current);
    return sameDirectory(root, rootIdentity);
  } catch {
    return false;
  }
}

/**
 * Copy the exact verified current bytes into the last-good slot. Reached only
 * after the foundation resolved CURRENT. The current slot is never modified;
 * every promotion failure is a fixed adapter error.
 */
function promoteVerifiedCurrent(
  root: string,
  rootIdentity: DirectoryIdentity,
  current: Buffer,
  lastGood: SlotRead | undefined,
): void {
  const lockPath = join(root, LOCK_SLOT);
  if (!sameDirectory(root, rootIdentity)) fail("promotion");
  let temporary: OwnedFile | undefined;
  let lock: OwnedFile | undefined;
  let publication: Publication | undefined;
  try {
    acquireLock(lockPath, (identity) => {
      lock = ownedFile(lockPath, identity);
    });
    if (!snapshotsUnchanged(root, rootIdentity, current, lastGood?.bytes)) fail("promotion");
    const scratch = join(root, `.${randomBytes(12).toString("hex")}.tmp`);
    temporary = ownedFile(scratch, writeDurableFile(scratch, current));
    if (!snapshotsUnchanged(root, rootIdentity, current, lastGood?.bytes)) fail("promotion");
    verifyScratch(temporary.path, temporary.identity, current);
    publication = publishScratchNoClobber(root, rootIdentity, temporary, current, lastGood);
    temporary = undefined;
    syncDirectory(root, rootIdentity);
    if (!publicationStable(root, rootIdentity, publication, current)) {
      if (!rollbackPublication(root, rootIdentity, publication)) fail("promotion");
      fail("promotion");
    }
    if (!finalizePublication(root, rootIdentity, publication, current)) fail("promotion");
    verifyScratch(join(root, LAST_GOOD_SLOT), publication.target.identity, current);
    if (lock === undefined || !retireOwnedFile(root, rootIdentity, lock)) fail("promotion");
    lock = undefined;
    syncDirectory(root, rootIdentity);
    if (!sameDirectory(root, rootIdentity) || !isAbsent(lockPath)) fail("promotion");
  } catch (error) {
    const publicationRolledBack =
      publication === undefined ||
      publication.settled ||
      rollbackPublication(root, rootIdentity, publication);
    const scratchDiscarded =
      temporary === undefined || retireOwnedFile(root, rootIdentity, temporary);
    const ownedLock = lock !== undefined;
    const lockDiscarded = lock === undefined || retireOwnedFile(root, rootIdentity, lock);
    let lockDurable = true;
    if (ownedLock && lockDiscarded)
      try {
        syncDirectory(root, rootIdentity);
      } catch {
        lockDurable = false;
      }
    if (!scratchDiscarded || !lockDiscarded || !publicationRolledBack || !lockDurable)
      fail("promotion");
    if (error instanceof AihError) throw error;
    fail("promotion");
  }
}

/**
 * Resolve the developer-seat catalog from the authority root's fixed slots and,
 * on a resolution that came from CURRENT, promote those exact bytes to last-good.
 *
 * Takes `unknown` rather than {@link ResolveOperationalDeveloperSeatCatalogV1Input}
 * so a hostile caller is rejected by the closed check above instead of by a type
 * the runtime cannot enforce. Returns the foundation's own frozen result
 * unchanged: no custody, path, root, slot, lock, or promotion fact is added.
 */
export function resolveOperationalDeveloperSeatCatalogV1(
  value: unknown,
): DeveloperSeatCatalogConsumptionV1Result {
  const input = parseClosedInput(value);
  rejectProxy(input.verifyCanonicalPae, "verifier");
  if (typeof input.verifyCanonicalPae !== "function") fail("verifier");
  const root = parseAuthorityRoot(input.seatRoot);
  const rootIdentity = directoryIdentity(root);
  if (rootIdentity === undefined) fail("authority root");

  const current = readSlot(join(root, CURRENT_SLOT), "current slot");
  const lastGood = readSlot(join(root, LAST_GOOD_SLOT), "last-good slot");

  const result = resolveDeveloperSeatCatalogConsumptionV1({
    current: current?.bytes ?? UNAVAILABLE,
    expectedAdminSignerIdentity: input.expectedAdminSignerIdentity,
    expectedAdminSignerRootSha256: input.expectedAdminSignerRootSha256,
    expectedEffectVersion: input.expectedEffectVersion,
    expectedHeadSignerRootSha256: input.expectedHeadSignerRootSha256,
    expectedSchemaVersion: input.expectedSchemaVersion,
    lastGood: lastGood?.bytes ?? UNAVAILABLE,
    maxAgeSeconds: input.maxAgeSeconds,
    now: input.now,
    verifyCanonicalPae: input.verifyCanonicalPae,
  });

  if (!snapshotsUnchanged(root, rootIdentity, current?.bytes, lastGood?.bytes)) fail("custody");

  if (result.kind === "resolved" && result.source === "current" && current !== undefined)
    promoteVerifiedCurrent(root, rootIdentity, current.bytes, lastGood);

  return result;
}
