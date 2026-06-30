import { resolve } from "node:path";
import { resolveContents } from "../internals/execute.js";
import { readIfExists } from "../internals/fsxn.js";
import { gitRead } from "../internals/git.js";
import {
  type ExecAction,
  exec,
  type PlanContext,
  type WriteAction,
  writeText,
} from "../internals/plan.js";
import { stripTrailingNewlines } from "../internals/render.js";

const WORKSPACE_TRANSIENT_PATTERNS = [
  ".aih/",
  ".aih/reports/",
  ".aih/runs/",
  "*.aih.bak",
  "*.aih.tmp",
];
const BASELINE_COMMIT_MESSAGE = "chore: initialize workspace config (aih workspace --git)";

function repoIgnorePattern(repo: string): string {
  return `${repo.replace(/\\/g, "/").replace(/\/+$/, "")}/`;
}

function workspaceGitignorePatterns(repos: readonly string[]): string[] {
  return [...repos.map(repoIgnorePattern), ...WORKSPACE_TRANSIENT_PATTERNS];
}

/** Ensure the parent workspace repo ignores child repo worktrees and transient outputs. */
export function workspaceGitignoreWrite(root: string, repos: readonly string[]): WriteAction {
  const existing = readIfExists(resolve(root, ".gitignore"));
  const patterns = workspaceGitignorePatterns(repos);
  const existingLines = existing?.split(/\r?\n/).map((line) => line.trim()) ?? [];
  const missing = patterns.filter((pattern) => !existingLines.includes(pattern));
  const block = ["# aih-managed (workspace git)", ...missing].join("\n");
  const contents =
    existing === undefined
      ? ["# aih-managed (workspace git)", ...patterns].join("\n")
      : missing.length === 0
        ? existing
        : `${stripTrailingNewlines(existing)}\n\n${block}\n`;

  return writeText(".gitignore", contents, "ignore child repos and aih workspace transient files");
}

function writeWouldChange(ctx: PlanContext, action: WriteAction): boolean {
  const abs = resolve(ctx.root, action.path);
  const existing = readIfExists(abs);
  if (action.once && existing !== undefined) return false;
  return resolveContents(action, abs) !== existing;
}

/** Local-only git setup for the workspace bridge repo; remote ownership stays user-controlled. */
export async function workspaceGitExecs(
  ctx: PlanContext,
  baselineWrites: readonly WriteAction[],
): Promise<ExecAction[]> {
  const insideGit = (await gitRead(ctx, ["rev-parse", "--is-inside-work-tree"])) === "true";
  const changedPaths = baselineWrites
    .filter((action) => writeWouldChange(ctx, action))
    .map((action) => action.path.replace(/\\/g, "/"));

  const actions: ExecAction[] = [];
  if (!insideGit) {
    actions.push(
      exec("initialize git repository at workspace root", ["git", "-C", ctx.root, "init"]),
    );
  }
  if (changedPaths.length > 0) {
    actions.push(
      exec("stage changed workspace git baseline files", [
        "git",
        "-C",
        ctx.root,
        "add",
        "--",
        ...changedPaths,
      ]),
      exec("commit changed workspace git baseline files", [
        "git",
        "-C",
        ctx.root,
        "commit",
        "-m",
        BASELINE_COMMIT_MESSAGE,
        "--",
        ...changedPaths,
      ]),
    );
  }
  return actions;
}

export function workspaceGitignoreMissing(
  repos: readonly string[],
  gitignore: string | undefined,
): string[] {
  const lines = gitignore?.split(/\r?\n/).map((line) => line.trim()) ?? [];
  return repos.map(repoIgnorePattern).filter((pattern) => !lines.includes(pattern));
}
