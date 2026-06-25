import {
  type CommandSpec,
  doc,
  type PlanContext,
  plan,
  probe,
  writeJson,
} from "../internals/plan.js";
import type { Check } from "../internals/verify.js";
import { scanRepo } from "../profile/scan.js";
import { devcontainerConfig, managedSandboxSettings, worktreeGuidance } from "./templates.js";

const DEVCONTAINER_PATH = ".devcontainer/devcontainer.json";
const MANAGED_SETTINGS_PATH = ".claude/managed-settings.json";

/**
 * Read-only check that the local Docker daemon is reachable, via `docker info`.
 * Exit 0 → pass. A missing binary (`spawnError`) or a non-zero exit (daemon
 * down) is a `skip`, never a `fail`: the harness does not own the developer's
 * Docker install, so its absence must not fail a verification run.
 */
async function dockerAvailable(ctx: PlanContext): Promise<Check> {
  const name = "docker available";
  const res = await ctx.run(["docker", "info"]);
  if (res.spawnError) {
    return { name, verdict: "skip", detail: "docker not found on PATH" };
  }
  if (res.code !== 0) {
    return { name, verdict: "skip", detail: "docker daemon not reachable" };
  }
  return { name, verdict: "pass", detail: "docker info exited 0" };
}

function sandboxPlan(ctx: PlanContext) {
  const stack = scanRepo(ctx.root, { maxDepth: 8, contextDir: ctx.contextDir });
  return plan(
    "sandbox",
    writeJson(
      DEVCONTAINER_PATH,
      devcontainerConfig({ contextDir: ctx.contextDir, stack }),
      "Generate a stack-aware devcontainer (installs the detected toolchain — Node/AWS CLI/Python — and runs the real dependency install)",
    ),
    writeJson(
      MANAGED_SETTINGS_PATH,
      managedSandboxSettings(stack),
      "Enforce Claude sandbox policy (failIfUnavailable, allowUnsandboxedCommands=false, egress allowlist incl. detected cloud) — merged into existing managed settings",
      { merge: true },
    ),
    doc(
      "Isolate agent runs with git worktrees and project edits back to the host",
      worktreeGuidance(),
    ),
    probe("docker available", dockerAvailable),
  );
}

export const command: CommandSpec = {
  name: "sandbox",
  summary: "Generate devcontainer + managed sandbox settings (allowlist, failIfUnavailable)",
  options: [
    {
      flags: "--worktree <name>",
      description: "scope the sandbox to a single git worktree under .claude/worktrees",
    },
  ],
  plan: sandboxPlan,
};
