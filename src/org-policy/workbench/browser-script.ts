import { createRequire } from "node:module";

const requireFromWorkbench = createRequire(import.meta.url);

/**
 * Loads the generated browser IIFE only when a server caller renders the
 * portable Workbench. Importing Core modules therefore never needs this
 * UI/package-lane artifact to exist.
 */
export function loadWorkbenchBrowserScript(): string {
  const generated = requireFromWorkbench("./bundle.generated.cjs") as unknown;
  if (typeof generated !== "string") {
    throw new Error("Generated Workbench browser script is invalid. Run npm run build:workbench.");
  }
  return generated;
}
