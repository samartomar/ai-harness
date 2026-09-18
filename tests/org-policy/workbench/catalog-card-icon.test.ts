import { type HTMLElement, Window } from "happy-dom";
import { afterEach, describe, expect, it } from "vitest";
import { policyStudioHtml } from "../../../src/org-policy/studio-template.js";
import { tinyStudioModel } from "../studio-test-fixture.js";

const openWindows = new Set<Window>();

function studio(): Window {
  const window = new Window({ url: "http://localhost/" });
  const html = policyStudioHtml(tinyStudioModel());
  window.document.write(html);
  (window as unknown as { structuredClone: typeof structuredClone }).structuredClone =
    structuredClone;
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gi)].map((match) => match[1]);
  if (scripts.length === 0) throw new Error("expected generated workbench script");
  window.eval(scripts.join("\n"));
  openWindows.add(window);
  return window;
}

afterEach(async () => {
  await Promise.all([...openWindows].map((window) => window.happyDOM.close()));
  openWindows.clear();
});

describe("catalog card kind icon (P3.1)", () => {
  it("adds one decorative kind icon per card without changing the title's name", () => {
    const model = tinyStudioModel();
    const window = studio();
    const rows = [
      ...window.document.querySelectorAll<HTMLElement>(
        ".workbench-inventory-rows article.workbench-asset",
      ),
    ];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const asset = model.workbenchBundle.assets[row.dataset.workbenchAssetId ?? ""];
      if (asset === undefined) throw new Error("expected a bundle asset for every card");
      const icons = row.querySelectorAll(".workbench-row-icon");
      expect(icons).toHaveLength(1);
      const icon = icons[0] as HTMLElement;
      expect(icon.getAttribute("aria-hidden")).toBe("true");
      expect(icon.querySelector("svg")).not.toBeNull();
      expect(icon.textContent).toBe("");
      if (["skill", "command", "agent", "mcp", "hook"].includes(asset.kind))
        expect(icon.classList.contains(`wb-primitive-${asset.kind}`)).toBe(true);
      const title = row.querySelector<HTMLElement>(
        "button.workbench-row-title[data-workbench-expand-id]",
      );
      expect(title?.querySelector("svg")).toBeNull();
      expect(title?.textContent?.trim().length).toBeGreaterThan(0);
    }
  });
});
