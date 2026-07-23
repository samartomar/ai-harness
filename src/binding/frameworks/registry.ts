import { AdapterRegistry } from "../adapter.js";
import type { FrameworkId } from "../schema.js";
import {
  createEccAdapter,
  ADAPTER_VERSION as ECC_ADAPTER_VERSION,
  type EccLeanAdapterDeps,
} from "./ecc.js";
import {
  createGstackAdapter,
  ADAPTER_VERSION as GSTACK_ADAPTER_VERSION,
  type GstackAdapterDeps,
} from "./gstack.js";
import {
  createSuperpowersAdapter,
  ADAPTER_VERSION as SUPERPOWERS_ADAPTER_VERSION,
  type SuperpowersAdapterDeps,
} from "./superpowers.js";

/**
 * The one assembly point that wires concrete D6 `FrameworkAdapter`s into an
 * {@link AdapterRegistry}. W4a registered the first (Superpowers, host-plugin);
 * W4b adds ECC Lean (upstream-local-installer); W5 adds gstack (shared-runtime).
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
 * Shared construction deps for every registered adapter. The shared fields
 * (`root`/`runner`/`env`/`cacheHome`/`timeoutMs`, plus the host-plugin
 * `locateCache`/`applyActions`) live on {@link SuperpowersAdapterDeps}; this shape
 * widens to also carry ECC's adapter-specific optionals (`installer`,
 * `installPreview`, and the ECC Full `excludedSurfaces`) and gstack's
 * upstream-installer seam (`installGstack`). Every factory accepts this merged
 * shape (each ignores fields it does not use).
 */
export type BindingRegistryDeps = SuperpowersAdapterDeps &
  Pick<EccLeanAdapterDeps, "installer" | "installPreview" | "excludedSurfaces"> &
  Pick<GstackAdapterDeps, "installGstack">;

/** Build an {@link AdapterRegistry} with every currently-implemented D6 adapter registered. */
export function createBindingAdapterRegistry(deps: BindingRegistryDeps): AdapterRegistry {
  const registry = new AdapterRegistry();
  registry.register(createSuperpowersAdapter(deps));
  registry.register(createEccAdapter(deps));
  registry.register(createGstackAdapter(deps));
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
export const ADAPTER_VERSIONS: Readonly<Record<FrameworkId, number>> = {
  superpowers: SUPERPOWERS_ADAPTER_VERSION,
  ecc: ECC_ADAPTER_VERSION,
  gstack: GSTACK_ADAPTER_VERSION,
};
