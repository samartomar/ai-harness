import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { parseWorkbenchInput } from "../../../src/org-policy/workbench/engine/index.js";
import { App } from "../../src/App.js";
import type { WorkbenchHost } from "../../src/host.js";
import { fragmentNavigation } from "../../src/navigation.js";
import { save, sha256Hex, showInputFailure } from "../shared.js";
import "../../src/styles.css";

/**
 * The hosted site: a static build with no bound policy and no connected
 * feature. Its input is one same-origin relative file next to the page.
 */

const hostedHost: WorkbenchHost = {
  capabilities: { boundPolicy: false, githubIntake: false },
  navigation: fragmentNavigation(),
  sha256Hex,
  save,
};

async function start(): Promise<void> {
  const root = document.getElementById("root");
  if (root === null) return;
  let value: unknown;
  try {
    const response = await fetch("./workbench-input.json");
    if (!response.ok) throw new Error("not ok");
    value = await response.json();
  } catch {
    showInputFailure(document, "This site could not load its Workbench input.");
    return;
  }
  const parsed = parseWorkbenchInput(value);
  if (!parsed.ok) {
    showInputFailure(document, parsed.errors.join(" "));
    return;
  }
  createRoot(root).render(
    <StrictMode>
      <App host={hostedHost} model={parsed.value.model} />
    </StrictMode>,
  );
}

void start();
