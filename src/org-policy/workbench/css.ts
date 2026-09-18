import { createRequire } from "node:module";

const requireFromWorkbench = createRequire(import.meta.url);

/**
 * Loads the generated workbench design-foundation CSS (tokens + compiled
 * Tailwind utilities, see tools/build-workbench.mjs) only when a server
 * caller renders the portable Workbench. Importing Core modules therefore
 * never needs this UI/package-lane artifact to exist.
 */
export function loadWorkbenchCss(): string {
  const generated = requireFromWorkbench("./css.generated.cjs") as unknown;
  if (typeof generated !== "string") {
    throw new Error("Generated Workbench CSS is invalid. Run npm run build:workbench.");
  }
  return generated;
}
