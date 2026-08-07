import { randomUUID } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  renameSync,
  rmSync,
  type Stats,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { containedPath, inspectContainedRelativePath } from "../internals/contained-path.js";
import { readRegularFileWithStats, retryTransient } from "../internals/fsxn.js";

/**
 * The guarded filesystem boundary for AIH-direct materialization.
 *
 * Every path this engine reads, creates, or removes goes through here, and
 * every one of them is checked the way the shipped lifecycles check theirs:
 * an absolute real root, a symlink refusal on each traversed segment,
 * containment inside the root, bounded unambiguous regular files, and a
 * temp+rename commit so a destination is never observed half-written.
 */

export const MAX_MATERIALIZED_FILE_BYTES = 4 * 1024 * 1024;
export const MATERIALIZED_CONTENT_MODE = 0o644;
export const MATERIALIZATION_RECEIPT_MODE = 0o600;
const CONTENT_DIRECTORY_MODE = 0o755;
const STATE_DIRECTORY_MODE = 0o700;

function lstatSafe(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}

/** The destination root must be an absolute, real, non-symlinked directory. */
export function materializationRoot(root: string): string {
  if (!isAbsolute(root)) throw new Error("ECC materialization root must be an absolute path");
  const stats = lstatSafe(root);
  if (stats === undefined) throw new Error(`ECC materialization root is not a directory: ${root}`);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`ECC materialization root must be a real directory: ${root}`);
  }
  return realpathSync(root);
}

/** Refuse a symlinked or escaping parent on every segment this engine traverses. */
function assertSafeParents(rootReal: string, path: string): void {
  const segments = path.split("/");
  let current = rootReal;
  for (let index = 0; index < segments.length - 1; index += 1) {
    current = resolve(current, segments[index] as string);
    const stats = lstatSafe(current);
    if (stats === undefined) return;
    if (stats.isSymbolicLink()) {
      throw new Error(`refusing a symlinked ECC materialization destination parent: ${path}`);
    }
    if (!stats.isDirectory()) {
      throw new Error(`ECC materialization destination parent is not a directory: ${path}`);
    }
    const canonical = realpathSync(current);
    if (!containedPath(rootReal, canonical)) {
      throw new Error(`ECC materialization destination escapes its root: ${path}`);
    }
    current = canonical;
  }
}

/** Read a destination's live bytes, refusing anything that is not a contained regular file. */
export function readLiveDestination(rootReal: string, path: string): Buffer | undefined {
  assertSafeParents(rootReal, path);
  const inspected = inspectContainedRelativePath(rootReal, path);
  if (inspected.state === "absent") return undefined;
  if (inspected.state === "unsafe") {
    throw new Error(
      inspected.reason === "symlink"
        ? `refusing a symlinked ECC materialization destination: ${path}`
        : `refusing an unsafe ECC materialization destination (${inspected.reason}): ${path}`,
    );
  }
  if (inspected.kind !== "file") {
    throw new Error(`ECC materialization destination is not a regular file: ${path}`);
  }
  const opened = readRegularFileWithStats(inspected.realPath, {
    maxBytes: MAX_MATERIALIZED_FILE_BYTES,
  });
  if (opened === undefined || opened.stats.nlink > 1) {
    throw new Error(
      `ECC materialization destination is not a bounded unambiguous regular file: ${path}`,
    );
  }
  return opened.contents;
}

function prepareDirectory(rootReal: string, path: string, mode: number): string {
  const segments = path.split("/");
  let current = rootReal;
  for (let index = 0; index < segments.length - 1; index += 1) {
    current = join(current, segments[index] as string);
    const stats = lstatSafe(current);
    if (stats === undefined) {
      mkdirSync(current, { recursive: false, mode });
      continue;
    }
    if (stats.isSymbolicLink()) {
      throw new Error(`refusing a symlinked ECC materialization destination parent: ${path}`);
    }
    if (!stats.isDirectory()) {
      throw new Error(`ECC materialization destination parent is not a directory: ${path}`);
    }
  }
  return current;
}

/**
 * Write through a temp file renamed into place — the ledger's atomic-write
 * pattern. A failed rename leaves the destination exactly as it was and no
 * scratch file behind, so a caller can never observe partial content.
 */
export function writeDestinationAtomic(
  rootReal: string,
  path: string,
  contents: Buffer,
  mode: number,
  rename?: (from: string, to: string) => void,
): void {
  assertSafeParents(rootReal, path);
  const directory = prepareDirectory(
    rootReal,
    path,
    mode === MATERIALIZATION_RECEIPT_MODE ? STATE_DIRECTORY_MODE : CONTENT_DIRECTORY_MODE,
  );
  const target = join(rootReal, ...path.split("/"));
  if (lstatSafe(target)?.isSymbolicLink() === true) {
    throw new Error(
      `refusing to write through a symlinked ECC materialization destination: ${path}`,
    );
  }
  const temporary = join(directory, `.aih-materialize.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, contents, { flag: "wx", mode });
    chmodSync(temporary, mode);
    const commit =
      rename ?? ((from: string, to: string) => retryTransient(() => renameSync(from, to)));
    commit(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function removeDestination(rootReal: string, path: string): void {
  assertSafeParents(rootReal, path);
  const target = join(rootReal, ...path.split("/"));
  const stats = lstatSafe(target);
  if (stats === undefined) return;
  if (stats.isSymbolicLink()) {
    throw new Error(`refusing to remove a symlinked ECC materialization destination: ${path}`);
  }
  rmSync(target, { force: true });
}
