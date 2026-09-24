import { AdapterRegistry } from "../adapter.js";
import type { FrameworkId } from "../schema.js";
import {
  createEccAdapter,
  ADAPTER_VERSION as ECC_ADAPTER_VERSION,
  type EccLeanAdapterDeps,
} from "./ecc.js";

/**
 * The one assembly point that wires concrete D6 `FrameworkAdapter`s into an
 * {@link AdapterRegistry}: ECC (upstream-local-installer). Superpowers is a
 * framework plugin (`@aihq/framework-superpowers`), not a binding adapter.
 * Later work packages add their own `create<Framework>Adapter`
 * factory in a sibling module and register it here too; `BindingRegistryDeps`
 * WIDENS additively (a merged shape covering every adapter's construction deps)
 * as they land, not replaced — matching the rest of Project Framework Binding.
 *
 * Deliberately NOT exported from `plan`/`provision`/etc: this module only
 * assembles a registry from deps; it carries no CLI wiring and no policy of
 * its own (that stays in each adapter).
 */

/**
 * Shared construction deps for every registered adapter: ECC's
 * (`root`/`runner`/`env`/`cacheHome`/`timeoutMs`, `locateCache`/`applyActions`,
 * `installer`, `installPreview` and the ECC Full `excludedSurfaces`).
 */
export type BindingRegistryDeps = EccLeanAdapterDeps;

/** Build an {@link AdapterRegistry} with every currently-implemented D6 adapter registered. */
export function createBindingAdapterRegistry(deps: BindingRegistryDeps): AdapterRegistry {
  const registry = new AdapterRegistry();
  registry.register(createEccAdapter(deps));
  return registry;
}

/**
 * The per-adapter `ADAPTER_VERSION` for every registered framework (W7 §C.2),
 * registered here ALONGSIDE the factory so the two never drift. It is the
 * `adapterVersion` a provision / acceptance flow keys into the runtime-qualification
 * cache (`scan-cache-tiers.ts` `runtimeQualKey`): a bump re-keys that framework's host
 * qualifications. WIDENS additively as later adapters land, exactly like
 * {@link BindingRegistryDeps}.
 */
export const ADAPTER_VERSIONS: Readonly<Partial<Record<FrameworkId, number>>> = {
  ecc: ECC_ADAPTER_VERSION,
};
