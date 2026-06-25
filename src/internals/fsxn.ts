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
          copyFileSync(w.path, backupPath, fsConstants.COPYFILE_EXCL);
        }
        writeFileSync(tmpPath, w.contents, { encoding: "utf8", flag: "wx" });
        if (w.mode !== undefined) chmodSync(tmpPath, w.mode);
        renameSync(tmpPath, w.path);
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
  return existsSync(path) ? readFileSync(path, "utf8") : undefined;
}
