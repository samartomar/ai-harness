import type { BaselineEvidencePipelineDeps } from "../baseline-evidence/pipeline.js";
import {
  type FrameworkDescriptorLoadV1,
  loadFrameworkDescriptorBytesV1,
} from "../catalog-package/framework-descriptors.js";
import { CatalogPackageRefusalError } from "../catalog-package/load-catalog-package.js";
import { postureFromContext } from "../config/posture.js";
import { AihError } from "../errors.js";
import type { PlanResult } from "../internals/execute.js";
import type { FileAssertion, PlanContext } from "../internals/plan.js";
import type { OrgPolicy } from "../org-policy/schema.js";
import {
  FRAMEWORK_PLUGIN_PACKAGE_NAMES,
  type FrameworkCommandPathV1,
  type FrameworkHostServicesV1,
  type FrameworkIdV1,
  type FrameworkOperationContextV1,
} from "./contract-v1.js";
import {
  type BoundFrameworkCoreRuntimeV1,
  bindFrameworkCoreRuntimeV1,
  FRAMEWORK_CORE_RUNTIME_FRAMEWORKS,
} from "./core-runtime.js";
import { frameworkHookControlRequestV1 } from "./hook-controls.js";
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
 * The operation context Core builds for one plugin operation: the framework
 * descriptor bytes loaded from Catalog (C1), Core's decisions for the
 * invocation, the merged hook-control request, and the host services given.
 */
export async function frameworkOperationContextV1(
  loaded: LoadedFrameworkPluginV1,
  ctx: PlanContext & { readonly targets: NonNullable<PlanContext["targets"]> },
  input: {
    readonly policy: OrgPolicy | undefined;
    readonly options: Readonly<Record<string, unknown>>;
    readonly host: FrameworkHostServicesV1;
  },
  deps: Pick<FrameworkCommandDepsV1, "loadDescriptor"> = {},
): Promise<FrameworkOperationContextV1> {
  const frameworkId = loaded.frameworkId;
  const descriptor = await (deps.loadDescriptor ?? loadFrameworkDescriptorBytesV1)(frameworkId);
  if (!descriptor.ok) throw new CatalogPackageRefusalError(descriptor.refusal);
  return Object.freeze({
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
    policy: Object.freeze({
      posture: postureFromContext(ctx),
      hookControls: frameworkHookControlRequestV1(frameworkId, input.policy, ctx.root),
    }),
    options: Object.freeze({ ...input.options }),
    env: environmentFor(loaded.description.environment, ctx.env),
    host: input.host,
  });
}

interface OpenFrameworkInvocationV1 {
  readonly context: FrameworkOperationContextV1;
  readonly produced: WeakSet<object>;
  readonly bound: BoundFrameworkCoreRuntimeV1 | undefined;
}

/**
 * Open one plugin invocation: host services and, for the frameworks that get
 * it, Core's runtime bound to the invocation, and the operation context built
 * from Core's decisions. The caller revokes `bound` when the invocation ends.
 */
async function openFrameworkInvocationV1(
  loaded: LoadedFrameworkPluginV1,
  operation: string,
  invocation: FrameworkInvocationV1,
  deps: FrameworkCommandDepsV1,
): Promise<OpenFrameworkInvocationV1> {
  const { ctx } = invocation;
  const frameworkId = loaded.frameworkId;
  if (ctx.targets === undefined) {
    throw new AihError(
      `framework ${operation} needs Core-resolved targets`,
      "AIH_FRAMEWORK_PLUGIN",
    );
  }
  const produced = new WeakSet<object>();
  const services = frameworkHostServicesV1({
    frameworkId,
    ctx,
    policy: invocation.policy,
    transactionPins: invocation.transactionPins,
    produced,
    ...(deps.pipelineDeps === undefined ? {} : { pipelineDeps: deps.pipelineDeps }),
  });
  const bound = FRAMEWORK_CORE_RUNTIME_FRAMEWORKS.has(frameworkId)
    ? bindFrameworkCoreRuntimeV1({
        frameworkId,
        ctx,
        transactionPins: invocation.transactionPins,
        produced,
      })
    : undefined;
  try {
    const context = await frameworkOperationContextV1(
      loaded,
      { ...ctx, targets: ctx.targets },
      {
        policy: invocation.policy,
        options: invocation.options,
        host:
          bound === undefined ? services : Object.freeze({ ...services, runtime: bound.runtime }),
      },
      deps,
    );
    return { context, produced, bound };
  } catch (error) {
    bound?.revoke();
    throw error;
  }
}

