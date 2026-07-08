import { AihError } from "../errors.js";
import { isTargeted } from "../internals/cli-detect.js";
import {
  type Action,
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
  if (typeof ctx.options.worktree === "string" && ctx.options.worktree.trim().length > 0) {
    throw new AihError(
      "--worktree is not implemented yet; run sandbox from the target worktree root instead",
      "AIH_CONFIG",
    );
  }
  const stack = scanRepo(ctx.root, { maxDepth: 8, contextDir: ctx.contextDir });
  const actions: Action[] = [
    // The devcontainer is tool-agnostic (it provisions the toolchain for any agent),
    // so it is always written.
    writeJson(
      DEVCONTAINER_PATH,
      devcontainerConfig({ contextDir: ctx.contextDir, stack }),
      "Generate a stack-aware devcontainer (installs the detected toolchain — Node/AWS CLI/Python — and runs the real dependency install)",
    ),
  ];

  // `.claude/managed-settings.json` enforces Claude's sandbox policy specifically —
  // under `aih init` it lands only when Claude is a target (standalone `aih sandbox`
  // always writes).
  if (isTargeted(ctx, "claude")) {
    actions.push(
      writeJson(
        MANAGED_SETTINGS_PATH,
        managedSandboxSettings(stack),
        "Enforce Claude sandbox policy (failIfUnavailable, allowUnsandboxedCommands=false, egress allowlist incl. detected cloud) — merged into existing managed settings",
        { merge: true },
      ),
    );
  }

  actions.push(
    doc(
      "Isolate agent runs with git worktrees and project edits back to the host",
      worktreeGuidance(),
    ),
    probe("docker available", dockerAvailable),
  );
  return plan("sandbox", ...actions);
}

export const command: CommandSpec = {
  name: "sandbox",
  summary: "Generate devcontainer + managed sandbox settings (allowlist, failIfUnavailable)",
  options: [
    {
      flags: "--worktree <name>",
      description: "reserved; currently fails closed, run from the target worktree root instead",
    },
  ],
  plan: sandboxPlan,
};
