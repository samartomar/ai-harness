import { lstatSync, realpathSync, type Stats } from "node:fs";
import { isAbsolute, relative, resolve, win32 } from "node:path";
import { readRegularFileWithStats } from "./fsxn.js";

export type ContainedPathKind = "file" | "directory" | "other";

export type ContainedPathInfo =
  | { state: "absent" }
  | { state: "unsafe"; reason: "symlink" | "outside-root" | "inaccessible" | "invalid-relative" }
  | { state: "present"; kind: ContainedPathKind; realPath: string; stats: Stats };

export type ContainedRegularFileRead =
  | { state: "absent" }
  | {
      state: "unsafe";
      reason:
        | "symlink"
        | "outside-root"
        | "inaccessible"
        | "invalid-relative"
        | "not-file"
        | "changed";
    }
  | { state: "present"; contents: Buffer; realPath: string; stats: Stats };

function canonicalPath(path: string): string {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

export function containedPath(rootReal: string, targetReal: string): boolean {
  const rel = relative(canonicalPath(rootReal), canonicalPath(targetReal));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function inspectContainedPath(rootReal: string, absPath: string): ContainedPathInfo {
  let stats: Stats;
  try {
    stats = lstatSync(absPath);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT"
      ? { state: "absent" }
      : { state: "unsafe", reason: "inaccessible" };
  }
  if (stats.isSymbolicLink()) return { state: "unsafe", reason: "symlink" };
  let realPath: string;
  try {
    realPath = realpathSync(absPath);
  } catch {
    return { state: "unsafe", reason: "inaccessible" };
  }
  if (!containedPath(rootReal, realPath)) return { state: "unsafe", reason: "outside-root" };
  const kind: ContainedPathKind = stats.isFile()
    ? "file"
    : stats.isDirectory()
      ? "directory"
      : "other";
  return { state: "present", kind, realPath, stats };
}

export function inspectContainedRelativePath(root: string, relPath: string): ContainedPathInfo {
  let rootReal: string;
  try {
    rootReal = realpathSync(root);
  } catch {
    return { state: "absent" };
  }
  if (!isValidRelativePath(rootReal, relPath))
    return { state: "unsafe", reason: "invalid-relative" };
  const target = resolve(rootReal, relPath);
  const segments = relative(rootReal, target)
    .split(/[\\/]+/)
    .filter(Boolean);
  let current = rootReal;
  for (const segment of segments) {
    current = resolve(current, segment);
    let stats: Stats;
    try {
      stats = lstatSync(current);
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === "ENOENT"
        ? { state: "absent" }
        : { state: "unsafe", reason: "inaccessible" };
    }
    if (stats.isSymbolicLink()) return { state: "unsafe", reason: "symlink" };
  }
  return inspectContainedPath(rootReal, target);
}

/**
 * Read a bounded regular file only after validating every path component under a
 * trusted root. The post-read inspection keeps bytes from a path changed between
 * validation and open from being returned to callers.
 */
export function readContainedRegularFile(
  root: string,
  relPath: string,
  options: { maxBytes: number },
): ContainedRegularFileRead {
  const before = inspectContainedRelativePath(root, relPath);
  if (before.state !== "present") return before;
  if (before.kind !== "file") return { state: "unsafe", reason: "not-file" };
  const opened = readRegularFileWithStats(before.realPath, options);
  if (opened === undefined) return { state: "unsafe", reason: "inaccessible" };
  const after = inspectContainedRelativePath(root, relPath);
  if (
    after.state !== "present" ||
    after.kind !== "file" ||
    after.realPath !== before.realPath ||
    after.stats.dev !== opened.stats.dev ||
    after.stats.ino !== opened.stats.ino ||
    after.stats.size !== opened.stats.size ||
    after.stats.mtimeMs !== opened.stats.mtimeMs ||
    after.stats.ctimeMs !== opened.stats.ctimeMs
  ) {
    return { state: "unsafe", reason: "changed" };
  }
  return {
    state: "present",
    contents: opened.contents,
    realPath: before.realPath,
    stats: opened.stats,
  };
}

function isValidRelativePath(root: string, relPath: string): boolean {
  if (relPath.length === 0 || isAbsolute(relPath) || win32.isAbsolute(relPath)) return false;
  const fromRoot = relative(root, resolve(root, relPath));
  return (
    relPath === "." || (fromRoot.length > 0 && !fromRoot.startsWith("..") && !isAbsolute(fromRoot))
  );
}
