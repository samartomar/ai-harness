import { z } from "zod";
import { AihError } from "../errors.js";
import type { Cli } from "../internals/clis.js";
import type { Action, PlanContext } from "../internals/plan.js";
import { FRAMEWORK_IDS_V1, type FrameworkUninstallOutcomeV1 } from "./contract-v1.js";
import { FrameworkPluginRefusalError, loadFrameworkPluginV1 } from "./load-framework-plugin.js";
import { type FrameworkCommandDepsV1, frameworkCleanupContextV1 } from "./run-framework-command.js";

const Outcome = z
  .object({
    removed: z.array(z.string().min(1).max(4096)).max(100_000),
    advisories: z
      .array(z.object({ path: z.string(), reason: z.string(), detail: z.string() }).strict())
      .max(100_000),
  })
  .strict();

/** Load every registered framework before Core begins a destructive lifecycle. */
async function loadedCleanupPlugins(deps: FrameworkCommandDepsV1) {
  const loaded = [];
  for (const id of FRAMEWORK_IDS_V1) {
    const result = await (deps.loadPlugin ?? loadFrameworkPluginV1)(id);
    if (!result.ok) throw new FrameworkPluginRefusalError(result.refusal);
    loaded.push(result);
  }
  return loaded;
}

export async function prepareFrameworkUninstallV1(
  ctx: PlanContext,
  deps: FrameworkCommandDepsV1 = {},
): Promise<() => Promise<FrameworkUninstallOutcomeV1>> {
  const loaded = await loadedCleanupPlugins(deps);
  return async () => {
    const removed: string[] = [];
    const advisories: FrameworkUninstallOutcomeV1["advisories"][number][] = [];
    for (const plugin of loaded) {
      const outcome = await plugin.plugin.uninstall.remove(
        frameworkCleanupContextV1(plugin, ctx, "uninstall cleanup"),
      );
      const parsed = Outcome.safeParse(outcome);
      if (!parsed.success)
        throw new AihError(
          `${plugin.packageName} returned an invalid uninstall outcome`,
          "AIH_FRAMEWORK_PLUGIN",
        );
      removed.push(...parsed.data.removed);
      advisories.push(...parsed.data.advisories);
    }
    return { removed, advisories };
  };
}

export async function frameworkPrunePlanV1(
  ctx: PlanContext,
  dropped: readonly Cli[],
  kept?: readonly Cli[],
  deps: FrameworkCommandDepsV1 = {},
): Promise<{ actions: Action[]; subtracted: number }> {
  const loaded = await loadedCleanupPlugins(deps);
  const actions: Action[] = [];
  let subtracted = 0;
  for (const plugin of loaded) {
    const planned = await plugin.plugin.prune.plan(
      frameworkCleanupContextV1(plugin, ctx, "prune cleanup"),
      dropped,
      kept,
    );
    if (
      !Array.isArray(planned.actions) ||
      !Number.isSafeInteger(planned.subtracted) ||
      planned.subtracted < 0
    )
      throw new AihError(
        `${plugin.packageName} returned an invalid prune plan`,
        "AIH_FRAMEWORK_PLUGIN",
      );
    actions.push(...planned.actions);
    subtracted += planned.subtracted;
  }
  return { actions, subtracted };
}
