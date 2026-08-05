import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";
import { policyStudioModel } from "../../src/org-policy/studio-model.js";
import { policyStudioHtml } from "../../src/org-policy/studio-template.js";

const model = policyStudioModel();
const assets = model.catalog.frameworks.flatMap((framework) =>
  framework.assets.map((asset) => ({ framework, asset })),
);

function studio(): Window {
  const window = new Window({ url: "http://localhost/" });
  const html = policyStudioHtml(model);
  window.document.write(html);
  (window as unknown as { structuredClone: typeof structuredClone }).structuredClone =
    structuredClone;
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gi)].map((match) => match[1]);
  if (scripts.length === 0) throw new Error("expected generated workbench script");
  window.eval(scripts.join("\n"));
  return window;
}

/** Minimal structural view of a rendered row; the DOM lib is not in scope here. */
interface InventoryRow {
  textContent: string | null;
  querySelector(selector: string): { textContent: string | null } | null;
}

function inventory(window: Window): { rows: InventoryRow[]; text: string } {
  const container = window.document.getElementById("framework-rows");
  if (container === null) throw new Error("workbench renders no framework inventory");
  return {
    rows: [...container.querySelectorAll(".row")] as unknown as InventoryRow[],
    text: container.textContent ?? "",
  };
}

describe("policy studio framework inventory", () => {
  // Locked boundary: ownership annotates an item, it never removes one. Before
  // this, all 151 framework components fed a prefill dropdown and nothing else.
  it("presents every framework-owned component as visible inventory", () => {
    const { rows, text } = inventory(studio());
    expect(rows.length).toBe(assets.length);
    for (const { asset } of assets) {
      expect(text, `${asset.id} is missing from the inventory`).toContain(asset.id);
    }
  });

  // The status and reason asserted here changed with the corrected selection
  // model: `Unsupported` and `no projector` describe an AIH gate that fails,
  // and no third-party row has one. That was the contract change, not
  // collateral damage — see the acceptance contract's item 5.
  it("annotates every row with owner, status, reason and next action", () => {
    const { rows } = inventory(studio());
    for (const row of rows) {
      const text = row.textContent ?? "";
      expect(text, "owner").toMatch(/affaan-m\/ecc|obra\/Superpowers/);
      expect(row.querySelector(".badge")?.textContent ?? "", "status").toMatch(
        /Selectable|Selected/,
      );
      expect(text, "reason").toContain("installs and runs it");
      expect(
        row.querySelector("[data-framework-select]"),
        `next action for ${text.slice(0, 60)}`,
      ).not.toBeNull();
    }
  });

  // The kinds row 10 recovered are exactly the ones with no curation grammar.
  // They stay selectable anyway, and their evidence path is stated rather than
  // replaced by the dead end this row originally shipped.
  it("keeps kinds that policy cannot curate, with their evidence path stated", () => {
    const { text } = inventory(studio());
    for (const kind of ["module:", "lang:", "framework:", "capability:", "mcp:", "runtime:"]) {
      expect(text, `${kind} inventory`).toContain(kind);
    }
    expect(text).toContain("aih evidence vet-baseline");
  });

  it("makes the curatable next action real by prefilling the curation form", () => {
    const window = studio();
    const button = window.document.querySelector("[data-curation-prefill]");
    expect(button).not.toBeNull();
    const key = (button?.getAttribute("data-curation-prefill") ?? "").split("|");
    button?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    const value = (id: string) =>
      (window.document.getElementById(id) as unknown as { value: string } | null)?.value;
    expect(value("curation-framework")).toBe(key[0]);
    expect(value("curation-kind")).toBe(key[1]);
    expect(value("curation-id")).toBe(key[2]);
    expect(value("curation-repository")).toMatch(/affaan-m\/ecc|obra\/Superpowers/);
    expect(value("curation-commit")).toMatch(/^[0-9a-f]{40}$/);
    expect(value("curation-path") ?? "").not.toBe("");
  });
});
