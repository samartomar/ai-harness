import { existsSync } from "node:fs";
import { basename, join, posix } from "node:path";
import type { Action, CommandSpec, Plan, PlanContext } from "../internals/plan.js";
import { doc, plan, probe, writeJson, writeText } from "../internals/plan.js";
import type { Check } from "../internals/verify.js";
import { detectChildRepos, reposOption } from "./detect.js";
import {
  codeWorkspace,
  crossRepoArchitectureDoc,
  nextStepsDoc,
  repoDisciplineDoc,
  spanningMcp,
  workspaceBootloader,
  workspaceMarker,
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
 * multi-root `.code-workspace`, a filesystem MCP spanning every child repo, the
 * `cross-repo-architecture.md` map (write-once, user-owned) and `repo-discipline.md`,
 * and thin `CLAUDE.md`/`AGENTS.md` workspace bootloaders. It does NOT touch the
 * child repos — run `aih init` in each. Child repos come from `--repos a,b` or are
 * auto-detected (immediate subdirs with a `.git`). Honors `--context-dir`.
 */
function workspacePlan(ctx: PlanContext): Plan {
  const dir = ctx.contextDir;
  const name = basename(ctx.root) || "workspace";
  const repos = detectChildRepos(ctx.root, reposOption(ctx.options.repos));

  const actions: Action[] = [
    writeJson(
      ".aih-workspace.json",
      workspaceMarker(repos, dir),
      `workspace marker (multi-repo: ${repos.length > 0 ? repos.join(", ") : "no repos detected"})`,
      { merge: true },
    ),
    writeJson(`${name}.code-workspace`, codeWorkspace(repos), "VS Code multi-root workspace", {
      merge: true,
    }),
    writeText(
      posix.join(dir, "cross-repo-architecture.md"),
      crossRepoArchitectureDoc(name, repos, dir),
      "cross-repo architecture + feature map (write-once — you own it)",
      { once: true },
    ),
    writeText(
      posix.join(dir, "repo-discipline.md"),
      repoDisciplineDoc(repos, dir),
      "per-repo discipline routing (read a repo's canon before editing it)",
    ),
    writeText(
      "CLAUDE.md",
      workspaceBootloader("Claude workspace", name, repos, dir),
      "Claude workspace bootloader → cross-repo canon",
    ),
    writeText(
      "AGENTS.md",
      workspaceBootloader("agent workspace", name, repos, dir),
      "AGENTS.md workspace bootloader (Codex/Kiro/… ) → cross-repo canon",
    ),
    writeJson(
      ".mcp.json",
      spanningMcp(repos),
      `filesystem MCP spanning ${repos.length} child repo(s), merged into any existing .mcp.json`,
      { merge: true },
    ),
    doc("workspace next steps (run `aih init` per child)", nextStepsDoc(name, repos, dir)),
  ];

  for (const repo of repos) actions.push(childScaffoldedProbe(repo, dir));

  return plan("workspace", ...actions);
}

export const command: CommandSpec = {
  name: "workspace",
  summary:
    "Scaffold a multi-repo workspace: cross-repo architecture map, spanning MCP, .code-workspace (parent-only)",
  options: [
    {
      flags: "--repos <list>",
      description: "child repos (comma-separated); else auto-detect *//.git",
    },
  ],
  plan: workspacePlan,
};
