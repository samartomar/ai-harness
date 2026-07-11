import { lstatSync, readdirSync, statSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";

export const DEFAULT_TRUST_SKIP_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  ".aih",
  "coverage",
  "dist",
  "node_modules",
  "vendor",
]);

export interface TrustFileEntry {
  absolutePath: string;
  relativePath: string;
  size: number;
}

export interface TrustFileInventory {
  files: readonly TrustFileEntry[];
  matching(predicate: (entry: TrustFileEntry) => boolean): Iterable<TrustFileEntry>;
}

export interface TrustInventoryBuildOptions {
  skipDirs?: ReadonlySet<string>;
  onProgress?: (processed: number) => void;
}

function toPosix(path: string): string {
  return path.replace(/\\/g, "/");
}

export function buildTrustFileInventory(
  root: string,
  options: TrustInventoryBuildOptions = {},
): TrustFileInventory {
  const absoluteRoot = resolve(root);
  const skipDirs = options.skipDirs ?? DEFAULT_TRUST_SKIP_DIRS;
  const files: TrustFileEntry[] = [];
  let processed = 0;
  const visit = (absolutePath: string): void => {
    const stats = lstatSync(absolutePath);
    if (stats.isSymbolicLink()) {
      const target = statSync(absolutePath);
      if (target.isFile()) {
        files.push({
          absolutePath,
          relativePath: toPosix(relative(absoluteRoot, absolutePath)),
          size: target.size,
        });
        processed++;
        if (processed % 250 === 0) options.onProgress?.(processed);
      }
      return;
    }
    if (stats.isDirectory()) {
      if (absolutePath !== absoluteRoot && skipDirs.has(basename(absolutePath))) return;
      for (const entry of readdirSync(absolutePath).sort()) visit(join(absolutePath, entry));
      return;
    }
    if (!stats.isFile()) return;
    files.push({
      absolutePath,
      relativePath: toPosix(relative(absoluteRoot, absolutePath)),
      size: stats.size,
    });
    processed++;
    if (processed % 250 === 0) options.onProgress?.(processed);
  };
  visit(absoluteRoot);
  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  const stableFiles = Object.freeze(files.map((entry) => Object.freeze(entry)));
  return Object.freeze({
    files: stableFiles,
    *matching(predicate: (entry: TrustFileEntry) => boolean): Iterable<TrustFileEntry> {
      for (const entry of stableFiles) {
        if (predicate(entry)) yield entry;
      }
    },
  });
}
