import { existsSync } from "node:fs";
import { basename, join, posix, resolve } from "node:path";
import { AihError } from "../errors.js";
import type { Action, CommandSpec, Plan, PlanContext, WriteAction } from "../internals/plan.js";
import { doc, plan, probe, writeJson, writeText } from "../internals/plan.js";
import type { Check } from "../internals/verify.js";
import { checkWorkspaceChildPath, detectChildRepos, reposOption } from "./detect.js";
import { workspaceGitExecs, workspaceGitignoreWrite } from "./git.js";
import { readWorkspaceManifest, workspaceReposFromPaths } from "./manifest.js";
import { snapshotCommand } from "./snapshot.js";
import { taskPlanCommand } from "./task-plan.js";
import {
  codeWorkspace,
  crossRepoArchitectureDoc,
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
    const present = existsSync(join(ctx.root, repo, dir, "RULE_ROUTER.md"));
    return present
      ? { name, verdict: "pass", detail: `${repo}/${dir}/ canon present` }
      : { name, verdict: "skip", detail: `not scaffolded — run \`aih init ./${repo} --apply\`` };
  });
}

/**
 * `aih workspace <parent>` — scaffold a MULTI-REPO workspace (parent-only). For a
 * parent folder holding separate repos (e.g. a UI repo and a backend repo), it
 * writes the cross-repo canon that bridges them: a workspace marker, a VS Code
 * multi-root `.code-workspace`, a combined graph + filesystem MCP spanning every child repo, the
 * `cross-repo-architecture.md` map (write-once, user-owned) and `repo-discipline.md`,
 * and thin `CLAUDE.md`/`AGENTS.md` workspace bootloaders. It does NOT touch the
 * child repos — run `aih init` in each. Child repos come from `--repos a,b` or are
 * auto-detected (immediate subdirs with a `.git`). Honors `--context-dir`.
 */
async function workspacePlan(ctx: PlanContext): Promise<Plan> {
  const dir = ctx.contextDir;
  // resolve() first: basename(".") is "." which would plan a "..code-workspace"
  // write that the executor's containment guard rejects as a parent escape.
  const name = basename(resolve(ctx.root)) || "workspace";
  const explicitRepos = reposOption(ctx.options.repos);
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
    : workspaceReposFromPaths(repos, posix.join(dir, "RULE_ROUTER.md"));
  for (const repo of normalizedRepos) checkWorkspaceChildPath(ctx.root, repo.path);
  const repoPaths = normalizedRepos.map((repo) => repo.path);
  const edges = existing?.edges ?? [];

  const writes: WriteAction[] = [
    writeJson(
      ".aih-workspace.json",
      useExistingRepos
        ? { ...existing.raw, ...(enableGit ? { git: true } : {}) }
        : workspaceMarker(repos, dir, enableGit),
      `workspace marker (multi-repo: ${repoPaths.length > 0 ? repoPaths.join(", ") : "no repos detected"})`,
      { merge: true },
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
    writeText(
      "CLAUDE.md",
      workspaceBootloader("Claude workspace", name, repoPaths, dir),
      "Claude workspace bootloader → cross-repo canon",
    ),
    writeText(
      "AGENTS.md",
      workspaceBootloader("agent workspace", name, repoPaths, dir),
      "AGENTS.md workspace bootloader (Codex/Kiro/… ) → cross-repo canon",
    ),
    writeJson(
      ".mcp.json",
      spanningMcp(repoPaths, (ctx.env.AIH_MCP_FS_VERSION ?? "").trim() || undefined),
      `combined graph + filesystem MCP spanning ${repoPaths.length} child repo(s), merged into any existing .mcp.json`,
      { merge: true },
    ),
  ];
  if (enableGit) writes.push(workspaceGitignoreWrite(ctx.root, repoPaths));

  const actions: Action[] = [
    ...writes,
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
    "Scaffold a multi-repo workspace: cross-repo map, combined graph/filesystem MCP, .code-workspace (parent-only)",
  options: [
    {
      flags: "--repos <list>",
      description: "child repos (comma-separated); else auto-detect *//.git",
    },
    {
      flags: "--git",
      description:
        "initialize a local git repo for workspace coordination files; remote setup remains user-owned",
    },
  ],
  plan: workspacePlan,
};

export { snapshotCommand, taskPlanCommand };
