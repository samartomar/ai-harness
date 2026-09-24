import { describe, expect, it } from "vitest";
import { hookInventory, planHookControls } from "../src/hooks.js";
import {
  descriptorFromDocument,
  fixtureDescriptorDocument,
  operationContext,
  PINNED_COMMIT,
} from "./context.js";

/** Catalog's descriptor plus the OpenCode plugin row Catalog's regeneration records. */
function withOpenCodeRow() {
  const document = fixtureDescriptorDocument() as {
    sections: { hookControlInventory: { hooks: unknown[] } };
  };
  document.sections.hookControlInventory.hooks.push({
    id: "opencode:ecc-hooks",
    event: "tool.execute.after",
    profiles: ["standard", "strict"],
    disableEligible: true,
    declarations: [
      {
        host: "opencode",
        sourcePath: ".opencode/plugins/ecc-hooks.ts",
        event: "tool.execute.after",
        execution: "in-process",
      },
    ],
    control: { kind: "none" },
  });
  return descriptorFromDocument(document);
}

describe("hookInventory", () => {
  it("exposes the 43 reviewed hooks with profiles and ECC's own disable switch", () => {
    const inventory = hookInventory(operationContext());
    expect(inventory.upstream).toEqual({ repository: "affaan-m/ECC", commit: PINNED_COMMIT });
    expect(inventory.hooks).toHaveLength(43);
    expect(inventory.profiles?.map((profile) => profile.id)).toEqual([
      "minimal",
      "standard",
      "strict",
    ]);
    const start = inventory.hooks.find((hook) => hook.id === "session:start");
    expect(start?.upstreamControl).toEqual({
      kind: "environment",
      name: "ECC_DISABLED_HOOKS",
      value: "session:start",
    });
    expect(start?.declarations).toEqual([
      { host: "claude", sourcePath: "hooks/hooks.json", event: start?.event, execution: "process" },
    ]);
    const wrapper = inventory.hooks.find((hook) => hook.id === "pre:bash:dispatcher");
    expect(wrapper?.disableEligible).toBe(false);
    expect(wrapper?.upstreamControl).toEqual({ kind: "none" });
    const eligible = inventory.hooks.filter((hook) => hook.disableEligible);
    const count = (profile: string) =>
      eligible.filter((hook) => hook.profiles?.includes(profile)).length;
    expect([eligible.length, count("minimal"), count("standard"), count("strict")]).toEqual([
      42, 11, 39, 42,
    ]);
  });
});

