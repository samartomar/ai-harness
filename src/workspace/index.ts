import { existsSync } from "node:fs";
import { basename, join, posix, resolve } from "node:path";
import { AihError } from "../errors.js";
import { bootloadersFor } from "../internals/cli-registry.js";
import { resolveClis } from "../internals/clis.js";
import { readIfExists } from "../internals/fsxn.js";
import type { Action, CommandSpec, Plan, PlanContext, WriteAction } from "../internals/plan.js";
import { doc, plan, probe, writeJson, writeText } from "../internals/plan.js";
import type { Check } from "../internals/verify.js";
import {
  checkWorkspaceChildPath,
  detectChildRepos,
  discoverChildGitRepos,
  reposOption,
} from "./detect.js";
import { workspaceGitExecs, workspaceGitignoreWrite } from "./git.js";
import { workspaceHydrateCommand } from "./hydrate.js";
import {
  readWorkspaceManifest,
  type WorkspaceManifest,
  type WorkspaceRepo,
  workspaceReposFromPaths,
} from "./manifest.js";
import { snapshotCommand } from "./snapshot.js";
import { taskPlanCommand } from "./task-plan.js";
import {
  codeWorkspace,
  crossRepoArchitectureDoc,
  isLegacyAihWorkspaceMcpServer,
  nextStepsDoc,
  repoDisciplineDoc,
  spanningMcp,
  workspaceBootloader,
  workspaceContractsDoc,
  workspaceMarker,
  workspaceRouterDoc,
} from "./templates.js";

/** Probe: is the child repo scaffolded (its canon present)? Absent → skip with the fix. */
function childScaffoldedProbe(repo: string, dir: string): Action {
  return probe(`child ${repo} scaffolded`, (ctx: PlanContext): Check => {
    const name = `child ${repo} scaffolded`;
    const repoRoot = join(ctx.root, repo);
    if (!existsSync(repoRoot)) {
      return {
        name,
        verdict: "skip",
        detail:
          "child repo path is missing — run `aih workspace hydrate --apply` or create the child repo",
      };
    }
    const present = existsSync(join(repoRoot, dir, "RULE_ROUTER.md"));
    return present
      ? { name, verdict: "pass", detail: `${repo}/${dir}/ canon present` }
      : {
          name,
          verdict: "skip",
          detail: "not scaffolded — run `aih init --apply` inside the child repo",
        };
  });
}

function staleManagedMcpServerKeys(root: string, incomingKeys: readonly string[]): string[] {
  const text = readIfExists(resolve(root, ".mcp.json"));
  if (text === undefined) return [];
  try {
    const parsed = JSON.parse(text) as { mcpServers?: unknown };
    if (
      typeof parsed.mcpServers !== "object" ||
      parsed.mcpServers === null ||
      Array.isArray(parsed.mcpServers)
    ) {
      return [];
    }
    const incoming = new Set(incomingKeys);
    return Object.entries(parsed.mcpServers)
      .filter(([name]) => !incoming.has(name))
      .filter(([name, value]) => isLegacyAihWorkspaceMcpServer(name, value))
      .map(([name]) => name);
  } catch {
    return [];
  }
}

function repoObjectEntriesByPath(manifest: WorkspaceManifest | undefined): Map<string, unknown> {
  const out = new Map<string, unknown>();
  const rawRepos = manifest?.raw.repos;
  if (manifest === undefined || !Array.isArray(rawRepos)) return out;
  manifest.repos.forEach((repo, index) => {
    const raw = rawRepos[index];
    if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
      out.set(repo.path, raw);
    }
  });
  return out;
}

function reposFromPathsWithExistingMetadata(
  paths: readonly string[],
  manifest: WorkspaceManifest | undefined,
  router: string,
): WorkspaceRepo[] {
  const generated = workspaceReposFromPaths(paths, router);
  if (manifest === undefined) return generated;
  const byPath = new Map(manifest.repos.map((repo) => [repo.path, repo]));
  return generated.map((repo) => byPath.get(repo.path) ?? repo);
}

function repoMarkerEntry(repo: WorkspaceRepo): string | WorkspaceRepo {
  return repo.kind !== undefined || repo.remote !== undefined || repo.ref !== undefined
    ? repo
    : repo.path;
}

