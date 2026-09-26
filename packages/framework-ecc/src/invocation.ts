import { AsyncLocalStorage } from "node:async_hooks";
import {
  AihError,
  type FrameworkCoreRuntimeV1,
  type FrameworkDescriptorBytesV1,
  type FrameworkOperationContextV1,
} from "@aihq/core/framework-host";
import {
  type EccDescriptor,
  type EccDescriptorSection,
  eccDescriptorSectionOf,
  readEccDescriptor,
} from "./descriptor.js";

/**
 * One Core invocation of this plugin: the validated ECC descriptor Core loaded
 * from Catalog and the Core runtime Core bound to the invocation. Every plugin
 * entry point runs its body inside {@link withEccInvocation}; the ECC modules
 * read descriptor data and reach Core's executors only through it, so no ECC
 * code runs against data or services another invocation supplied.
 */
export interface EccInvocation {
  readonly descriptor: EccDescriptor;
  /** Absent for read-only operations (inventory, component identification). */
  readonly runtime?: FrameworkCoreRuntimeV1;
}

const storage = new AsyncLocalStorage<EccInvocation>();

/** Set only by this package's own tests; production entry points always run inside an invocation. */
let testInvocation: EccInvocation | undefined;

const parsed = new Map<string, EccDescriptor>();

/** Validate descriptor bytes once per digest (the digest is checked against the bytes on first read). */
export function eccDescriptorFor(bytes: FrameworkDescriptorBytesV1): EccDescriptor {
  const cached = parsed.get(bytes.sha256);
  if (cached !== undefined) return cached;
  const descriptor = readEccDescriptor(bytes);
  parsed.clear();
  parsed.set(bytes.sha256, descriptor);
  return descriptor;
}

/** Run `body` as part of the invocation `ctx` describes. */
export function withEccInvocation<T>(
  ctx: Pick<FrameworkOperationContextV1, "descriptor"> & {
    readonly host?: { readonly runtime?: FrameworkCoreRuntimeV1 };
  },
  body: () => T,
): T {
  const descriptor = eccDescriptorFor(ctx.descriptor);
  const runtime = ctx.host?.runtime;
  return storage.run(
    Object.freeze({ descriptor, ...(runtime === undefined ? {} : { runtime }) }),
    body,
  );
}

export function currentEccInvocation(): EccInvocation {
  const invocation = storage.getStore() ?? testInvocation;
  if (invocation === undefined) {
    throw new AihError(
      "ECC framework code ran outside a Core invocation; Core calls this plugin only through its FrameworkPluginV1 entry points",
      "AIH_FRAMEWORK_PLUGIN",
    );
  }
  return invocation;
}

/** The Core runtime of the current invocation; operations with effects require one. */
export function currentCoreRuntime(): FrameworkCoreRuntimeV1 {
  const runtime = currentEccInvocation().runtime;
  if (runtime === undefined) {
    throw new AihError(
      "this ECC operation needs Core's runtime, but Core invoked the plugin without one",
      "AIH_FRAMEWORK_PLUGIN",
    );
  }
  return runtime;
}

/** Test seam for this package's tests only: an ambient invocation used when no Core invocation is active. */
export function setEccTestInvocation(invocation: EccInvocation | undefined): void {
  testInvocation = invocation;
}

/**
 * One section of the current invocation's descriptor, as a private copy. The
 * caller validates its shape with its own schema.
 */
export function eccDescriptorSection<T = unknown>(section: EccDescriptorSection): T {
  return structuredClone(eccDescriptorSectionOf(currentEccInvocation().descriptor, section)) as T;
}

const memos = new Map<string, { readonly digest: string; readonly value: unknown }>();

/**
 * A value derived from the current invocation's descriptor, computed once per
 * descriptor digest: a later invocation with other descriptor bytes recomputes it.
 */
export function eccDescriptorMemo<T>(key: string, compute: () => T): T {
  const digest = currentEccInvocation().descriptor.sha256;
  const memo = memos.get(key);
  if (memo !== undefined && memo.digest === digest) return memo.value as T;
  const value = compute();
  memos.set(key, { digest, value });
  return value;
}
