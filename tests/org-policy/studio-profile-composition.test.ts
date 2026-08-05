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
const frameworkAssetCount = model.catalog.frameworks.reduce(
  (total, framework) => total + framework.assets.length,
  0,
);

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
function authoredPolicy(window: Window): {
  minimumPosture: string;
  governance: {
    catalog: { reviewed: { id: string }[]; custom: { id: string }[] };
    activations: { candidate: string; state: string }[];
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

  // "Everything this catalog offers" must state what it could not offer, or the
  // completeness claim hides the ownership boundary rows 10-11 made visible.
  it("states what Vibe could not enable, with countable inventory", () => {
    const window = studio();
    selectProfile(window, "vibe");
    const text = announcement(window);
    expect(text).toContain(`${controls.length} AIH control`);
    expect(text).toContain(`${frameworkAssetCount} framework-owned component`);
    expect(text).toContain("no projector");
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
    expect(announcement(window)).not.toContain("rejected");
  });
});
