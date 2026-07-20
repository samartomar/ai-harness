import {
  assertPlanAllowed,
  assertProvisionAllowed,
  type BindingContext,
  type BindingPlan,
  type BindingReport,
  type FrameworkAdapter,
  type InspectReport,
  type InspectRequest,
  type ProvisionRequest,
  type ProvisionResult,
  type RemoveResult,
  type ResolveRequest,
  type VerifyResult,
} from "../../src/binding/adapter.js";
import type { BindingLock } from "../../src/binding/lock.js";
import {
  type ResolvedSource,
  resolvedSourceDigest,
  type ScanDisposition,
} from "../../src/binding/scan-gate.js";
import type { FrameworkId } from "../../src/binding/schema.js";

export interface FakeAdapterOptions {
  framework: FrameworkId;
  adapterType: FrameworkAdapter["adapterType"];
  /** The resolved identity `resolve()` returns (irrelevant to provision's digest check). */
  resolved: ResolvedSource;
  /** A deliberately sloppy adapter whose `provision` skips its own guard, proving
   *  the registry wrapper enforces the D12 invariant structurally. */
  skipGuard?: boolean;
}

/**
 * In-memory {@link FrameworkAdapter} exercising the D6 contract. `plan` and
 * `provision` each independently enforce D8 (one framework), and `provision`
 * additionally requires a {@link ScanDisposition} by type and revalidates it
 * through the scan gate before it would run any upstream code.
 */
export function createFakeAdapter(options: FakeAdapterOptions): FrameworkAdapter {
  return {
    framework: options.framework,
    adapterType: options.adapterType,

    inspect(request: InspectRequest): InspectReport {
      return { framework: options.framework, treePath: request.treePath, notes: ["fake inspect"] };
    },

    resolve(_request: ResolveRequest): Promise<ResolvedSource> {
      return Promise.resolve(options.resolved);
    },

    plan(context: BindingContext): BindingPlan {
      // D8 layer 2 — re-reject a second framework at plan time.
      assertPlanAllowed(context);
      return { framework: options.framework, writes: [], ownership: [] };
    },

    async provision(
      request: ProvisionRequest,
      disposition: ScanDisposition,
    ): Promise<ProvisionResult> {
      // D8 layer 3 + D12 scan-gate authorization, before any upstream code. A
      // guard throw becomes a rejection because this is an async method. A sloppy
      // adapter skips this — the registry wrapper must still block it.
      if (options.skipGuard !== true) assertProvisionAllowed(request, disposition);
      const digest = resolvedSourceDigest(request.resolved);
      const lock: BindingLock = {
        schemaVersion: 1,
        declaration: request.context.declaration,
        writes: [],
        scannedDigest: digest,
        loadedDigest: digest,
        match: true,
        ownership: [],
      };
      return { lock };
    },

    verify(_context: BindingContext): VerifyResult {
      return { ok: true, drift: [] };
    },

    remove(_context: BindingContext): RemoveResult {
      return { mode: "drift-report-only" };
    },

    report(context: BindingContext): BindingReport {
      return {
        framework: options.framework,
        lines: [`bound to ${context.declaration.framework.id}`],
      };
    },
  };
}
