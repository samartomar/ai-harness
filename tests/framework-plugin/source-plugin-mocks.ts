import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { fixtureDescriptorBytes } from "../../packages/framework-ecc/tests/context.js";
import type { FrameworkDescriptorLoadV1 } from "../../src/catalog-package/framework-descriptors.js";
import type { FrameworkIdV1 } from "../../src/framework-plugin/contract-v1.js";
import type { FrameworkPluginAccessV1 } from "../../src/framework-plugin/load-framework-plugin.js";

/**
 * Module-mock building blocks for tests that reach framework plugins through
 * deep Core call chains (policy projection, governed delivery, uninstall):
 * `vi.mock` the loader to read each plugin from this repository's package
 * source, and the descriptor loader to serve Catalog's exact ECC bytes. This
 * file imports no value from the modules it helps mock.
 *
 * ```ts
 * vi.mock("../../src/framework-plugin/load-framework-plugin.js", async (importOriginal) => {
 *   const actual = await importOriginal<typeof import("../../src/framework-plugin/load-framework-plugin.js")>();
 *   const { sourcePluginAccess } = await import("../framework-plugin/source-plugin-mocks.js");
 *   return { ...actual, loadFrameworkPluginV1: (id, options) =>
 *     actual.loadFrameworkPluginV1(id, { ...options, access: sourcePluginAccess(id) }) };
 * });
 * ```
 */

const PACKAGES = {
  ecc: "framework-ecc",
  superpowers: "framework-superpowers",
} as const satisfies Record<FrameworkIdV1, string>;

export function sourcePluginAccess(frameworkId: FrameworkIdV1): FrameworkPluginAccessV1 {
  const manifest = fileURLToPath(
    new URL(`../../packages/${PACKAGES[frameworkId]}/package.json`, import.meta.url),
  );
  return {
    importPlugin: () =>
      frameworkId === "ecc"
        ? import("../../packages/framework-ecc/src/index.js")
        : import("../../packages/framework-superpowers/src/index.js"),
    resolvePackageJson: () => manifest,
    resolveEntry: () => fileURLToPath(new URL("src/index.ts", pathToFileURL(manifest))),
    readFile: (path) => readFileSync(path),
    realpath: (path) => realpathSync(path),
    allowedRoots: () => [realpathSync(dirname(dirname(manifest)))],
    loadCatalogIdentities: async () => ({
      ok: false,
      refusal: { reason: "catalog-package-unavailable", detail: "not installed" },
    }),
  };
}

/** Catalog's exact ECC descriptor bytes, as Core's descriptor loader returns them. */
export function eccDescriptorLoad(): FrameworkDescriptorLoadV1 {
  const bytes = fixtureDescriptorBytes();
  return {
    ok: true,
    frameworkId: "ecc",
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}
