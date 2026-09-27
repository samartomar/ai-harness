import { defineConfig } from "tsup";

// cli.ts carries a leading `#!/usr/bin/env node` shebang which esbuild preserves
// on the entry chunk, so we do not inject another shebang (including into index.js).
export default defineConfig({
  entry: {
    cli: "src/cli.ts",
    "ecc-runtime": "src/ecc-runtime.ts",
    index: "src/index.ts",
    // `@aihq/core/framework-host`: the versioned host API framework plugins import.
    "framework-host": "src/framework-host/index.ts",
  },
  format: ["esm"],
  target: "node20",
  platform: "node",
  outDir: "dist",
  clean: true,
  // Declarations come from `tsc -p tsconfig.dts.json` (see the build script), not tsup:
  // the vendored rollup-plugin-dts breaks against the TypeScript 7 compiler API (#365).
  dts: false,
  // The published tarball is the artifact that matters: minify the chunks (~1.3 MB → ~½)
  // and drop source maps (~2.6 MB that no CLI consumer debugs — local dev works from src/).
  // keepNames preserves function/class names so stack traces in bug reports stay readable.
  sourcemap: false,
  minify: true,
  keepNames: true,
  // The projected runtime keeps its ESM identity after its JS chunks are copied
  // outside the package, so ship a package marker beside those chunks.
  publicDir: "src/ecc-profile/runtime-package",
  //
  // The native ECC runtime (`ecc-runtime.js`) is executed from wherever it was
  // projected, outside the installed package and with no dependency closure
  // beside it — a bare dependency import in a shared chunk therefore fails ESM
  // resolution before the runtime handles any command (#611). Bundle zod and
  // yaml (used to validate Serena's owned config) so the
  // projected runtime is self-contained; the other runtime dependencies stay
  // external because nothing in that entry's graph reaches them, and
  // tests/ecc-profile/projected-runtime.test.ts fails if one ever does.
  noExternal: ["jsonc-parser", "zod", "yaml"],
  // @aihq/scan is an optional peer resolved from the consumer's own install and
  // loaded only through src/scan-package/load-scan-package.ts. Never bundle it:
  // a bundled copy would freeze one Scan build inside Core and defeat updating
  // Scan independently. It must never appear in `noExternal`.
  // @aihq/catalog is the same arrangement, loaded only through
  // src/catalog-package/load-catalog-package.ts; Core pins the descriptor bytes
  // it accepts from it, so a bundled copy would add nothing but a stale Catalog.
  // The framework plugins are not dependencies: each is built by its own
  // packages/*/tsup.config.ts, shipped beside dist/ in Core's tarball and imported
  // at run time from Core's own package root by
  // src/framework-plugin/load-framework-plugin.ts, so Core's chunks never carry
  // framework plugin code.
  external: ["@aihq/scan", "@aihq/catalog"],
  // YAML's bundled CommonJS distribution requires Node's built-in process module.
  // Keep that built-in resolution available in each standalone ESM chunk.
  banner: {
    js: 'import { createRequire as __aihCreateRequire } from "node:module"; const require = __aihCreateRequire(import.meta.url);',
  },
});
