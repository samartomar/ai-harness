import { type Dirent, existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { readRegularFile } from "../internals/fsxn.js";

function canonical(path: string): string {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

function realpathOrResolve(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function isContained(rootReal: string, candidateReal: string): boolean {
  const rel = relative(canonical(rootReal), canonical(candidateReal));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function safeExistingPath(rootReal: string, full: string): "file" | "dir" | undefined {
  try {
    const st = lstatSync(full);
    if (st.isSymbolicLink()) return undefined;
    const real = realpathSync(full);
    if (!isContained(rootReal, real)) return undefined;
    if (st.isDirectory()) return "dir";
    if (st.isFile()) return "file";
  } catch {
    return undefined;
  }
  return undefined;
}

/** Safe existence check for CLI-native sources. Symlinks/junctions are ignored. */
export function safePathExists(root: string, full: string): boolean {
  if (!existsSync(full)) return false;
  return safeExistingPath(realpathOrResolve(root), full) !== undefined;
}

/** Read one CLI-native source file without following symlinks or escaping root. */
export function safeReadText(root: string, full: string): string | undefined {
  const rootReal = realpathOrResolve(root);
  if (safeExistingPath(rootReal, full) !== "file") return undefined;
  const contents = readRegularFile(full);
  return contents === undefined ? undefined : contents.toString("utf8");
}

/** Recursive source walk that refuses symlinked/junctioned dirs and escaped realpaths. */
export function safeWalkFiles(root: string, dir: string): string[] {
  const rootReal = realpathOrResolve(root);
  if (safeExistingPath(rootReal, dir) !== "dir") return [];
  let ents: Dirent[];
  try {
    ents = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const e of ents) {
    const full = join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) out.push(...safeWalkFiles(root, full));
    else if (e.isFile() && safeExistingPath(rootReal, full) === "file") out.push(full);
  }
  return out;
}
