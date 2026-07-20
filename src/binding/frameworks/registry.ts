import { AdapterRegistry } from "../adapter.js";
import { createSuperpowersAdapter, type SuperpowersAdapterDeps } from "./superpowers.js";

/**
 * The one assembly point that wires concrete D6 `FrameworkAdapter`s into an
 * {@link AdapterRegistry}. W4a registers the first (and today, only) one —
 * Superpowers. Later W4 work packages (ecc, gstack, gsd-core) add their own
 * `create<Framework>Adapter` factory in a sibling module and register it
 * here too; `BindingRegistryDeps` is expected to WIDEN (a union or a merged
 * shape covering every adapter's construction deps) as they land, not to be
 * replaced — keep it additive, matching the rest of Project Framework Binding.
 *
 * Deliberately NOT exported from `plan`/`provision`/etc: this module only
 * assembles a registry from deps; it carries no CLI wiring and no policy of
 * its own (that stays in each adapter).
 */

/** Shared construction deps for every registered adapter. Today: just Superpowers'. */
export type BindingRegistryDeps = SuperpowersAdapterDeps;

/** Build an {@link AdapterRegistry} with every currently-implemented D6 adapter registered. */
export function createBindingAdapterRegistry(deps: BindingRegistryDeps): AdapterRegistry {
  const registry = new AdapterRegistry();
  registry.register(createSuperpowersAdapter(deps));
  return registry;
}
