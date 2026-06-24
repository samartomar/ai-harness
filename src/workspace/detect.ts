import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * The child repositories of a workspace parent. An explicit list (from
 * `--repos a,b`) is honored as-is (filtered to those that exist); otherwise every
 * immediate subdirectory that contains a `.git` (dir for a clone, file for a
 * worktree/submodule) is treated as a repo. Hidden dirs are skipped. Deterministic
 * order (sorted) so the plan is stable.
 */
export function detectChildRepos(parent: string, explicit: readonly string[] = []): string[] {
  if (explicit.length > 0) {
    return explicit.map((r) => r.trim()).filter((r) => r.length > 0 && existsSync(join(parent, r)));
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
