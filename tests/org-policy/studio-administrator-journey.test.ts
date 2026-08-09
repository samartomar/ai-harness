import { Window } from "happy-dom";
import { describe, expect, it } from "vitest";
import { policyStudioModel } from "../../src/org-policy/studio-model.js";
import { policyStudioHtml } from "../../src/org-policy/studio-template.js";

/**
 * The workflow test the original suite never had. Every recorded product
 * failure passed CI because the tests proved the narrowed implementation
 * contract - that a function returned what it was written to return - instead
 * of walking what an administrator actually does. This file walks the journey
 * in order and asserts what they can see at each step, so a regression in any
 * one row fails here as a broken workflow rather than as a changed constant.
 */

const model = policyStudioModel();
const controls = [...model.catalog.mcp.map((item) => item.control), ...model.catalog.hooks];
const inventoryCount = model.catalog.frameworks.reduce(
  (total, framework) => total + framework.assets.length,
  0,
);

function openWorkbench(): Window {
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

const text = (window: Window, id: string): string =>
  window.document.getElementById(id)?.textContent ?? "";
const rowCount = (window: Window, id: string): number =>
  window.document.getElementById(id)?.querySelectorAll(".row").length ?? 0;
const value = (window: Window, id: string): string =>
  (window.document.getElementById(id) as unknown as { value: string } | null)?.value ?? "";

function chooseProfile(window: Window, profile: string): void {
  const preset = window.document.querySelector(`[data-preset="${profile}"]`);
  if (preset === null) throw new Error(`expected ${profile} preset`);
  preset.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
}

function click(window: Window, id: string): void {
  window.document
    .getElementById(id)
    ?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
}

describe("policy workbench administrator journey", () => {
  it("walks open -> survey -> compose -> inspect -> extend -> export", () => {
    const window = openWorkbench();

    // 1. OPEN. Nothing is selected, and nothing pretends to be.
    expect(value(window, "config-preview"), "a starting policy is authored").toContain(
      '"schemaVersion"',
    );
    expect(text(window, "mcp-rows"), "no control claims provenance yet").not.toContain(
      "Requested by:",
    );

    // 2. SURVEY. The main plane holds the non-duplicated inventory; the four
    //    ECC namespaces owned by the rail remain selectable there.
    const railOwned = model.catalog.frameworks
      .find((framework) => framework.id === "ecc")
      ?.assets.filter((asset) =>
        ["lang", "framework", "capability", "module"].includes(asset.kind),
      ).length;
    expect(rowCount(window, "framework-rows"), "non-duplicated inventory").toBe(
      inventoryCount - (railOwned ?? 0),
    );
    expect(text(window, "framework-rows")).toContain("Selectable");
    expect(text(window, "framework-rows")).toContain("installs and runs it");
    expect(text(window, "framework-rows")).toContain("aih evidence vet-baseline");

    // 3. COMPOSE. Choosing a posture composes a selection, not a label.
    chooseProfile(window, "enterprise");
    const composed = JSON.parse(value(window, "config-preview"));
    expect(composed.minimumPosture).toBe("enterprise");
    expect(
      composed.governance.activations
        .filter((item: { state: string }) => item.state === "active")
        .map((item: { candidate: string }) => item.candidate)
        .sort(),
    ).toEqual(controls.map((control) => control.id).sort());
    expect(text(window, "composition-parts"), "the composition is named").toContain("ECC");
    // Naming is not selection: the composition authors no curation records.
    expect(composed.governance.externalCuration).toEqual([]);

    // 4. INSPECT. The administrator can see what is selected, why, and what an
    //    AIH-owned hook will actually do at event time.
    expect(text(window, "mcp-rows"), "provenance").toContain("Requested by: enterprise profile");
    const hooks = text(window, "hook-rows");
    expect(hooks, "hook trigger").toContain("PostToolUse");
    expect(hooks, "hook artifact").toContain(".aih/usage.jsonl");
    expect(hooks, "hook cannot block").toContain("never blocks");
    expect(hooks, "pinned identity").toMatch(/sha256:[0-9a-f]{64}/);

    // 5. EXTEND. A custom source is accepted, stays blocked, and ends in a
    //    command rather than in nothing.
    for (const [id, entry] of [
      ["custom-id", "acme-mcp"],
      ["custom-package", "@acme/mcp-server"],
      ["custom-version", "1.4.2"],
      ["custom-integrity", `sha256:${"a".repeat(64)}`],
      ["custom-evidence", "acme-scan-001"],
    ] as const) {
      const input = window.document.getElementById(id) as unknown as { value: string } | null;
      if (input === null) throw new Error(`expected #${id}`);
      input.value = entry;
    }
    window.document
      .getElementById("custom-form")
      ?.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    const custom = text(window, "custom-rows");
    expect(custom, "accepted").toContain("acme-mcp");
    expect(custom, "still fenced").toContain("Blocked");
    expect(custom, "exact next command").toContain("aih trust scan");
    expect(custom, "bound to its own pin").toContain("@acme/mcp-server");

    // 6. EXPORT. What they authored validates against the real policy grammar.
    click(window, "validate");
    expect(text(window, "announcement")).toContain("validation passed");
    const exported = JSON.parse(value(window, "config-preview"));
    expect(exported.governance.catalog.custom).toHaveLength(1);
    expect(exported.governance.catalog.reviewed).toHaveLength(controls.length);
  });

  // The journey must not depend on the order the administrator happens to take.
  it("composes the same selection whether the custom source is added first", () => {
    const window = openWorkbench();
    for (const [id, entry] of [
      ["custom-id", "acme-mcp"],
      ["custom-package", "@acme/mcp-server"],
      ["custom-version", "1.4.2"],
      ["custom-integrity", `sha256:${"b".repeat(64)}`],
      ["custom-evidence", "acme-scan-002"],
    ] as const) {
      const input = window.document.getElementById(id) as unknown as { value: string } | null;
      if (input === null) throw new Error(`expected #${id}`);
      input.value = entry;
    }
    window.document
      .getElementById("custom-form")
      ?.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    chooseProfile(window, "enterprise");
    const policy = JSON.parse(value(window, "config-preview"));
    expect(policy.governance.catalog.custom).toHaveLength(1);
    expect(policy.governance.catalog.reviewed).toHaveLength(controls.length);
    click(window, "validate");
    expect(text(window, "announcement")).toContain("validation passed");
  });
});
