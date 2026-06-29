import { existsSync } from "node:fs";
import { join } from "node:path";
import { readIfExists } from "./fsxn.js";

/** The one clone-local command aih shows for activating its managed hooks dir. */
export const GITHOOKS_PATH_COMMAND = "git config core.hooksPath .githooks";

function normalizeHooksPath(value: string): string {
  return value
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "");
}

/** Whether `.git/config` points git at aih's managed `.githooks/` directory. */
export function usesManagedHooksPath(root: string): boolean {
  const text = readIfExists(join(root, ".git", "config"));
  if (text === undefined) return false;
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
    if (match && normalizeHooksPath(match[1] ?? "") === ".githooks") return true;
  }
  return false;
}

/**
 * True when commits will run a pre-commit hook through either git's default hook
 * path or aih's clone-local `.githooks/` path.
 */
export function preCommitHookActive(root: string): boolean {
  if (existsSync(join(root, ".git", "hooks", "pre-commit"))) return true;
  return existsSync(join(root, ".githooks", "pre-commit")) && usesManagedHooksPath(root);
}
