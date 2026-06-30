import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { PlanContext } from "../internals/plan.js";
import type { WorkspaceManifest, WorkspaceRepo } from "./manifest.js";

export interface WorkspaceRepoState {
  id: string;
  path: string;
  branch?: string;
  sha?: string;
  dirty: boolean;
  git: boolean;
  ahead?: number;
  behind?: number;
}

export interface WorkspaceSnapshot {
  schemaVersion: 1;
  createdAt: string;
  label?: string;
  repos: WorkspaceRepoState[];
}

async function gitChildRead(
  ctx: PlanContext,
  repo: WorkspaceRepo,
  args: string[],
): Promise<string | undefined> {
  const res = await ctx.run(["git", "-C", join(ctx.root, repo.path), ...args]);
  if (res.spawnError || res.code !== 0) return undefined;
  return res.stdout.replace(/\s+$/, "");
}

function parseAheadBehind(raw: string | undefined): { ahead?: number; behind?: number } {
  const [behindRaw, aheadRaw] = (raw ?? "").split(/\s+/);
  const behind = Number.parseInt(behindRaw ?? "", 10);
  const ahead = Number.parseInt(aheadRaw ?? "", 10);
  return {
    ...(Number.isFinite(ahead) ? { ahead } : {}),
    ...(Number.isFinite(behind) ? { behind } : {}),
  };
}

export async function readWorkspaceRepoState(
  ctx: PlanContext,
  repo: WorkspaceRepo,
): Promise<WorkspaceRepoState> {
  const inside = (await gitChildRead(ctx, repo, ["rev-parse", "--is-inside-work-tree"])) === "true";
  if (!inside) return { id: repo.id, path: repo.path, dirty: false, git: false };
  const branch = await gitChildRead(ctx, repo, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const sha = await gitChildRead(ctx, repo, ["rev-parse", "--short", "HEAD"]);
  const dirty = ((await gitChildRead(ctx, repo, ["status", "--porcelain"])) ?? "").length > 0;
  const aheadBehind = parseAheadBehind(
    await gitChildRead(ctx, repo, ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"]),
  );
  return {
    id: repo.id,
    path: repo.path,
    ...(branch ? { branch } : {}),
    ...(sha ? { sha } : {}),
    dirty,
    git: true,
    ...aheadBehind,
  };
}

export async function collectWorkspaceSnapshot(
  ctx: PlanContext,
  manifest: WorkspaceManifest,
  opts: { label?: string; createdAt?: string } = {},
): Promise<WorkspaceSnapshot> {
  const repos: WorkspaceRepoState[] = [];
  for (const repo of manifest.repos) repos.push(await readWorkspaceRepoState(ctx, repo));
  return {
    schemaVersion: 1,
    createdAt: opts.createdAt ?? new Date().toISOString(),
    ...(opts.label ? { label: opts.label } : {}),
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
