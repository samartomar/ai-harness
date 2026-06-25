import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { AihError } from "../errors.js";

function normalizeRepoPath(raw: string): string {
  const value = raw.trim().replace(/\\/g, "/");
  if (value.length === 0) return "";
  if (value.startsWith("/") || /^[A-Za-z]:/.test(value) || value.startsWith("//")) {
    throw new AihError(
      `workspace repo path must be relative to the parent: ${raw}`,
      "AIH_WORKSPACE",
    );
  }
  const parts = value.split("/").filter((p) => p.length > 0);
  if (parts.some((p) => p === "." || p === "..")) {
    throw new AihError(`workspace repo path must not traverse parents: ${raw}`, "AIH_WORKSPACE");
  }
  return parts.join("/");
}

function isGitRepo(parent: string, repo: string): boolean {
  const dir = join(parent, repo);
  try {
    return statSync(dir).isDirectory() && existsSync(join(dir, ".git"));
  } catch {
    return false;
  }
}

/**
 * The child repositories of a workspace parent. An explicit list (from
 * `--repos a,b`) is honored as-is (filtered to those that exist); otherwise every
 * immediate subdirectory that contains a `.git` (dir for a clone, file for a
 * worktree/submodule) is treated as a repo. Hidden dirs are skipped. Deterministic
 * order (sorted) so the plan is stable.
 */
export function detectChildRepos(parent: string, explicit: readonly string[] = []): string[] {
  if (explicit.length > 0) {
    const repos = [...new Set(explicit.map(normalizeRepoPath).filter((r) => r.length > 0))];
    const missing = repos.filter((r) => !existsSync(join(parent, r)));
    if (missing.length > 0) {
      throw new AihError(
        `workspace --repos entries do not exist under the parent: ${missing.join(", ")}`,
        "AIH_WORKSPACE",
      );
    }
    const notRepos = repos.filter((r) => !isGitRepo(parent, r));
    if (notRepos.length > 0) {
      throw new AihError(
        `workspace --repos entries are not git repos (missing .git): ${notRepos.join(", ")}`,
        "AIH_WORKSPACE",
      );
    }
    return repos;
  }
  let entries: string[];
  try {
    entries = readdirSync(parent);
  } catch {
    return [];
  }
  return entries
    .filter((name) => !name.startsWith("."))
    .filter((name) => {
      const dir = join(parent, name);
      try {
        return statSync(dir).isDirectory() && existsSync(join(dir, ".git"));
      } catch {
        return false;
      }
    })
    .sort();
}

/** Parse `--repos a,b,c` into a list (empty when the flag is absent). */
export function reposOption(raw: unknown): string[] {
  if (typeof raw !== "string" || raw.trim().length === 0) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
