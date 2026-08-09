import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";
import { policyStudioModel } from "../../src/org-policy/studio-model.js";
import { policyStudioHtml } from "../../src/org-policy/studio-template.js";

const model = policyStudioModel();
const ecc = model.catalog.frameworks.find((framework) => framework.id === "ecc");
const superpowers = model.catalog.frameworks.find((framework) => framework.id === "superpowers");
if (ecc === undefined || superpowers === undefined)
  throw new Error("expected both pinned frameworks in the catalog");
const aihControls = model.catalog.mcp.length + model.catalog.hooks.length;

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

function click(window: Window, selector: string): void {
  const node = window.document.querySelector(selector);
  if (node === null) throw new Error(`expected ${selector}`);
  node.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
}

function visibleGroups(window: Window): string[] {
  return [...window.document.querySelectorAll(".grp[data-owner]")]
    .filter((group) => !(group as unknown as { hidden: boolean }).hidden)
    .map((group) => group.querySelector("h2")?.textContent ?? "");
}

describe("policy studio owner ticker", () => {
  it("counts every owner's rows", () => {
    const window = studio();
    const chips = [...window.document.querySelectorAll("#owner-ticker [data-owner-focus]")].map(
      (button) => [button.getAttribute("data-owner-focus"), button.textContent?.trim()],
    );
    expect(chips).toEqual([
      ["all", `All ${aihControls + ecc.assets.length + superpowers.assets.length}`],
      ["AIH", `AIH ${aihControls}`],
      ["ECC", `ECC ${ecc.assets.length}`],
      ["Superpowers", `Superpowers ${superpowers.assets.length}`],
      ["You", "Your sources 0"],
    ]);
  });

  // Focus is a view. It must never touch the authored policy, or a focused
  // surface and the document it produces could disagree.
  it("focuses one surface without changing the policy", () => {
    const window = studio();
    const preview = () =>
      (window.document.getElementById("config-preview") as unknown as { value: string }).value;
    const before = preview();
    click(window, '[data-owner-focus="AIH"]');
    expect(visibleGroups(window)).toEqual([
      "AIH MCP servers",
      "AIH hooks",
      "Hook registrar",
      "Approval / evidence",
    ]);
    expect(preview(), "focus authored nothing").toBe(before);
    click(window, '[data-owner-focus="Superpowers"]');
    expect(visibleGroups(window)).toContain("Superpowers");
    expect(visibleGroups(window)).not.toContain("AIH MCP servers");
    click(window, '[data-owner-focus="all"]');
    expect(visibleGroups(window).length).toBeGreaterThan(10);
  });

  // The upcoming surfaces are declared rather than absent, so an administrator
  // is not left wondering whether the surface exists and is empty.
  it("declares the surfaces that are still coming", () => {
    const window = studio();
    const soon = window.document.querySelector("#owner-ticker .soon")?.textContent ?? "";
    expect(soon).toContain("VibeSec");
    expect(soon).toContain("Voice");
  });
});
