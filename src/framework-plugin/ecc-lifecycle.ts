import { lstatSync, type Stats, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, parse, resolve, sep } from "node:path";
import { z } from "zod";
import { ECC_MCP_EXPLICIT_ADD_RECEIPT_PATH } from "../ecc/mcp-explicit-add-receipt.js";
import {
  type EccNativeStateRootV1,
  eccNativeStateRootCandidatesV1,
  NATIVE_ECC_REGISTRATION_RECEIPT,
} from "../ecc-profile/native-registration.js";
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

/** The ECC profile lifecycle's ownership receipt (the plugin's `ECC_PROFILE_OWNERSHIP_PATH`). */
const ECC_PROFILE_OWNERSHIP_RECEIPT = ".aih/ecc-profile/ownership-v1.json";

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

/**
 * Inspect one candidate with `lstat`, component by component from the
 * file-system root down through its base and segments, so nothing above a
 * supplied base (an explicit root, `HOME`, `LOCALAPPDATA`...) is skipped. Only
 * a genuinely missing entry under directories is absent (`undefined`). A
 * dangling symbolic link or junction, an inaccessible entry or a component
 * that is not a directory is state, named by the component where it was found;
 * a resolving symbolic link or junction is followed like the directory or file
 * it names.
 */
function inspectStatePath(base: string, segments: readonly string[]): string | undefined {
  const full = resolve(base, ...segments);
  const fsRoot = parse(full).root;
  const components = full.slice(fsRoot.length).split(sep).filter(Boolean);
  let current = fsRoot;
  for (let index = -1; index < components.length; index += 1) {
    if (index >= 0) current = join(current, components[index] as string);
    const last = index === components.length - 1;
    let entry: Stats;
    try {
      entry = lstatSync(current);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return undefined;
      if (errorCode(error) === "ENOTDIR") return `${current} (not a directory)`;
      return `${current} (inaccessible)`;
    }
    if (entry.isSymbolicLink()) {
      try {
        entry = statSync(current);
      } catch (error) {
        const code = errorCode(error);
        return code === "ENOENT" || code === "ELOOP" || code === "ENOTDIR"
          ? `${current} (dangling symbolic link)`
          : `${current} (inaccessible)`;
      }
    }
    if (last) return current;
    if (!entry.isDirectory()) return `${current} (not a directory)`;
  }
  return current;
}

/**
 * The state aih writes for ECC that Core can see without the plugin: the
 * project's `.aih/ecc/` receipts and explicit MCP receipt, the ECC profile
 * lifecycle state under `.aih/ecc-profile/` (its ownership and native
 * registration receipts), the native registration's machine state root (from
 * Core's one resolver, {@link eccNativeStateRootCandidatesV1}), the machine
 * registration ledger under `~/.aih/ecc/`, and aih's Codex install state. Each path and its ancestors are inspected
 * with `lstat`: anything but genuine absence is listed, a path that is not
 * plainly present carrying its condition in parentheses.
 */
export function eccStatePathsV1(ctx: PlanContext): string[] {
  // The homes the ECC code resolves: HOME or USERPROFILE (either order), the
  // OS home only when the invocation names neither.
  const named = [ctx.env.USERPROFILE, ctx.env.HOME].filter(
    (home): home is string => typeof home === "string" && home.length > 0,
  );
  const homes = named.length > 0 ? named : [homedir()];
  const segments = (relativePath: string): string[] => relativePath.split("/");
  const candidates: Array<[string, string[]]> = [
    [ctx.root, [".aih", "ecc"]],
    [ctx.root, segments(ECC_MCP_EXPLICIT_ADD_RECEIPT_PATH)],
    [ctx.root, [".aih", "ecc-profile"]],
    [ctx.root, segments(ECC_PROFILE_OWNERSHIP_RECEIPT)],
    [ctx.root, segments(NATIVE_ECC_REGISTRATION_RECEIPT)],
    ...homes.flatMap(
      (home): Array<[string, string[]]> => [
        [home, [".aih", "ecc"]],
        [home, [".codex", "ecc-aih-install-state.json"]],
      ],
    ),
  ];
  const found = candidates
    .map(([base, parts]) => inspectStatePath(base, parts))
    .filter((path): path is string => path !== undefined);
  return [...new Set([...found, ...nativeStateRootPaths(ctx)])];
}

/**
 * The native registration's machine state roots under this invocation. A
 * relative `AIH_ECC_STATE_ROOT` leaves the root undeterminable, so it is named
 * as state rather than treated as absent.
 */
function nativeStateRootPaths(ctx: PlanContext): string[] {
  let roots: EccNativeStateRootV1[];
  try {
    roots = eccNativeStateRootCandidatesV1(ctx.env, ctx.host.platform);
  } catch (error) {
    if (!(error instanceof AihError)) throw error;
    return [`AIH_ECC_STATE_ROOT=${ctx.env.AIH_ECC_STATE_ROOT?.trim()} (not an absolute path)`];
  }
  return roots
    .map((root) => inspectStatePath(root.base, root.segments))
    .filter((path): path is string => path !== undefined);
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
