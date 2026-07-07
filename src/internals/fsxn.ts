import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  type Stats,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { FsTxnError } from "../errors.js";

/**
 * Transient Windows file-lock error codes. On Windows an antivirus scanner or the
 * Search indexer opens a file the instant it appears, so a `copyFile`/`rename`/
 * `read` issued microseconds after a write can fail with one of these and then
 * succeed on the very next attempt — the "failed on CI, passed on a re-run"
 * signature. POSIX does not raise these for our in-process, same-volume sync
 * operations, so {@link retryTransient} is a no-op there.
 */
const TRANSIENT_LOCK_CODES = new Set(["EBUSY", "EPERM", "EACCES"]);
const MAX_LOCK_RETRIES = 10;

/** Sleep the current thread synchronously (every fs call below is sync). */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Run a synchronous fs operation, retrying ONLY the transient Windows lock codes
 * in {@link TRANSIENT_LOCK_CODES} with a short bounded backoff (~0.5s worst case).
 * Any other error — `EEXIST` from an exclusive create, a genuine `EACCES` on a
 * locked-down path that never clears — is re-thrown on its first occurrence, so
 * this absorbs the sub-millisecond scanner window without ever masking a real
 * failure. The retry preserves the caller's atomicity/rollback guarantees: it
 * re-issues the same single syscall, nothing more.
 *
 * Exported for direct unit testing — the FS-level retry is exercised through the
 * real filesystem elsewhere, but a transient lock cannot be reproduced on demand,
 * so the retry/give-up/passthrough contract is pinned here.
 */
export function retryTransient<T>(op: () => T): T {
  let delayMs = 1;
  for (let attempt = 1; ; attempt++) {
    try {
      return op();
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const transient = code !== undefined && TRANSIENT_LOCK_CODES.has(code);
      if (!transient || attempt >= MAX_LOCK_RETRIES) throw err;
      sleepSync(delayMs);
      delayMs = Math.min(delayMs * 2, 100);
    }
  }
}

interface StagedWrite {
  path: string;
  contents: string;
  mode?: number;
}

interface AppliedWrite {
  path: string;
  backup?: string;
  created: boolean;
}

/** A file to remove by MOVING it to `legacyPath` (under gitignored `.aih/legacy/`). */
interface StagedRemoval {
  path: string;
  legacyPath: string;
  /**
   * Backup-sibling destination (hard-delete's `<path>.aih.bak`). Like the default
   * `.aih/legacy/` archive it NEVER overwrites an occupied destination — an existing
   * `.aih.bak` may be the ONLY copy of prior content (a removal backup is not like a
   * write backup, whose content also survives in the replaced file). A taken slot
   * falls back to `<path>.1.aih.bak`, `<path>.2.aih.bak`, … which still match the
   * gitignored `*.aih.bak` glob.
   */
  backupSibling?: boolean;
}

interface AppliedRemoval {
  path: string;
  legacyPath: string;
}

export interface FsTxnResult {
  written: string[];
  backups: string[];
  /** Files moved out of the tree (source → `.aih/legacy/` destination). */
  removed: AppliedRemoval[];
}

/**
 * Stages writes in memory and commits them atomically. Each existing target is
 * first copied to `<path>.aih.bak`; new content is written to a temp file and
 * `rename`d into place (atomic on the same volume). If any write throws, every
 * write applied so far is rolled back (created files removed, overwritten files
 * restored from their backup).
 */
export class FsTransaction {
  private staged: StagedWrite[] = [];
  private stagedRemovals: StagedRemoval[] = [];

  stage(path: string, contents: string, mode?: number): void {
    this.staged.push({ path, contents, mode });
  }

  /**
   * Stage a file REMOVAL as a reversible move to `legacyPath` (under gitignored
   * `.aih/legacy/`). The move IS the backup: rollback (and the user) restore by
   * moving it back. Symlinks are refused at commit (moving a link then restoring it
   * would recreate a regular file). No-op if the source is already gone.
   * `backupSibling` marks a hard-delete destination (`<path>.aih.bak`): still
   * never-overwrite, but a taken slot falls back to `<path>.N.aih.bak` (matches the
   * gitignored `*.aih.bak` glob) instead of the archive's `<path>.N`.
   */
  stageRemoval(path: string, legacyPath: string, opts: { backupSibling?: boolean } = {}): void {
    this.stagedRemovals.push({ path, legacyPath, backupSibling: opts.backupSibling });
  }

  preview(): ReadonlyArray<StagedWrite> {
    return [...this.staged];
  }

