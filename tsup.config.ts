import { defineConfig } from "tsup";

// cli.ts carries a leading `#!/usr/bin/env node` shebang which esbuild preserves
// on the entry chunk, so we do not inject a banner (that would also shebang index.js).
export default defineConfig({
  entry: { cli: "src/cli.ts", index: "src/index.ts" },
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
  // Templates are pure TS string builders (no asset loading), so nothing to copy.
});
