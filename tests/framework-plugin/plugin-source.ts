import { readFileSync, realpathSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type FrameworkPluginAccessV1,
  type FrameworkPluginLoadV1,
  loadFrameworkPluginV1,
} from "../../src/framework-plugin/load-framework-plugin.js";

/**
 * Load the Superpowers plugin from this repository's package source through
 * Core's real loader, as an installed package would be loaded (Catalog not
 * installed). Test-only: production imports the installed package.
 */
export const SUPERPOWERS_MANIFEST = fileURLToPath(
  new URL("../../packages/framework-superpowers/package.json", import.meta.url),
);

export function superpowersSourceAccess(
  over: Partial<FrameworkPluginAccessV1> = {},
): FrameworkPluginAccessV1 {
  return {
    importPlugin: () => import("../../packages/framework-superpowers/src/index.js"),
    resolvePackageJson: () => SUPERPOWERS_MANIFEST,
    readFile: (path) => readFileSync(path),
    realpath: (path) => realpathSync(path),
    allowedRoots: () => [realpathSync(dirname(dirname(SUPERPOWERS_MANIFEST)))],
    loadCatalogIdentities: async () => ({
      ok: false,
      refusal: { reason: "catalog-package-unavailable", detail: "not installed" },
    }),
    ...over,
  };
}

export function loadSuperpowersFromSource(
  over: Partial<FrameworkPluginAccessV1> = {},
): Promise<FrameworkPluginLoadV1> {
  return loadFrameworkPluginV1("superpowers", { access: superpowersSourceAccess(over) });
}
