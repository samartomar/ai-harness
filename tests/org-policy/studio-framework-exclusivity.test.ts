import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";
import { parseOrgPolicy } from "../../src/org-policy/schema.js";
import { defaultStudioPolicy, policyStudioModel } from "../../src/org-policy/studio-model.js";
import { policyStudioHtml } from "../../src/org-policy/studio-template.js";

const model = policyStudioModel();
const frameworks = model.catalog.frameworks;
const ecc = frameworks.find((item) => item.id === "ecc");
const superpowers = frameworks.find((item) => item.id === "superpowers");
if (ecc === undefined || superpowers === undefined)
  throw new Error("expected both pinned frameworks in the catalog");

const eccAsset = ecc.assets[0];
const spAsset = superpowers.assets[0];
if (eccAsset === undefined || spAsset === undefined)
  throw new Error("expected both frameworks to carry assets");

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

interface Authored {
  minimumPosture: string;
  governance: {
    catalog: { reviewed: { id: string }[]; custom: unknown[] };
    activations: unknown[];
    externalSelections: Array<{ framework: string; items: Array<{ id: string }> }>;
    externalCuration: unknown[];
  };
}

function authored(window: Window): Authored {
  const preview = window.document.getElementById("config-preview") as unknown as {
    value: string;
  } | null;
  if (preview === null) throw new Error("expected authored policy preview");
  return JSON.parse(preview.value);
}

function announcement(window: Window): string {
  return window.document.getElementById("announcement")?.textContent ?? "";
}

function selectKey(framework: { id: string }, asset: { kind: string; id: string }): string {
  return `[data-framework-select="${framework.id}|${asset.kind}|${asset.id}"]`;
}

function click(window: Window, selector: string): void {
  const node = window.document.querySelector(selector);
  if (node === null) throw new Error(`expected ${selector}`);
  node.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
}

function selections(window: Window): Array<{ framework: string; items: Array<{ id: string }> }> {
  return authored(window).governance.externalSelections;
}

describe("policy studio framework exclusivity", () => {
  // The grammar already says "only one framework intent may be active at a
  // time" for framework candidates. A policy that selects components from two
  // pinned frameworks at once is the same contradiction one level down.
  it("rejects selections drawn from two frameworks at once", () => {
    const policy = defaultStudioPolicy();
    const governance = policy.governance;
    if (governance === undefined) throw new Error("expected default studio governance");
    expect(() =>
      parseOrgPolicy({
        ...policy,
        governance: {
          ...governance,
          externalSelections: [
            {
              framework: "ecc",
              items: [{ kind: eccAsset.kind, id: eccAsset.id, source: { ...eccAsset.source } }],
            },
            {
              framework: "superpowers",
              items: [{ kind: spAsset.kind, id: spAsset.id, source: { ...spAsset.source } }],
            },
          ],
        },
      }),
    ).toThrow(/one framework/i);
  });

  it("refuses a Superpowers selection while ECC is selected, and says why", () => {
    const window = studio();
    click(window, selectKey(ecc, eccAsset));
    expect(selections(window)).toHaveLength(1);
    click(window, selectKey(superpowers, spAsset));
    const groups = selections(window);
    expect(groups, "policy still holds exactly one framework").toHaveLength(1);
    expect(groups[0]?.framework).toBe("ecc");
    expect(announcement(window).toLowerCase()).toContain("one framework");
  });

  it("refuses an ECC selection while Superpowers is selected", () => {
    const window = studio();
    click(window, selectKey(superpowers, spAsset));
    click(window, selectKey(ecc, eccAsset));
    const groups = selections(window);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.framework).toBe("superpowers");
  });

  // Ownership annotates a row; it never removes one. A framework that cannot
  // currently be selected stays fully listed and fully inspectable.
  it("keeps the excluded framework's inventory visible", () => {
    const window = studio();
    click(window, selectKey(ecc, eccAsset));
    const rows = window.document.querySelectorAll("#framework-rows .row");
    expect(rows.length).toBe(ecc.assets.length + superpowers.assets.length);
    const text = window.document.getElementById("framework-rows")?.textContent ?? "";
    for (const asset of superpowers.assets) expect(text).toContain(asset.id);
  });

  // Acceptance demonstration step 3 opens with "Reset, select Enterprise, ...".
  it("clears every selection back to the starting policy", () => {
    const window = studio();
    click(window, '[data-preset="vibe"]');
    expect(selections(window).length).toBeGreaterThan(0);
    expect(authored(window).governance.catalog.reviewed.length).toBeGreaterThan(0);
    click(window, "#clear-policy");
    const policy = authored(window);
    expect(policy.governance.externalSelections).toEqual([]);
    expect(policy.governance.catalog.reviewed).toEqual([]);
    expect(policy.governance.activations).toEqual([]);
    expect(policy.governance.externalCuration).toEqual([]);
    expect(policy.minimumPosture).toBe("team");
    expect(announcement(window).toLowerCase()).toContain("cleared");
  });

  it("lets the other framework be selected once the policy is cleared", () => {
    const window = studio();
    click(window, selectKey(ecc, eccAsset));
    click(window, "#clear-policy");
    click(window, selectKey(superpowers, spAsset));
    const groups = selections(window);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.framework).toBe("superpowers");
  });

  // Vibe means "everything this catalog offers", which the exclusivity rule
  // now bounds to one framework. It must compose the whole of that framework
  // and state what it left out rather than silently dropping it.
  it("composes Vibe within a single framework and states the exclusion", () => {
    const window = studio();
    click(window, '[data-preset="vibe"]');
    const groups = selections(window);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.framework).toBe("ecc");
    expect(groups[0]?.items).toHaveLength(ecc.assets.length);
    const text = announcement(window);
    expect(text).toContain(`${superpowers.assets.length}`);
    expect(text.toLowerCase()).toContain("one framework");
  });

  it("composes Vibe into the framework already in play", () => {
    const window = studio();
    click(window, selectKey(superpowers, spAsset));
    click(window, '[data-preset="vibe"]');
    const groups = selections(window);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.framework).toBe("superpowers");
    expect(groups[0]?.items).toHaveLength(superpowers.assets.length);
  });
});
