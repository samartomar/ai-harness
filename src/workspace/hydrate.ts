import { dirname, join } from "node:path";
import { AihError } from "../errors.js";
import { readIfExists } from "../internals/fsxn.js";
import { parseJsoncText } from "../internals/merge.js";
import type { Action, CommandSpec, PlanContext } from "../internals/plan.js";
import { doc, exec, plan } from "../internals/plan.js";
import { assertWorkspaceChildCloneTarget, checkWorkspaceChildPath } from "./detect.js";
import {
  normalizeWorkspacePath,
  normalizeWorkspaceRef,
  normalizeWorkspaceRemote,
  readWorkspaceManifest,
  type WorkspaceRepo,
} from "./manifest.js";
import { mapWorkspaceRepos, type WorkspaceRepoState, type WorkspaceSnapshot } from "./state.js";

interface HydrateSource {
  remote?: string;
  ref?: string;
  refKind?: "named" | "sha";
}

interface CurrentCheckout {
  inside: boolean;
  branch?: string;
  sha?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFullGitSha(value: string | undefined): boolean {
  return value !== undefined && /^[0-9a-fA-F]{40}$/.test(value);
}

function normalizeSnapshotSha(raw: unknown): string | undefined {
  const sha = normalizeWorkspaceRef(raw);
  if (sha === undefined) return undefined;
  if (!isFullGitSha(sha)) {
    throw new AihError(
      "workspace snapshot sha must be a full 40-character hex commit id; regenerate the workspace lock",
      "AIH_WORKSPACE",
    );
  }
  return sha.toLowerCase();
}

function snapshotSourceFor(
  repo: WorkspaceRepo,
  snapshot: WorkspaceSnapshot | undefined,
): HydrateSource {
  const entry = snapshot?.repos.find((item) => item.path === repo.path || item.id === repo.id);
  if (entry === undefined) return {};
  if (entry.sha) {
    return {
      ...(entry.remote ? { remote: entry.remote } : {}),
      ref: entry.sha,
      refKind: "sha",
    };
  }
  const ref = entry.sha ?? entry.branch;
  return {
    ...(entry.remote ? { remote: entry.remote } : {}),
    ...(ref ? { ref } : {}),
    ...(ref ? { refKind: "named" as const } : {}),
  };
}

function optionalNumber(raw: unknown, label: string): number | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "number" || !Number.isSafeInteger(raw)) {
    throw new AihError(`workspace hydrate requires a valid ${label}`, "AIH_WORKSPACE");
  }
  return raw;
}

function parseWorkspaceSnapshotRepo(raw: unknown, label: string): WorkspaceRepoState {
  if (!isRecord(raw)) {
    throw new AihError(
      `workspace hydrate requires dense repo objects in ${label}`,
      "AIH_WORKSPACE",
    );
  }
  if (typeof raw.id !== "string" || typeof raw.path !== "string") {
    throw new AihError(`workspace hydrate requires repo id and path in ${label}`, "AIH_WORKSPACE");
  }
  if (typeof raw.dirty !== "boolean" || typeof raw.git !== "boolean") {
    throw new AihError(
      `workspace hydrate requires repo dirty/git state in ${label}`,
      "AIH_WORKSPACE",
    );
  }
  const remote = normalizeWorkspaceRemote(raw.remote);
  const branch = normalizeWorkspaceRef(raw.branch);
  const sha = normalizeSnapshotSha(raw.sha);
  const ahead = optionalNumber(raw.ahead, `${label} ahead count`);
  const behind = optionalNumber(raw.behind, `${label} behind count`);
  return {
    id: raw.id,
    path: normalizeWorkspacePath(raw.path, "workspace repo path"),
    ...(remote ? { remote } : {}),
    ...(branch ? { branch } : {}),
    ...(sha ? { sha } : {}),
    dirty: raw.dirty,
    git: raw.git,
    ...(ahead !== undefined ? { ahead } : {}),
    ...(behind !== undefined ? { behind } : {}),
  };
}