function markerRepoEntries(
  manifest: WorkspaceManifest | undefined,
  repos: readonly WorkspaceRepo[],
): unknown[] {
  const existingObjects = repoObjectEntriesByPath(manifest);
  if (existingObjects.size === 0) return repos.map(repoMarkerEntry);
  return repos.map((repo) => existingObjects.get(repo.path) ?? repo);
}

function markerForWrite(
  manifest: WorkspaceManifest | undefined,
  repos: readonly WorkspaceRepo[],
  dir: string,
  enableGit: boolean,
): unknown {
  const repoPaths = repos.map((repo) => repo.path);
  const marker = workspaceMarker(repoPaths, dir, enableGit) as Record<string, unknown>;
  if (manifest === undefined) return marker;
  return {
    ...manifest.raw,
    ...marker,
    repos: markerRepoEntries(manifest, repos),
    ...(enableGit ? { git: true } : {}),
  };
}

const WORKSPACE_BOOTLOADER_LABELS: Record<string, string> = {
  "CLAUDE.md": "Claude workspace",
  "AGENTS.md": "AGENTS.md workspace",
  "GEMINI.md": "Gemini workspace",
  ".kiro/steering/00-canon.md": "Kiro workspace",
};

function workspaceBootloaderLabel(path: string): string {
  return WORKSPACE_BOOTLOADER_LABELS[path] ?? `${path} workspace`;
}

function workspaceBootloaderWrites(
  bootloaders: readonly string[],
  name: string,
  repoPaths: readonly string[],
  dir: string,
): WriteAction[] {
  return bootloaders.map((path) =>
    writeText(
      path,
      workspaceBootloader(workspaceBootloaderLabel(path), name, [...repoPaths], dir),
      `${path} workspace bootloader → cross-repo canon`,
    ),
  );
}

/**
 * `aih workspace <parent>` — scaffold a MULTI-REPO workspace (parent-only). For a
 * parent folder holding separate repos (e.g. a UI repo and a backend repo), it
 * writes the cross-repo canon that bridges them: a workspace marker, a VS Code
 * multi-root `.code-workspace`, graph MCP scoped per declared child repo, the
 * `cross-repo-architecture.md` map (write-once, user-owned) and `repo-discipline.md`,
 * and tool-native workspace bootloaders. It does NOT touch the
 * child repos — run `aih init` in each. Child repos come from `--repos a,b` or an
 * existing workspace marker; detected child git repos are reported but not auto-enrolled.
 * Honors `--context-dir`.
 */
