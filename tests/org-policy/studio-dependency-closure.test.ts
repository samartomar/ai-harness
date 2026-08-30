import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";
import { eccModuleDependencyIds } from "../../src/ecc/evidence.js";
import { type PolicyStudioModel, policyStudioModel } from "../../src/org-policy/studio-model.js";
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

function assetClosure(rootIds: readonly string[]): string[] {
  const selected = new Set(rootIds);
  const pending = [...rootIds];
  while (pending.length > 0) {
    const id = pending.shift();
    const asset = ecc?.assets.find((candidate) => candidate.id === id);
    if (asset === undefined) throw new Error(`expected ECC asset ${id}`);
    for (const required of [...(asset.dependencies ?? []), ...(asset.riders ?? [])]) {
      if (selected.has(required)) continue;
      selected.add(required);
      pending.push(required);
    }
  }
  return [...selected];
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

  it("makes a whole-module semantic component visibly require its containing module", () => {
    const asset = ecc.assets.find(
      (candidate) =>
        candidate.kind !== "module" &&
        candidate.dependencies?.some((dependency) => dependency.startsWith("module:")),
    );
    if (asset === undefined) throw new Error("expected a semantic whole-module ECC component");

    const window = studio();
    click(window, `[data-framework-select="ecc|${asset.kind}|${asset.id}"]`);

    expect(selectedIds(window).sort()).toEqual(assetClosure([asset.id]).sort());
    for (const dependency of asset.dependencies ?? []) {
      expect(
        window.document
          .querySelector(`[data-framework-select="ecc|module|${dependency}"]`)
          ?.getAttribute("aria-pressed"),
        `${dependency} is visibly selected with ${asset.id}`,
      ).toBe("true");
    }
    window.close();
  });

  it("selects and visibly checks every transitive module dependency in one change", () => {
    const window = studio();
    const module = ecc.assets.find(
      (asset) => asset.kind === "module" && (asset.dependencies?.length ?? 0) >= 3,
    );
    if (module === undefined)
      throw new Error("expected an ECC module with transitive dependencies");

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

  it("refuses removal of a required module and prunes derived modules with the root", () => {
    const window = studio();
    const module = ecc.assets.find(
      (asset) => asset.kind === "module" && (asset.dependencies?.length ?? 0) >= 3,
    );
    if (module === undefined) throw new Error("expected an ECC module with dependencies");
    const dependency = module.dependencies?.[0];
    if (dependency === undefined) throw new Error("expected a module dependency");

    click(window, `[data-framework-select="ecc|module|${module.id}"]`);
    click(window, `[data-framework-select="ecc|module|${dependency}"]`);
    expect(selectedIds(window).sort()).toEqual(assetClosure([module.id]).sort());
    expect(window.document.getElementById("announcement")?.textContent).toMatch(
      /cannot be deselected.*requires it/i,
    );

    click(window, `[data-framework-select="ecc|module|${module.id}"]`);
    expect(selectedIds(window)).toEqual([]);
    window.close();
  });

  it("retains shared dependencies while another selected root still requires them", () => {
    const modules = ecc.assets.filter(
      (asset) => asset.kind === "module" && (asset.dependencies?.length ?? 0) > 0,
    );
    const pair = modules
      .flatMap((first, index) => modules.slice(index + 1).map((second) => ({ first, second })))
      .find(({ first, second }) =>
        (first.dependencies ?? []).some((dependency) =>
          (second.dependencies ?? []).includes(dependency),
        ),
      );
    if (pair === undefined) throw new Error("expected ECC modules with a shared dependency");

    const window = studio();
    click(window, `[data-framework-select="ecc|module|${pair.first.id}"]`);
    click(window, `[data-framework-select="ecc|module|${pair.second.id}"]`);
    click(window, `[data-framework-select="ecc|module|${pair.first.id}"]`);

    expect(selectedIds(window).sort()).toEqual(assetClosure([pair.second.id]).sort());
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
