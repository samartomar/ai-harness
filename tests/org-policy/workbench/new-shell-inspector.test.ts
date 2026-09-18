/**
 * S4 (NEW-SHELL-PLAN.md §4): the item inspector moves into the new shell's
 * inspector rail. Every behavioural hook (`#workbench-detail-panel`,
 * `[data-workbench-panel-view]`, "Close details") keeps working there.
 */
import { afterEach, describe, expect, it } from "vitest";
import type { PolicyStudioModel } from "../../../src/org-policy/studio-model.js";
import { tinyStudioModel } from "../studio-test-fixture.js";
import { closeStudios, preview, studio } from "./shell-parity-harness.js";

afterEach(closeStudios);

function newShell(model: PolicyStudioModel = tinyStudioModel()) {
  return studio(model).window;
}

type Window = ReturnType<typeof newShell>;

function click(node: { dispatchEvent(event: unknown): boolean } | null, window: Window): void {
  if (node === null) throw new Error("expected a control");
  node.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
}

describe("new shell inspector rail", () => {
  it("mounts the item inspector in the inspector rail, outside the catalog", () => {
    const document = newShell().document;
    const inspector = document.getElementById("workbench-detail-panel");
    expect(inspector?.closest("#inspector-rail #wb-inspector-panel")).not.toBeNull();
    expect(inspector?.closest("#framework-rows")).toBeNull();
    expect(inspector?.querySelector("[data-workbench-panel-view='exposure']")).not.toBeNull();
    expect(document.getElementById("workbench-detail-title")?.textContent).toBe("Item details");
  });

  it("opens an item from a card and closes it without changing the policy", () => {
    const window = newShell();
    const document = window.document;
    const before = preview(window);
    const title = document.querySelector("button.workbench-row-title[data-workbench-expand-id]");
    const assetId = title?.getAttribute("data-workbench-expand-id");
    click(title, window);
    const inspector = document.getElementById("workbench-detail-panel");
    expect(inspector?.getAttribute("data-workbench-inspector-asset-id")).toBe(assetId);
    expect(inspector?.getAttribute("data-workbench-inspector-open")).toBe("true");
    const close = [...(inspector?.querySelectorAll("button") ?? [])].find(
      (button) => button.textContent === "Close details",
    );
    click(close ?? null, window);
    expect(inspector?.getAttribute("data-workbench-inspector-open")).toBe("false");
    expect(preview(window)).toBe(before);
  });

  it("switches inspector views from inside the rail", () => {
    const window = newShell();
    const document = window.document;
    const inspector = document.getElementById("workbench-detail-panel");
    click(inspector?.querySelector("[data-workbench-panel-view='exposure']") ?? null, window);
    expect(inspector?.getAttribute("data-workbench-inspector-view")).toBe("exposure");
    expect(inspector?.querySelector("[data-workbench-exposure-overview]")).not.toBeNull();
    click(inspector?.querySelector("[data-workbench-panel-view='draft']") ?? null, window);
    expect(inspector?.getAttribute("data-workbench-inspector-view")).toBe("draft");
  });

  it("reopens a closed inspector rail when an item opens", () => {
    const window = newShell();
    const document = window.document;
    const rail = document.getElementById("inspector-rail");
    click(document.querySelector("[data-close-inspector]"), window);
    expect(rail?.getAttribute("data-wb-rail-state")).toBe("closed");
    click(document.querySelector("button.workbench-row-title[data-workbench-expand-id]"), window);
    expect(rail?.getAttribute("data-wb-rail-state")).toBe("auto");
  });

  it("opens the evidence sheet from the Security tab", () => {
    const window = newShell();
    const document = window.document;
    click(document.querySelector("button.workbench-row-title[data-workbench-expand-id]"), window);
    const sheet = document.querySelector("#workbench-detail-panel .workbench-evidence-sheet");
    expect(sheet).not.toBeNull();
    const technical = sheet?.closest("details");
    if (technical !== null && technical !== undefined)
      (technical as unknown as { open: boolean }).open = false;
    click(document.querySelector("[data-wb-inspector-tab='security']"), window);
    if (technical !== null && technical !== undefined)
      expect((technical as unknown as { open: boolean }).open).toBe(true);
    expect(
      document.getElementById("wb-inspector-panel")?.getAttribute("data-wb-inspector-panel"),
    ).toBe("security");
  });

  it("writes hostile item text in the inspector as text, never as markup", () => {
    const model = tinyStudioModel();
    const hostile = '<img src=x onerror="globalThis.__pwned=1">';
    const asset = Object.values(model.workbenchBundle.assets)[0];
    if (asset === undefined) throw new Error("expected a fixture asset");
    asset.label = hostile;
    const window = newShell(model);
    const document = window.document;
    click(
      document.querySelector(`button.workbench-row-title[data-workbench-expand-id="${asset.id}"]`),
      window,
    );
    const inspector = document.getElementById("workbench-detail-panel");
    expect(inspector?.getAttribute("data-workbench-inspector-asset-id")).toBe(asset.id);
    expect(inspector?.querySelectorAll("img")).toHaveLength(0);
    expect(inspector?.textContent).toContain(hostile);
  });
});
