import { CatalogPackageRefusalError } from "../catalog-package/load-catalog-package.js";
import { AihError } from "../errors.js";
import type { PlanContext } from "../internals/plan.js";
import type { Check } from "../internals/verify.js";
import type {
  FrameworkCapabilityPackageDomainV1,
  FrameworkOperationContextV1,
} from "./contract-v1.js";
import {
  FrameworkPluginRefusalError,
  frameworkPluginRefusalMessage,
  loadFrameworkPluginV1,
} from "./load-framework-plugin.js";
import {
  type FrameworkCommandDepsV1,
  type LoadedFrameworkPluginV1,
  selfContainedFrameworkContextV1,
} from "./run-framework-command.js";

/**
 * ECC's read-only contributions to `aih doctor` and `aih report`. Both run
 * without the plugin: when it is missing, or Catalog cannot supply its
 * descriptor, they state that the ECC checks were not run and why, instead of
 * failing the command. A plugin that is present but broken is a failure.
 */

export type EccReadOutcomeV1<T> =
  | { readonly state: "ran"; readonly value: T }
  | { readonly state: "not-run"; readonly detail: string; readonly broken: boolean };

async function withEccRead<T>(
  ctx: PlanContext,
  operation: string,
  deps: Pick<FrameworkCommandDepsV1, "loadPlugin" | "loadDescriptor">,
  body: (loaded: LoadedFrameworkPluginV1, context: FrameworkOperationContextV1) => Promise<T>,
): Promise<EccReadOutcomeV1<T>> {
  const loaded = await (deps.loadPlugin ?? loadFrameworkPluginV1)("ecc");
  if (!loaded.ok) {
    return {
      state: "not-run",
      detail: frameworkPluginRefusalMessage(loaded.refusal),
      broken: loaded.refusal.reason !== "framework-plugin-unavailable",
    };
  }
  let context: FrameworkOperationContextV1;
  try {
    context = await selfContainedFrameworkContextV1(loaded, ctx, operation, undefined, deps);
  } catch (error) {
    if (error instanceof CatalogPackageRefusalError) {
      return { state: "not-run", detail: error.message, broken: false };
    }
    throw error;
  }
  return { state: "ran", value: await body(loaded, context) };
}

const VERDICTS = new Set(["pass", "fail", "skip"]);

function isCheck(value: unknown): value is Check {
  if (typeof value !== "object" || value === null) return false;
  const check = value as Partial<Check>;
  return (
    typeof check.name === "string" &&
    check.name.length > 0 &&
    check.name.length <= 200 &&
    typeof check.verdict === "string" &&
    VERDICTS.has(check.verdict) &&
    (check.detail === undefined ||
      (typeof check.detail === "string" && check.detail.length <= 4096))
  );
}

/** ECC's `aih doctor` checks, or one row stating they were not run and why. */
export async function eccDoctorChecksV1(
  ctx: PlanContext,
  deps: Pick<FrameworkCommandDepsV1, "loadPlugin" | "loadDescriptor"> = {},
): Promise<Check[]> {
  const outcome = await withEccRead(ctx, "running doctor checks", deps, async (loaded, context) => {
    const hook = loaded.plugin.doctor;
    if (hook === undefined) {
      return [
        {
          name: "ECC checks",
          verdict: "fail" as const,
          detail: `framework-plugin-incompatible: ${loaded.packageName} ${loaded.version} provides no doctor hook`,
        },
      ];
    }
    const checks: unknown = await hook.checks(context);
    if (!Array.isArray(checks) || checks.length > 1000 || !checks.every(isCheck)) {
      throw new AihError(
        `${loaded.packageName} ${loaded.version} returned malformed doctor checks`,
        "AIH_FRAMEWORK_PLUGIN",
      );
    }
    return checks.map((check) => ({
      name: check.name,
      verdict: check.verdict,
      ...(check.detail === undefined ? {} : { detail: check.detail }),
    }));
  });
  if (outcome.state === "ran") return outcome.value;
  return [
    {
      name: "ECC checks",
      verdict: outcome.broken ? "fail" : "skip",
      detail: `ECC checks were not run: ${outcome.detail}`,
    },
  ];
}

/** The ECC language packs that apply to this repository, from the plugin's component identification. */
export async function eccLanguagePacksV1(
  ctx: PlanContext,
  deps: Pick<FrameworkCommandDepsV1, "loadPlugin" | "loadDescriptor"> = {},
): Promise<EccReadOutcomeV1<readonly string[]>> {
  return withEccRead(ctx, "identifying components", deps, async (loaded, context) => {
    const packs: unknown = loaded.plugin.identifyComponents(context).languagePacks ?? [];
    if (
      !Array.isArray(packs) ||
      packs.length > 200 ||
      !packs.every((pack) => typeof pack === "string" && /^[a-z][a-z0-9-]{0,63}$/.test(pack))
    ) {
      throw new AihError(
        `${loaded.packageName} ${loaded.version} returned malformed language packs`,
        "AIH_FRAMEWORK_PLUGIN",
      );
    }
    return Object.freeze([...packs]);
  });
}

/**
 * ECC's planning for `aih capability package`, bound to one invocation, or
 * the reason it is not available (the coordinator refuses when it needs it).
 * A plugin that is present but broken, or lacks the hook, is refused here.
 */
export async function eccCapabilityPackageDomainV1(
  ctx: PlanContext,
  deps: Pick<FrameworkCommandDepsV1, "loadPlugin" | "loadDescriptor"> = {},
): Promise<EccReadOutcomeV1<FrameworkCapabilityPackageDomainV1>> {
  const outcome = await withEccRead(
    ctx,
    "planning capability packages",
    deps,
    async (loaded, context) => {
      const hook = loaded.plugin.capabilityPackages;
      if (hook === undefined) {
        throw new FrameworkPluginRefusalError({
          reason: "framework-plugin-incompatible",
          frameworkId: "ecc",
          packageName: "@aihq/framework-ecc",
          detail: `${loaded.packageName} ${loaded.version} provides no capabilityPackages hook`,
        });
      }
      return hook.domain(context);
    },
  );
  if (outcome.state === "not-run" && outcome.broken) {
    throw new AihError(outcome.detail, "AIH_FRAMEWORK_PLUGIN");
  }
  return outcome;
}