function parseWorkspaceSnapshot(raw: unknown, label: string): WorkspaceSnapshot {
  if (
    !isRecord(raw) ||
    raw.schemaVersion !== 1 ||
    typeof raw.createdAt !== "string" ||
    !Array.isArray(raw.repos)
  ) {
    throw new AihError(`workspace hydrate requires a valid ${label}`, "AIH_WORKSPACE");
  }
  const repos: WorkspaceRepoState[] = [];
  for (let index = 0; index < raw.repos.length; index += 1) {
    if (!(index in raw.repos)) {
      throw new AihError(
        `workspace hydrate requires dense repo entries in ${label}`,
        "AIH_WORKSPACE",
      );
    }
    repos.push(parseWorkspaceSnapshotRepo(raw.repos[index], label));
  }
  return {
    schemaVersion: 1,
    createdAt: raw.createdAt,
    ...(typeof raw.label === "string" ? { label: raw.label } : {}),
    repos,
  };
}

function readSnapshotFile(path: string, label: string): WorkspaceSnapshot {
  const text = readIfExists(path);
  if (text === undefined) {
    throw new AihError(`workspace hydrate could not read ${label}`, "AIH_WORKSPACE");
  }
  try {
    return parseWorkspaceSnapshot(parseJsoncText(text), label);
  } catch (err) {
    if (err instanceof AihError) throw err;
    throw new AihError(
      `workspace hydrate requires a valid ${label}: ${(err as Error).message}`,
      "AIH_WORKSPACE",
    );
  }
}

function readHydrateSnapshot(ctx: PlanContext, contextDir: string): WorkspaceSnapshot | undefined {
  if (contextDir === ".aih" || contextDir.startsWith(".aih/")) {
    throw new AihError(
      "workspace hydrate requires a committed context dir; .aih is runtime state",
      "AIH_WORKSPACE",
    );
  }
  const lockPath = join(ctx.root, contextDir, "workspace-lock.json");
  if (readIfExists(lockPath) !== undefined)
    return readSnapshotFile(lockPath, "workspace-lock.json");
  return undefined;
}

async function gitRead(
  ctx: PlanContext,
  repo: WorkspaceRepo,
  args: string[],
): Promise<string | undefined> {
  const result = await ctx.run(["git", "-C", join(ctx.root, repo.path), ...args]);
  if (result.spawnError || result.code !== 0) return undefined;
  return result.stdout.trim();
}

async function currentCheckout(ctx: PlanContext, repo: WorkspaceRepo): Promise<CurrentCheckout> {
  const [inside, branch, sha] = await Promise.all([
    gitRead(ctx, repo, ["rev-parse", "--is-inside-work-tree"]),
    gitRead(ctx, repo, ["rev-parse", "--abbrev-ref", "HEAD"]),
    gitRead(ctx, repo, ["rev-parse", "HEAD"]),
  ]);
  if (inside !== "true") return { inside: false };
  return {
    inside: true,
    ...(branch ? { branch } : {}),
    ...(sha ? { sha } : {}),
  };
}

async function childStatus(ctx: PlanContext, repo: WorkspaceRepo): Promise<string | undefined> {
  return gitRead(ctx, repo, ["status", "--porcelain"]);
}

function sameSource(source: HydrateSource, current: CurrentCheckout): boolean {
  if (source.ref === undefined) return true;
  if (source.refKind !== "sha" && current.branch === source.ref) return true;
  return source.refKind === "sha" && current.sha?.toLowerCase() === source.ref.toLowerCase();
}

function sourceFor(repo: WorkspaceRepo, snapshot: WorkspaceSnapshot | undefined): HydrateSource {
  const snap = snapshotSourceFor(repo, snapshot);
  const ref = snap.ref ?? repo.ref;
  return {
    remote: snap.remote ?? repo.remote,
    ref,
    ...(ref
      ? {
          refKind:
            snap.ref === ref ? (snap.refKind ?? "named") : isFullGitSha(ref) ? "sha" : "named",
        }
      : {}),
  };
}

function parentDirAction(ctx: PlanContext, repo: WorkspaceRepo): Action | undefined {
  const parent = dirname(repo.path).replace(/\\/g, "/");
  if (parent === "." || parent.length === 0) return undefined;
  return exec(
    `create parent directory for workspace child ${repo.path}`,
    [
      process.execPath,
      "-e",
      "require('node:fs').mkdirSync(process.argv[1], { recursive: true })",
      parent,
    ],
    { cwd: ctx.root },
  );
}

