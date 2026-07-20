import { AdapterRegistry } from "../adapter.js";
import { createEccAdapter, type EccLeanAdapterDeps } from "./ecc.js";
import { createSuperpowersAdapter, type SuperpowersAdapterDeps } from "./superpowers.js";

/**
 * The one assembly point that wires concrete D6 `FrameworkAdapter`s into an
 * {@link AdapterRegistry}. W4a registered the first (Superpowers, host-plugin);
 * W4b adds ECC Lean (upstream-local-installer). Later W4 work packages (gstack,
 * gsd-core) add their own `create<Framework>Adapter` factory in a sibling module
 * and register it here too; `BindingRegistryDeps` WIDENS additively (a merged
 * shape covering every adapter's construction deps) as they land, not replaced —
 * matching the rest of Project Framework Binding.
 *
 * Deliberately NOT exported from `plan`/`provision`/etc: this module only
 * assembles a registry from deps; it carries no CLI wiring and no policy of
 * its own (that stays in each adapter).
 */

/**
 * Shared construction deps for every registered adapter. The shared fields
 * (`root`/`runner`/`env`/`cacheHome`/`timeoutMs`) live on {@link SuperpowersAdapterDeps};
 * this shape widens to also carry ECC's adapter-specific optionals (`installer`,
 * `installPreview`). Both factories accept this merged shape (each ignores fields
 * it does not use).
 */
export type BindingRegistryDeps = SuperpowersAdapterDeps &
  Pick<EccLeanAdapterDeps, "installer" | "installPreview">;

/** Build an {@link AdapterRegistry} with every currently-implemented D6 adapter registered. */
export function createBindingAdapterRegistry(deps: BindingRegistryDeps): AdapterRegistry {
  const registry = new AdapterRegistry();
  registry.register(createSuperpowersAdapter(deps));
  registry.register(createEccAdapter(deps));
  return registry;
}
