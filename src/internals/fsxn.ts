import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
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
    try {
      for (const w of this.staged) {
        mkdirSync(dirname(w.path), { recursive: true });
        const existed = existsSync(w.path);
        let backup: string | undefined;
        if (existed) {
          backup = `${w.path}.aih.bak`;
          copyFileSync(w.path, backup);
        }
        const tmp = `${w.path}.aih.tmp`;
        writeFileSync(tmp, w.contents, "utf8");
        if (w.mode !== undefined) chmodSync(tmp, w.mode);
        renameSync(tmp, w.path);
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
