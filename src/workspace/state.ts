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

function parseBranchDivergence(raw: string): { ahead: number; behind: number } | undefined {
  const match = /^\+([0-9]+) -([0-9]+)$/.exec(raw);
  if (match === null) return undefined;
  const ahead = gitInt(match[1]);
  const behind = gitInt(match[2]);
  if (ahead === undefined || behind === undefined) return undefined;
  return { ahead, behind };
}

interface WorkspaceRevision {
  branch: string;
  sha: string;
  dirty: boolean;
  ahead?: number;
  behind?: number;
}

async function readWorkspaceRevision(
  ctx: PlanContext,
  repo: WorkspaceRepo,
): Promise<WorkspaceRevision | undefined> {
  // `status --porcelain=v2 --branch` emits branch, HEAD, dirty state, and
  // upstream divergence in one Git process. Independent rev-parse/status calls
  // could otherwise each be valid yet describe different revisions mid-switch.
  const raw = await gitChildRead(ctx, repo, ["status", "--porcelain=v2", "--branch"], {
    trim: false,
  });
  if (raw === undefined) return undefined;
  const headers = new Map<string, string>();
  const entries: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.length === 0) continue;
    if (!line.startsWith("# ")) {
      entries.push(line);
      continue;
    }
    const separator = line.indexOf(" ", 2);
    if (separator < 0) return undefined;
    const key = line.slice(2, separator);
    const value = line.slice(separator + 1);
    if (value.length === 0 || headers.has(key)) return undefined;
    headers.set(key, value);
  }
  const branch = headers.get("branch.head");
  const sha = headers.get("branch.oid");
  if (
    branch === undefined ||
    branch.length === 0 ||
    sha === undefined ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(sha)
  )
    return undefined;
  const branchAb = headers.get("branch.ab");
  const counts = branchAb === undefined ? {} : parseBranchDivergence(branchAb);
  if (counts === undefined) return undefined;
  return { branch, sha, dirty: entries.length > 0, ...counts };
}

function sameWorkspaceRevision(left: WorkspaceRevision, right: WorkspaceRevision): boolean {
  return (
    left.branch === right.branch &&
    left.sha === right.sha &&
    left.dirty === right.dirty &&
    left.ahead === right.ahead &&
    left.behind === right.behind
  );
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
  const remote = repo.remote === undefined ? await readWorkspaceRepoRemote(ctx, repo) : repo.remote;
  const after = await readWorkspaceRevision(ctx, repo);
  if (after === undefined) return incompleteWorkspaceRepoState(repo, "unavailable");
  if (!sameWorkspaceRevision(before, after)) {
    return incompleteWorkspaceRepoState(repo, "diverged");
  }
  return {
    id: repo.id,
    path: repo.path,
    ...(remote ? { remote } : {}),
    branch: before.branch,
    sha: before.sha,
    dirty: before.dirty,
    git: true,
    ...(before.ahead === undefined || before.behind === undefined
      ? {}
      : { ahead: before.ahead, behind: before.behind }),
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