  commit(): FsTxnResult {
    const applied: AppliedWrite[] = [];
    const removed: AppliedRemoval[] = [];
    // Collapse repeated writes to the same target (last wins) BEFORE committing:
    // staging one path twice would back up the first write as `<path>.aih.bak`, then
    // overwrite that backup with the second — making a later rollback non-restorative.
    const staged = dedupeByPath(this.staged);
    const removals = dedupeRemovals(this.stagedRemovals);
    // A path cannot be both written AND removed in one transaction — the on-disk
    // outcome (write, then move-to-legacy) would contradict the reported writes[].
    // No shipping command produces this; fail closed so a future one can't silently.
    const writePaths = new Set(staged.map((w) => w.path));
    for (const r of removals) {
      if (writePaths.has(r.path)) {
        throw new FsTxnError(`transaction both writes and removes the same path: ${r.path}`);
      }
    }
    try {
      for (const w of staged) {
        mkdirSync(dirname(w.path), { recursive: true });
        // Refuse to write THROUGH an existing symlink — it can redirect the write
        // outside the repo, and copyFileSync would back up the link's TARGET, not the
        // link. Fail closed; the executor enforces parent-dir containment separately.
        const info = lstatSafe(w.path);
        if (info?.isSymbolicLink()) {
          throw new Error(`refusing to write through a symlink: ${w.path}`);
        }
        const existed = info !== undefined;
        const backupPath = `${w.path}.aih.bak`;
        const tmpPath = `${w.path}.aih.tmp`;
        // The temp + backup paths are followed by copyFileSync/writeFileSync, so a
        // pre-placed symlink THERE would redirect the write/copy outside the repo just
        // like a symlinked target. Reject a planted link and clear any stale scratch so
        // the exclusive create below can't be tricked into following one.
        clearScratch(backupPath);
        clearScratch(tmpPath);
        let backup: string | undefined;
        if (existed) {
          backup = backupPath;
          // Reads the just-written source; retry the transient Windows scanner lock.
          retryTransient(() => copyFileSync(w.path, backupPath, fsConstants.COPYFILE_EXCL));
        }
        retryTransient(() => writeFileSync(tmpPath, w.contents, { encoding: "utf8", flag: "wx" }));
        if (w.mode !== undefined) chmodSync(tmpPath, w.mode);
        // Renaming OVER the existing target is the classic Windows flake: the dest
        // handle may be briefly held by AV/the indexer right after the prior write.
        retryTransient(() => renameSync(tmpPath, w.path));
        applied.push({ path: w.path, backup, created: !existed });
      }
      // Removals commit AFTER writes so a partial failure rolls both back in order.
      for (const r of removals) {
        const info = lstatSafe(r.path);
        if (info === undefined) continue; // already gone — idempotent no-op
        // Never MOVE a symlink: rollback would renameSync it back as-is, but a link
        // that pointed outside the repo has no place in .aih/legacy/ and restoring it
        // silently re-establishes the escape. The executor also rejects this earlier.
        if (info.isSymbolicLink()) {
          throw new Error(`refusing to remove a symlink: ${r.path}`);
        }
        mkdirSync(dirname(r.legacyPath), { recursive: true });
        // NEVER overwrite an occupied destination — for BOTH modes. An aborted prune
        // rolls its move back (so it leaves nothing here), which means an existing file
        // at the dest is a COMPLETED prior rescue (or a write backup that may be the
        // ONLY copy of never-committed content); deleting it would destroy that copy.
        // The archive falls back to `<path>.N`; a hard-delete backup falls back to
        // `<path>.N.aih.bak` so every slot keeps matching the gitignored glob.
        const dest = r.backupSibling ? freeBackupDest(r.legacyPath) : freeLegacyDest(r.legacyPath);
        retryTransient(() => renameSync(r.path, dest));
        removed.push({ path: r.path, legacyPath: dest });
      }
      return {
        written: applied.map((a) => a.path),
        backups: applied.flatMap((a) => (a.backup ? [a.backup] : [])),
        removed,
      };
    } catch (err) {
      rollbackRemovals(removed);
      rollback(applied);
      throw new FsTxnError(`transaction failed and was rolled back: ${(err as Error).message}`);
    }
  }
}

/** Keep only the last staged removal per source path (deterministic). */
function dedupeRemovals(staged: StagedRemoval[]): StagedRemoval[] {
  const byPath = new Map<string, StagedRemoval>();
  for (const r of staged) byPath.set(r.path, r);
  return [...byPath.values()];
}

/**
 * A free legacy destination: `base` if nothing is there, else `base.1`, `base.2`, …
 * so a second rescue of a repopulated path never clobbers the first. Refuses a
 * symlink at any candidate (it would redirect the rename out of the repo).
 */
function freeLegacyDest(base: string): string {
  const check = (p: string): "free" | "file" => {
    const st = lstatSafe(p);
    if (st === undefined) return "free";
    if (st.isSymbolicLink()) throw new Error(`refusing to move onto a symlinked legacy path: ${p}`);
    return "file";
  };
  if (check(base) === "free") return base;
  for (let n = 1; n < 100000; n++) {
    const cand = `${base}.${n}`;
    if (check(cand) === "free") return cand;
  }
  throw new Error(`too many prior rescues at ${base}`);
}

