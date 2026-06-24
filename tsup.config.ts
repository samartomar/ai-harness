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
  dts: true,
  sourcemap: true,
  // Templates are pure TS string builders (no asset loading), so nothing to copy.
});
