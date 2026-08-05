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
const controls = [...model.catalog.mcp.map((item) => item.control), ...model.catalog.hooks];
const frameworkAssets = model.catalog.frameworks.flatMap((framework) =>
  framework.assets.map((asset) => ({ framework, asset })),
);
const frameworkAssetCount = frameworkAssets.length;

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

/** The authored policy exactly as the surface shows it, not internal state. */
interface FrameworkGroup {
  framework: string;
  items: Array<{ kind: string; id: string; source: Record<string, string> }>;
}

function authoredPolicy(window: Window): {
  minimumPosture: string;
  governance: {
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
  const button = window.document.querySelector("[data-curation-prefill]");
  if (button === null) throw new Error("expected a curatable inventory row");
  button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  const field = (id: string) =>
    window.document.getElementById(id) as unknown as { value: string } | null;
  const record = field("audit-record");
  const digest = field("audit-digest");
  if (record === null || digest === null) throw new Error("expected audit evidence fields");
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
  it("composes Vibe into requested intent for every AIH control", () => {
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

  it("shows every composed control as requested in the rows it composed", () => {
    const window = studio();
    selectProfile(window, "vibe");
    for (const container of ["mcp-rows", "hook-rows"]) {
      const rows = [...(window.document.getElementById(container)?.querySelectorAll(".row") ?? [])];
      expect(rows.length, container).toBeGreaterThan(0);
      for (const row of rows) {
        expect(row.querySelector(".badge")?.textContent ?? "", container).toContain(
          "Requested intent",
        );
        expect(row.querySelector("[data-reviewed]")?.hasAttribute("disabled") ?? false).toBe(true);
      }
    }
  });

  // The artifact's Vibe is "everything this catalog offers". Under the approved
  // selection model that is finally expressible: a selection carries the
  // component's pinned source and no audit fields, so a preset composing one
  // fabricates nothing. Naming the inventory was the compromise this row was
  // forced into while every third-party row was unselectable.
  it("selects every framework-owned component as requested intent", () => {
    const window = studio();
    selectProfile(window, "vibe");
    const groups = authoredPolicy(window).governance.externalSelections;
    expect(selectedIds(window).sort()).toEqual(frameworkAssets.map(({ asset }) => asset.id).sort());
    for (const { framework, asset } of frameworkAssets) {
      const group = groups.find((item) => item.framework === framework.id);
      expect(group?.items, asset.id).toContainEqual({
        kind: asset.kind,
        id: asset.id,
        source: { ...asset.source },
      });
    }
  });

  // This row's real ruling, preserved intact: a preset must never author audit
  // evidence. External curation needs an audit record and a sha256 digest, and
  // no preset can invent either.
  it("authors no external curation, because a preset cannot invent audit evidence", () => {
    const window = studio();
    selectProfile(window, "vibe");
    expect(authoredPolicy(window).governance.externalCuration).toEqual([]);
  });

  // A curated component already carries its evidence. Composing over it must not
  // downgrade it to a bare selection, and the grammar forbids holding both.
  it("leaves an already-curated component curated rather than selecting it", () => {
    const window = studio();
    const curated = curateFromFirstRow(window);
    selectProfile(window, "vibe");
    expect(curatedIds(window), "stays curated").toContain(curated);
    expect(selectedIds(window), "not also selected").not.toContain(curated);
    expect(announcement(window)).not.toContain("rejected");
    expect(selectedIds(window)).toHaveLength(frameworkAssetCount - 1);
  });

  it("states what Vibe composed, with countable inventory", () => {
    const window = studio();
    selectProfile(window, "vibe");
    const text = announcement(window);
    expect(text).toContain(`${controls.length} AIH control`);
    expect(text).toContain(`${frameworkAssetCount} framework-owned component`);
    expect(text).toContain("ECC and Superpowers install and run");
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
    expect(selectedIds(window)).toHaveLength(frameworkAssetCount);
    expect(announcement(window)).not.toContain("rejected");
  });
});
