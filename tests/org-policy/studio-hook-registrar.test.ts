import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";
import { hookOverlaps } from "../../src/org-policy/hook-registrar.js";
import { policyStudioModel } from "../../src/org-policy/studio-model.js";
import { policyStudioHtml } from "../../src/org-policy/studio-template.js";

const model = policyStudioModel();

function workbenchText(id: string): string {
  const window = new Window({ url: "http://localhost/" });
  const html = policyStudioHtml(model);
  window.document.write(html);
  (window as unknown as { structuredClone: typeof structuredClone }).structuredClone =
    structuredClone;
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gi)].map((match) => match[1]);
  if (scripts.length === 0) throw new Error("expected generated workbench script");
  window.eval(scripts.join("\n"));
  const container = window.document.getElementById(id);
  if (container === null) throw new Error(`workbench renders no #${id}`);
  return container.textContent ?? "";
}

describe("H4 — visible inventory, source-labeled", () => {
  it("carries AIH-owned handlers and third-party hooks in one inventory", () => {
    const registry = model.catalog.hookRegistry;
    expect(registry.entries.length).toBeGreaterThan(0);
    expect(registry.entries.some((entry) => entry.owner === "aih")).toBe(true);
    expect(registry.entries.some((entry) => entry.owner === "third-party")).toBe(true);
    for (const entry of registry.entries) {
      expect(entry.source.length, `${entry.id} source label`).toBeGreaterThan(0);
      expect(["aih-enforced", "not-aih-enforced"]).toContain(entry.enforcement);
      expect(entry.selectable, `${entry.id} selectable`).toBe(true);
    }
  });

  it("labels third-party items as not AIH-enforced without disabling authoring", () => {
    for (const entry of model.catalog.hookRegistry.entries) {
      if (entry.owner !== "third-party") continue;
      expect(entry.enforcement).toBe("not-aih-enforced");
      // Absence of AIH enforcement is a label on a selectable item, never a
      // disabled authoring experience.
      expect(entry.selectable).toBe(true);
    }
  });

  it("shows both owners' rows with their source labels on the inventory screen", () => {
    const text = workbenchText("hook-registry-rows");
    for (const entry of model.catalog.hookRegistry.entries) {
      expect(text, `${entry.id} row`).toContain(entry.id);
      expect(text, `${entry.id} source`).toContain(entry.source);
    }
  });
});

describe("H3 — no semantic ownership of third-party controls", () => {
  it("records the controls a source declares, read-only", () => {
    const controls = model.catalog.hookRegistry.declaredControls;
    expect(controls.length).toBeGreaterThan(0);
    for (const control of controls) {
      expect(control.owner).not.toBe("aih");
      expect(control.enforcedByAih).toBe(false);
      expect(control.detail.length).toBeGreaterThan(0);
    }
    expect(controls.map((control) => control.name)).toEqual(
      expect.arrayContaining(["ECC_HOOK_PROFILE", "ECC_DISABLED_HOOKS"]),
    );
  });

  it("states that a source-disabled hook still costs a process", () => {
    const text = workbenchText("hook-registry-controls");
    expect(text).toContain("ECC_HOOK_PROFILE");
    expect(text).toContain("ECC_DISABLED_HOOKS");
    expect(text.toLowerCase()).toContain("process");
  });
});

describe("H5 and H7 — overlap and cost on the signing screen", () => {
  // The shipped catalog records ECC's hook COMPONENTS with provenance, never a
  // per-hook registration table — AIH has no pinned evidence for one, and
  // inventing it would be a claim its own inventory denies. So the surface is
  // asserted against whatever registrations the model actually carries, and the
  // overlap arithmetic itself is proved in the core H5 tests.
  it("derives overlaps from the model's own registrations, resolving none", () => {
    const registry = model.catalog.hookRegistry;
    expect(registry.overlaps).toEqual(hookOverlaps(registry.registrations));
    for (const overlap of registry.overlaps) {
      expect(overlap.owners.length).toBeGreaterThanOrEqual(2);
      expect(overlap.event.length).toBeGreaterThan(0);
    }
  });

  it("states on the signing screen that AIH never auto-resolves an overlap", () => {
    const text = workbenchText("hook-registry-overlaps");
    expect(text.toLowerCase()).toContain("overlap");
    expect(text.toLowerCase()).not.toContain("automatically resolved");
    for (const overlap of model.catalog.hookRegistry.overlaps) {
      expect(text, `${overlap.functionTag} overlap`).toContain(overlap.functionTag);
      for (const owner of overlap.owners) expect(text).toContain(owner);
    }
  });

  it("shows the per-event spawn cost the administrator signs against", () => {
    const cost = model.catalog.hookRegistry.spawnCost;
    expect(cost.totalEntries).toBeGreaterThan(0);
    expect(cost.totalSpawns).toBeGreaterThanOrEqual(cost.totalEntries);
    const text = workbenchText("hook-registry-cost");
    for (const event of cost.events) {
      expect(text, `${event.event} cost`).toContain(event.event);
      expect(text, `${event.event} spawns`).toContain(String(event.spawns));
    }
  });

  it("puts overlap and cost on the same screen as the inventory", () => {
    const html = policyStudioHtml(model);
    for (const id of [
      "hook-registry-rows",
      "hook-registry-controls",
      "hook-registry-overlaps",
      "hook-registry-cost",
    ]) {
      expect(html).toContain(id);
    }
  });
});
