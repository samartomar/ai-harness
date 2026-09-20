import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "../src/App.js";
import type { WorkbenchHost } from "../src/host.js";
import "../src/styles.css";

/**
 * The preview host. It behaves like the hosted site: no bound policy and no
 * GitHub intake, imports come through a file picker, files leave as downloads.
 */
const previewHost: WorkbenchHost = {
  capabilities: { boundPolicy: false, githubIntake: false },
  async sha256Hex(bytes) {
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  },
  save(file) {
    const url = URL.createObjectURL(new Blob([file.text], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = file.name;
    link.click();
    URL.revokeObjectURL(url);
  },
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