describe("planHookControls", () => {
  it("keeps every hook enabled and patches no environment when nothing is requested", () => {
    const planned = planHookControls(operationContext(), { disabled: [] });
    expect(planned.decisions).toHaveLength(43);
    expect(planned.decisions.every((decision) => decision.state === "enabled")).toBe(true);
    expect(planned.environment).toBeUndefined();
    expect(planned.actions).toEqual([]);
  });

  it("returns the Claude env patch ECC enforces, with enterprise authority winning", () => {
    const planned = planHookControls(operationContext({ targets: ["claude", "codex"] }), {
      profile: { id: "standard", authority: "enterprise" },
      disabled: [
        { hookId: "pre:write:doc-file-warning", authority: "user" },
        { hookId: "session:start", authority: "user" },
        { hookId: "session:start", authority: "enterprise" },
      ],
    });
    expect(planned.environment?.host).toBe("claude");
    expect(planned.environment?.keys).toEqual(["ECC_HOOK_PROFILE", "ECC_DISABLED_HOOKS"]);
    expect(planned.environment?.set.ECC_HOOK_PROFILE).toBe("standard");
    expect(planned.environment?.set.ECC_DISABLED_HOOKS?.split(",").sort()).toEqual([
      "pre:write:doc-file-warning",
      "session:start",
    ]);
    const start = planned.decisions.find((decision) => decision.hookId === "session:start");
    expect(start).toMatchObject({ state: "disabled", authority: "enterprise" });
    expect(start?.hosts.map((host) => host.enforcement)).toEqual([
      "upstream-switch",
      "not-applicable",
    ]);
    const doc = planned.decisions.find(
      (decision) => decision.hookId === "pre:write:doc-file-warning",
    );
    expect(doc).toMatchObject({ state: "disabled", authority: "user" });
  });

  it("refuses an unknown id, the wrapper, an unknown profile and a hook the profile never runs", () => {
    const ctx = operationContext();
    expect(() =>
      planHookControls(ctx, { disabled: [{ hookId: "hook:nope", authority: "user" }] }),
    ).toThrow(/unknown ECC hook id\(s\) hook:nope/);
    expect(() =>
      planHookControls(ctx, {
        disabled: [{ hookId: "pre:bash:dispatcher", authority: "enterprise" }],
      }),
    ).toThrow(/pre:bash:dispatcher is not individually disable-eligible/);
    expect(() =>
      planHookControls(ctx, { profile: { id: "max", authority: "enterprise" }, disabled: [] }),
    ).toThrow(/unknown ECC hook profile max/);
    expect(() =>
      planHookControls(ctx, {
        profile: { id: "minimal", authority: "enterprise" },
        disabled: [{ hookId: "pre:write:doc-file-warning", authority: "user" }],
      }),
    ).toThrow(/not eligible under the minimal profile/);
  });

  it("plans an OpenCode plugin disable as unenforced with a next route, outside ECC_DISABLED_HOOKS", () => {
    const ctx = operationContext({
      descriptor: withOpenCodeRow(),
      targets: ["claude", "opencode"],
    });
    const inventory = hookInventory(ctx);
    const row = inventory.hooks.find((hook) => hook.id === "opencode:ecc-hooks");
    expect(row?.upstreamControl).toEqual({ kind: "none" });
    expect(row?.declarations.map((declaration) => declaration.host)).toEqual(["opencode"]);

    const planned = planHookControls(ctx, {
      disabled: [
        { hookId: "opencode:ecc-hooks", authority: "enterprise" },
        { hookId: "session:start", authority: "user" },
      ],
    });
    const decision = planned.decisions.find((entry) => entry.hookId === "opencode:ecc-hooks");
    expect(decision).toMatchObject({ state: "disabled", authority: "enterprise" });
    expect(decision?.hosts).toEqual([
      expect.objectContaining({ host: "claude", enforcement: "not-applicable" }),
      expect.objectContaining({ host: "opencode", enforcement: "unenforced" }),
    ]);
    expect(decision?.hosts[1]?.detail).toContain(
      "Next route: do not install ECC's .opencode/plugins/ecc-hooks.ts on opencode",
    );
    expect(planned.environment?.set).toEqual({ ECC_DISABLED_HOOKS: "session:start" });
  });
});

describe("hosts aih does not control", () => {
  /** Catalog's descriptor plus a row an uncontrolled host (Muse) declares alongside Claude. */
  function withMuseRow() {
    const document = fixtureDescriptorDocument() as {
      sections: { hookControlInventory: { hooks: unknown[] } };
    };
    document.sections.hookControlInventory.hooks.push({
      id: "muse:session-start",
      event: "SessionStart",
      profiles: ["standard", "strict"],
      disableEligible: true,
      declarations: [
        {
          host: "muse",
          sourcePath: ".muse-plugin/plugin.json",
          event: "SessionStart",
          execution: "process",
        },
      ],
      control: { kind: "none" },
    });
    return descriptorFromDocument(document);
  }

  it("accepts the declaration with control none, labelled unenforced with the host's own route", () => {
    const inventory = hookInventory(operationContext({ descriptor: withMuseRow() }));
    const row = inventory.hooks.find((hook) => hook.id === "muse:session-start");
    expect(row?.upstreamControl).toEqual({ kind: "none" });
    expect(row?.declarations).toEqual([
      expect.objectContaining({
        host: "muse",
        hostControl: expect.objectContaining({ kind: "none", enforcement: "unenforced" }),
      }),
    ]);
    expect(row?.declarations[0]?.hostControl?.nextRoute).toMatch(/muse's own/);
  });

  it("keeps the row selectable: a disable plans, labels muse unenforced, and claims no enforcement", () => {
    const ctx = operationContext({ descriptor: withMuseRow(), targets: ["claude", "codex"] });
    const planned = planHookControls(ctx, {
      disabled: [{ hookId: "muse:session-start", authority: "enterprise" }],
    });
    const decision = planned.decisions.find((entry) => entry.hookId === "muse:session-start");
    expect(decision).toMatchObject({ state: "disabled", authority: "enterprise" });
    // Undeclared targeted hosts stay not-applicable; muse is never a decision.
    expect(decision?.hosts.map((host) => [host.host, host.enforcement])).toEqual([
      ["claude", "not-applicable"],
      ["codex", "not-applicable"],
    ]);
    expect(planned.environment).toBeUndefined();
    const text = JSON.stringify(planned.actions);
    expect(text).toMatch(/muse: unenforced/);
    expect(text).toMatch(/Next route: [^"]*muse's own/);
    expect(text.toLowerCase()).not.toMatch(/withheld|blocked|unsupported/);
  });
});
