import { existsSync, lstatSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { readIfExists } from "./fsxn.js";

/** The one clone-local command aih shows for activating its managed hooks dir. */
export const GITHOOKS_PATH_COMMAND = "git config core.hooksPath .githooks";

function normalizeHooksPath(value: string): string {
  const normalized = value
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "");
  if (/^\/+$/.test(normalized) || /^[A-Za-z]:\/?$/.test(normalized)) return normalized;
  return normalized.replace(/\/+$/, "");
}

function lstatSafe(path: string) {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}

function windowsAbsolutePath(value: string): boolean {
  return /^[A-Za-z]:\//.test(value);
}

function resolvePathLike(base: string, value: string): string | undefined {
  if (windowsAbsolutePath(value) && !isAbsolute(value)) return undefined;
  return isAbsolute(value) ? resolve(value) : resolve(base, value);
}

function containedRelativePath(root: string, absPath: string): string | undefined {
  const rel = relative(root, absPath);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return undefined;
  return rel;
}

function defaultHookPath(root: string, hookName: string): string | undefined {
  const gitMeta = lstatSafe(join(root, ".git"));
  if (gitMeta?.isFile()) return undefined;
  return join(".git", "hooks", hookName);
}

/** Convert a git `core.hooksPath` value into a repo-local hook file path, if safe. */
export function repoLocalHookPath(
  root: string,
  hookName: string,
  hooksPath?: string,
): string | undefined {
  const normalized =
    hooksPath === undefined || hooksPath.trim() === "" ? undefined : normalizeHooksPath(hooksPath);
  if (normalized === undefined) return defaultHookPath(root, hookName);
  if (normalized.startsWith("~")) return undefined;

  const absHookPath = resolvePathLike(root, join(normalized, hookName));
  return absHookPath === undefined ? undefined : containedRelativePath(root, absHookPath);
}

function repoGitConfigPath(root: string): string {
  const dotGit = join(root, ".git");
  const gitMeta = lstatSafe(dotGit);
  if (gitMeta?.isFile()) {
    const match = /^gitdir:\s*(.+)$/im.exec(readIfExists(dotGit) ?? "");
    const gitDir = match?.[1]?.trim();
    const resolved = gitDir === undefined ? undefined : resolvePathLike(root, gitDir);
    if (resolved !== undefined) return join(resolved, "config");
  }
  return join(dotGit, "config");
}

function hooksPathFromConfig(path: string): string | undefined {
  const text = readIfExists(path);
  if (text === undefined) return undefined;
  let inCore = false;
  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    const trimmed = line.trim();
    const section = trimmed.match(/^\[([^\]]+)\]$/);
    if (section) {
      inCore = section[1]?.trim().toLowerCase() === "core";
      continue;
    }
    if (!inCore || trimmed.startsWith("#") || trimmed.startsWith(";")) continue;
    const match = trimmed.match(/^hooksPath\s*=\s*(.+)$/i);
    if (match) return match[1] ?? undefined;
  }
  return undefined;
}

function globalConfigPaths(env: NodeJS.ProcessEnv): string[] {
  if (env.GIT_CONFIG_NOGLOBAL === "true" || env.GIT_CONFIG_NOGLOBAL === "1") return [];
  const paths = [
    env.GIT_CONFIG_GLOBAL,
    env.XDG_CONFIG_HOME === undefined ? undefined : join(env.XDG_CONFIG_HOME, "git", "config"),
    env.HOME === undefined ? undefined : join(env.HOME, ".gitconfig"),
    env.HOME === undefined ? undefined : join(env.HOME, ".config", "git", "config"),
    env.USERPROFILE === undefined ? undefined : join(env.USERPROFILE, ".gitconfig"),
  ];
  return [...new Set(paths.filter((p): p is string => p !== undefined && p.trim() !== ""))];
}

function configuredHooksPath(
  root: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const repoHooksPath = hooksPathFromConfig(repoGitConfigPath(root));
  if (repoHooksPath !== undefined) return repoHooksPath;
  for (const path of globalConfigPaths(env)) {
    const hooksPath = hooksPathFromConfig(path);
    if (hooksPath !== undefined) return hooksPath;
  }
  return undefined;
}

/** Active repo-local hook path from `.git/config`, or the git default when unset. */
export function configuredRepoLocalHookPath(
  root: string,
  hookName: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return repoLocalHookPath(root, hookName, configuredHooksPath(root, env));
}

/** Whether `.git/config` points git at aih's managed `.githooks/` directory. */
export function usesManagedHooksPath(root: string): boolean {
  const hooksPath = configuredHooksPath(root);
  return hooksPath !== undefined && normalizeHooksPath(hooksPath) === ".githooks";
}

/**
 * True when commits will run a pre-commit hook through either git's default hook
 * path or aih's clone-local `.githooks/` path.
 */
export function preCommitHookActive(root: string): boolean {
  if (existsSync(join(root, ".git", "hooks", "pre-commit"))) return true;
  return existsSync(join(root, ".githooks", "pre-commit")) && usesManagedHooksPath(root);
}
