import { type Document, type Element, Window } from "happy-dom";
import { describe, expect, it } from "vitest";
import type { PolicyStudioModel } from "../../src/org-policy/studio-model.js";
import { policyStudioModel } from "../../src/org-policy/studio-model.js";
import { policyStudioHtml } from "../../src/org-policy/studio-template.js";

const model = policyStudioModel();
const STATE_FACTS = new Set(["Availability", "Requested", "Effective", "Gate"]);

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

function click(window: Window, node: Element | null, label: string): void {
  if (node === null) throw new Error(`expected ${label}`);
  node.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
}

function policyText(window: Window): string {
  const preview = window.document.getElementById("config-preview") as unknown as {
    value: string;
  } | null;
  if (preview === null) throw new Error("expected authored policy preview");
  return preview.value;
}

function byAttribute(root: Document | Element, attribute: string, value: string): Element | null {
  return (
    [...root.querySelectorAll(`[${attribute}]`)].find(
      (node) => node.getAttribute(attribute) === value,
    ) ?? null
  );
}

function assertRoundTrip(
  window: Window,
  root: () => Document | Element,
  attribute: string,
  value: string,
): void {
  const baseline = policyText(window);
  click(window, byAttribute(root(), attribute, value), `${attribute}=${value}`);
  expect(policyText(window), `${value} authors a selection`).not.toBe(baseline);
  const inverse = byAttribute(root(), attribute, value);
  expect(inverse?.hasAttribute("disabled") ?? true, `${value} keeps an inverse`).toBe(false);
  click(window, inverse, `inverse ${attribute}=${value}`);
  expect(policyText(window), `${value} returns to baseline`).toBe(baseline);
}

function openDetail(window: Window, key: string): void {
  click(window, byAttribute(window.document, "data-detail", key), `detail ${key}`);
}

function detailFacts(window: Window, key: string): Map<string, string> {
  openDetail(window, key);
  const facts = new Map<string, string>();
  for (const row of window.document.querySelectorAll("#drawer-detail .kv > div")) {
    const label = row.querySelector("span")?.textContent ?? "";
    if (STATE_FACTS.has(label)) facts.set(label, row.querySelector("b")?.textContent ?? "");
  }
  return facts;
}

function frameworkDetailKey(frameworkId: string, kind: string, id: string): string {
  return `${frameworkId} / ${kind}: ${id}`;
}

function modelWithFrameworkSelected(frameworkId: string): PolicyStudioModel {
  const selectedModel = structuredClone(model) as PolicyStudioModel;
  const governance = selectedModel.initialPolicy.governance;
  const framework = selectedModel.catalog.frameworks.find((item) => item.id === frameworkId);
  if (governance === undefined || framework === undefined) {
    throw new Error(`expected governance and framework ${frameworkId}`);
  }
  governance.externalSelections = [
    {
      framework: framework.id as "ecc" | "superpowers",
      items: framework.assets.map((asset) => ({
        kind: asset.kind,
        id: asset.id,
        source: { ...asset.source },
      })),
    },
  ];
  return selectedModel;
}

function expectEveryStateFactToVary(
  label: string,
  baseline: Map<string, string>,
  selected: Map<string, string>,
): void {
  expect([...baseline.keys()], `${label} state facts`).toEqual([...selected.keys()]);
  expect(baseline.size, `${label} exposes state facts`).toBeGreaterThan(0);
  for (const [name, value] of baseline) {
    expect(selected.get(name), `${label} ${name} changes with selection state`).not.toBe(value);
  }
}

