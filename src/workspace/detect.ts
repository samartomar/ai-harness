import { existsSync, lstatSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { AihError } from "../errors.js";
import { assertWorkspacePrintable } from "./manifest.js";

function cleanPrintable(value: string, label: string): void {
  try {
    assertWorkspacePrintable(value, label);
  } catch {
    throw new AihError(`${label} must be safe to print in workspace reports`, "AIH_WORKSPACE");
  }
}

function normalizeRepoPath(raw: string): string {
  const value = raw.trim().replace(/\\/g, "/");
  if (value.length === 0) return "";
  if (value.startsWith("/") || /^[A-Za-z]:/.test(value) || value.startsWith("//")) {
    throw new AihError(
      `workspace repo path must be relative to the parent: ${raw}`,
      "AIH_WORKSPACE",
    );
  }
  cleanPrintable(value, "workspace repo path");
  const parts = value.split("/").filter((p) => p.length > 0);
  if (parts.some((p) => p === "." || p === "..")) {
    throw new AihError(`workspace repo path must not traverse parents: ${raw}`, "AIH_WORKSPACE");
  }
  if (parts.some((p) => p.startsWith("-"))) {
    throw new AihError(
      `workspace repo path segment must not start with '-': ${raw}`,
      "AIH_WORKSPACE",
    );
  }
  return parts.join("/");
}

function isContainedPath(parent: string, child: string): boolean {
  const rel = relative(realpathSync(parent), realpathSync(child));
  return rel.length === 0 || (!rel.startsWith("..") && !isAbsolute(rel));
}

export interface WorkspaceChildPathCheck {
  path: string;
  exists: boolean;
  git: boolean;
}

export function checkWorkspaceChildPath(parent: string, repo: string): WorkspaceChildPathCheck {
  const path = normalizeRepoPath(repo);
  const dir = join(parent, path);
  let info: ReturnType<typeof lstatSync>;
  try {
    info = lstatSync(dir);
  } catch {
    return { path, exists: false, git: false };
  }
  if (info.isSymbolicLink()) {
    throw new AihError(
      `workspace repo path must be a real directory inside the parent, not a link: ${repo}`,
      "AIH_WORKSPACE",
    );
  }
  if (!info.isDirectory()) {
    throw new AihError(`workspace repo path must be a directory: ${repo}`, "AIH_WORKSPACE");
  }
  if (!isContainedPath(parent, dir)) {
    throw new AihError(
      `workspace repo path must stay inside the parent workspace: ${repo}`,
      "AIH_WORKSPACE",
    );
  }
  return { path, exists: true, git: existsSync(join(dir, ".git")) };
}

export function assertWorkspaceChildCloneTarget(parent: string, repo: string): string {
  const path = normalizeRepoPath(repo);
  const parts = path.split("/").filter((part) => part.length > 0);
  let current = parent;
  for (const segment of parts.slice(0, -1)) {
    current = join(current, segment);
    let info: ReturnType<typeof lstatSync>;
    try {
      info = lstatSync(current);
    } catch {
      break;
    }
    if (info.isSymbolicLink()) {
      throw new AihError(
        `workspace repo path ancestor must be a real directory inside the parent, not a link: ${repo}`,
        "AIH_WORKSPACE",
      );
    }
    if (!info.isDirectory()) {
      throw new AihError(
        `workspace repo path ancestor must be a directory: ${repo}`,
        "AIH_WORKSPACE",
      );
    }
    if (!isContainedPath(parent, current)) {
      throw new AihError(
        `workspace repo path must stay inside the parent workspace: ${repo}`,
        "AIH_WORKSPACE",
      );
    }
  }
  return path;
}

function isSafeGitignoreLineName(name: string): boolean {
  if (name.endsWith(" ")) return false;
  for (const ch of name) {
    if (ch === "\\" || ch.charCodeAt(0) < 0x20) return false;
  }
  return true;
}

export function assertDiscoverableChildGitRepoName(
  name: string,
  options: DiscoverChildGitRepoOptions = {},
): void {
  if (options.printableOnly !== false) {
    cleanPrintable(name, "workspace repo path");
  }
  if (!isSafeGitignoreLineName(name)) {
    throw new AihError(
      options.printableOnly !== false
        ? "workspace child git repo name must be safe to print in workspace reports"
        : "workspace child git repo name cannot be represented safely in .gitignore",
      "AIH_WORKSPACE",
    );
  }
}

function isDiscoveredChildGitRepo(
  parent: string,
  name: string,
  options: DiscoverChildGitRepoOptions,
): boolean {
  try {
    const dir = join(parent, name);
    const info = lstatSync(dir);
    if (info.isSymbolicLink() || !info.isDirectory()) return false;
    if (!isContainedPath(parent, dir)) return false;
    if (!existsSync(join(dir, ".git"))) return false;
    assertDiscoverableChildGitRepoName(name, options);
    return true;
  } catch (error) {
    if (error instanceof AihError) throw error;
    return false;
  }
}

export interface DiscoverChildGitRepoOptions {
  includeHidden?: boolean;
  printableOnly?: boolean;
}

/**
 * Immediate child directories containing `.git` metadata. This is discovery only:
 * callers must not use it as an implicit workspace read-scope allowlist.
 */
export function discoverChildGitRepos(
  parent: string,
  options: DiscoverChildGitRepoOptions = {},
): string[] {
  let entries: string[];
  try {
    entries = readdirSync(parent);
  } catch {
    return [];
  }
  return entries
    .filter((name) => options.includeHidden === true || !name.startsWith("."))
    .filter((name) => isDiscoveredChildGitRepo(parent, name, options))
    .sort();
}

/**
 * The declared child repositories of a workspace parent. An explicit list (from
 * `--repos a,b`) is honored as-is after validation. When `--repos` is absent, this
 * returns an empty allowlist rather than silently enrolling every child `.git`
 * directory into generated workspace/MCP read scopes.
 */
export function detectChildRepos(parent: string, explicit: readonly string[] = []): string[] {
  if (explicit.length > 0) {
    const repos = [...new Set(explicit.map(normalizeRepoPath).filter((r) => r.length > 0))];
    const checks = repos.map((repo) => checkWorkspaceChildPath(parent, repo));
    const missing = checks.filter((check) => !check.exists).map((check) => check.path);
    if (missing.length > 0) {
      throw new AihError(
        `workspace --repos entries do not exist under the parent: ${missing.join(", ")}`,
        "AIH_WORKSPACE",
      );
    }
    const notRepos = checks.filter((check) => !check.git).map((check) => check.path);
    if (notRepos.length > 0) {
      throw new AihError(
        `workspace --repos entries are not git repos (missing .git): ${notRepos.join(", ")}`,
        "AIH_WORKSPACE",
      );
    }
    return repos;
  }
  return [];
}

/** Parse `--repos a,b,c` into a list (empty when the flag is absent). */
export function reposOption(raw: unknown): string[] {
  if (typeof raw !== "string" || raw.trim().length === 0) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
