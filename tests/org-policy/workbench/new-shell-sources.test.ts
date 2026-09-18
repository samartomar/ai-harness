/**
 * S3 (NEW-SHELL-PLAN.md §4): the admin-sources screen of the new shell. The
 * catalog controller (catalog-inventory.ts) mounts in the sources screen with
 * the prototype's card markup and keeps every behavioural hook.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { PolicyStudioModel } from "../../../src/org-policy/studio-model.js";
import { tinyStudioModel } from "../studio-test-fixture.js";
import { closeStudios, preview, studio } from "./shell-parity-harness.js";

afterEach(closeStudios);

function newShell(model: PolicyStudioModel = tinyStudioModel()) {
  return studio({ ...model, shell: "new" }).window;
}

function click(node: { dispatchEvent(event: unknown): boolean } | null, window: Window): void {
  if (node === null) throw new Error("expected a control");
  node.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
}

type Window = ReturnType<typeof newShell>;

describe("new shell sources screen", () => {
  it("mounts the catalog in the sources screen as prototype cards", () => {
    const window = newShell();
    const document = window.document;
    const root = document.getElementById("framework-rows");
    expect(root?.closest('[data-wb-screen-panel="sources"]')).not.toBeNull();
    expect(root?.classList.contains("workbench-inventory")).toBe(true);
    expect(document.querySelector('[data-wb-pending-screen="sources"]')).toBeNull();
    const cards = document.querySelector("[data-wb-sources-cards]");
    expect(cards?.classList.contains("workbench-inventory-rows")).toBe(true);
    const articles = document.querySelectorAll("[data-wb-sources-cards] > article");
    expect(articles.length).toBeGreaterThan(0);
    for (const article of articles) {
      expect(article.getAttribute("data-workbench-asset-id")).not.toBeNull();
      expect(
        article.querySelector("button.workbench-row-title[data-workbench-expand-id]"),
      ).not.toBeNull();
      expect(article.querySelector("button[data-workbench-row-action]")).not.toBeNull();
    }
    expect(
      document.querySelector("[data-wb-sources-masthead] .workbench-source-review"),
    ).not.toBeNull();
    expect(
      document.querySelector("[data-workbench-source-rail] [data-workbench-source-tab]"),
    ).not.toBeNull();
    expect(document.querySelector("input[aria-label='Search catalog']")).not.toBeNull();
    expect(document.body.textContent).toContain("effective: not evaluated");
  });

  it("adds a card to the draft through the policy session and the ledger", () => {
    const window = newShell();
    const document = window.document;
    const before = preview(window);
    const ledgerBefore = document.querySelector("[data-wb-ledger]")?.textContent;
    const action = document.querySelector("button[data-workbench-row-action]") as unknown as {
      dispatchEvent(event: unknown): boolean;
      dataset: { workbenchAssetId?: string };
    };
    const assetId = action.dataset.workbenchAssetId;
    click(action, window);
    expect(preview(window)).not.toBe(before);
    expect(JSON.parse(preview(window)).schemaVersion).toBe(3);
    expect(document.querySelector("[data-wb-ledger]")?.textContent).not.toBe(ledgerBefore);
    expect(
      document.querySelector(`article[data-workbench-asset-id="${assetId}"]`)?.textContent,
    ).not.toContain("Status: Not in draft");
  });

  it("filters the cards by search and switches source tabs", () => {
    const window = newShell();
    const document = window.document;
    const first = document.querySelector("article[data-workbench-asset-id]");
    const id = first?.getAttribute("data-workbench-asset-id") ?? "";
    const search = document.querySelector("input[aria-label='Search catalog']") as unknown as {
      value: string;
      dispatchEvent(event: unknown): boolean;
    };
    search.value = "no-such-catalog-item";
    search.dispatchEvent(new window.Event("input", { bubbles: true }));
    expect(document.querySelectorAll("article[data-workbench-asset-id]")).toHaveLength(0);
    expect(document.getElementById("framework-rows")?.textContent).toContain(
      'No catalog items match "no-such-catalog-item"',
    );
    search.value = id;
    search.dispatchEvent(new window.Event("input", { bubbles: true }));
    expect(document.querySelector(`article[data-workbench-asset-id="${id}"]`)).not.toBeNull();
    const tab = document.querySelector("[data-workbench-source-tab]");
    click(tab, window);
    expect(tab?.getAttribute("aria-pressed")).toBe("true");
  });

  it("writes hostile catalog text as text, never as markup", () => {
    const model = tinyStudioModel();
    const hostile = '<img src=x onerror="globalThis.__pwned=1">';
    const asset = Object.values(model.workbenchBundle.assets)[0];
    if (asset === undefined) throw new Error("expected a fixture asset");
    asset.label = hostile;
    const window = newShell(model);
    expect(window.document.querySelectorAll("#wb-root img")).toHaveLength(0);
    expect(window.document.getElementById("framework-rows")?.textContent).toContain(hostile);
  });
});