describe("policy studio surface invariants", () => {
  it("gives every group card only ticker-resolvable owners", () => {
    const window = studio();
    const tickerOwners = new Set(
      [...window.document.querySelectorAll("#owner-ticker [data-owner-focus]")]
        .map((button) => button.getAttribute("data-owner-focus") ?? "")
        .filter((owner) => owner !== "all"),
    );
    const groups = [...window.document.querySelectorAll("[data-groupcard]")];
    expect(groups.length).toBeGreaterThan(0);
    for (const group of groups) {
      const label = group.querySelector("h2")?.textContent ?? "unnamed group";
      const owners = (group.getAttribute("data-owner") ?? "").split(" ").filter(Boolean);
      expect(owners.length, `${label} has an owner`).toBeGreaterThan(0);
      for (const owner of owners) {
        expect(tickerOwners.has(owner), `${label} owner ${owner} resolves`).toBe(true);
      }
    }
  });

  it("gives every selection an inverse that round-trips the policy to baseline", () => {
    const window = studio();
    const document = window.document;

    for (const control of [
      ...model.catalog.mcp.map((item) => item.control),
      ...model.catalog.hooks.map((item) => item.control),
    ]) {
      assertRoundTrip(window, () => document, "data-reviewed", control.id);
    }
    const inventoryKeys = [
      ...(document.getElementById("framework-rows")?.querySelectorAll("[data-framework-select]") ??
        []),
    ].map((control) => control.getAttribute("data-framework-select"));
    expect(inventoryKeys.sort()).toEqual(
      model.catalog.frameworks
        .flatMap((framework) =>
          framework.assets.map((asset) => `${framework.id}|${asset.kind}|${asset.id}`),
        )
        .sort(),
    );
    for (const framework of model.catalog.frameworks) {
      const frameworkWindow = studio();
      const asset = framework.assets[0];
      if (asset === undefined) throw new Error(`expected an asset for ${framework.id}`);
      assertRoundTrip(
        frameworkWindow,
        () => frameworkWindow.document.getElementById("framework-rows") ?? frameworkWindow.document,
        "data-framework-select",
        `${framework.id}|${asset.kind}|${asset.id}`,
      );
      frameworkWindow.close();
    }
    for (const part of model.catalog.enterpriseComposition.parts.filter(
      (item) => item.selection === "additive",
    )) {
      assertRoundTrip(window, () => document, "data-composition-add", part.id);
    }
    for (const host of model.catalog.hosts) {
      assertRoundTrip(window, () => document, "data-sanctioned-cli", host.id);
    }
    for (const preset of ["vibe", "enterprise"]) {
      const presetWindow = studio();
      const baseline = policyText(presetWindow);
      click(
        presetWindow,
        byAttribute(presetWindow.document, "data-preset", preset),
        `${preset} preset`,
      );
      expect(policyText(presetWindow), `${preset} authors a selection`).not.toBe(baseline);
      click(
        presetWindow,
        presetWindow.document.getElementById("clear-policy"),
        `${preset} inverse`,
      );
      expect(policyText(presetWindow), `${preset} returns to baseline`).toBe(baseline);
      presetWindow.close();
    }
    window.close();
  }, 15_000);

  it("makes every component id named by a panel resolve through its click-through", () => {
    const window = studio();
    const compositionIds = model.catalog.enterpriseComposition.parts.flatMap(
      (part) => part.componentIds,
    );
    const compositionLinks = [
      ...window.document.querySelectorAll("#composition-parts [data-id-reference]"),
    ];
    expect(compositionLinks.map((link) => link.textContent)).toEqual(compositionIds);
    for (const link of compositionLinks) {
      click(window, link, `composition id ${link.textContent}`);
      expect(window.document.querySelector("#drawer-detail h2")?.textContent).toBe(
        link.textContent,
      );
    }

    const registrarLinks = [
      ...window.document.querySelectorAll("#hook-registry-rows [data-id-reference]"),
    ];
    expect(registrarLinks.map((link) => link.textContent)).toEqual(
      model.catalog.hookRegistry.entries.map((entry) => entry.id),
    );
    for (const link of registrarLinks) {
      click(window, link, `registrar id ${link.textContent}`);
      expect(window.document.querySelector("#drawer-detail h2")?.textContent).toBe(
        link.textContent,
      );
    }
  });

  it("renders no detail state fact as a constant across selectable states", () => {
    const baseline = studio();
    const selectedEcc = studio();
    click(selectedEcc, byAttribute(selectedEcc.document, "data-preset", "vibe"), "vibe preset");

    for (const item of [...model.catalog.mcp, ...model.catalog.hooks]) {
      expectEveryStateFactToVary(
        item.id,
        detailFacts(baseline, item.id),
        detailFacts(selectedEcc, item.id),
      );
    }
    const ecc = model.catalog.frameworks.find((framework) => framework.id === "ecc");
    if (ecc === undefined) throw new Error("expected ECC framework");
    for (const asset of ecc.assets) {
      const key = frameworkDetailKey(ecc.id, asset.kind, asset.id);
      expectEveryStateFactToVary(key, detailFacts(baseline, key), detailFacts(selectedEcc, key));
    }

    const superpowers = model.catalog.frameworks.find(
      (framework) => framework.id === "superpowers",
    );
    if (superpowers === undefined) throw new Error("expected Superpowers framework");
    const selectedSuperpowers = studio(modelWithFrameworkSelected(superpowers.id));
    for (const asset of superpowers.assets) {
      const key = frameworkDetailKey(superpowers.id, asset.kind, asset.id);
      expectEveryStateFactToVary(
        key,
        detailFacts(baseline, key),
        detailFacts(selectedSuperpowers, key),
      );
    }
  }, 15_000);

  it("narrates the requested and effective count at every export", () => {
    const window = studio();
    const first = model.catalog.frameworks[0]?.assets[0];
    const framework = model.catalog.frameworks[0];
    if (first === undefined || framework === undefined) throw new Error("expected catalog asset");
    click(
      window,
      byAttribute(
        window.document.getElementById("framework-rows") ?? window.document,
        "data-framework-select",
        `${framework.id}|${first.kind}|${first.id}`,
      ),
      first.id,
    );

    click(window, window.document.getElementById("export"), "policy export");
    const narration = /1 requested item\(s\), 0 effective in this browser/i;
    expect(window.document.getElementById("announcement")?.textContent).toMatch(narration);
    const report = window.document.getElementById("report-preview") as unknown as {
      value: string;
    } | null;
    expect(report?.value).toMatch(narration);

    Object.defineProperty(window.URL, "createObjectURL", {
      configurable: true,
      value: () => "blob:policy",
    });
    Object.defineProperty(window.URL, "revokeObjectURL", {
      configurable: true,
      value: () => undefined,
    });
    (window.HTMLAnchorElement.prototype as unknown as { click: () => void }).click = () =>
      undefined;
    click(window, window.document.getElementById("download"), "policy download");
    expect(window.document.getElementById("announcement")?.textContent).toMatch(narration);
  });
});
