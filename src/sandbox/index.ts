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
import { verifiedOrgPolicyProjection } from "../org-policy/project.js";
import { readOrgPolicy } from "../org-policy/schema.js";
import { scanRepo } from "../profile/scan.js";
import { openCodeSandboxActions, openCodeSandboxAssertions } from "./opencode.js";
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
    expect: {
      sha256: createHash("sha256").update(source, "utf8").digest("hex"),
    },
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

async function sandboxPlan(ctx: PlanContext) {
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
            ? {
                removeJsonKeys: { sandbox: ["allowedDomains"] },
                expect: legacy.expect,
              }
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
  let verifiedProjection: Awaited<ReturnType<typeof verifiedOrgPolicyProjection>> | undefined;
  if (ctx.options.launch === true) {
    const policy = readOrgPolicy(ctx.root, ctx.env);
    if (policy === undefined) {
      throw new AihError(
        "OpenCode sandbox launch requires its persisted organization policy",
        "AIH_CONFIG",
      );
    }
    verifiedProjection = await verifiedOrgPolicyProjection(
      { ...ctx, targets: ["opencode"] },
      policy,
    );
    actions.push(...verifiedProjection.actions);
  }
  actions.push(...openCodeSandboxActions(ctx));
  return {
    ...plan("sandbox", ...actions),
    ...(ctx.options.launch !== true && verifiedProjection?.fileAssertions === undefined
      ? {}
      : {
          fileAssertions: [
            ...(verifiedProjection?.fileAssertions ?? []),
            ...(ctx.options.launch === true ? openCodeSandboxAssertions(ctx.root) : []),
          ],
        }),
    ...(verifiedProjection?.commitNotAfter === undefined
      ? {}
      : { commitNotAfter: verifiedProjection.commitNotAfter }),
    ...(verifiedProjection?.commitLock === undefined
      ? {}
      : { commitLock: verifiedProjection.commitLock }),
  };
}

export const command: CommandSpec = {
  name: "sandbox",
  summary: "Generate managed sandbox settings or configure and launch OpenCode on Linux",
  options: [
    {
      flags: "--worktree <name>",
      description: "reserved; currently fails closed, run from the target worktree root instead",
    },
    {
      flags: "--binding <NAME=value>",
      description: "persist one non-secret OpenCode environment binding for fresh launches",
      repeatable: true,
    },
    {
      flags: "--hide-path <absolute-path>",
      description: "hide one existing host file or directory from OpenCode",
      repeatable: true,
    },
    {
      flags: "--read-only-path <absolute-path>",
      description: "keep one existing host path read-only inside OpenCode",
      repeatable: true,
    },
    {
      flags: "--client-arg <arg>",
      description: "persist one OpenCode argument for fresh launches",
      repeatable: true,
    },
    {
      flags: "--bwrap-executable <absolute-path>",
      description: "external pinned bubblewrap executable for this Linux sandbox",
    },
    {
      flags: "--opencode-executable <absolute-path>",
      description: "external pinned OpenCode executable for this Linux sandbox",
    },
    {
      flags: "--seccomp-executable <absolute-path>",
      description: "external pinned apply-seccomp executable for this Linux sandbox",
    },
    {
      flags: "--launch",
      description: "launch OpenCode through this root's persisted Linux sandbox profile",
    },
  ],
  plan: sandboxPlan,
};
