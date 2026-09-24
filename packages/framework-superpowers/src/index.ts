import type { FrameworkPluginDescriptionV1, FrameworkPluginV1 } from "@aihq/core/framework-host";
import { executeSuperpowers, identifyComponents } from "./command.js";
import { hookInventory, planHookControls } from "./hooks.js";
import {
  CONTRACT_VERSION,
  HOST_API_VERSION,
  KIRO_STEERING_PATH,
  PACKAGE_NAME,
  PACKAGE_VERSION,
  REF_ENVIRONMENT_VARIABLE,
  SUPPORTED_HOSTS,
  UPSTREAM,
} from "./identity.js";

function describe(): FrameworkPluginDescriptionV1 {
  return {
    frameworkId: "superpowers",
    displayName: "Superpowers",
    upstream: { ...UPSTREAM },
    supportedHosts: [...SUPPORTED_HOSTS],
    catalogSubpath: "./catalog-framework-superpowers.json",
    descriptorSections: ["vendorLock", "hookControlInventory"],
    environment: [REF_ENVIRONMENT_VARIABLE],
    ownedArtifacts: [{ host: "kiro", path: KIRO_STEERING_PATH }],
  };
}

/** The framework plugin export `@aihq/core` loads (contract 1, C3). */
export const aihFrameworkPluginV1: FrameworkPluginV1 = Object.freeze({
  contractVersion: CONTRACT_VERSION,
  hostApiVersion: HOST_API_VERSION,
  frameworkId: "superpowers",
  packageName: PACKAGE_NAME,
  packageVersion: PACKAGE_VERSION,
  describe,
  identifyComponents,
  hookInventory,
  planHookControls,
  commands: Object.freeze({ superpowers: Object.freeze({ execute: executeSuperpowers }) }),
});
