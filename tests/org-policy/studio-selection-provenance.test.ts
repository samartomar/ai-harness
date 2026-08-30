import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";
import { policyStudioModel } from "../../src/org-policy/studio-model.js";
import { policyStudioHtml } from "../../src/org-policy/studio-template.js";

const model = policyStudioModel();
const controls = [...model.catalog.mcp.map((item) => item.control), ...model.catalog.hooks];

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

function activations(window: Window): { candidate: string; clarification?: string }[] {
  const preview = window.document.getElementById("config-preview") as unknown as {
    value: string;
  } | null;
  if (preview === null) throw new Error("expected authored policy preview");
  return JSON.parse(preview.value).governance.activations;
}

function controlRows(window: Window): { text: string; firstBadge: string }[] {
  return ["mcp-rows", "hook-rows"].flatMap((container) =>
    [...(window.document.getElementById(container)?.querySelectorAll(".row") ?? [])]
      .filter((row) => row.querySelector("[data-reviewed]") !== null)
      .map((row) => ({
        text: row.textContent ?? "",
        firstBadge: row.querySelector(".badge")?.textContent ?? "",
      })),
  );
}

describe("policy studio selection provenance", () => {
  // Recorded product failure 6: removal worked, but the administrator could not
  // see what was selected or why - every activation carried the same sentence
  // whether a human clicked it or a profile composed it.
  it("records the administrator as the origin of a directly requested control", () => {
    const window = studio();
    const target = window.document.querySelector("[data-reviewed]");
    const id = target?.getAttribute("data-reviewed") ?? "";
    target?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    const activation = activations(window).find((item) => item.candidate === id);
    expect(activation?.clarification).toBe("Requested by: administrator");
  });

  it("records the composing profile as the origin of every control it requested", () => {
    const window = studio();
    selectProfile(window, "vibe");
    const recorded = activations(window);
    expect(recorded).toHaveLength(controls.length);
    for (const activation of recorded) {
      expect(activation.clarification, activation.candidate).toBe("Requested by: vibe profile");
    }
  });

  // The refcounted-cascade ruling made product at row scale: a control declared
  // by more than one origin keeps every declarer, so the administrator can see
  // that removing one reason does not remove the selection.
  it("accumulates every origin that declared the same control", () => {
    const window = studio();
    selectProfile(window, "vibe");
    selectProfile(window, "enterprise");
    for (const activation of activations(window)) {
      expect(activation.clarification, activation.candidate).toBe(
        "Requested by: vibe profile, enterprise profile",
      );
    }
  });

  it("drops only the administrator origin when a profile still requests the control", () => {
    const window = studio();
    const target = window.document.querySelector("[data-reviewed]");
    const id = target?.getAttribute("data-reviewed") ?? "";
    target?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    selectProfile(window, "vibe");

    window.document
      .querySelector(`[data-reviewed="${id}"]`)
      ?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));

    expect(activations(window).find((item) => item.candidate === id)?.clarification).toBe(
      "Requested by: vibe profile",
    );
    expect(
      window.document.querySelector(`[data-reviewed="${id}"]`)?.getAttribute("aria-pressed"),
    ).toBe("true");
  });

  it("shows the provenance on the row it explains", () => {
    const window = studio();
    selectProfile(window, "vibe");
    for (const row of controlRows(window)) {
      expect(row.text).toContain("Requested by: vibe profile");
    }
  });

  it("leaves an unrequested control with no provenance to explain", () => {
    const window = studio();
    for (const row of controlRows(window)) {
      expect(row.text).not.toContain("Requested by:");
    }
  });

  // Row 11's inventory contract reads a row's FIRST .badge as its status.
  // Provenance must not displace it.
  it("keeps the status badge first in the row", () => {
    const window = studio();
    selectProfile(window, "vibe");
    for (const row of controlRows(window)) {
      expect(row.firstBadge).toContain("Requested intent");
    }
  });
});
