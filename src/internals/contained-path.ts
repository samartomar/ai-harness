import { lstatSync, realpathSync, type Stats } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

export type ContainedPathKind = "file" | "directory" | "other";

export type ContainedPathInfo =
  | { state: "absent" }
  | { state: "unsafe"; reason: "symlink" | "outside-root" | "inaccessible" }
  | { state: "present"; kind: ContainedPathKind; realPath: string; stats: Stats };

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
  return inspectContainedPath(rootReal, resolve(root, relPath));
}
