import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { ECC_MCP_EXPLICIT_ADD_RECEIPT_PATH } from "../ecc/mcp-explicit-add-receipt.js";
import { AihError } from "../errors.js";
import type { Cli } from "../internals/clis.js";
import type { Action, PlanContext } from "../internals/plan.js";
import {
  FRAMEWORK_PLUGIN_PACKAGE_NAMES,
  type FrameworkPrunePlanV1,
  type FrameworkUninstallOutcomeV1,
} from "./contract-v1.js";
import { FrameworkPluginRefusalError, loadFrameworkPluginV1 } from "./load-framework-plugin.js";
import {
  type FrameworkCommandDepsV1,
  type LoadedFrameworkPluginV1,
  selfContainedFrameworkContextV1,
  withFrameworkInvocationV1,
} from "./run-framework-command.js";

/**
 * ECC's share of `aih uninstall` and `aih prune`. Core reads the state aih
 * itself wrote for ECC (receipts, the registration ledger) and decides; the
 * removal and reconciliation run in `@aihq/framework-ecc`. Without the plugin,
 * a command that has ECC state to act on refuses with
 * `framework-plugin-unavailable`; one with none has nothing ECC to do.
 */

const PACKAGE = FRAMEWORK_PLUGIN_PACKAGE_NAMES.ecc;

/**
 * The state aih writes for ECC that Core can see without the plugin: the
 * project's `.aih/ecc/` receipts and explicit MCP receipt, the machine
 * registration ledger under `~/.aih/ecc/`, and aih's Codex install state.
 */
export function eccStatePathsV1(ctx: PlanContext): string[] {
  // The homes the ECC code resolves: HOME or USERPROFILE (either order), the
  // OS home only when the invocation names neither.
  const named = [ctx.env.USERPROFILE, ctx.env.HOME].filter(
    (home): home is string => typeof home === "string" && home.length > 0,
  );
  const homes = named.length > 0 ? named : [homedir()];
  const candidates = [
    join(ctx.root, ".aih", "ecc"),
    join(ctx.root, ECC_MCP_EXPLICIT_ADD_RECEIPT_PATH),
    ...homes.flatMap((home) => [
      join(home, ".aih", "ecc"),
      join(home, ".codex", "ecc-aih-install-state.json"),
    ]),
  ];
  return [...new Set(candidates)].filter((path) => existsSync(path));
}

function incompatible(loaded: LoadedFrameworkPluginV1, hook: string, need: string): never {
  throw new FrameworkPluginRefusalError({
    reason: "framework-plugin-incompatible",
    frameworkId: "ecc",
    packageName: PACKAGE,
    detail: `${loaded.packageName} ${loaded.version} provides no ${hook} hook, which ${need} requires`,
  });
}

const OutcomeSchema = z
  .object({
    removed: z.array(z.string().min(1).max(4096)).max(100_000),
    advisories: z
      .array(
        z
          .object({
            path: z.string().min(1).max(4096),
            reason: z.string().min(1).max(200),
            detail: z.string().max(4096),
          })
          .strict(),
      )
      .max(100_000),
  })
  .strict();

/**
 * `aih uninstall`'s ECC preflight, before any cleanup runs. With ANY aih ECC
 * state ({@link eccStatePathsV1}) or receipt-proven materialization, the plugin
 * must load: a missing or broken one refuses by name
 * (`framework-plugin-unavailable` / `-incompatible`), naming the state found.
 * Returns the removal Core calls under `--apply` once its own cleanup
 * succeeded, only when `removeMaterialization` (the materialization receipt
 * proves owned content); otherwise nothing ECC runs.
 */
export async function prepareEccUninstallV1(
  ctx: PlanContext,
  removeMaterialization: boolean,
  deps: FrameworkCommandDepsV1 = {},
): Promise<(() => Promise<FrameworkUninstallOutcomeV1>) | undefined> {
  const state = eccStatePathsV1(ctx);
  if (state.length === 0 && !removeMaterialization) return undefined;
  const loaded = await (deps.loadPlugin ?? loadFrameworkPluginV1)("ecc");
  if (!loaded.ok) {
    const found = state.length === 0 ? "" : ` aih ECC state found: ${state.join(", ")}.`;
    throw new FrameworkPluginRefusalError({
      ...loaded.refusal,
      detail: `${loaded.refusal.detail}${found}`.slice(0, 2000),
    });
  }
  if (!removeMaterialization) return undefined;
  const hook = loaded.plugin.uninstall ?? incompatible(loaded, "uninstall", "removing ECC content");
  const context = await selfContainedFrameworkContextV1(
    loaded,
    ctx,
    "removing receipt-proven ECC content",
    undefined,
    deps,
  );
  return async () => {
    const parsed = OutcomeSchema.safeParse(await hook.remove(context));
    if (!parsed.success) {
      throw new AihError(
        `${loaded.packageName} ${loaded.version} returned a malformed uninstall outcome`,
        "AIH_FRAMEWORK_PLUGIN",
      );
    }
    return parsed.data;
  };
}

function isAction(value: unknown): value is Action {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { kind?: unknown }).kind === "string" &&
    typeof (value as { describe?: unknown }).describe === "string"
  );
}

/**
 * ECC's share of an `aih prune` plan: the dropped targets, and the machine
 * registration ledger's reconciliation, which runs even when no target is
 * dropped. Without the plugin: nothing when no aih ECC state exists, otherwise
 * the refusal, naming the state it found and the install command.
 */
export async function eccPrunePlanV1(
  ctx: PlanContext,
  dropped: readonly Cli[],
  deps: FrameworkCommandDepsV1 = {},
): Promise<FrameworkPrunePlanV1> {
  const loaded = await (deps.loadPlugin ?? loadFrameworkPluginV1)("ecc");
  if (!loaded.ok) {
    const state = eccStatePathsV1(ctx);
    if (loaded.refusal.reason === "framework-plugin-unavailable" && state.length === 0) {
      return { actions: [], subtracted: 0 };
    }
    const found = state.length === 0 ? "" : ` aih ECC state to reconcile: ${state.join(", ")}.`;
    throw new FrameworkPluginRefusalError({
      ...loaded.refusal,
      detail: `${loaded.refusal.detail}${found}`.slice(0, 2000),
    });
  }
  const hook = loaded.plugin.prune ?? incompatible(loaded, "prune", "reconciling dropped targets");
  return withFrameworkInvocationV1(
    loaded,
    "prune planning",
    {
      ctx: { ...ctx, targets: ctx.targets ?? [] },
      policy: undefined,
      transactionPins: {},
      options: {},
    },
    deps,
    async (context) => {
      const planned: unknown = await hook.plan(context, Object.freeze([...dropped]));
      const shape = planned as Partial<FrameworkPrunePlanV1> | undefined;
      if (
        typeof shape !== "object" ||
        shape === null ||
        !Array.isArray(shape.actions) ||
        !shape.actions.every(isAction) ||
        !Number.isSafeInteger(shape.subtracted) ||
        (shape.subtracted as number) < 0
      ) {
        throw new AihError(
          `${loaded.packageName} ${loaded.version} returned a malformed prune plan`,
          "AIH_FRAMEWORK_PLUGIN",
        );
      }
      return { actions: [...shape.actions], subtracted: shape.subtracted as number };
    },
  );
}
