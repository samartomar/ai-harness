import { resolve } from "node:path";
import { AihError } from "../errors.js";
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
import { discoverChildGitRepos } from "./detect.js";

const WORKSPACE_TRANSIENT_PATTERNS = [
  ".aih/",
  ".aih/reports/",
  ".aih/runs/",
  "*.aih.bak",
  "*.aih.tmp",
];
const BASELINE_COMMIT_MESSAGE = "chore: initialize workspace config (aih workspace --git)";

export function workspaceGitignorePatternForRepo(repo: string): string {
  const normalized = repo.replace(/\\/g, "/").replace(/\/+$/, "");
  return `/${normalized.replace(/[\\#!*?[\]]/g, "\\$&")}/`;
}

function legacyWorkspaceGitignorePatternForRepo(repo: string): string {
  return workspaceGitignorePatternForRepo(repo).replace(/^\//, "");
}

export function workspaceGitignoreRequiredRepos(root: string, repos: readonly string[]): string[] {
  const discovered = discoverChildGitRepos(root, { includeHidden: true, printableOnly: false });
  return [...new Set([...repos, ...discovered])];
}

function workspaceGitignorePatterns(root: string, repos: readonly string[]): string[] {
  const repoPatterns = workspaceGitignoreRequiredRepos(root, repos).map(
    workspaceGitignorePatternForRepo,
  );
  return [...repoPatterns, ...WORKSPACE_TRANSIENT_PATTERNS];
}

/** Ensure the parent workspace repo ignores child repo worktrees and transient outputs. */
export function workspaceGitignoreWrite(root: string, repos: readonly string[]): WriteAction {
  const existing = readIfExists(resolve(root, ".gitignore"));
  const patterns = workspaceGitignorePatterns(root, repos);
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
  // Keep this in lockstep with executePlan's WriteAction effect calculation: the
  // git baseline commit must stage the same writes the executor is about to apply.
  const abs = resolve(ctx.root, action.path);
  const existing = readIfExists(abs);
  if (action.once && existing !== undefined) return false;
  return resolveContents(action, abs) !== existing;
}

function writeActionPath(action: WriteAction): string {
  return action.path.replace(/\\/g, "/");
}

async function gitConfigValue(ctx: PlanContext, key: "user.email" | "user.name"): Promise<string> {
  const res = await ctx.run(["git", "-C", ctx.root, "config", "--get", key]);
  return res.code === 0 && !res.spawnError ? res.stdout.trim() : "";
}

async function assertGitIdentity(ctx: PlanContext): Promise<void> {
  const [email, name] = await Promise.all([
    gitConfigValue(ctx, "user.email"),
    gitConfigValue(ctx, "user.name"),
  ]);
  const missing = [
    email.length === 0 ? "user.email" : undefined,
    name.length === 0 ? "user.name" : undefined,
  ].filter((value): value is string => value !== undefined);
  if (missing.length === 0) return;
  throw new AihError(
    `workspace --git needs git identity before creating the baseline commit; missing ${missing.join(
      " and ",
    )}. Configure it with \`git config --global user.email you@example.com\` and \`git config --global user.name "Your Name"\`, then re-run \`aih workspace --apply --git\`.`,
    "AIH_WORKSPACE",
  );
}

/** Local-only git setup for the workspace bridge repo; remote ownership stays user-controlled. */
export async function workspaceGitExecs(
  ctx: PlanContext,
  baselineWrites: readonly WriteAction[],
): Promise<ExecAction[]> {
  const insideGit = (await gitRead(ctx, ["rev-parse", "--is-inside-work-tree"])) === "true";
  const changedPaths = baselineWrites
    .filter((action) => writeWouldChange(ctx, action))
    .map(writeActionPath);
  const baselinePaths = [...new Set(baselineWrites.map(writeActionPath))];
  const pathsToCommit = insideGit ? changedPaths : baselinePaths;

  const actions: ExecAction[] = [];
  if (!insideGit) {
    actions.push(
      exec("initialize git repository at workspace root", ["git", "-C", ctx.root, "init"]),
    );
  }
  if (pathsToCommit.length > 0) {
    if (ctx.apply) await assertGitIdentity(ctx);
    actions.push(
      exec("stage workspace git baseline files", [
        "git",
        "-C",
        ctx.root,
        "add",
        "--",
        ...pathsToCommit,
      ]),
      exec("commit workspace git baseline files", [
        "git",
        "-C",
        ctx.root,
        "commit",
        "-m",
        BASELINE_COMMIT_MESSAGE,
        "--",
        ...pathsToCommit,
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
  return repos
    .map((repo) => ({
      anchored: workspaceGitignorePatternForRepo(repo),
      legacy: legacyWorkspaceGitignorePatternForRepo(repo),
    }))
    .filter(({ anchored, legacy }) => !lines.includes(anchored) && !lines.includes(legacy))
    .map(({ anchored }) => anchored);
}
