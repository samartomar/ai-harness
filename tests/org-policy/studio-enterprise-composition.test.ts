import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";
import { CORE_ECC_COMPONENTS, UPSTREAM_CORE_ECC_MODULE_IDS } from "../../src/ecc/components.js";
import { policyStudioModel } from "../../src/org-policy/studio-model.js";
import { policyStudioHtml } from "../../src/org-policy/studio-template.js";

const model = policyStudioModel();
const controls = [
  ...model.catalog.mcp.filter((item) => item.availability === "always").map((item) => item.control),
  ...model.catalog.hooks,
];
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
  const preset = window.document.getElementById("preset-select") as unknown as {
    value: string;
    dispatchEvent(event: unknown): boolean;
  } | null;
  if (preset === null) throw new Error(`expected ${value} preset`);
  preset.value = value;
  preset.dispatchEvent(new window.Event("change", { bubbles: true }));
}

function authoredPolicy(window: Window): {
  minimumPosture: string;
  governance: {
    supportedClis: ["claude"];
    catalog: { reviewed: { id: string }[] };
    activations: { candidate: string; state: string }[];
    externalCuration: unknown[];
    externalSelections: Array<{
      framework: string;
      roots?: string[];
      items: Array<{ id: string }>;
    }>;
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

function selectedIds(window: Window): string[] {
  return authoredPolicy(window).governance.externalSelections.flatMap((group) =>
    group.items.map((item) => item.id),
  );
}

function eccSelectionClosure(rootIds: readonly string[]): string[] {
  const selected = new Set(rootIds);
  const pending = [...rootIds];
  while (pending.length > 0) {
    const id = pending.shift();
    const asset = ecc?.assets.find((candidate) => candidate.id === id);
    if (asset === undefined) throw new Error(`expected ECC asset ${id}`);
    for (const required of [
      ...(asset.dependencies ?? []),
      ...(asset.members ?? []),
      ...(asset.riders ?? []),
    ]) {
      if (selected.has(required)) continue;
      selected.add(required);
      pending.push(required);
    }
  }
  return [...selected];
}

describe("policy studio enterprise composition", () => {
  const composition = model.catalog.enterpriseComposition;
  const partIds = (selection: "composed" | "additive") =>
    composition.parts
      .filter((part) => part.selection === selection)
      .flatMap((part) => part.componentIds);

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
    // The composition is no longer a read-only list, so the wording that said
    // so is gone with it.
    expect(text).not.toContain("no projector");
    expect(text).not.toContain("0 selectable");
  });

  // Contract item 2: Enterprise exposes ECC Core *and additive choices*, and
  // the acceptance journey has the administrator select languages and add
  // security. Both only work if Enterprise leaves those parts unselected.
  it("marks Core as composed and languages and security as additive", () => {
    const byId = new Map(composition.parts.map((part) => [part.id, part.selection]));
    expect(byId.get("ecc-install-core")).toBe("composed");
    expect(byId.get("aih-core-closure")).toBe("composed");
    expect(byId.get("language")).toBe("additive");
    expect(byId.get("security")).toBe("additive");
  });

  it("composes Enterprise into ECC Core as requested intent and states the composition", () => {
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
    expect(selectedIds(window).sort()).toEqual(eccSelectionClosure(partIds("composed")).sort());
    expect(policy.governance.externalSelections[0]?.roots?.sort()).toEqual(
      partIds("composed").sort(),
    );
    const announcement = window.document.getElementById("announcement")?.textContent ?? "";
    expect(announcement).toContain(`${controls.length} AIH control`);
    expect(announcement).toContain(`${partIds("composed").length} ECC Core component`);
    expect(announcement).toContain(`${partIds("additive").length}`);
    expect(announcement).not.toContain("no projector");
    expect(announcement).toContain("not effective until runtime evaluation");
  });

  // "The administrator can select languages and then add security" has to be a
  // control, not a sentence. Adding a part selects exactly its components and
  // leaves everything else alone.
  it("lets the administrator add an additive part from the composition", () => {
    const window = studio();
    selectProfile(window, "enterprise");
    const before = selectedIds(window);
    const button = window.document.querySelector('[data-composition-add="language"]');
    expect(button, "a control to add the language composition").not.toBeNull();
    button?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    const language = composition.parts.find((part) => part.id === "language")?.componentIds ?? [];
    expect(selectedIds(window).sort()).toEqual(
      [...new Set([...before, ...eccSelectionClosure(language)])].sort(),
    );
    window.document
      .querySelector('[data-composition-add="security"]')
      ?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    const security = composition.parts.find((part) => part.id === "security")?.componentIds ?? [];
    for (const id of security) expect(selectedIds(window)).toContain(id);
  });

  it("reverses an added part from the same control", () => {
    const window = studio();
    selectProfile(window, "enterprise");
    const before = selectedIds(window).sort();
    const add = () =>
      window.document
        .querySelector('[data-composition-add="language"]')
        ?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    add();
    add();
    expect(selectedIds(window).sort()).toEqual(before);
  });

  it("does not remove a root selected individually when reversing an additive part", () => {
    const window = studio();
    selectProfile(window, "enterprise");
    window.document
      .querySelector('[data-framework-select="ecc|module|module:security"]')
      ?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    const add = () =>
      window.document
        .querySelector('[data-composition-add="security"]')
        ?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));

    add();
    add();

    const policy = authoredPolicy(window);
    expect(policy.governance.externalSelections[0]?.roots).toContain("module:security");
    expect(selectedIds(window)).toContain("module:security");
    window.close();
  });

  // Row 12's ruling: a preset must never author an audit record it did not
  // receive. Asserted directly rather than inferred from a count.
  it("authors no external curation when Enterprise is composed", () => {
    const window = studio();
    selectProfile(window, "enterprise");
    expect(authoredPolicy(window).governance.externalCuration).toEqual([]);
  });

  // Row 11 guard, now bounded by the one-framework rule: exposing a
  // composition must not disturb the inventory of the framework in play, and
  // the framework it scopes out must be accounted for rather than dropped.
  it("leaves the composed framework's inventory intact and accounts for the rest", () => {
    const window = studio();
    selectProfile(window, "enterprise");
    const frameworkRows =
      window.document.getElementById("framework-rows")?.querySelectorAll(".row").length ?? 0;
    const governedSkillRows = [
      ...window.document.querySelectorAll("[data-ecc-skill-availability]"),
    ].filter((row) => row.querySelector("[data-framework-select]") !== null).length;
    const mcpDeclarations = ecc.assets.filter((asset) => asset.kind === "mcp").length;
    expect(frameworkRows + governedSkillRows).toBe(ecc.assets.length - mcpDeclarations);
    const others = model.catalog.frameworks
      .filter((framework) => framework.id !== "ecc")
      .reduce((total, framework) => total + framework.assets.length, 0);
    const notice = window.document.querySelector("[data-framework-notice]")?.textContent ?? "";
    expect(notice).toContain(String(others));
  });
});
