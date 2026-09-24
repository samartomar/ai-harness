import type { BaselineEvidencePipelineDeps } from "../baseline-evidence/pipeline.js";
import {
  type FrameworkDescriptorLoadV1,
  loadFrameworkDescriptorBytesV1,
} from "../catalog-package/framework-descriptors.js";
import { CatalogPackageRefusalError } from "../catalog-package/load-catalog-package.js";
import { postureFromContext } from "../config/posture.js";
import { AihError } from "../errors.js";
import type { PlanResult } from "../internals/execute.js";
import type { PlanContext } from "../internals/plan.js";
import type { OrgPolicy } from "../org-policy/schema.js";
import type {
  FrameworkCommandPathV1,
  FrameworkIdV1,
  FrameworkOperationContextV1,
} from "./contract-v1.js";
import { type FrameworkTransactionPinsV1, frameworkHostServicesV1 } from "./host-services.js";
import {
  type FrameworkPluginLoadV1,
  FrameworkPluginRefusalError,
  loadFrameworkPluginV1,
} from "./load-framework-plugin.js";

export type LoadedFrameworkPluginV1 = Extract<FrameworkPluginLoadV1, { ok: true }>;

/** Test seams for a framework command. Production uses the installed packages. */
export interface FrameworkCommandDepsV1 {
  readonly loadPlugin?: (frameworkId: FrameworkIdV1) => Promise<FrameworkPluginLoadV1>;
  readonly loadDescriptor?: (frameworkId: FrameworkIdV1) => Promise<FrameworkDescriptorLoadV1>;
  readonly pipelineDeps?: BaselineEvidencePipelineDeps;
}

/** What Core decided for one framework invocation before any plugin code runs. */
export interface FrameworkInvocationV1 {
  /** The invocation's plan context, with `targets` resolved. */
  readonly ctx: PlanContext;
  readonly policy: OrgPolicy | undefined;
  readonly transactionPins: FrameworkTransactionPinsV1;
  /** The command's own parsed options. */
  readonly options: Readonly<Record<string, unknown>>;
}

/** Load the installed plugin or throw its typed refusal. */
export async function requireFrameworkPluginV1(
  frameworkId: FrameworkIdV1,
  deps: FrameworkCommandDepsV1 = {},
): Promise<LoadedFrameworkPluginV1> {
  const loaded = await (deps.loadPlugin ?? loadFrameworkPluginV1)(frameworkId);
  if (!loaded.ok) throw new FrameworkPluginRefusalError(loaded.refusal);
  return loaded;
}

function environmentFor(
  names: readonly string[],
  env: NodeJS.ProcessEnv,
): Readonly<Record<string, string>> {
  const picked: Record<string, string> = {};
  for (const name of names) {
    const value = env[name];
    if (value !== undefined) picked[name] = value;
  }
  return Object.freeze(picked);
}

/**
 * Run one plugin command: load the framework descriptor bytes from Catalog
 * (C1), build the operation context from Core's decisions, execute, and accept
 * only a result Core's own host services produced for this invocation.
 */
export async function executeFrameworkCommandV1(
  loaded: LoadedFrameworkPluginV1,
  commandPath: FrameworkCommandPathV1,
  invocation: FrameworkInvocationV1,
  deps: FrameworkCommandDepsV1 = {},
): Promise<PlanResult> {
  const { ctx } = invocation;
  const frameworkId = loaded.frameworkId;
  if (ctx.targets === undefined) {
    throw new AihError(
      `framework command ${commandPath} needs Core-resolved targets`,
      "AIH_FRAMEWORK_PLUGIN",
    );
  }
  const descriptor = await (deps.loadDescriptor ?? loadFrameworkDescriptorBytesV1)(frameworkId);
  if (!descriptor.ok) throw new CatalogPackageRefusalError(descriptor.refusal);
  const produced = new WeakSet<object>();
  const context: FrameworkOperationContextV1 = Object.freeze({
    frameworkId,
    root: ctx.root,
    targets: Object.freeze([...ctx.targets]),
    mode: Object.freeze({ apply: ctx.apply, verify: ctx.verify }),
    descriptor: Object.freeze({
      frameworkId,
      bytes: Uint8Array.from(descriptor.bytes),
      sha256: descriptor.sha256,
      ...(descriptor.catalogVersion === undefined
        ? {}
        : { catalogVersion: descriptor.catalogVersion }),
    }),
    // No policy grammar carries framework hook disables yet; see the W3 report.
    policy: Object.freeze({
      posture: postureFromContext(ctx),
      hookControls: Object.freeze({ disabled: Object.freeze([]) }),
    }),
    options: Object.freeze({ ...invocation.options }),
    env: environmentFor(loaded.description.environment, ctx.env),
    host: frameworkHostServicesV1({
      frameworkId,
      ctx,
      policy: invocation.policy,
      transactionPins: invocation.transactionPins,
      produced,
      ...(deps.pipelineDeps === undefined ? {} : { pipelineDeps: deps.pipelineDeps }),
    }),
  });
  const command = loaded.plugin.commands[commandPath];
  if (command === undefined) {
    throw new AihError(
      `${loaded.packageName} ${loaded.version} does not implement "${commandPath}"`,
      "AIH_FRAMEWORK_PLUGIN",
    );
  }
  const result: unknown = await command.execute(context);
  if (typeof result !== "object" || result === null || !produced.has(result)) {
    throw new AihError(
      `${loaded.packageName} ${loaded.version} returned a "${commandPath}" result that Core's host services did not produce`,
      "AIH_FRAMEWORK_PLUGIN",
    );
  }
  return result as PlanResult;
}
