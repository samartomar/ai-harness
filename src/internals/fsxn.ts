import {
  chmodSync,
  copyFileSync,
  existsSync,
  constants as fsConstants,
  lstatSync,
  mkdirSync,
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

export interface FsTxnResult {
  written: string[];
  backups: string[];
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

  stage(path: string, contents: string, mode?: number): void {
    this.staged.push({ path, contents, mode });
  }

  preview(): ReadonlyArray<StagedWrite> {
    return [...this.staged];
  }

  commit(): FsTxnResult {
    const applied: AppliedWrite[] = [];
    // Collapse repeated writes to the same target (last wins) BEFORE committing:
    // staging one path twice would back up the first write as `<path>.aih.bak`, then
    // overwrite that backup with the second — making a later rollback non-restorative.
    const staged = dedupeByPath(this.staged);
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
      return {
        written: applied.map((a) => a.path),
        backups: applied.flatMap((a) => (a.backup ? [a.backup] : [])),
      };
    } catch (err) {
      rollback(applied);
      throw new FsTxnError(`transaction failed and was rolled back: ${(err as Error).message}`);
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
