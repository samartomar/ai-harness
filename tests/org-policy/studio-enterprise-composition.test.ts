import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";
import { CORE_ECC_COMPONENTS, UPSTREAM_CORE_ECC_MODULE_IDS } from "../../src/ecc/components.js";
import { policyStudioModel } from "../../src/org-policy/studio-model.js";
import { policyStudioHtml } from "../../src/org-policy/studio-template.js";

const model = policyStudioModel();
const controls = [...model.catalog.mcp.map((item) => item.control), ...model.catalog.hooks];
const ecc = model.catalog.frameworks.find((framework) => framework.id === "ecc");
if (ecc === undefined) throw new Error("expected an ecc framework in the catalog");
const eccAssetIds = new Set(ecc.assets.map((asset) => asset.id));

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

function selectProfile(window: Window, value: string): void {
  const profile = window.document.getElementById("profile") as unknown as {
    value: string;
    dispatchEvent: (event: unknown) => boolean;
  } | null;
  if (profile === null) throw new Error("expected profile selector");
  profile.value = value;
  profile.dispatchEvent(new window.Event("change", { bubbles: true }));
}

function authoredPolicy(window: Window): {
  minimumPosture: string;
  governance: {
    catalog: { reviewed: { id: string }[] };
    activations: { candidate: string; state: string }[];
    externalCuration: unknown[];
  };
} {
  const preview = window.document.getElementById("config-preview") as unknown as {
    value: string;
  } | null;
  if (preview === null) throw new Error("expected authored policy preview");
  return JSON.parse(preview.value);
}

function compositionText(window: Window): string {
  const node = window.document.getElementById("composition-parts");
  if (node === null) throw new Error("workbench exposes no Enterprise composition");
  return node.textContent ?? "";
}

describe("policy studio enterprise composition", () => {
  const composition = model.catalog.enterpriseComposition;

  // Recorded product failure 2: Enterprise named a posture and exposed nothing,
  // so ECC Core, the language set and the security rule were invisible.
  it("carries the Enterprise composition in the model, derived from product constructors", () => {
    expect(composition.framework).toBe("ecc");
    const byId = new Map(composition.parts.map((part) => [part.id, part]));
    expect([...byId.keys()]).toEqual([
      "ecc-install-core",
      "aih-core-closure",
      "language",
      "security",
    ]);
    // Pinned against the product's own constants, not a literal, so a catalog
    // change fails here instead of silently renaming what "Core" means.
    expect(byId.get("ecc-install-core")?.componentIds).toEqual(
      UPSTREAM_CORE_ECC_MODULE_IDS.map((id) => `module:${id}`),
    );
    expect(byId.get("aih-core-closure")?.componentIds).toEqual([...CORE_ECC_COMPONENTS]);
    expect(byId.get("language")?.componentIds).toEqual(
      ecc.assets.filter((asset) => asset.kind === "lang").map((asset) => asset.id),
    );
    expect(byId.get("security")?.componentIds).toEqual(["capability:security", "module:security"]);
  });

  // A composition that named a component the pinned catalog does not contain
  // would be a claim about inventory that the inventory contradicts.
  it("names only components the pinned catalog actually contains", () => {
    for (const part of composition.parts) {
      expect(part.componentIds.length, part.id).toBeGreaterThan(0);
      expect(part.rule.length, `${part.id} states its derivation`).toBeGreaterThan(0);
      for (const id of part.componentIds) {
        expect(eccAssetIds.has(id), `${id} in ${part.id}`).toBe(true);
      }
    }
  });

  it("renders every part with its label, rule, count and members", () => {
    const text = compositionText(studio());
    for (const part of composition.parts) {
      expect(text, `${part.id} label`).toContain(part.label);
      expect(text, `${part.id} rule`).toContain(part.rule);
      for (const id of part.componentIds) expect(text, `${id} member`).toContain(id);
    }
    // Naming is not selection: nothing framework-owned has a projector.
    expect(text).toContain("no projector");
  });

  it("composes Enterprise into requested intent and states the composition", () => {
    const window = studio();
    selectProfile(window, "enterprise");
    const policy = authoredPolicy(window);
    expect(policy.minimumPosture).toBe("enterprise");
    expect(
      policy.governance.activations
        .filter((item) => item.state === "active")
        .map((item) => item.candidate)
        .sort(),
    ).toEqual(controls.map((control) => control.id).sort());
    const named = composition.parts.reduce((total, part) => total + part.componentIds.length, 0);
    const announcement = window.document.getElementById("announcement")?.textContent ?? "";
    expect(announcement).toContain(`${controls.length} AIH control`);
    expect(announcement).toContain(`${named} framework-owned component`);
    expect(announcement).toContain("not effective until runtime evaluation");
  });

  // Row 12's ruling: a preset must never author an audit record it did not
  // receive. Asserted directly rather than inferred from a count.
  it("authors no external curation when Enterprise is composed", () => {
    const window = studio();
    selectProfile(window, "enterprise");
    expect(authoredPolicy(window).governance.externalCuration).toEqual([]);
  });

  // Row 11 guard: exposing a composition must not disturb the full inventory.
  it("leaves the full framework inventory intact", () => {
    const window = studio();
    selectProfile(window, "enterprise");
    const rows =
      window.document.getElementById("framework-rows")?.querySelectorAll(".row").length ?? 0;
    expect(rows).toBe(
      model.catalog.frameworks.reduce((total, framework) => total + framework.assets.length, 0),
    );
  });
});
