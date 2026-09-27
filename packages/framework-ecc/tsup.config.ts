import { defineConfig } from "tsup";

// One ESM entry. `@aihq/core` is a peer: the plugin reaches Core only through
// `@aihq/core/framework-host`, resolved from the consumer's install at run time
// and never bundled, so the plugin always acts through the Core that loaded it.
export default defineConfig({
  entry: { index: "src/index.ts" },
  tsconfig: "tsconfig.json",
  format: ["esm"],
  target: "node20",
  platform: "node",
  outDir: "dist",
  clean: true,
  dts: false,
  sourcemap: false,
  minify: false,
  removeNodeProtocol: false,
  external: ["@aihq/core", "@aihq/core/framework-host"],
});
