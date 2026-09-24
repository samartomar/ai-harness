import { describe, expect, it } from "vitest";
import { hookInventory, planHookControls } from "../src/hooks.js";
import { operationContext, PINNED_COMMIT } from "./context.js";

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
    ).toThrow(/is a wrapper/);
    expect(() =>
      planHookControls(ctx, { profile: { id: "max", authority: "user" }, disabled: [] }),
    ).toThrow(/unknown ECC hook profile max/);
    expect(() =>
      planHookControls(ctx, {
        profile: { id: "minimal", authority: "enterprise" },
        disabled: [{ hookId: "pre:write:doc-file-warning", authority: "user" }],
      }),
    ).toThrow(/not eligible under the minimal profile/);
  });
});
