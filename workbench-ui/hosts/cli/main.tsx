import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "../../src/App.js";
import type { WorkbenchGithubSkillHost, WorkbenchHost } from "../../src/host.js";
import { queryNavigation } from "../../src/navigation.js";
import { copyText, readEmbeddedInput, save, sha256Hex } from "../shared.js";
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

/**
 * Lane E (row 18): the GitHub Skill intake, against the local server's two
 * existing routes and no new one. The captured request token goes in the body,
 * exactly as `ui/artifact-intake-runtime.js` sends it; the token never reaches
 * the DOM, the engine, or a log. A refusal carries the server's own sentence.
 */
const RESOLVE_PATH = "/api/artifact-intake/github-skill/resolve";
const PREPARE_PATH = "/api/artifact-intake/github-skill/prepare";
const RESOLVE_TIMEOUT_MS = 10000;

async function callServer(path: string, body: Record<string, unknown>): Promise<unknown> {
  const token = requestToken();
  if (token === undefined) throw new Error("This page has no request token for the local server.");
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, RESOLVE_TIMEOUT_MS);
  try {
    const response = await fetch(path, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, ...body }),
      signal: controller.signal,
    });
    const payload: unknown = await response.json();
    if (!response.ok) {
      const error =
        payload !== null && typeof payload === "object"
          ? (payload as { error?: unknown }).error
          : undefined;
      throw new Error(
        typeof error === "string" && error.length > 0 && error.length <= 500
          ? error
          : "GitHub could not resolve this Skill request. This candidate remains unpinned and cannot be added.",
      );
    }
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

const githubSkill: WorkbenchGithubSkillHost = {
  resolve: (request) => callServer(RESOLVE_PATH, { ...request }),
  async prepare(request) {
    const prepared = await callServer(PREPARE_PATH, { ...request });
    // The server answered by re-rendering the page; the reload shows it.
    location.reload();
    return prepared;
  },
};

function start(): void {
  const root = document.getElementById("root");
  if (root === null) return;
  const input = readEmbeddedInput(document);
  if (input === undefined) return;
  const model = input.model as Record<string, unknown>;
  const host: WorkbenchHost = {
    capabilities: {
      boundPolicy: input.door === "user" && model.policySource !== undefined,
      // Only this host can reach the local server, and only with its token.
      githubIntake: requestToken() !== undefined,
    },
    githubSkill,
    navigation: queryNavigation(),
    sha256Hex,
    save,
    copyText,
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
