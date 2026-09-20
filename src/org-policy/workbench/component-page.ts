import { createRequire } from "node:module";
import type { WorkbenchInputV1 } from "./engine/index.js";

const requireFromWorkbench = createRequire(import.meta.url);

const PLACEHOLDER = "__AIH_WORKBENCH_INPUT__";

/**
 * Loads the generated component page only when a server caller renders it, the
 * same way `browser-script.ts` loads the hand-built page's bundle. Importing
 * Core modules therefore never needs this UI/package-lane artifact to exist.
 */
function loadComponentPage(): string {
  let generated: unknown;
  try {
    generated = requireFromWorkbench("./component-page.generated.cjs") as unknown;
  } catch {
    throw new Error(
      "The generated component Workbench page is missing. Run npm run build:workbench.",
    );
  }
  if (typeof generated !== "string" || !generated.includes(PLACEHOLDER)) {
    throw new Error(
      "The generated component Workbench page is invalid. Run npm run build:workbench.",
    );
  }
  return generated;
}

/** Safe inside an HTML script element, and safe for a JavaScript string literal. */
function embeddedJson(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

/** The offline component page with this host's input embedded in it. */
export function componentWorkbenchHtml(input: WorkbenchInputV1): string {
  const json = embeddedJson(input);
  // A function replacement: `$&` and friends inside the model are literal text.
  return loadComponentPage().replace(PLACEHOLDER, () => json);
}
