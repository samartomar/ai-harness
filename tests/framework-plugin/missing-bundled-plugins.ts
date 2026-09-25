import { fileURLToPath } from "node:url";
import type * as Loader from "../../src/framework-plugin/load-framework-plugin.js";

/**
 * A damaged `@aihq/core` install whose bundled plugin files are missing: since
 * the plugins ship inside Core (D71), the one route to
 * `framework-plugin-unavailable`. This directory stands in for that Core root: it
 * has no `packages/framework-*` beneath it. Tests of that refusal `vi.mock` the
 * loader with it, so they never depend on whether this checkout has built
 * `packages/*\/dist`. Calls that pass their own `access` are left unchanged. This
 * file imports no value from the module it helps mock.
 *
 * ```ts
 * vi.mock("../../src/framework-plugin/load-framework-plugin.js", async (importOriginal) => {
 *   const { withBundledPluginsMissing } = await import("./missing-bundled-plugins.js");
 *   return withBundledPluginsMissing(await importOriginal());
 * });
 * ```
 */
const CORE_ROOT_WITHOUT_BUNDLED_PLUGINS = fileURLToPath(new URL(".", import.meta.url));

export function withBundledPluginsMissing(actual: typeof Loader): typeof Loader {
  const missing = actual.bundledFrameworkPluginAccessV1(() => CORE_ROOT_WITHOUT_BUNDLED_PLUGINS);
  return {
    ...actual,
    loadFrameworkPluginV1: (frameworkId, options = {}) =>
      actual.loadFrameworkPluginV1(frameworkId, {
        ...options,
        access: options.access ?? missing,
      }),
  };
}