/**
 * A free hard-delete backup destination: `<path>.aih.bak` if free, else
 * `<path>.1.aih.bak`, `<path>.2.aih.bak`, … — the counter sits BEFORE the suffix so
 * every fallback still matches the gitignored `*.aih.bak` glob. Same symlink refusal
 * and never-overwrite guarantee as {@link freeLegacyDest}: an existing backup may be
 * the only copy of never-committed content and is never destroyed.
 */
function freeBackupDest(base: string): string {
  const check = (p: string): "free" | "file" => {
    const st = lstatSafe(p);
    if (st === undefined) return "free";
    if (st.isSymbolicLink()) throw new Error(`refusing to move onto a symlinked backup path: ${p}`);
    return "file";
  };
  if (check(base) === "free") return base;
  const stem = base.endsWith(".aih.bak") ? base.slice(0, -".aih.bak".length) : base;
  for (let n = 1; n < 100000; n++) {
    const cand = `${stem}.${n}.aih.bak`;
    if (check(cand) === "free") return cand;
  }
  throw new Error(`too many prior backups at ${base}`);
}

/** Restore moved-out files by renaming them back from `.aih/legacy/` (best-effort). */
function rollbackRemovals(removed: AppliedRemoval[]): void {
  for (const r of [...removed].reverse()) {
    try {
      if (existsSync(r.legacyPath) && !existsSync(r.path)) {
        mkdirSync(dirname(r.path), { recursive: true });
        renameSync(r.legacyPath, r.path);
      }
    } catch {
      // best-effort; rollback should never mask the original error
    }
  }
}

/** Keep only the last staged write per target path (deterministic, insertion order). */
function dedupeByPath(staged: StagedWrite[]): StagedWrite[] {
  const byPath = new Map<string, StagedWrite>();
  for (const w of staged) byPath.set(w.path, w);
  return [...byPath.values()];
}

/** `lstat` (does not follow links) or `undefined` if the path does not exist. */
function lstatSafe(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}

/**
 * Prepare a `.aih.tmp` / `.aih.bak` scratch path for an exclusive create: fail
 * closed if a symlink was planted there (it would redirect the write/copy out of
 * the repo), and remove a stale REGULAR leftover from a prior aborted run so the
 * exclusive create doesn't `EEXIST`. Never follows or deletes through a link.
 */
function clearScratch(path: string): void {
  const st = lstatSafe(path);
  if (st === undefined) return;
  if (st.isSymbolicLink()) {
    throw new Error(`refusing to write through a symlinked scratch path: ${path}`);
  }
  rmSync(path, { force: true });
}

function rollback(applied: AppliedWrite[]): void {
  for (const a of [...applied].reverse()) {
    try {
      if (a.created) {
        if (existsSync(a.path)) rmSync(a.path, { force: true });
      } else if (a.backup && existsSync(a.backup)) {
        copyFileSync(a.backup, a.path);
        rmSync(a.backup, { force: true });
      }
    } catch {
      // best-effort; rollback should never mask the original error
    }
  }
}

/** Read a file's text, or `undefined` if it does not exist. */
export function readIfExists(path: string): string | undefined {
  // A read issued right after the file was written (e.g. a second `executePlan`
  // re-reading what the first just laid down) hits the same transient Windows lock
  // window as the write side, so it gets the same bounded retry.
  return existsSync(path) ? retryTransient(() => readFileSync(path, "utf8")) : undefined;
}

/** `O_NOFOLLOW` where the platform has it (absent at runtime on Windows despite the typings). */
const O_NOFOLLOW = (fsConstants as Record<string, number | undefined>).O_NOFOLLOW ?? 0;

/**
 * Open-then-read on ONE file descriptor: the regular-file check (`fstat` on the
 * open fd, never a second path lookup) and the read cannot be raced apart, and
 * a symlink swapped in after directory enumeration is refused at open where
 * `O_NOFOLLOW` exists rather than silently followed. Returns undefined for
 * anything that is not a readable regular file.
 *
 * Use this — not {@link readIfExists} — for any path DISCOVERED by a directory
 * scan: a plain exists-then-read pair on a scanned path is a swap window where
 * a symlink planted between enumeration and read gets silently followed and its
 * target's bytes laundered into an artifact (marketplace build, evidence
 * bundle, fleet bundle all package what they read).
 */
export function readRegularFileWithStats(
  abs: string,
): { contents: Buffer; stats: Stats } | undefined {
  let fd: number;
  try {
    fd = openSync(abs, fsConstants.O_RDONLY | O_NOFOLLOW);
  } catch {
    return undefined;
  }
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile()) return undefined;
    return { contents: readFileSync(fd), stats };
  } finally {
    closeSync(fd);
  }
}

export function readRegularFile(abs: string): Buffer | undefined {
  return readRegularFileWithStats(abs)?.contents;
}
