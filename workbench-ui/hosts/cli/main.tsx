import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "../../src/App.js";
import type { WorkbenchHost } from "../../src/host.js";
import { queryNavigation } from "../../src/navigation.js";
import { readEmbeddedInput, save, sha256Hex } from "../shared.js";
import "../../src/styles.css";

/**
 * The CLI host: one self-contained file served by `npx @aihq/core --ui`. Its
 * input is embedded in the page, its request token arrives in the fragment,
 * and it therefore routes in the query so the fragment is never rewritten.
 */

function tokenFromFragment(fragment: string): string | undefined {
  const value = fragment.startsWith("#") ? fragment.slice(1) : fragment;
  return /^[a-f0-9]{64}$/.test(value) ? value : undefined;
}

/**
 * Captured once, at bootstrap. It is never re-read, never written back to the
 * URL, never stored, and never put in the DOM. The later GitHub intake work
 * sends it to the local server; nothing else may see it.
 */
const capturedRequestToken = tokenFromFragment(
  typeof location === "undefined" ? "" : location.hash,
);

export function requestToken(): string | undefined {
  return capturedRequestToken;
}

function start(): void {
  const root = document.getElementById("root");
  if (root === null) return;
  const input = readEmbeddedInput(document);
  if (input === undefined) return;
  const model = input.model as Record<string, unknown>;
  const host: WorkbenchHost = {
    capabilities: {
      boundPolicy: input.door === "user" && model.policySource !== undefined,
      // The control itself arrives with the intake outcome; the page omits it today.
      githubIntake: true,
    },
    navigation: queryNavigation(),
    sha256Hex,
    save,
  };
  if (new URLSearchParams(location.search).get("page") === null) {
    host.navigation.go(input.door === "user" ? "user" : "admin");
  }
  createRoot(root).render(
    <StrictMode>
      <App host={host} model={input.model} />
    </StrictMode>,
  );
}

start();
