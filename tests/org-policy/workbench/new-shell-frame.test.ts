/**
 * S1 (NEW-SHELL-PLAN.md §4): the new admin shell frame and screen router,
 * behind the dual-shell switch. The legacy shell stays the default.
 */
import { TextEncoder } from "node:util";
import { Window } from "happy-dom";
import { afterEach, describe, expect, it } from "vitest";
import type { PolicyStudioModel } from "../../../src/org-policy/studio-model.js";
import { policyStudioHtml } from "../../../src/org-policy/studio-template.js";
import {
  isWorkbenchScreen,
  resolveWorkbenchShell,
  WORKBENCH_SCREENS,
} from "../../../src/org-policy/workbench/ui/shell/screens.js";
import { tinyStudioModel } from "../studio-test-fixture.js";

const windows = new Set<Window>();

afterEach(async () => {
  await Promise.all([...windows].map((window) => window.happyDOM.close()));
  windows.clear();
});

function open(model: PolicyStudioModel, url = "http://localhost/"): Window {
  const window = new Window({ url });
  windows.add(window);
  const html = policyStudioHtml(model);
  window.document.write(html);
  Object.defineProperty(window, "crypto", { configurable: true, value: globalThis.crypto });
  Object.defineProperty(window, "TextEncoder", { configurable: true, value: TextEncoder });
  (window as unknown as { structuredClone: typeof structuredClone }).structuredClone =
    structuredClone;
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gi)].map((match) => match[1]);
  if (scripts.length === 0) throw new Error("expected generated workbench script");
  window.eval(scripts.join("\n"));
  return window;
}

function click(window: Window, selector: string): void {
  const node = window.document.querySelector(selector);
  if (node === null) throw new Error(`expected ${selector}`);
  node.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
}

function newShellModel(): PolicyStudioModel {
  return { ...tinyStudioModel(), shell: "new" };
}

describe("dual-shell switch", () => {
  it("keeps the legacy shell as the default and lets the model or ?shell= choose", () => {
    expect(resolveWorkbenchShell(undefined, "")).toBe("legacy");
    expect(resolveWorkbenchShell("new", "")).toBe("new");
    expect(resolveWorkbenchShell("new", "?shell=legacy")).toBe("legacy");
    expect(resolveWorkbenchShell(undefined, "?shell=new")).toBe("new");
    expect(resolveWorkbenchShell(undefined, "?shell=%3Cb%3E")).toBe("legacy");
    expect(resolveWorkbenchShell("other", "")).toBe("legacy");
  });

  it("emits data-wb-shell on both pages and a lean root for the new shell", () => {
    const legacy = policyStudioHtml(tinyStudioModel());
    expect(legacy).toContain('<html lang="en" data-theme="light" data-wb-shell="legacy">');
    expect(legacy).toContain('id="framework-rows"');
    const next = policyStudioHtml(newShellModel());
    expect(next).toContain('<html lang="en" data-theme="light" data-wb-shell="new">');
    expect(next).toContain('<div id="wb-root" data-wb-shell="new"></div>');
    expect(next).not.toContain('id="framework-rows"');
    expect(next).toContain('<style id="wb-styles">');
  });

  it("renders the legacy workspace by default", () => {
    const window = open(tinyStudioModel());
    expect(window.document.getElementById("framework-rows")).not.toBeNull();
    expect(window.document.querySelector("[data-wb-screen]")).toBeNull();
  });
});