async function workspacePlan(ctx: PlanContext): Promise<Plan> {
  const dir = ctx.contextDir;
  // resolve() first: basename(".") is "." which would plan a "..code-workspace"
  // write that the executor's containment guard rejects as a parent escape.
  const name = basename(resolve(ctx.root)) || "workspace";
  const explicitRepos = reposOption(ctx.options.repos);
  const discoveredRepos = explicitRepos.length === 0 ? discoverChildGitRepos(ctx.root) : [];
  const repos = detectChildRepos(ctx.root, explicitRepos);
  const enableGit = ctx.options.git === true;
  const existing = readWorkspaceManifest(ctx.root, dir);
  if (existing?.status === "ERROR") {
    throw new AihError(
      `workspace requires a valid .aih-workspace.json: ${existing.errors.join("; ")}`,
      "AIH_WORKSPACE",
    );
  }
  const useExistingRepos = explicitRepos.length === 0 && existing && existing.repos.length > 0;
  const normalizedRepos = useExistingRepos
    ? existing.repos
    : reposFromPathsWithExistingMetadata(repos, existing, posix.join(dir, "RULE_ROUTER.md"));
  const repoChecks = normalizedRepos.map((repo) => ({
    repo,
    check: checkWorkspaceChildPath(ctx.root, repo.path),
  }));
  const repoPaths = normalizedRepos.map((repo) => repo.path);
  const presentRepoPaths = repoChecks
    .filter(({ check }) => check.exists)
    .map(({ repo }) => repo.path);
  const absentRepoPaths = repoChecks
    .filter(({ check }) => !check.exists)
    .map(({ repo }) => repo.path);
  const edges = existing?.edges ?? [];
  const mcp = spanningMcp(ctx.root, presentRepoPaths);
  const mcpKeys = Object.keys(mcp.mcpServers);
  const staleMcpKeys = staleManagedMcpServerKeys(ctx.root, mcpKeys);
  const bootloaders = bootloadersFor(resolveClis(ctx.options, { strict: true }));

  const writes: WriteAction[] = [
    writeJson(
      ".aih-workspace.json",
      markerForWrite(existing, normalizedRepos, dir, enableGit),
      `workspace marker (multi-repo: ${repoPaths.length > 0 ? repoPaths.join(", ") : "no repos declared"})`,
    ),
    writeJson(`${name}.code-workspace`, codeWorkspace(repoPaths), "VS Code multi-root workspace", {
      merge: true,
    }),
    writeText(
      posix.join(dir, "workspace-router.md"),
      workspaceRouterDoc(normalizedRepos),
      "workspace router (federated child repo table of contents)",
    ),
    writeText(
      posix.join(dir, "workspace-contracts.md"),
      workspaceContractsDoc(edges),
      "workspace contracts (parent-owned cross-repo dependency index)",
    ),
    writeText(
      posix.join(dir, "cross-repo-architecture.md"),
      crossRepoArchitectureDoc(name, repoPaths, dir),
      "cross-repo architecture + feature map (write-once — you own it)",
      { once: true },
    ),
    writeText(
      posix.join(dir, "repo-discipline.md"),
      repoDisciplineDoc(repoPaths, dir),
      "per-repo discipline routing (read a repo's canon before editing it)",
    ),
    ...workspaceBootloaderWrites(bootloaders, name, repoPaths, dir),
    writeJson(
      ".mcp.json",
      mcp,
      `workspace graph MCP scoped to ${repoPaths.length} declared child repo(s), merged into any existing .mcp.json`,
      {
        merge: true,
        replaceJsonChildKeys: { mcpServers: mcpKeys },
        ...(staleMcpKeys.length > 0
          ? { pruneJsonChildKeys: { mcpServers: { exact: staleMcpKeys } } }
          : {}),
      },
    ),
  ];
  if (enableGit) writes.push(workspaceGitignoreWrite(ctx.root, repoPaths));

  const actions: Action[] = [
    ...writes,
    ...(explicitRepos.length === 0 && !useExistingRepos && discoveredRepos.length > 0
      ? [
          doc(
            "workspace auto-enroll skipped",
            [
              "Child git repos were detected but not enrolled automatically.",
              "",
              "Detected candidates:",
              ...discoveredRepos.map((repo) => `- ${repo}`),
              "",
              "Re-run with an explicit allowlist, for example:",
              "aih workspace --repos <comma-separated-child-repos> --apply",
            ].join("\n"),
          ),
        ]
      : []),
    ...(absentRepoPaths.length > 0
      ? [
          doc(
            "workspace child repo absent",
            [
              "Declared child repo paths are missing, so aih skipped their workspace graph MCP scope.",
              "",
              "Missing children:",
              ...absentRepoPaths.map((repo) => `- ${repo}/`),
              "",
              "Run `aih workspace hydrate --apply` to restore committed children, or create the child repo before relying on workspace MCP.",
            ].join("\n"),
          ),
        ]
      : []),
    doc(
      "workspace next steps (run `aih init` per child)",
      nextStepsDoc(name, repoPaths, dir, enableGit),
    ),
    ...(enableGit ? await workspaceGitExecs(ctx, writes) : []),
  ];

  for (const repo of repoPaths) actions.push(childScaffoldedProbe(repo, dir));

  return plan("workspace", ...actions);
}

export const command: CommandSpec = {
  name: "workspace",
  summary:
    "Scaffold a multi-repo workspace: cross-repo map, declared-repo graph MCP, .code-workspace (parent-only)",
  options: [
    {
      flags: "--repos <list>",
      description: "explicit child repo allowlist (comma-separated)",
    },
    {
      flags: "--git",
      description:
        "initialize a local git repo for workspace coordination files; remote setup remains user-owned",
    },
  ],
  plan: workspacePlan,
};

export { snapshotCommand, taskPlanCommand, workspaceHydrateCommand };
