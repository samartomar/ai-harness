import { readdirSync } from "node:fs";
import { join } from "node:path";
import { AihError } from "../errors.js";
import { gitInt } from "../internals/git.js";
import type { PlanContext } from "../internals/plan.js";
import { checkWorkspaceChildPath } from "./detect.js";
import {
  normalizeWorkspaceRemote,
  type WorkspaceManifest,
  type WorkspaceRepo,
} from "./manifest.js";
import { normalizeWorkspaceDisplayText } from "./text.js";

export interface WorkspaceRepoState {
  id: string;
  path: string;
  remote?: string;
  branch?: string;
  sha?: string;
  dirty?: boolean;
  git: boolean;
  ahead?: number;
  behind?: number;
  /** Volatile revision evidence could not be captured as one coherent observation. */
  observation?: "diverged" | "unavailable";
}

export interface WorkspaceSnapshot {
  schemaVersion: 1;
  createdAt: string;
  label?: string;
  repos: WorkspaceRepoState[];
}

export const WORKSPACE_REPO_CONCURRENCY = 4;

async function gitChildRead(
  ctx: PlanContext,
  repo: WorkspaceRepo,
  args: string[],
  options: { trim?: boolean } = {},
): Promise<string | undefined> {
  const res = await ctx.run(["git", "-C", join(ctx.root, repo.path), ...args]);
  if (res.spawnError || res.code !== 0) return undefined;
  return options.trim === false ? res.stdout : res.stdout.replace(/\s+$/, "");
}

function parseAheadBehind(raw: string | undefined): { ahead?: number; behind?: number } {
  const fields = raw?.replace(/\r?\n$/, "").split("\t");
  if (fields === undefined || fields.length !== 2) return {};
  const behind = gitInt(fields[0]);
  const ahead = gitInt(fields[1]);
  if (ahead === undefined || behind === undefined) return {};
  return { ahead, behind };
}

interface WorkspaceRevision {
  branch: string;
  sha: string;
}

async function readWorkspaceRevision(
  ctx: PlanContext,
  repo: WorkspaceRepo,
): Promise<WorkspaceRevision | undefined> {
  const [branch, sha] = await Promise.all([
    gitChildRead(ctx, repo, ["rev-parse", "--abbrev-ref", "HEAD"]),
    gitChildRead(ctx, repo, ["rev-parse", "HEAD"]),
  ]);
  if (branch === undefined || sha === undefined) return undefined;
  return { branch, sha };
}

function sameWorkspaceRevision(left: WorkspaceRevision, right: WorkspaceRevision): boolean {
  return left.branch === right.branch && left.sha === right.sha;
}

function incompleteWorkspaceRepoState(
  repo: WorkspaceRepo,
  observation: "diverged" | "unavailable",
): WorkspaceRepoState {
  return { id: repo.id, path: repo.path, git: true, observation };
}

function safeObservedRemote(raw: string | undefined): string | undefined {
  if (raw === undefined || raw.length === 0) return undefined;
  try {
    return normalizeWorkspaceRemote(raw);
  } catch {
    return undefined;
  }
}

async function readWorkspaceRepoRemote(
  ctx: PlanContext,
  repo: WorkspaceRepo,
): Promise<string | undefined> {
  return safeObservedRemote(
    await gitChildRead(ctx, repo, ["config", "--local", "--get", "remote.origin.url"]),
  );
}

export async function readWorkspaceRepoState(
  ctx: PlanContext,
  repo: WorkspaceRepo,
): Promise<WorkspaceRepoState> {
  const checked = checkWorkspaceChildPath(ctx.root, repo.path);
  if (!checked.exists) return { id: repo.id, path: repo.path, dirty: false, git: false };
  const inside = (await gitChildRead(ctx, repo, ["rev-parse", "--is-inside-work-tree"])) === "true";
  if (!inside) return { id: repo.id, path: repo.path, dirty: false, git: false };
  const before = await readWorkspaceRevision(ctx, repo);
  if (before === undefined) return incompleteWorkspaceRepoState(repo, "unavailable");
  const [status, upstream, remote] = await Promise.all([
    gitChildRead(ctx, repo, ["status", "--porcelain"]),
    gitChildRead(ctx, repo, ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"], {
      trim: false,
    }),
    repo.remote === undefined ? readWorkspaceRepoRemote(ctx, repo) : Promise.resolve(repo.remote),
  ]);
  const after = await readWorkspaceRevision(ctx, repo);
  if (after === undefined) return incompleteWorkspaceRepoState(repo, "unavailable");
  if (!sameWorkspaceRevision(before, after)) {
    return incompleteWorkspaceRepoState(repo, "diverged");
  }
  const dirty = (status ?? "").length > 0;
  const aheadBehind = parseAheadBehind(upstream);
  return {
    id: repo.id,
    path: repo.path,
    ...(remote ? { remote } : {}),
    branch: before.branch,
    sha: before.sha,
    dirty,
    git: true,
    ...aheadBehind,
  };
}

export async function mapWorkspaceRepos<T>(
  repos: readonly WorkspaceRepo[],
  mapper: (repo: WorkspaceRepo) => Promise<T>,
): Promise<T[]> {
  const out = new Array<T>(repos.length);
  let next = 0;
  const workerCount = Math.min(WORKSPACE_REPO_CONCURRENCY, repos.length);
  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= repos.length) return;
      const repo = repos[index];
      if (repo === undefined) {
        throw new AihError(
          "workspace repo list must be dense; sparse entries cannot be collected safely",
          "AIH_WORKSPACE",
        );
      }
      out[index] = await mapper(repo);
    }
  });
  await Promise.all(workers);
  return out;
}

export async function collectWorkspaceSnapshot(
  ctx: PlanContext,
  manifest: WorkspaceManifest,
  opts: { label?: string; createdAt?: string } = {},
): Promise<WorkspaceSnapshot> {
  const repos = await mapWorkspaceRepos(manifest.repos, (repo) =>
    readWorkspaceRepoState(ctx, repo),
  );
  const label = normalizeWorkspaceDisplayText(opts.label, "workspace snapshot label");
  return {
    schemaVersion: 1,
    createdAt: opts.createdAt ?? new Date().toISOString(),
    ...(label ? { label } : {}),
    repos,
  };
}

export function latestWorkspaceSnapshotPath(root: string): string | undefined {
  const dir = join(root, ".aih", "workspace-snapshots");
  let files: string[];
  try {
    files = readdirSync(dir)
      .filter((f) => f.endsWith(".json"))
      .sort();
  } catch {
    return undefined;
  }
  const latest = files.at(-1);
  return latest ? join(dir, latest) : undefined;
}
