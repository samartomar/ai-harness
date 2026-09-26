/**
 * Core command deps for tests that drive Core's governed delivery into this
 * package: the plugin read from package source, with its policy delivery built
 * over the ECC test seams, and Catalog's fixture descriptor bytes.
 */
import type { FrameworkCommandDepsV1 } from "../../../src/framework-plugin/run-framework-command.js";
import { loadEccFromSource } from "../../../tests/framework-plugin/plugin-source.js";
import { eccDescriptorLoad } from "../../../tests/framework-plugin/source-plugin-mocks.js";
import type { EccCommandDeps } from "../src/ecc/pipeline.js";
import { eccPolicyDelivery } from "../src/policy-delivery.js";

export function eccCoreDeps(deps: EccCommandDeps): FrameworkCommandDepsV1 {
  return {
    loadPlugin: async () => {
      const loaded = await loadEccFromSource();
      if (!loaded.ok) return loaded;
      return {
        ...loaded,
        plugin: { ...loaded.plugin, policyDelivery: eccPolicyDelivery(deps) },
      };
    },
    loadDescriptor: async () => eccDescriptorLoad(),
  };
}
