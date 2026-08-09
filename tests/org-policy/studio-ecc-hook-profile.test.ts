import { type Element, Window } from "happy-dom";
import { describe, expect, it } from "vitest";
import { parseOrgPolicy } from "../../src/org-policy/schema.js";
import { policyStudioModel } from "../../src/org-policy/studio-model.js";
import { policyStudioHtml } from "../../src/org-policy/studio-template.js";

const model = policyStudioModel();

type EccHookControls = {
  sourceContentSha256: string;
  profiles: Array<{ id: "minimal" | "standard" | "strict"; label: string }>;
  hooks: Array<{
    id: string;
    event: string;
    profiles: Array<"minimal" | "standard" | "strict">;
    disableEligible: boolean;
  }>;
  disabledHooks: { availability: "supported"; detail: string; eligibleIds: string[] };
};

type ControlInput = Element & { value: string };
type ControlButton = Element & { disabled: boolean };

function eccHookControls(): EccHookControls {
  const controls = (model.catalog as unknown as { eccHookControls?: EccHookControls })
    .eccHookControls;
  if (controls === undefined) throw new Error("expected pinned ECC hook controls");
  return controls;
}

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

function click(window: Window, node: Element | null, label: string): void {
  if (node === null) throw new Error(`expected ${label}`);
  node.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
}

function policy(window: Window): unknown {
  const preview = window.document.getElementById("config-preview") as unknown as {
    value: string;
  } | null;
  if (preview === null) throw new Error("expected policy preview");
  return JSON.parse(preview.value);
}

function disableButton(window: Window, id: string): ControlButton | null {
  return window.document.querySelector(
    `[data-ecc-hook-disable="${id}"]`,
  ) as unknown as ControlButton | null;
}

describe("ECC hook profile authoring", () => {
  it("records the pinned profile and reversibly disables only eligible pinned hooks", () => {
    const window = studio();
    const controls = eccHookControls();
    const baseline = JSON.stringify(policy(window));
    const panel = window.document.getElementById("ecc-hook-controls");
    if (panel === null) throw new Error("expected ECC hook controls panel");

    expect(panel.textContent).toContain("ECC executes hooks");
    expect(panel.textContent).toContain("AIH configures");
    expect(
      [...panel.querySelectorAll('input[name="ecc-hook-profile"]')].map(
        (input) => (input as unknown as ControlInput).value,
      ),
    ).toEqual(controls.profiles.map((profile) => profile.id));
    expect(controls.disabledHooks.eligibleIds).toHaveLength(40);
    expect(new Set(controls.disabledHooks.eligibleIds).size).toBe(40);
    expect(
      controls.hooks.filter((hook) => hook.disableEligible && hook.profiles.includes("minimal")),
    ).toHaveLength(10);
    expect(
      controls.hooks.filter((hook) => hook.disableEligible && hook.profiles.includes("standard")),
    ).toHaveLength(37);
    expect(
      controls.hooks.filter((hook) => hook.disableEligible && hook.profiles.includes("strict")),
    ).toHaveLength(40);
    for (const hook of controls.hooks) {
      const row = panel.querySelector(`[data-ecc-hook-id="${hook.id}"]`);
      expect(row, `${hook.id} row`).not.toBeNull();
      expect(row?.textContent).toContain(hook.event);
      for (const profile of hook.profiles) {
        expect(row?.textContent, `${hook.id} ${profile} eligibility`).toContain(profile);
      }
    }

    const standard = panel.querySelector('input[name="ecc-hook-profile"][value="standard"]');
    click(window, standard, "standard ECC hook profile");
    expect(parseOrgPolicy(policy(window)).governance?.eccHookControls).toEqual({
      profile: "standard",
    });

    const disabled = controls.hooks.find(
      (hook) =>
        hook.disableEligible &&
        hook.profiles.includes("standard") &&
        !hook.profiles.includes("minimal"),
    );
    if (disabled === undefined) throw new Error("expected a standard-only disable-eligible hook");
    expect(controls.disabledHooks.eligibleIds).toContain(disabled.id);
    const disable = disableButton(window, disabled.id);
    expect(disable, `${disabled.id} disable affordance`).not.toBeNull();
    expect(disable?.disabled).toBe(false);
    expect(panel.textContent).toContain(controls.disabledHooks.detail);
    expect(panel.textContent?.toLowerCase()).toContain("after process spawn");
    expect(panel.textContent?.toLowerCase()).toContain("not aih enforcement");
    click(window, disable, `disable ${disabled.id}`);
    expect(parseOrgPolicy(policy(window)).governance?.eccHookControls).toEqual({
      profile: "standard",
      disabledIds: [disabled.id],
    });
    click(window, disableButton(window, disabled.id), `re-enable ${disabled.id}`);
    expect(parseOrgPolicy(policy(window)).governance?.eccHookControls).toEqual({
      profile: "standard",
    });

    click(
      window,
      disableButton(window, disabled.id),
      `disable ${disabled.id} before profile change`,
    );
    const minimal = panel.querySelector('input[name="ecc-hook-profile"][value="minimal"]');
    click(window, minimal, "minimal ECC hook profile");
    expect(parseOrgPolicy(policy(window)).governance?.eccHookControls).toEqual({
      profile: "minimal",
    });

    click(window, window.document.getElementById("clear-policy"), "profile inverse");
    expect(JSON.stringify(policy(window))).toBe(baseline);
    window.close();
  });
});
