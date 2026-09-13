import { createHash } from "node:crypto";
import { join } from "node:path";
import { AihError } from "../errors.js";
import { isTargeted } from "../internals/cli-detect.js";
import { readIfExists } from "../internals/fsxn.js";
import { isPlainObject, parseJsoncText } from "../internals/merge.js";
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
import {
  devcontainerConfig,
  managedSandboxSettings,
  sandboxAllowedDomains,
  worktreeGuidance,
} from "./templates.js";

const DEVCONTAINER_PATH = ".devcontainer/devcontainer.json";
const MANAGED_SETTINGS_PATH = ".claude/managed-settings.json";

function matchesLegacyAllowedDomains(value: unknown, expected: readonly string[]): boolean {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((domain, index) => domain === expected[index])
  );
}

function legacyAllowedDomainsMigration(ctx: PlanContext, expected: readonly string[]) {
  const source = readIfExists(join(ctx.root, MANAGED_SETTINGS_PATH));
  if (source === undefined) return { kind: "absent" as const };

  let parsed: unknown;
  try {
    parsed = parseJsoncText(source);
  } catch {
    return { kind: "unreadable" as const };
  }
  if (
    !isPlainObject(parsed) ||
    !isPlainObject(parsed.sandbox) ||
    !Object.hasOwn(parsed.sandbox, "allowedDomains")
  ) {
    return { kind: "absent" as const };
  }
  if (!matchesLegacyAllowedDomains(parsed.sandbox.allowedDomains, expected)) {
    return { kind: "custom" as const };
  }
  return {
    kind: "generated" as const,
    expect: { sha256: createHash("sha256").update(source, "utf8").digest("hex") },
  };
}

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

  // This Claude policy artifact needs deployment through a host-supported settings
  // source. Under `aih init` it lands only when Claude is a target (standalone
  // `aih sandbox` always writes it).
  if (isTargeted(ctx, "claude")) {
    const legacy = legacyAllowedDomainsMigration(ctx, sandboxAllowedDomains(stack));
    actions.push(
      writeJson(
        MANAGED_SETTINGS_PATH,
        managedSandboxSettings(stack),
        "Generate Claude sandbox policy (failIfUnavailable, allowUnsandboxedCommands=false, network egress allowlist incl. detected cloud) — merged into existing managed settings; loading/enforcement requires the host's managed-settings deployment",
        {
          merge: true,
          ...(legacy.kind === "generated"
            ? { removeJsonKeys: { sandbox: ["allowedDomains"] }, expect: legacy.expect }
            : {}),
        },
      ),
    );
    if (legacy.kind === "custom") {
      actions.push(
        doc(
          "Review obsolete Claude sandbox allowedDomains setting",
          "`.claude/managed-settings.json` retains a customized legacy `sandbox.allowedDomains` setting. AIH now generates `sandbox.network.allowedDomains`; review and remove the obsolete legacy field if it is no longer needed.",
        ),
      );
    }
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
