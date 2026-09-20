import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { previewFixture } from "./preview/fixture-plugin.js";

const uiRoot = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(uiRoot, "..");

/** The live preview of the component UI. The production targets arrive with the real hosts. */
export default defineConfig({
  root: uiRoot,
  plugins: [react(), previewFixture()],
  // Pre-bundled together, so a cold start never re-optimizes React mid-session.
  optimizeDeps: { include: ["react", "react-dom/client", "@radix-ui/react-dialog"] },
  server: {
    host: "127.0.0.1",
    port: 5179,
    strictPort: true,
    // The engine entry, the tokens and the fonts live under the repository's src/.
    fs: { allow: [repositoryRoot] },
  },
  build: { outDir: resolve(uiRoot, "dist"), emptyOutDir: true },
});
