import { type Document, type Element, Window } from "happy-dom";
import { afterEach, describe, expect, it } from "vitest";
import type { PolicyStudioModel } from "../../src/org-policy/studio-model.js";
import { policyStudioModel } from "../../src/org-policy/studio-model.js";
import { policyStudioHtml } from "../../src/org-policy/studio-template.js";

const model = policyStudioModel();
const openWindows = new Set<Window>();

afterEach(async () => {
  await Promise.all([...openWindows].map((window) => window.happyDOM.close()));
  openWindows.clear();
});

async function closeWindow(window: Window): Promise<void> {
  await window.happyDOM.close();
  openWindows.delete(window);
}

function studio(studioModel: PolicyStudioModel = model): Window {
  const window = new Window({ url: "http://localhost/" });
  const html = policyStudioHtml(studioModel);
  window.document.write(html);
  (window as unknown as { structuredClone: typeof structuredClone }).structuredClone =
    structuredClone;
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gi)].map((match) => match[1]);
  if (scripts.length === 0) throw new Error("expected generated workbench script");
  window.eval(scripts.join("\n"));
  openWindows.add(window);
  return window;
}

function click(window: Window, node: Element | null, label: string): void {
  if (node === null) throw new Error(`expected ${label}`);
  node.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
}

function choosePreset(window: Window, value: "vibe" | "enterprise"): void {
  const select = window.document.getElementById("preset-select") as unknown as {
    value: string;
    dispatchEvent: (event: unknown) => boolean;
  } | null;
  if (select === null) throw new Error(`expected ${value} preset`);
  select.value = value;
  select.dispatchEvent(new window.Event("change", { bubbles: true }));
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

function attributeValues(root: Document | Element, attribute: string): string[] {
  return [
    ...new Set(
      [...root.querySelectorAll(`[${attribute}]`)]
        .map((node) => node.getAttribute(attribute))
        .filter((value): value is string => value !== null),
    ),
  ].sort();
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

function detailControls(window: Window): ReadonlyMap<string, Element> {
  const controls = new Map<string, Element>();
  for (const control of window.document.querySelectorAll("[data-detail]")) {
    const key = control.getAttribute("data-detail");
    if (key === null) throw new Error("expected detail control identity");
    if (!controls.has(key)) controls.set(key, control);
  }
  return controls;
}

function detailNarration(
  window: Window,
  controls: ReadonlyMap<string, Element>,
  key: string,
): string {
  click(window, controls.get(key) ?? null, `detail ${key}`);
  return window.document.querySelector("#drawer-detail .journey-effective")?.textContent ?? "";
}

function frameworkDetailKey(frameworkId: string, kind: string, id: string): string {
  return `${frameworkId} / ${kind}: ${id}`;
}

function narratedFrameworkAssets(framework: PolicyStudioModel["catalog"]["frameworks"][number]) {
  return framework.assets.filter(
    (asset) => !["lang", "framework", "capability", "module"].includes(asset.kind),
  );
}

function representativeAssetsByKind(framework: PolicyStudioModel["catalog"]["frameworks"][number]) {
  return [
    ...new Map(narratedFrameworkAssets(framework).map((asset) => [asset.kind, asset])).values(),
  ];
}

function selectedFrameworkAssetIds(window: Window, frameworkId: string): ReadonlySet<string> {
  const policy = JSON.parse(policyText(window)) as {
    governance?: {
      externalSelections?: Array<{
        framework?: unknown;
        items?: Array<{ id?: unknown }>;
      }>;
    };
  };
  const group = policy.governance?.externalSelections?.find(
    (selection) => selection.framework === frameworkId,
  );
  return new Set(
    (group?.items ?? [])
      .map((item) => item.id)
      .filter((id): id is string => typeof id === "string"),
  );
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

function expectDetailNarrationToVary(label: string, baseline: string, selected: string): void {
  expect(baseline, `${label} baseline narration`).toContain("Authored intent: not selected.");
  expect(selected, `${label} selected narration`).toContain("Authored intent: selected.");
  expect(baseline, `${label} effective truth`).toContain("Effective count: not evaluated");
  expect(selected, `${label} selected effective truth`).toContain("Effective count: not evaluated");
}

describe("policy studio surface invariants", () => {
  it("lets the checkbox carry ordinary row state and keeps one plain details action", () => {
    const window = studio();
    const rows = [...window.document.querySelectorAll(".row[data-state]")];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const key = row.getAttribute("data-row") ?? "unnamed row";
      expect(row.querySelector(".cust"), `${key} has no cryptic custody strip`).toBeNull();
      const compactState = row.querySelector(".row-state")?.textContent?.trim() ?? "";
      expect(compactState, `${key} does not repeat its checkbox state`).not.toMatch(
        /^(Selected|Selectable)$/,
      );
      const fullState = row.querySelector(".badge")?.textContent?.trim() ?? "";
      if (
        row.getAttribute("data-state") === "requested" ||
        fullState.startsWith("Selectable") ||
        fullState.startsWith("Disabled") ||
        fullState.startsWith("Available")
      ) {
        expect(compactState, `${key} lets its checkbox carry selection state`).toBe("");
      } else {
        expect(compactState, `${key} names its non-selection state`).toMatch(
          /^(Awaiting|Blocked|Approval|External)$/,
        );
      }
      expect(
        row.querySelector('.vet[data-vet="pass"]'),
        `${key} has no redundant pass tick`,
      ).toBeNull();
      const details = row.querySelector("button.more");
      expect(details?.textContent?.trim() ?? "", `${key} names its details action`).toBe("Details");
      expect(
        details?.querySelector('[aria-hidden="true"]'),
        `${key} has no decorative arrow`,
      ).toBeNull();
      expect(details?.getAttribute("aria-label") ?? "", `${key} keeps its full identity`).toMatch(
        /^Details for /,
      );
    }
    window.close();
  });

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

  it("gives every selection an inverse that round-trips the policy to baseline", async () => {
    const window = studio();
    const document = window.document;

    const controls = [
      ...model.catalog.mcp.map((item) => item.control),
      ...model.catalog.hooks.map((item) => item.control),
    ];
    expect(attributeValues(document, "data-reviewed")).toEqual(
      controls.map((control) => control.id).sort(),
    );
    for (const control of controls) {
      assertRoundTrip(window, () => document, "data-reviewed", control.id);
    }
    const inventoryKeys = [
      ...document.querySelectorAll(
        "#framework-rows [data-framework-select], #ecc-skill-rows [data-framework-select], #ecc-mcp-declaration-rows [data-framework-select]",
      ),
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
        () => frameworkWindow.document,
        "data-framework-select",
        `${framework.id}|${asset.kind}|${asset.id}`,
      );
      await closeWindow(frameworkWindow);
    }
    const additiveParts = model.catalog.enterpriseComposition.parts.filter(
      (item) => item.selection === "additive",
    );
    expect(attributeValues(document, "data-composition-add")).toEqual(
      additiveParts.map((part) => part.id).sort(),
    );
    for (const part of additiveParts) {
      assertRoundTrip(window, () => document, "data-composition-add", part.id);
    }
    expect(attributeValues(document, "data-sanctioned-cli")).toEqual(
      model.catalog.hosts.map((host) => host.id).sort(),
    );
    const representativeHost = model.catalog.hosts[0];
    if (representativeHost === undefined) throw new Error("expected a host");
    assertRoundTrip(window, () => document, "data-sanctioned-cli", representativeHost.id);

    const capabilities = [...model.catalog.aihSkills, ...model.catalog.aihAgents];
    expect(attributeValues(document, "data-aih-capability-package")).toEqual(
      capabilities.map((capability) => capability.id).sort(),
    );
    const representativeCapability = capabilities[0];
    if (representativeCapability === undefined) throw new Error("expected an AIH capability");
    assertRoundTrip(
      window,
      () => document,
      "data-aih-capability-package",
      representativeCapability.id,
    );
    for (const preset of ["vibe", "enterprise"]) {
      const presetWindow = studio();
      const baseline = policyText(presetWindow);
      choosePreset(presetWindow, preset as "vibe" | "enterprise");
      expect(policyText(presetWindow), `${preset} authors a selection`).not.toBe(baseline);
      click(
        presetWindow,
        presetWindow.document.getElementById("clear-policy"),
        `${preset} inverse`,
      );
      expect(policyText(presetWindow), `${preset} returns to baseline`).toBe(baseline);
      await closeWindow(presetWindow);
    }
    await closeWindow(window);
  }, 60_000);

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
  }, 15_000);

  it("narrates authored selection without inventing a target-evaluated state", async () => {
    const baseline = studio();
    const baselineControls = detailControls(baseline);
    const baselineNarration = new Map<string, string>();
    for (const item of [...model.catalog.mcp, ...model.catalog.hooks]) {
      baselineNarration.set(item.id, detailNarration(baseline, baselineControls, item.id));
    }
    for (const framework of model.catalog.frameworks) {
      const narratedAssets = narratedFrameworkAssets(framework);
      for (const asset of narratedAssets) {
        const key = frameworkDetailKey(framework.id, asset.kind, asset.id);
        expect(baselineControls.has(key), `${key} resolves to a detail control`).toBe(true);
      }
      for (const asset of representativeAssetsByKind(framework)) {
        const key = frameworkDetailKey(framework.id, asset.kind, asset.id);
        baselineNarration.set(key, detailNarration(baseline, baselineControls, key));
      }
    }
    await closeWindow(baseline);

    const selectedEcc = studio();
    choosePreset(selectedEcc, "vibe");
    for (const item of model.catalog.mcp.filter(
      (candidate) => candidate.availability !== "always",
    )) {
      click(
        selectedEcc,
        byAttribute(selectedEcc.document, "data-reviewed", item.id),
        `conditional MCP ${item.id}`,
      );
    }
    const selectedEccControls = detailControls(selectedEcc);

    for (const item of [...model.catalog.mcp, ...model.catalog.hooks]) {
      expectDetailNarrationToVary(
        item.id,
        baselineNarration.get(item.id) ?? "",
        detailNarration(selectedEcc, selectedEccControls, item.id),
      );
    }
    const ecc = model.catalog.frameworks.find((framework) => framework.id === "ecc");
    if (ecc === undefined) throw new Error("expected ECC framework");
    const selectedEccIds = selectedFrameworkAssetIds(selectedEcc, ecc.id);
    expect(
      narratedFrameworkAssets(ecc)
        .filter((asset) => !selectedEccIds.has(asset.id))
        .map((asset) => asset.id),
      "Vibe selects every narrated ECC asset",
    ).toEqual([]);
    for (const asset of representativeAssetsByKind(ecc)) {
      const key = frameworkDetailKey(ecc.id, asset.kind, asset.id);
      expectDetailNarrationToVary(
        key,
        baselineNarration.get(key) ?? "",
        detailNarration(selectedEcc, selectedEccControls, key),
      );
    }
    await closeWindow(selectedEcc);

    const superpowers = model.catalog.frameworks.find(
      (framework) => framework.id === "superpowers",
    );
    if (superpowers === undefined) throw new Error("expected Superpowers framework");
    const selectedSuperpowers = studio(modelWithFrameworkSelected(superpowers.id));
    const selectedSuperpowersControls = detailControls(selectedSuperpowers);
    const selectedSuperpowersIds = selectedFrameworkAssetIds(selectedSuperpowers, superpowers.id);
    expect(
      narratedFrameworkAssets(superpowers)
        .filter((asset) => !selectedSuperpowersIds.has(asset.id))
        .map((asset) => asset.id),
      "the selected Superpowers model includes every narrated asset",
    ).toEqual([]);
    for (const asset of representativeAssetsByKind(superpowers)) {
      const key = frameworkDetailKey(superpowers.id, asset.kind, asset.id);
      expectDetailNarrationToVary(
        key,
        baselineNarration.get(key) ?? "",
        detailNarration(selectedSuperpowers, selectedSuperpowersControls, key),
      );
    }
    await closeWindow(selectedSuperpowers);
  }, 60_000);

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
