import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";
import { eccModuleDependencyIds } from "../../src/ecc/evidence.js";
import { policyStudioModel, type PolicyStudioModel } from "../../src/org-policy/studio-model.js";
import { policyStudioHtml } from "../../src/org-policy/studio-template.js";

const model = policyStudioModel();
const ecc = model.catalog.frameworks.find((framework) => framework.id === "ecc");
if (ecc === undefined) throw new Error("expected an ECC framework");

function studio(studioModel: PolicyStudioModel = model): Window {
  const window = new Window({ url: "http://localhost/" });
  const html = policyStudioHtml(studioModel);
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

function selectedIds(window: Window): string[] {
  const preview = window.document.getElementById("config-preview") as unknown as {
    value: string;
  } | null;
  if (preview === null) throw new Error("expected policy preview");
  const policy = JSON.parse(preview.value) as {
    governance: { externalSelections: Array<{ items: Array<{ id: string }> }> };
  };
  return policy.governance.externalSelections.flatMap((group) =>
    group.items.map((item) => item.id),
  );
}

describe("policy studio dependency-closed selection", () => {
  it("carries the pinned transitive dependency closure on every ECC module", () => {
    const moduleAssets = ecc.assets.filter((asset) => asset.kind === "module");
    expect(moduleAssets.length).toBeGreaterThan(0);
    for (const asset of moduleAssets) {
      const moduleId = asset.id.slice("module:".length);
      expect(asset.dependencies ?? [], asset.id).toEqual(
        eccModuleDependencyIds(moduleId).map((id) => `module:${id}`),
      );
    }
  });

  it("selects and visibly checks every transitive module dependency in one change", () => {
    const window = studio();
    const module = ecc.assets.find(
      (asset) => asset.kind === "module" && (asset.dependencies?.length ?? 0) >= 3,
    );
    if (module === undefined) throw new Error("expected an ECC module with transitive dependencies");

    click(window, `.rail [data-framework-select="ecc|module|${module.id}"]`);

    const expected = [module.id, ...(module.dependencies ?? [])].sort();
    expect(selectedIds(window).sort()).toEqual(expected);
    for (const id of expected) {
      const key = `ecc|module|${id}`;
      expect(
        window.document
          .querySelector(`.rail [data-framework-select="${key}"]`)
          ?.getAttribute("aria-pressed"),
        `${id} is checked in the ECC module rail`,
      ).toBe("true");
      expect(
        window.document
          .querySelector(`#framework-rows [data-framework-select="${key}"]`)
          ?.getAttribute("aria-pressed"),
        `${id} is checked in the canonical inventory`,
      ).toBe("true");
    }
    expect(window.document.getElementById("announcement")?.textContent).toContain(
      `${module.dependencies?.length ?? 0} required component`,
    );
    window.close();
  });

  it("rejects a policy that omits a selected module dependency", () => {
    const partialModel = structuredClone(model);
    const module = ecc.assets.find(
      (asset) => asset.kind === "module" && (asset.dependencies?.length ?? 0) > 0,
    );
    if (module === undefined) throw new Error("expected an ECC module dependency");
    partialModel.initialPolicy.governance?.externalSelections.push({
      framework: "ecc",
      items: [{ kind: module.kind, id: module.id, source: { ...module.source } }],
    });

    const window = studio(partialModel);
    click(window, "#validate");

    expect(window.document.getElementById("announcement")?.textContent).toMatch(
      /validation failed.*requires.*module:/i,
    );
    window.close();
  });
});
