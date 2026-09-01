import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";
import { policyStudioModel } from "../../src/org-policy/studio-model.js";
import { policyStudioHtml } from "../../src/org-policy/studio-template.js";

const model = policyStudioModel();

/**
 * Every AIH control the workbench can request. Derived from the model rather
 * than listed, so a catalog change fails these tests instead of silently
 * shrinking what a profile composes.
 */
const controls = [
  ...model.catalog.mcp.filter((item) => item.availability === "always").map((item) => item.control),
  ...model.catalog.hooks,
];
const frameworkAssets = model.catalog.frameworks.flatMap((framework) =>
  framework.assets.map((asset) => ({ framework, asset })),
);
const frameworkAssetCount = frameworkAssets.length;
/**
 * A policy selects from one framework at a time, so Vibe composes the whole of
 * the framework in play — ECC when nothing is selected yet — rather than the
 * whole catalog. The other framework stays listed and unselected.
 */
const ecc = model.catalog.frameworks.find((framework) => framework.id === "ecc");
if (ecc === undefined) throw new Error("expected an ecc framework in the catalog");
const eccAssetCount = ecc.assets.length;
const excludedCount = frameworkAssetCount - eccAssetCount;

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

/** The authored policy exactly as the surface shows it, not internal state. */
interface FrameworkGroup {
  framework: string;
  items: Array<{ kind: string; id: string; source: Record<string, string> }>;
}

function authoredPolicy(window: Window): {
  minimumPosture: string;
  governance: {
    supportedClis: ["claude"];
    catalog: { reviewed: { id: string }[]; custom: { id: string }[] };
    activations: { candidate: string; state: string }[];
    externalSelections: FrameworkGroup[];
    externalCuration: Array<{ framework: string; items: Array<{ id: string }> }>;
  };
} {
  const preview = window.document.getElementById("config-preview") as unknown as {
    value: string;
  } | null;
  if (preview === null) throw new Error("expected authored policy preview");
  return JSON.parse(preview.value);
}

function announcement(window: Window): string {
  return window.document.getElementById("announcement")?.textContent ?? "";
}

function selectedIds(window: Window): string[] {
  return authoredPolicy(window).governance.externalSelections.flatMap((group) =>
    group.items.map((item) => item.id),
  );
}

function clickCanonicalAsset(window: Window, kind: string, id: string): void {
  const key = `ecc|${kind}|${id}`;
  const control = [...window.document.querySelectorAll(`[data-framework-select="${key}"]`)].find(
    (candidate) => candidate.closest(".rail") === null,
  );
  if (control === undefined) throw new Error(`expected canonical ${key}`);
  control.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
}

function curatedIds(window: Window): string[] {
  return authoredPolicy(window).governance.externalCuration.flatMap((group) =>
    group.items.map((item) => item.id),
  );
}

/**
 * Author one real curation item through the surface's own form, reached the way
 * an administrator reaches it: the inventory row's prefill button supplies the
 * pinned identity, and only the audit evidence is typed.
 */
function curateFromFirstRow(window: Window): string {
  // Per-item authoring lives in the drawer, so open a curatable row before
  // reaching for its curation control.
  const curatable = frameworkAssets.find(
    ({ framework, asset }) =>
      asset.curationKind !== undefined &&
      (framework.id !== "ecc" ||
        !["lang", "framework", "capability", "module"].includes(asset.kind)),
  );
  if (curatable === undefined) throw new Error("expected a curatable asset in the catalog");
  const key = `${curatable.framework.id} / ${curatable.asset.kind}: ${curatable.asset.id}`;
  window.document
    .querySelector(`[data-detail="${key}"]`)
    ?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  const button = window.document.querySelector("[data-curation-prefill]");
  if (button === null) throw new Error("expected a curatable inventory row");
  button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  const field = (id: string) =>
    window.document.getElementById(id) as unknown as { value: string } | null;
  const record = field("audit-record");
  const digest = field("audit-digest");
  const owner = field("curation-owner");
  if (record === null || digest === null || owner === null)
    throw new Error("expected audit evidence fields");
  owner.value = "curator@acme.example";
  record.value = "audit-vibe-fixture";
  digest.value = `sha256:${"c".repeat(64)}`;
  window.document
    .getElementById("add-curation")
    ?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  const curated = curatedIds(window);
  if (curated.length !== 1) throw new Error(`expected one curated item, got ${curated.length}`);
  return curated[0] as string;
}

