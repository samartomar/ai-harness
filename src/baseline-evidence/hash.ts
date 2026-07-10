import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, realpathSync, type Stats } from "node:fs";
import { isAbsolute, posix, relative, resolve } from "node:path";
import { AihError } from "../errors.js";

export interface BaselineHashedFile {
  path: string;
  bytes: number;
  sha256: string;
}

export interface BaselineTreeHash {
  treeSha256: string;
  files: BaselineHashedFile[];
}

interface TreeEntry {
  type: "directory" | "file";
  path: string;
  bytes?: number;
  sha256?: string;
}

function refuse(message: string): never {
  throw new AihError(message, "AIH_TRUST");
}

function sourceRelative(root: string, target: string): string {
  const rel = relative(root, target).replace(/\\/g, "/");
  if (rel.length === 0 || rel === ".." || rel.startsWith("../") || isAbsolute(rel)) {
    return refuse(`baseline component path escapes or aliases the source root: ${target}`);
  }
  return rel;
}

function normalizedDeclaredPath(raw: string): string {
  if (raw.length === 0 || raw.includes("\\") || raw.startsWith("/")) {
    return refuse(`baseline component path must be source-relative POSIX text: ${raw}`);
  }
  const normalized = posix.normalize(raw);
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    isAbsolute(normalized)
  ) {
    return refuse(`baseline component path escapes the source root: ${raw}`);
  }
  return normalized;
}

function fileDigest(path: string): { bytes: number; sha256: string } {
  try {
    const bytes = readFileSync(path);
    return {
      bytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  } catch (err) {
    return refuse(`baseline component file is unreadable: ${path} (${(err as Error).message})`);
  }
}

export function hashComponentTree(
  sourceRoot: string,
  declaredPaths: readonly string[],
): BaselineTreeHash {
  let root: string;
  try {
    const rootStat = lstatSync(sourceRoot);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      return refuse(`baseline source root must be a real directory: ${sourceRoot}`);
    }
    root = realpathSync(sourceRoot);
  } catch (err) {
    return refuse(`baseline source root is unavailable: ${sourceRoot} (${(err as Error).message})`);
  }
  if (declaredPaths.length === 0) return refuse("baseline component declares no paths");

  const roots = declaredPaths.map(normalizedDeclaredPath);
  const uniqueRoots = new Set(roots);
  if (uniqueRoots.size !== roots.length) {
    return refuse("duplicate normalized baseline component root");
  }

  const entries = new Map<string, TreeEntry>();
  const visit = (path: string): void => {
    let stat: Stats;
    try {
      stat = lstatSync(path);
    } catch (err) {
      refuse(
        `baseline component path does not exist or is unreadable: ${path} (${(err as Error).message})`,
      );
    }
    const rel = sourceRelative(root, path);
    if (entries.has(rel)) refuse(`duplicate baseline tree entry: ${rel}`);
    if (stat.isSymbolicLink()) refuse(`refusing symbolic link in baseline component: ${rel}`);
    if (stat.isDirectory()) {
      entries.set(rel, { type: "directory", path: rel });
      let children: string[];
      try {
        children = readdirSync(path).sort((left, right) => left.localeCompare(right));
      } catch (err) {
        refuse(`baseline component directory is unreadable: ${rel} (${(err as Error).message})`);
      }
      for (const child of children) visit(resolve(path, child));
      return;
    }
    if (!stat.isFile()) refuse(`unsupported baseline component entry type: ${rel}`);
    if (stat.nlink > 1) refuse(`refusing hard-linked file in baseline component: ${rel}`);
    const digest = fileDigest(path);
    entries.set(rel, { type: "file", path: rel, ...digest });
  };

  for (const declared of [...uniqueRoots].sort((left, right) => left.localeCompare(right))) {
    const target = resolve(root, ...declared.split("/"));
    sourceRelative(root, target);
    visit(target);
  }

  const ordered = [...entries.values()].sort((left, right) => left.path.localeCompare(right.path));
  const serialized = JSON.stringify(ordered);
  return {
    treeSha256: createHash("sha256").update(serialized, "utf8").digest("hex"),
    files: ordered.flatMap((entry) =>
      entry.type === "file"
        ? [{ path: entry.path, bytes: entry.bytes ?? 0, sha256: entry.sha256 ?? "" }]
        : [],
    ),
  };
}
