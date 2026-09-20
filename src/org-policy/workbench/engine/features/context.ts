import type { WorkbenchPolicyBindingsV1 } from "../../compile-policy.js";
import type {
  AuthoringCatalogBundleV1,
  WorkbenchActionV1,
  WorkbenchSourceInputsV1,
  WorkbenchStateV1,
} from "../../contracts.js";
import type { PolicySession } from "../../ui/shell/policy-session.js";
import type { AdminCatalogItem } from "../admin-engine.js";
import type { EngineOutcome } from "../shared.js";

/**
 * What every admin feature shares (Policy Workbench UI delivery, the feature
 * seam). `buildAdminEngine` builds exactly one of these and hands it to each
 * feature factory, so a new feature needs no new plumbing.
 *
 * Pure, like everything under `engine/`: no DOM, no `window`, no Node built-ins.
 */
export interface AdminEngineContext {
  /** The page model, already checked to be an object with a policy and a catalog. */
  readonly model: Record<string, unknown>;
  /** The one policy session every feature reads and changes. */
  readonly active: PolicySession;
  /** The prepared catalog; absent when it is invalid or unavailable. */
  readonly bundle: AuthoringCatalogBundleV1 | undefined;
  /**
   * LANE A (Sources screen): the catalog the administrator BROWSES —
   * `workbenchBrowseBundleV1(bundle)`, the same projection the hand-built
   * catalog offers. Everything a view lists reads this; selection, import and
   * download keep reading `bundle`, so saved policies still round-trip.
   */
  readonly browseBundle: AuthoringCatalogBundleV1 | undefined;
  readonly bindings: WorkbenchPolicyBindingsV1 | undefined;
  readonly catalogValid: boolean;
  readonly sourceInputs: WorkbenchSourceInputsV1;
  /** The policy text the page opened with: the diff baseline, captured once. */
  readonly baseline: string;
  /** The current policy read as a selection state; absent when it cannot be. */
  currentState(): WorkbenchStateV1 | undefined;
  /** LANE A: the resolved selection of the current policy, from the complete bundle. */
  selectedAssetIds(): readonly string[];
  /**
   * LANE A: these catalog ids as view items, with one selection read shared by
   * all of them. The ids come from a browse result; the asset records are the
   * complete bundle's, so a browsed item and a selectable item are one thing.
   */
  catalogItems(assetIds: readonly string[]): readonly AdminCatalogItem[];
  /** Reduce, compile, persist, and fall back to a repair (`main.ts` 171-281). */
  dispatch(action: WorkbenchActionV1): EngineOutcome;
  /** Forget the session's last announcement before an operation that will announce. */
  resetOutcome(): void;
  /** The session's announcement, or `fallback` when it said nothing. */
  outcome(fallback: string): EngineOutcome;
  /** The model's finding kinds for one of the scan screen's two groups. */
  findingKinds(group: "dispositionable" | "fenced"): string[];
  /* LANE C (organization screen). */
  /**
   * Persist a policy a feature compiled itself, under the same re-projection
   * guard `dispatch` uses (`main.ts` 171-281). The message of a refused
   * restore, or undefined when it was kept.
   */
  restore(policy: unknown): string | undefined;
}
