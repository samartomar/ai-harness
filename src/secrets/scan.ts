import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** What a repository scan turned up: plaintext secret files + a `secrets/` dir. */
export interface SecretScan {
  /** Relative paths (POSIX separators) of `.env` / `.env.*` files that are not examples. */
  envFiles: string[];
  /** Relative path of a root-level `secrets/` credential directory, if present. */
  secretDirs: string[];
  /** Convenience union of every flagged path, sorted, for warning text. */
  matches: string[];
}

/** `.env.example` / `.env.sample` are templates, not real secrets — never flag them. */
const EXAMPLE_SUFFIXES = [".example", ".sample"] as const;

function isEnvFile(name: string): boolean {
  if (name !== ".env" && !name.startsWith(".env.")) return false;
  return !EXAMPLE_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

/** List directory entries, tolerating an unreadable/missing dir as "empty". */
function safeReadDir(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Scan `root` for plaintext secret material — `.env` files shallow plus one
 * level deep (excluding `.env.example` / `.env.sample`), and a credential
 * directory named `secrets/` at the repo ROOT only. Nested directories named
 * `secrets` (e.g. `src/secrets`, `tests/secrets`) are code, not secret stores,
 * and are deliberately ignored — matching the root-anchored `Read(./secrets/**)`
 * deny rule. Pure: reads the filesystem, touches no network, mutates nothing;
 * returns repo-relative POSIX paths so results feed deterministically into deny
 * rules and warning docs.
 */
export function scanSecrets(
  root: string,
  opts: { accept?: (rel: string) => boolean } = {},
): SecretScan {
  // A plaintext secret on disk is a finding regardless of git status, so the
  // default keeps everything; callers pass `accept` only to narrow by `--since`
  // for a fast PR scan (never to honor gitignore — a gitignored .env is still a leak).
  const accept = opts.accept ?? (() => true);
  const envFiles = new Set<string>();
  const secretDirs = new Set<string>();

  const visit = (relDir: string, depth: number): void => {
    const absDir = relDir === "" ? root : join(root, relDir);
    for (const entry of safeReadDir(absDir)) {
      const rel = relDir === "" ? entry : `${relDir}/${entry}`;
      const abs = join(absDir, entry);
      if (isDir(abs)) {
        // Only a ROOT-level secrets/ dir is a credential store; nested dirs
        // named "secrets" (src/secrets, tests/secrets, …) are code.
        if (entry === "secrets" && relDir === "" && accept(rel)) secretDirs.add(rel);
        // Recurse exactly one level deep (depth 0 → scan immediate children).
        if (depth > 0) visit(rel, depth - 1);
      } else if (isEnvFile(entry) && accept(rel)) {
        envFiles.add(rel);
      }
    }
  };

  if (existsSync(root)) visit("", 1);

  const envList = [...envFiles].sort();
  const dirList = [...secretDirs].sort();
  return {
    envFiles: envList,
    secretDirs: dirList,
    matches: [...envList, ...dirList].sort(),
  };
}
