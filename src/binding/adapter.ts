import { AihError } from "../errors.js";
import type { FrameworkCard } from "./card.js";
import type { BindingLock, BindingOwnershipEntry, BindingWrite } from "./lock.js";
import {
  assertProvisionAuthorized,
  type ResolvedSource,
  resolvedSourceDigest,
  type ScanDisposition,
} from "./scan-gate.js";
import {
  assertSingleMethodologyFramework,
  type BindingDeclaration,
  type FrameworkId,
} from "./schema.js";

/**
 * The one narrow framework-adapter contract (D6): inspect, resolve, plan,
 * provision, verify, remove, report. There is no general-purpose arbitrary
 * installer — every adapter is one of the five D6 types, and `standalone-host`
 * is deferred (registering one throws).
 *
 * `provision` requires a {@link ScanDisposition} BY TYPE — it is not callable
 * without one — and revalidates it at runtime through the scan gate before any
 * upstream code could run. D8 (exactly one framework) is enforced independently
 * at each layer: the schema is structural, `plan` re-rejects a second framework
 * (layer 2), and `provision` re-rejects it again (layer 3).
 */

export type AdapterType =
  | "host-plugin"
  | "project-skills"
  | "upstream-local-installer"
  | "shared-runtime"
  | "standalone-host";

export const ADAPTER_TYPES: readonly AdapterType[] = [
  "host-plugin",
  "project-skills",
  "upstream-local-installer",
  "shared-runtime",
  "standalone-host",
];

/** Adapter types not yet implemented; registering one fails closed. */
export const DEFERRED_ADAPTER_TYPES: ReadonlySet<AdapterType> = new Set<AdapterType>([
  "standalone-host",
]);

/** The world an adapter acts against: the declaration + any framework already bound. */
export interface BindingContext {
  declaration: BindingDeclaration;
  /** Framework already bound in this project (from the lock/declaration), if any. */
  existingFramework?: FrameworkId;
}

export interface InspectRequest {
  treePath: string;
}

export interface InspectReport {
  framework: FrameworkId;
  treePath: string;
  notes: string[];
}

export interface ResolveRequest {
  declaration: BindingDeclaration;
}

export interface BindingPlan {
  framework: FrameworkId;
  writes: BindingWrite[];
  ownership: BindingOwnershipEntry[];
}

export interface ProvisionRequest {
  context: BindingContext;
  resolved: ResolvedSource;
}

export interface ProvisionResult {
  lock: BindingLock;
}

export interface VerifyResult {
  ok: boolean;
  drift: string[];
}

export interface RemoveResult {
  mode: "apply" | "drift-report-only";
}

export interface BindingReport {
  framework: FrameworkId;
  /**
   * The typed, versioned Framework Card (W7 §A) — the derived, rebuildable
   * evidence record `lines` is rendered from. `report()` builds it; a `provision()`
   * persists it beside the lock (O8). See {@link FrameworkCard}.
   *
   * OPTIONAL: the migrated ECC and Superpowers reports always populate it; the
   * gstack report is EVALUATED_DEFERRED for v1 (maintainer scope reduction,
   * DECISION-LOG 2026-07-23) and still returns lines-only, so consumers must
   * treat `card` as possibly-absent until every adapter is migrated.
   */
  card?: FrameworkCard;
  lines: string[];
}

export interface FrameworkAdapter {
  readonly framework: FrameworkId;
  readonly adapterType: AdapterType;
  inspect(request: InspectRequest): InspectReport | Promise<InspectReport>;
  resolve(request: ResolveRequest): Promise<ResolvedSource>;
  plan(context: BindingContext): BindingPlan;
  provision(request: ProvisionRequest, disposition: ScanDisposition): Promise<ProvisionResult>;
  verify(context: BindingContext): VerifyResult;
  remove(context: BindingContext): RemoveResult;
  report(context: BindingContext): BindingReport;
}

/** Adapter-registry violation (deferred type, unknown type, duplicate framework). */
export class BindingAdapterRegistryError extends AihError {
  constructor(message: string) {
    super(message, "AIH_BINDING_ADAPTER");
  }
}

/**
 * D8 layer 2 — `plan` must call this so a plan for a second methodology framework
 * is rejected before any work is scheduled.
 */
export function assertPlanAllowed(context: BindingContext): void {
  assertSingleMethodologyFramework(context.declaration.framework.id, context.existingFramework);
}

/**
 * D8 layer 3 + the D12 scan-gate invariant — `provision` must call this before it
 * runs any upstream code: re-reject a second framework, then require the exact
 * source disposition to be genuine, allow, and digest-matched.
 */
export function assertProvisionAllowed(
  request: ProvisionRequest,
  disposition: ScanDisposition,
): void {
  assertSingleMethodologyFramework(
    request.context.declaration.framework.id,
    request.context.existingFramework,
  );
  assertProvisionAuthorized(disposition, resolvedSourceDigest(request.resolved));
}

/**
 * Wrap an adapter so every registry-dispatched `provision` runs
 * {@link assertProvisionAllowed} BEFORE delegating. This makes the D12 invariant
 * structural at the dispatch boundary — an adapter whose own `provision` forgets
 * to guard still cannot run behind a forged, blocked, or mismatched disposition.
 * The adapter's own method is left untouched; only registry dispatch is wrapped.
 */
function guardProvision(adapter: FrameworkAdapter): FrameworkAdapter {
  return {
    framework: adapter.framework,
    adapterType: adapter.adapterType,
    inspect: (request) => adapter.inspect(request),
    resolve: (request) => adapter.resolve(request),
    plan: (context) => adapter.plan(context),
    provision: async (request, disposition) => {
      assertProvisionAllowed(request, disposition);
      return adapter.provision(request, disposition);
    },
    verify: (context) => adapter.verify(context),
    remove: (context) => adapter.remove(context),
    report: (context) => adapter.report(context),
  };
}

/**
 * Registry of the five D6 adapter types, keyed by framework (exactly one adapter
 * per framework). A deferred type or an unknown type is refused at registration.
 * Registered adapters are dispatched through a provision guard (see
 * {@link guardProvision}).
 */
export class AdapterRegistry {
  private readonly byFramework = new Map<FrameworkId, FrameworkAdapter>();

  register(adapter: FrameworkAdapter): void {
    if (!ADAPTER_TYPES.includes(adapter.adapterType)) {
      throw new BindingAdapterRegistryError(`unknown adapter type "${adapter.adapterType}"`);
    }
    if (DEFERRED_ADAPTER_TYPES.has(adapter.adapterType)) {
      throw new BindingAdapterRegistryError(
        `adapter type "${adapter.adapterType}" is deferred and cannot be registered`,
      );
    }
    if (this.byFramework.has(adapter.framework)) {
      throw new BindingAdapterRegistryError(
        `framework "${adapter.framework}" already has a registered adapter`,
      );
    }
    this.byFramework.set(adapter.framework, guardProvision(adapter));
  }

  get(framework: FrameworkId): FrameworkAdapter | undefined {
    return this.byFramework.get(framework);
  }

  has(framework: FrameworkId): boolean {
    return this.byFramework.has(framework);
  }

  frameworks(): FrameworkId[] {
    return [...this.byFramework.keys()];
  }
}