function cloneActions(ctx: PlanContext, repo: WorkspaceRepo, source: HydrateSource): Action[] {
  if (source.remote === undefined) {
    return [
      doc(
        "workspace hydrate skipped",
        `${repo.path}: no recorded remote; run \`aih workspace snapshot --lock --apply\` from a populated workspace or add remote metadata to .aih-workspace.json.`,
      ),
    ];
  }
  const actions: Action[] = [];
  assertWorkspaceChildCloneTarget(ctx.root, repo.path);
  const parentAction = parentDirAction(ctx, repo);
  if (parentAction !== undefined) actions.push(parentAction);
  const cloneArgv =
    source.ref === undefined
      ? ["git", "clone", "--", source.remote, repo.path]
      : source.refKind === "sha"
        ? ["git", "clone", "--no-checkout", "--", source.remote, repo.path]
        : ["git", "clone", "--branch", source.ref, "--", source.remote, repo.path];
  actions.push(
    exec(`clone workspace child ${repo.path}`, cloneArgv, { cwd: ctx.root, timeoutMs: 120_000 }),
  );
  if (source.ref !== undefined && source.refKind === "sha")
    actions.push(checkoutAction(ctx, repo, source.ref, source.refKind));
  return actions;
}

function checkoutAction(
  ctx: PlanContext,
  repo: WorkspaceRepo,
  ref: string,
  refKind: HydrateSource["refKind"] = "named",
): Action {
  const argv =
    refKind === "sha"
      ? ["git", "-C", join(ctx.root, repo.path), "checkout", "--detach", ref]
      : ["git", "-C", join(ctx.root, repo.path), "switch", ref];
  return exec(`checkout workspace child ${repo.path} at ${ref}`, argv);
}

async function hydrateRepo(
  ctx: PlanContext,
  repo: WorkspaceRepo,
  snapshot: WorkspaceSnapshot | undefined,
): Promise<Action[]> {
  const checked = checkWorkspaceChildPath(ctx.root, repo.path);
  const source = sourceFor(repo, snapshot);
  if (!checked.exists) return cloneActions(ctx, repo, source);
  if (!checked.git) {
    return [
      doc(
        "workspace hydrate skipped",
        `${repo.path}: present but not a git repo; move it aside or initialize it before hydrating.`,
      ),
    ];
  }
  const current = await currentCheckout(ctx, repo);
  if (!current.inside) {
    return [
      doc(
        "workspace hydrate skipped",
        `${repo.path}: git could not confirm this child is a worktree; refusing checkout.`,
      ),
    ];
  }
  if (sameSource(source, current)) return [];
  const status = await childStatus(ctx, repo);
  if (status === undefined) {
    return [
      doc(
        "workspace hydrate skipped",
        `${repo.path}: could not verify a clean working tree; refusing checkout.`,
      ),
    ];
  }
  if (status.length > 0) {
    return [
      doc(
        "workspace hydrate skipped",
        `${repo.path}: working tree is dirty; refusing to checkout ${source.ref ?? "recorded ref"}.`,
      ),
    ];
  }
  return source.ref === undefined ? [] : [checkoutAction(ctx, repo, source.ref, source.refKind)];
}

async function workspaceHydratePlan(ctx: PlanContext): Promise<ReturnType<typeof plan>> {
  const manifest = readWorkspaceManifest(ctx.root, ctx.contextDir);
  if (!manifest) {
    throw new AihError("workspace hydrate requires .aih-workspace.json", "AIH_WORKSPACE");
  }
  if (manifest.status === "ERROR") {
    throw new AihError(
      `workspace hydrate requires a valid .aih-workspace.json: ${manifest.errors.join("; ")}`,
      "AIH_WORKSPACE",
    );
  }
  const snapshot = readHydrateSnapshot(ctx, manifest.contextDir);
  const actions = (
    await mapWorkspaceRepos(manifest.repos, (repo) => hydrateRepo(ctx, repo, snapshot))
  ).flat();
  return plan("workspace hydrate", ...actions);
}

export const workspaceHydrateCommand: CommandSpec = {
  name: "hydrate",
  summary: "Clone or checkout declared child repos from recorded workspace metadata",
  plan: workspaceHydratePlan,
};
