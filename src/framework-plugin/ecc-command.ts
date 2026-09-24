import { AihError } from "../errors.js";
import type { PlanResult } from "../internals/execute.js";
import type { CommandSpec, PlanContext } from "../internals/plan.js";
import { verifiedOrgPolicyTargets } from "../org-policy/project.js";
import { FRAMEWORK_PLUGIN_PACKAGE_NAMES, type FrameworkCommandPathV1 } from "./contract-v1.js";
import {
  executeFrameworkCommandV1,
  type FrameworkCommandDepsV1,
  type FrameworkInvocationV1,
  type FrameworkPolicyDeliveryV1,
  prepareFrameworkPolicyDeliveryV1,
  requireFrameworkPluginV1,
} from "./run-framework-command.js";

/**
 * `aih ecc` and `aih ecc mcp add|remove` — Core keeps the command surface
 * (names, summaries, options) and the invocation's decisions: the policy
 * targets and the policy custody pins its runtime forces into every
 * transaction. Everything ECC-specific runs in `@aihq/framework-ecc`, against
 * the Core runtime bound to the invocation; without the plugin these commands
 * refuse with `framework-plugin-unavailable` and name the install command.
 */

const PACKAGE = FRAMEWORK_PLUGIN_PACKAGE_NAMES.ecc;

function runsThroughPlugin(path: FrameworkCommandPathV1<"ecc">): CommandSpec["plan"] {
  return () => {
    throw new AihError(
      `aih ${path} runs through ${PACKAGE} and Core's runtime; it has no standalone plan`,
      "AIH_FRAMEWORK_PLUGIN",
    );
  };
}

/** Core's decisions for one ECC invocation: the policy targets and custody pins. */
async function eccInvocation(ctx: PlanContext): Promise<FrameworkInvocationV1> {
  const policyTargets = await verifiedOrgPolicyTargets(ctx);
  return {
    ctx: { ...ctx, targets: policyTargets.resolution.clis },
    policy: policyTargets.policy,
    transactionPins: {
      ...(policyTargets.fileAssertions === undefined
        ? {}
        : { fileAssertions: policyTargets.fileAssertions }),
      ...(policyTargets.commitNotAfter === undefined
        ? {}
        : { commitNotAfter: policyTargets.commitNotAfter }),
      ...(policyTargets.commitLock === undefined ? {} : { commitLock: policyTargets.commitLock }),
    },
    options: ctx.options,
  };
}

async function executeEccPath(
  path: FrameworkCommandPathV1<"ecc">,
  ctx: PlanContext,
  deps: FrameworkCommandDepsV1,
): Promise<PlanResult> {
  const loaded = await requireFrameworkPluginV1("ecc", deps);
  return executeFrameworkCommandV1(loaded, path, await eccInvocation(ctx), deps);
}

/**
 * Prepare the ECC delivery organization policy requires (`aih policy project`,
 * `aih init` on a bound project) as an ECC install. The caller commits it after
 * its own projection, or not, and always ends it.
 */
export async function prepareEccPolicyDelivery(
  ctx: PlanContext,
  deps: FrameworkCommandDepsV1 = {},
): Promise<FrameworkPolicyDeliveryV1> {
  const loaded = await requireFrameworkPluginV1("ecc", deps);
  const install = { ...ctx, options: { ...ctx.options, lifecycle: "install" } };
  return prepareFrameworkPolicyDeliveryV1(loaded, await eccInvocation(install), deps);
}

export function executeEccCommand(
  ctx: PlanContext,
  deps: FrameworkCommandDepsV1 = {},
): Promise<PlanResult> {
  return executeEccPath("ecc", ctx, deps);
}

export function executeEccMcpAddCommand(
  ctx: PlanContext,
  deps: FrameworkCommandDepsV1 = {},
): Promise<PlanResult> {
  return executeEccPath("ecc mcp add", ctx, deps);
}

export function executeEccMcpRemoveCommand(
  ctx: PlanContext,
  deps: FrameworkCommandDepsV1 = {},
): Promise<PlanResult> {
  return executeEccPath("ecc mcp remove", ctx, deps);
}

export const eccMcpAddCommand: CommandSpec = {
  name: "add",
  summary: "Add one policy-approved ECC HTTPS MCP to one selected CLI configuration",
  positional: { name: "id", required: true, optionName: "id", description: "ECC MCP id" },
  plan: runsThroughPlugin("ecc mcp add"),
};

export const eccMcpRemoveCommand: CommandSpec = {
  name: "remove",
  summary: "Remove one receipt-owned ECC HTTPS MCP from one selected CLI configuration",
  positional: { name: "id", required: true, optionName: "id", description: "ECC MCP id" },
  plan: runsThroughPlugin("ecc mcp remove"),
};

export const command: CommandSpec = {
  name: "ecc",
  summary: "Install affaan-m/ECC from an evidence-verified exact source pin for the selected CLIs",
  options: [
    {
      flags: "--profile <profile>",
      description: "ECC install profile: minimal|core|full",
      default: "minimal",
    },
    {
      flags: "--with <component>",
      description: "add an ECC component declaration (repeatable)",
      repeatable: true,
    },
    {
      flags: "--ecc-path <dir>",
      description: "use an existing exact local ECC checkout as the evidence-gated source",
    },
    {
      flags: "--lifecycle <operation>",
      description:
        "manage the AIH-owned Claude/Codex profile: install|update|repair|rollback|uninstall. In a governed repository `install` instead materializes the policy's evidence-passed component selection (removal lives in `aih uninstall`), and update|repair|rollback are refused. The governed install materializes for the targets `--cli` selects (default claude); all six governed targets are wired — claude, codex, kimi, cursor, opencode, kiro — and any other CLI is refused by name. Kiro materializes only evidence-passed agent:* selections with an exact pinned Kiro mapping, baseline:rules, and skill:* selections; every unsupported or unmapped component refuses by name. OpenCode materializes only the tool-shared project surfaces (AGENTS.md, .agents/), because no evidenced per-tool .opencode/ content layout exists; every other component refuses by name for it",
    },
  ],
  plan: runsThroughPlugin("ecc"),
  alwaysVerify: true,
};