describe("new admin shell frame", () => {
  it("renders header, sub-header, nav rail, ledger, main and inspector", () => {
    const window = open(newShellModel());
    const document = window.document;
    expect(document.documentElement.getAttribute("data-wb-shell")).toBe("new");
    const root = document.getElementById("wb-root");
    expect(root?.getAttribute("data-wb-screen")).toBe("sources");
    expect(document.querySelector("[data-wb-header]")?.getAttribute("aria-label")).toBe(
      "Policy workbench toolbar",
    );
    expect(document.querySelector("[data-wb-subheader] #status")?.textContent).toBe(
      "Ready - no repository is required.",
    );
    expect(document.getElementById("announcement")?.getAttribute("aria-live")).toBe("polite");
    expect(document.getElementById("nav-rail")).not.toBeNull();
    expect(document.getElementById("inspector-rail")?.hasAttribute("data-wb-inspector")).toBe(true);
    expect(
      Object.fromEntries(
        [...document.querySelectorAll("[data-wb-screen-panel]")].map((panel) => [
          panel.getAttribute("data-wb-screen-panel"),
          panel.hasAttribute("hidden"),
        ]),
      ),
    ).toEqual(
      Object.fromEntries(WORKBENCH_SCREENS.map((screen) => [screen, screen !== "sources"])),
    );
    // The frame renders no legacy layout hooks.
    for (const retired of ["[data-view-tab]", ".bar", "#byo-actions", "#panel-author"])
      expect(document.querySelector(retired)).toBeNull();
    expect(document.querySelectorAll("#wb-root img, #wb-root script")).toHaveLength(0);
  });

  it("counts the prepared catalog per kind in the ledger", () => {
    const window = open(newShellModel());
    const tiles = [...window.document.querySelectorAll("[data-kind-ledger-tile]")].map((tile) => [
      tile.getAttribute("data-kind-ledger-tile"),
      tile.textContent,
    ]);
    expect(tiles).toEqual([
      ["skill", "Skills0%0/1selected"],
      ["command", "Command0%0/0selected"],
      ["agent", "Agents0%0/0selected"],
      ["mcp", "MCP servers0%0/1selected"],
      ["hook", "Hooks0%0/1selected"],
    ]);
  });

  it("routes between screens from the nav rail and the header", () => {
    const window = open(newShellModel());
    const document = window.document;
    const root = document.getElementById("wb-root");
    const changes: string[] = [];
    root?.addEventListener("aih-workbench-screen-change", (event) => {
      changes.push((event as unknown as { detail: { screen: string } }).detail.screen);
    });
    click(window, '#nav-rail [data-wb-nav="scan"]');
    expect(root?.getAttribute("data-wb-screen")).toBe("scan");
    expect(document.querySelector('[data-wb-screen-panel="scan"]')?.hasAttribute("hidden")).toBe(
      false,
    );
    expect(document.querySelector('[data-wb-screen-panel="sources"]')?.hasAttribute("hidden")).toBe(
      true,
    );
    expect(
      document.querySelector('#nav-rail [data-wb-nav="scan"]')?.getAttribute("aria-current"),
    ).toBe("page");
    expect(
      document.querySelector('#nav-rail [data-wb-nav="sources"]')?.hasAttribute("aria-current"),
    ).toBe(false);
    click(window, '[data-wb-header] [data-wb-nav="changes"]');
    expect(root?.getAttribute("data-wb-screen")).toBe("changes");
    click(window, '[data-wb-header] [data-wb-nav="changes"]');
    expect(changes).toEqual(["scan", "changes"]);
  });

  it("names every screen and rejects an unknown one", () => {
    expect(WORKBENCH_SCREENS).toEqual(["sources", "item", "changes", "scan", "org", "acme"]);
    expect(isWorkbenchScreen("org")).toBe(true);
    expect(isWorkbenchScreen("compose")).toBe(false);
    expect(isWorkbenchScreen(undefined)).toBe(false);
  });

  it("toggles the theme with the same accessible names as the legacy toolbar", () => {
    const window = open(newShellModel());
    const document = window.document;
    const toggle = document.getElementById("theme-toggle");
    expect(toggle?.getAttribute("aria-label")).toBe("Switch to dark theme");
    click(window, "#theme-toggle");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(toggle?.getAttribute("aria-label")).toBe("Switch to light theme");
    click(window, "#theme-toggle");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("switches inspector tabs and closes the rails", () => {
    const window = open(newShellModel());
    const document = window.document;
    click(window, '[data-wb-inspector-tab="security"]');
    expect(
      [...document.querySelectorAll("[data-wb-inspector-tab]")].map((tab) =>
        tab.getAttribute("aria-selected"),
      ),
    ).toEqual(["false", "true", "false"]);
    expect(
      document.getElementById("wb-inspector-panel")?.getAttribute("data-wb-inspector-panel"),
    ).toBe("security");
    click(window, "[data-close-inspector]");
    expect(document.getElementById("inspector-rail")?.getAttribute("data-wb-rail-state")).toBe(
      "closed",
    );
    click(window, "#toggle-nav-btn");
    expect(document.getElementById("nav-rail")?.getAttribute("data-wb-rail-state")).toBe("closed");
    expect(document.getElementById("toggle-nav-btn")?.getAttribute("aria-expanded")).toBe("false");
  });

  it("replaces the legacy markup when a legacy page is opened with ?shell=new", () => {
    const window = open(tinyStudioModel(), "http://localhost/?shell=new");
    const document = window.document;
    expect(document.documentElement.getAttribute("data-wb-shell")).toBe("new");
    expect(document.getElementById("wb-root")?.getAttribute("data-wb-screen")).toBe("sources");
    expect(document.getElementById("framework-rows")).toBeNull();
    expect(document.querySelectorAll("#wb-root")).toHaveLength(1);
    expect([...document.querySelectorAll("style")].map((style) => style.id)).toEqual(["wb-styles"]);
  });
});