describe("policy studio profile composition", () => {
  // Recorded product failure 1: Vibe changed a label and nothing else, so the
  // administrator got a posture rename in place of the complete selection the
  // profile names.
  it("composes Vibe into requested intent for every always-available AIH control", () => {
    const window = studio();
    selectProfile(window, "vibe");
    const policy = authoredPolicy(window);
    expect(policy.minimumPosture).toBe("vibe");
    expect(policy.governance.catalog.reviewed.map((item) => item.id).sort()).toEqual(
      controls.map((control) => control.id).sort(),
    );
    expect(
      policy.governance.activations
        .filter((item) => item.state === "active")
        .map((item) => item.candidate)
        .sort(),
    ).toEqual(controls.map((control) => control.id).sort());
  });

  it("leaves target-conditional Playwright as an explicit administrator choice", () => {
    const window = studio();
    selectProfile(window, "vibe");
    expect(authoredPolicy(window).governance.catalog.reviewed.map((item) => item.id)).not.toContain(
      "playwright",
    );
    const playwright = window.document.querySelector('[data-reviewed="playwright"]');
    expect(playwright?.getAttribute("aria-pressed")).toBe("false");
    expect(playwright?.hasAttribute("disabled")).toBe(false);
    expect(playwright?.closest(".row")?.textContent).toContain("Web target only");
  });

  it("shows every composed control as requested in the rows it composed", () => {
    const window = studio();
    selectProfile(window, "vibe");
    for (const control of controls) {
      const inverse = window.document.querySelector(`[data-reviewed="${control.id}"]`);
      const row = inverse?.closest(".row");
      expect(row?.querySelector(".badge")?.textContent ?? "", control.id).toContain(
        "Requested intent",
      );
      expect(inverse?.hasAttribute("disabled") ?? true).toBe(false);
      expect(inverse?.getAttribute("aria-label")).toContain("Deselect");
    }
  });

  // The artifact's Vibe is "everything this catalog offers". Under the approved
  // selection model that is finally expressible: a selection carries the
  // component's pinned source and no audit fields, so a preset composing one
  // fabricates nothing. Naming the inventory was the compromise this row was
  // forced into while every third-party row was unselectable.
  it("selects every component of the framework in play as requested intent", () => {
    const window = studio();
    selectProfile(window, "vibe");
    const groups = authoredPolicy(window).governance.externalSelections;
    expect(groups, "one framework at a time").toHaveLength(1);
    expect(selectedIds(window).sort()).toEqual(ecc.assets.map((asset) => asset.id).sort());
    for (const asset of ecc.assets) {
      expect(groups[0]?.items, asset.id).toContainEqual({
        kind: asset.kind,
        id: asset.id,
        source: { ...asset.source },
      });
    }
  });

  it("names a center exclusion when that final authority blocks Vibe", () => {
    const window = studio();
    selectProfile(window, "vibe");
    const excluded = ecc.assets.find((asset) => asset.kind === "skill");
    if (excluded === undefined) throw new Error("expected an ECC Skill");

    clickCanonicalAsset(window, excluded.kind, excluded.id);
    const beforeRetry = authoredPolicy(window);
    selectProfile(window, "vibe");

    expect(authoredPolicy(window)).toEqual(beforeRetry);
    expect(selectedIds(window)).not.toContain(excluded.id);
    expect(announcement(window)).toContain("center inventory");
    expect(announcement(window)).toContain("Nothing changed");
  });

  // This row's real ruling, preserved intact: a preset must never author audit
  // evidence. External curation needs an audit record and a sha256 digest, and
  // no preset can invent either.
  it("authors no external curation, because a preset cannot invent audit evidence", () => {
    const window = studio();
    selectProfile(window, "vibe");
    expect(authoredPolicy(window).governance.externalCuration).toEqual([]);
  });

  // A curated component is report-only evidence, not a module selection. Vibe
  // cannot silently install a whole module while one of the members it must
  // select is held only as curation, so the preset fails closed atomically.
  it("blocks Vibe when curation prevents a dependency-closed selection", () => {
    const window = studio();
    const curated = curateFromFirstRow(window);
    selectProfile(window, "vibe");
    expect(curatedIds(window), "stays curated").toContain(curated);
    expect(selectedIds(window), "not also selected").not.toContain(curated);
    expect(announcement(window)).toContain("Vibe composition blocked");
    expect(announcement(window)).toContain("Nothing changed");
    expect(selectedIds(window)).toEqual([]);
  });

  it("states what Vibe composed and what the one-framework rule left out", () => {
    const window = studio();
    selectProfile(window, "vibe");
    const text = announcement(window);
    expect(text).toContain(`${controls.length} AIH control`);
    expect(text).toContain(`${eccAssetCount} ecc component`);
    expect(text).toContain(`${excludedCount} component(s) in the other framework`);
    expect(text).toContain("ecc installs and runs them");
    expect(text.toLowerCase()).toContain("one framework at a time");
    expect(text).not.toContain("no projector");
    expect(text).toContain("not effective until runtime evaluation");
  });

  it("leaves the composed policy valid under the actual schema and grammar", () => {
    const window = studio();
    selectProfile(window, "vibe");
    expect(announcement(window)).not.toContain("rejected");
    window.document
      .getElementById("validate")
      ?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    expect(announcement(window)).toContain("validation passed");
  });

  // Re-selecting a profile is an administrator reflex; duplicate candidate ids
  // are a grammar violation, so a non-idempotent compose would corrupt the policy.
  it("stays idempotent when Vibe is composed twice", () => {
    const window = studio();
    selectProfile(window, "vibe");
    selectProfile(window, "vibe");
    const policy = authoredPolicy(window);
    expect(policy.governance.catalog.reviewed).toHaveLength(controls.length);
    expect(policy.governance.activations).toHaveLength(controls.length);
    expect(selectedIds(window)).toHaveLength(eccAssetCount);
    expect(announcement(window)).not.toContain("rejected");
  });

  // Composing over an existing selection adds nothing for what is already held.
  // Reporting the delta made a fully-composed catalog announce a partial one:
  // Enterprise then Vibe said "120 of 151 selected" while holding all 151.
  it("announces the resulting selection, not the number newly added", () => {
    const window = studio();
    selectProfile(window, "enterprise");
    selectProfile(window, "vibe");
    expect(selectedIds(window)).toHaveLength(eccAssetCount);
    expect(announcement(window)).toContain(`${eccAssetCount} of ${eccAssetCount} ecc component`);
  });
});
