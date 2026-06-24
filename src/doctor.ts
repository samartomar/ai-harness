import { existsSync } from "node:fs";
import { join } from "node:path";
import { detectClis, presentClis } from "./internals/cli-detect.js";
import { readIfExists } from "./internals/fsxn.js";
import { type Action, type CommandSpec, type PlanContext, plan, probe } from "./internals/plan.js";

/** Read the workspace marker's repo list, or [] when this root is not a workspace. */
function workspaceRepos(ctx: PlanContext): string[] {
  const raw = readIfExists(join(ctx.root, ".aih-workspace.json"));
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    const repos = (parsed as { repos?: unknown }).repos;
    return Array.isArray(repos) ? repos.filter((r): r is string => typeof r === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Fail-closed preflight. Returns probe actions; the read-only command path forces
 * `verify`, so probes run and the verification report drives the exit code. A
 * `skip` (tool/artifact absent) never fails the run — only a hard `fail` does. In a
 * multi-repo workspace root (a `.aih-workspace.json` marker), it also validates
 * that each child repo has been scaffolded.
 */
export const command: CommandSpec = {
  name: "doctor",
  summary: "Verify the harness / workstation / repo configuration (fail-closed)",
  readOnly: true,
  options: [],
  plan: (ctx) => {
    const base: Action[] = [
      probe("node runtime >= 20", () => {
        const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
        return major >= 20
          ? { name: "node-version", verdict: "pass", detail: `node ${process.versions.node}` }
          : { name: "node-version", verdict: "fail", detail: `node ${process.versions.node} < 20` };
      }),
      probe("git available", async () => {
        const res = await ctx.run(["git", "--version"]);
        return res.spawnError
          ? { name: "git", verdict: "skip", detail: "git not found on PATH" }
          : { name: "git", verdict: "pass", detail: res.stdout.trim() };
      }),
      probe("platform adapter", () => ({
        name: "platform",
        verdict: ctx.host.verified ? "pass" : "skip",
        detail: `${ctx.host.platform}${ctx.host.verified ? " (verified)" : " (unverified path)"}`,
      })),
      probe("canonical context dir", () => {
        const dir = join(ctx.root, ctx.contextDir);
        return existsSync(dir)
          ? { name: "context-dir", verdict: "pass", detail: dir }
          : {
              name: "context-dir",
              verdict: "skip",
              detail: `${ctx.contextDir} not scaffolded — run: aih scaffold --apply`,
            };
      }),
      probe("AI CLIs detected", async () => {
        const present = presentClis(await detectClis(ctx));
        return present.length > 0
          ? { name: "ai-clis", verdict: "pass", detail: present.join(", ") }
          : {
              name: "ai-clis",
              verdict: "skip",
              detail: "none detected — target explicitly with --cli or --all-tools",
            };
      }),
    ];

    // Workspace mode: validate each child repo is scaffolded.
    const repos = workspaceRepos(ctx);
    const wsProbes: Action[] = repos.map((repo) =>
      probe(`workspace child ${repo} scaffolded`, () => {
        const present = existsSync(join(ctx.root, repo, ctx.contextDir, "RULE_ROUTER.md"));
        return present
          ? {
              name: `child:${repo}`,
              verdict: "pass",
              detail: `${repo}/${ctx.contextDir}/ canon present`,
            }
          : {
              name: `child:${repo}`,
              verdict: "skip",
              detail: `not scaffolded — run \`aih init ./${repo} --apply\``,
            };
      }),
    );

    return plan("doctor", ...base, ...wsProbes);
  },
};
