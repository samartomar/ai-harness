import { createHash, randomUUID } from "node:crypto";
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
import { isAbsolute, join, relative, resolve } from "node:path";
import { containedPath, inspectContainedRelativePath } from "../internals/contained-path.js";
import { readRegularFileWithStats, retryTransient } from "../internals/fsxn.js";
import {
  assertUnreservedSegments,
  ECC_MATERIALIZATION_RECEIPT_PATH,
  MAX_MATERIALIZED_FILE_BYTES,
} from "./materialization-receipt.js";

/**
 * The guarded filesystem boundary for AIH-direct materialization, and the
 * commit machinery that gives the engine the three guarantees the shipped
 * `FsTransaction` gives its callers: nothing is touched until every step is
 * planned, each step is re-pinned against live bytes immediately before its own
 * side effect, and any failure rolls the applied steps back.
 *
 * The engine does not reuse `FsTransaction` itself because that class stages
 * `string` contents and archives removals into `.aih/legacy/`; materialized
 * component content is bytes (a skill may ship an image) and an uninstall must
 * actually remove what it owns rather than relocate it under the reserved area
 * this engine forbids components from writing to.
 */

/** The engine own state, exempt from the reserved-area guard it enforces on components. */
const ENGINE_STATE_PATHS = new Set([ECC_MATERIALIZATION_RECEIPT_PATH]);

export { MAX_MATERIALIZED_FILE_BYTES };
export const MATERIALIZED_CONTENT_MODE = 0o644;
export const MATERIALIZATION_RECEIPT_MODE = 0o600;
const CONTENT_DIRECTORY_MODE = 0o755;
const STATE_DIRECTORY_MODE = 0o700;

export type DestinationRead =
  | { state: "absent" }
  | { state: "present"; bytes: Buffer; mode: number }
  | { state: "unreadable"; detail: string };

export type DestinationExpectation = { absent: true } | { sha256: string };

export interface MaterializationCommitStep {
  path: string;
  mode: number;
  /** Absent means remove. */
  contents?: Buffer;
  /** Re-checked immediately before this step's side effect. */
  expect: DestinationExpectation;
  /** Bytes to restore if a later step fails. Absent means the step created the file. */
  prior?: Buffer;
  /** The mode those bytes had, so a rollback does not silently widen permissions. */
  priorMode?: number;
  /** Announced before the re-pin check, so a caller can observe (or interrupt) the boundary. */
  announce?: () => void;
}

/**
 * The canonical path the OS itself would open. `fs.realpathSync` is implemented
 * in JS and leaves an NTFS 8.3 short name as it found it, so `GIT~1` would stay
 * `GIT~1` and every reserved-name check downstream would compare the wrong
 * string. The native binding resolves through `GetFinalPathNameByHandle`, which
 * returns the long name — that is the only spelling worth checking.
 */
const realpathCanonical: (path: string) => string =
  (realpathSync as unknown as { native?: (path: string) => string }).native ?? realpathSync;

function lstatSafe(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** The destination root must be an absolute, real, non-symlinked directory. */
export function materializationRoot(root: string): string {
  if (!isAbsolute(root)) throw new Error("ECC materialization root must be an absolute path");
  const stats = lstatSafe(root);
  if (stats === undefined) throw new Error(`ECC materialization root is not a directory: ${root}`);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`ECC materialization root must be a real directory: ${root}`);
  }
  return realpathCanonical(root);
}

/**
 * Refuse a symlinked, escaping, or RESERVED segment on every path this engine
 * traverses — checked on what the filesystem actually resolves each segment to,
 * not on the requested string. A requested string is not what the OS opens: on
 * NTFS with 8.3 generation `GIT~1` opens `.git` and `AIH~1` opens `.aih`, so a
 * string-level guard alone would let a component write an executable hook into
 * a real repository or forge AIH's own state.
 */
function assertSafeParents(rootReal: string, path: string): void {
  const ownState = ENGINE_STATE_PATHS.has(path);
  const segments = path.split("/");
  let current = rootReal;
  for (let index = 0; index < segments.length; index += 1) {
    const isLeaf = index === segments.length - 1;
    current = resolve(current, segments[index] as string);
    const stats = lstatSafe(current);
    if (stats === undefined) return;
    if (stats.isSymbolicLink()) {
      throw new Error(
        isLeaf
          ? `refusing a symlinked ECC materialization destination: ${path}`
          : `refusing a symlinked ECC materialization destination parent: ${path}`,
      );
    }
    if (!isLeaf && !stats.isDirectory()) {
      throw new Error(`ECC materialization destination parent is not a directory: ${path}`);
    }
    const canonical = realpathCanonical(current);
    if (!containedPath(rootReal, canonical)) {
      throw new Error(`ECC materialization destination escapes its root: ${path}`);
    }
    if (!ownState) {
      assertUnreservedSegments(
        relative(rootReal, canonical)
          .split(/[\\/]/)
          .filter((segment) => segment.length > 0),
        path,
      );
    }
    current = canonical;
  }
}

