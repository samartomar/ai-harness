import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { save, sha256Hex } from "../hosts/shared.js";
import { App } from "../src/App.js";
import type { WorkbenchHost } from "../src/host.js";
import { fragmentNavigation } from "../src/navigation.js";
import "../src/styles.css";

/**
 * The preview host. It behaves like the hosted site: no bound policy and no
 * GitHub intake, imports come through a file picker, files leave as downloads.
 */
const previewHost: WorkbenchHost = {
  capabilities: { boundPolicy: false, githubIntake: false },
  navigation: fragmentNavigation(),
  sha256Hex,
  save,
};

async function start(): Promise<void> {
  const root = document.getElementById("root");
  if (root === null) throw new Error("The preview page has no root element.");
  const response = await fetch("/preview-fixture.json");
  const model: unknown = response.ok ? await response.json() : undefined;
  createRoot(root).render(
    <StrictMode>
      <App host={previewHost} model={model} />
    </StrictMode>,
  );
}

void start();
