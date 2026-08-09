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

const planeCount = (framework: (typeof frameworks)[number]): number =>
  framework.assets.filter(
    (asset) =>
      framework.id !== "ecc" || !["lang", "framework", "capability", "module"].includes(asset.kind),
  ).length;

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
    supportedClis: ["claude"];
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
          supportedClis: ["claude"],
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

  // Once a framework is chosen the other one leaves the plane: a policy that
  // cannot select it should not present it as inventory to work through. This
  // is scoping by an explicit reversible choice, not hiding for want of
  // enforcement, so the count and the way back are both stated.
  it("takes the other framework out of the plane and states the count", () => {
    const window = studio();
    click(window, selectKey(ecc, eccAsset));
    expect(window.document.querySelectorAll("#framework-rows .row").length).toBe(planeCount(ecc));
    const notice = window.document.querySelector("[data-framework-notice]")?.textContent ?? "";
    expect(notice).toContain(String(planeCount(superpowers)));
    expect(notice.toLowerCase()).toContain("one framework at a time");
    expect(notice).toContain("Clear");
  });

  it("scopes to Superpowers when Superpowers is chosen first", () => {
    const window = studio();
    click(window, selectKey(superpowers, spAsset));
    expect(window.document.querySelectorAll("#framework-rows .row").length).toBe(
      planeCount(superpowers),
    );
    const notice = window.document.querySelector("[data-framework-notice]")?.textContent ?? "";
    expect(notice).toContain(String(planeCount(ecc)));
  });

  // The excluded framework stays reachable through search, so the refusal has
  // to hold on that path too rather than relying on the row simply being gone.
  it("still refuses the excluded framework from its drawer", () => {
    const window = studio();
    click(window, selectKey(ecc, eccAsset));
    click(window, "#seek");
    const query = window.document.getElementById("spot-q") as unknown as {
      value: string;
      dispatchEvent: (event: unknown) => boolean;
    } | null;
    if (query === null) throw new Error("expected the spotlight input");
    query.value = spAsset.id;
    query.dispatchEvent(new window.Event("input", { bubbles: true }));
    click(window, "#hits .hit");
    const add = window.document.querySelector("#drawer-detail [data-framework-select]");
    expect(add, "the drawer still offers the item").not.toBeNull();
    add?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    const groups = selections(window);
    expect(groups, "policy still holds exactly one framework").toHaveLength(1);
    expect(groups[0]?.framework).toBe("ecc");
    expect(announcement(window).toLowerCase()).toContain("one framework at a time");
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
    expect(policy.minimumPosture).toBe("vibe");
    expect(announcement(window).toLowerCase()).toContain("cleared");
  });

  it("changes posture without rewriting selected components", () => {
    const window = studio();
    click(window, selectKey(ecc, eccAsset));
    click(window, `[data-sanctioned-cli="claude"]`);
    const before = structuredClone(selections(window));
    const sanctionedBefore = structuredClone(authored(window).governance.supportedClis);
    const posture = window.document.getElementById("posture");
    if (posture === null) throw new Error("expected posture control");
    (posture as unknown as { value: string }).value = "enterprise";
    posture.dispatchEvent(new window.Event("change", { bubbles: true }));

    expect(authored(window).minimumPosture).toBe("enterprise");
    expect(selections(window)).toEqual(before);
    expect(authored(window).governance.supportedClis).toEqual(sanctionedBefore);
    expect(window.document.querySelector('option[value="team"]')).toBeNull();
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