/**
 * Read a destination without deciding what its unreadability means. Removal
 * paths turn `unreadable` into an advisory that names the path; write paths
 * refuse. Neither guesses, and neither aborts a whole operation over one file.
 */
export function inspectDestination(rootReal: string, path: string): DestinationRead {
  try {
    assertSafeParents(rootReal, path);
    const inspected = inspectContainedRelativePath(rootReal, path);
    if (inspected.state === "absent") return { state: "absent" };
    if (inspected.state === "unsafe") {
      return {
        state: "unreadable",
        detail:
          inspected.reason === "symlink"
            ? `ECC materialization destination is a symlink: ${path}`
            : `ECC materialization destination is unsafe (${inspected.reason}): ${path}`,
      };
    }
    if (inspected.kind !== "file") {
      return {
        state: "unreadable",
        detail: `ECC materialization destination is not a regular file: ${path}`,
      };
    }
    const opened = readRegularFileWithStats(inspected.realPath, {
      maxBytes: MAX_MATERIALIZED_FILE_BYTES,
    });
    if (opened === undefined || opened.stats.nlink > 1) {
      return {
        state: "unreadable",
        detail: `ECC materialization destination is not a bounded unambiguous regular file: ${path}`,
      };
    }
    return { state: "present", bytes: opened.contents, mode: opened.stats.mode & 0o777 };
  } catch (error) {
    return { state: "unreadable", detail: (error as Error).message };
  }
}

/** The write-path read: an unreadable destination refuses rather than degrading. */
export function readLiveDestination(rootReal: string, path: string): Buffer | undefined {
  const live = inspectDestination(rootReal, path);
  if (live.state === "unreadable") throw new Error(`refusing ${live.detail}`);
  return live.state === "absent" ? undefined : live.bytes;
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

function assertExpected(rootReal: string, step: MaterializationCommitStep): void {
  const live = inspectDestination(rootReal, step.path);
  if (live.state === "unreadable") {
    throw new Error(
      `ECC materialization destination became unreadable before commit: ${step.path}`,
    );
  }
  const unchanged =
    "absent" in step.expect
      ? live.state === "absent"
      : live.state === "present" && sha256(live.bytes) === step.expect.sha256;
  if (!unchanged) {
    throw new Error(`ECC materialization destination changed before commit: ${step.path}`);
  }
}

/**
 * Commit an ordered plan. Each step is re-pinned against live bytes right
 * before its own side effect — the window between planning and committing spans
 * every earlier step, and `announce` runs inside it — and any failure restores
 * what earlier steps replaced or removed.
 */
export function commitMaterializationSteps(
  rootReal: string,
  steps: readonly MaterializationCommitStep[],
  rename?: (from: string, to: string) => void,
): void {
  const applied: MaterializationCommitStep[] = [];
  try {
    for (const step of steps) {
      step.announce?.();
      assertExpected(rootReal, step);
      if (step.contents === undefined) removeDestination(rootReal, step.path);
      else writeDestinationAtomic(rootReal, step.path, step.contents, step.mode, rename);
      applied.push(step);
    }
  } catch (error) {
    const unrestored = rollback(rootReal, applied, rename);
    if (unrestored.length === 0) throw error;
    throw new Error(
      `${(error as Error).message}; rollback did not restore ${unrestored.join(", ")}`,
    );
  }
}

/**
 * Restore in reverse order, re-pinned exactly like the forward path: a step is
 * undone only while the destination still holds what THAT step left. Anything
 * else arrived after the step, is not AIH's, and is reported rather than
 * destroyed — the engine's cardinal rule has to hold on the way out too.
 * Failures never mask the original error; they are named alongside it.
 */
function rollback(
  rootReal: string,
  applied: readonly MaterializationCommitStep[],
  rename?: (from: string, to: string) => void,
): string[] {
  const unrestored: string[] = [];
  for (const step of [...applied].reverse()) {
    try {
      const live = inspectDestination(rootReal, step.path);
      const asLeft =
        step.contents === undefined
          ? live.state === "absent"
          : live.state === "present" && sha256(live.bytes) === sha256(step.contents);
      if (!asLeft) {
        unrestored.push(step.path);
        continue;
      }
      if (step.prior === undefined) {
        removeDestination(rootReal, step.path);
        continue;
      }
      writeDestinationAtomic(rootReal, step.path, step.prior, step.priorMode ?? step.mode, rename);
    } catch {
      unrestored.push(step.path);
    }
  }
  return unrestored;
}