function acceptProduced(
  loaded: LoadedFrameworkPluginV1,
  operation: string,
  result: unknown,
  produced: WeakSet<object>,
): PlanResult {
  if (typeof result !== "object" || result === null || !produced.has(result)) {
    throw new AihError(
      `${loaded.packageName} ${loaded.version} returned a ${operation} result that Core's host services did not produce`,
      "AIH_FRAMEWORK_PLUGIN",
    );
  }
  return result as PlanResult;
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
  const command = loaded.plugin.commands[commandPath];
  if (command === undefined) {
    throw new AihError(
      `${loaded.packageName} ${loaded.version} does not implement "${commandPath}"`,
      "AIH_FRAMEWORK_PLUGIN",
    );
  }
  const opened = await openFrameworkInvocationV1(
    loaded,
    `command ${commandPath}`,
    invocation,
    deps,
  );
  try {
    return acceptProduced(
      loaded,
      `"${commandPath}"`,
      await command.execute(opened.context),
      opened.produced,
    );
  } finally {
    opened.bound?.revoke();
  }
}

/** A policy delivery Core prepared through a plugin, held open until Core ends it. */
export interface FrameworkPolicyDeliveryV1 {
  /** The prepared delivery: the preview when not applying. */
  readonly result: PlanResult;
  /**
   * Commit the prepared delivery, at most once. Present only when the plugin
   * retained a delivery to commit. `policyBinding` is the binding assertion
   * Core re-read after its projection; it replaces the invocation's pin on the
   * same path, for Core's runtime and for the plugin's prepared transaction.
   */
  readonly commit?: (policyBinding: FileAssertion | undefined) => Promise<PlanResult>;
  /** End the invocation. Core calls it once, whatever happened. */
  end(): void;
}

function samePath(a: string, b: string): boolean {
  const normal = (path: string) => path.replace(/\\/g, "/").replace(/^\.\//, "");
  return normal(a) === normal(b);
}

/**
 * Prepare the framework delivery the organization policy requires. Unlike a
 * command, the invocation stays open across Core's own policy projection:
 * Core commits the prepared delivery (or not) and then ends it.
 */
export async function prepareFrameworkPolicyDeliveryV1(
  loaded: LoadedFrameworkPluginV1,
  invocation: FrameworkInvocationV1,
  deps: FrameworkCommandDepsV1 = {},
): Promise<FrameworkPolicyDeliveryV1> {
  const hook = loaded.plugin.policyDelivery;
  if (hook === undefined) {
    throw new FrameworkPluginRefusalError({
      reason: "framework-plugin-incompatible",
      frameworkId: loaded.frameworkId,
      packageName: FRAMEWORK_PLUGIN_PACKAGE_NAMES[loaded.frameworkId],
      detail: `${loaded.packageName} ${loaded.version} provides no policy delivery, which organization policy selecting ${loaded.frameworkId} components requires`,
    });
  }
  const opened = await openFrameworkInvocationV1(loaded, "policy delivery", invocation, deps);
  const end = () => opened.bound?.revoke();
  try {
    const prepared = await hook.prepare(opened.context);
    const result = acceptProduced(loaded, "policy delivery", prepared?.result, opened.produced);
    const commitPrepared = prepared.commit;
    if (commitPrepared === undefined) return Object.freeze({ result, end });
    let committed = false;
    const commit = async (policyBinding: FileAssertion | undefined): Promise<PlanResult> => {
      if (committed) {
        throw new AihError(
          `the ${loaded.frameworkId} policy delivery was already committed`,
          "AIH_FRAMEWORK_PLUGIN",
        );
      }
      committed = true;
      if (policyBinding !== undefined) {
        const pins = invocation.transactionPins;
        opened.bound?.repin({
          ...pins,
          fileAssertions: [
            ...(pins.fileAssertions ?? []).filter(
              (assertion) => !samePath(assertion.path, policyBinding.path),
            ),
            policyBinding,
          ],
        });
      }
      return acceptProduced(
        loaded,
        "policy delivery commit",
        await commitPrepared(Object.freeze(policyBinding === undefined ? {} : { policyBinding })),
        opened.produced,
      );
    };
    return Object.freeze({ result, commit, end });
  } catch (error) {
    end();
    throw error;
  }
}
