import { describe, expect, it } from "vitest";
import { hookInventory, planHookControls } from "../src/hooks.js";
import { operationContext, PINNED_COMMIT } from "./context.js";

describe("hookInventory", () => {
  it("exposes the SessionStart hook with every host declaration from the pinned tree", () => {
    const inventory = hookInventory(operationContext());
    expect(inventory.frameworkId).toBe("superpowers");
    expect(inventory.upstream).toEqual({ repository: "obra/Superpowers", commit: PINNED_COMMIT });
    const [hook] = inventory.hooks;
    expect(hook?.id).toBe("hook:session-start");
    expect(hook?.event).toBe("SessionStart");
    expect(hook?.declarations).toContainEqual({
      host: "claude",
      sourcePath: "hooks/hooks.json",
      event: "SessionStart",
      matcher: "startup|clear|compact",
      command: '"$' + '{CLAUDE_PLUGIN_ROOT}/hooks/run-hook.cmd" session-start',
      execution: "process",
    });
    expect(hook?.declarations).toContainEqual({
      host: "kimi",
      sourcePath: ".kimi-plugin/plugin.json",
      event: "sessionStart",
      execution: "declarative",
    });
  });
});

describe("planHookControls", () => {
  it("keeps every hook enabled when policy disables nothing", () => {
    const planned = planHookControls(operationContext(), { disabled: [] });
    expect(planned.decisions).toEqual([
      { hookId: "hook:session-start", state: "enabled", hosts: [] },
    ]);
    expect(planned.actions).toEqual([]);
  });

  it("labels a disabled hook per targeted host and gives the next route where aih cannot enforce it", () => {
    const planned = planHookControls(
      operationContext({ targets: ["claude", "codex", "kiro", "cursor"] }),
      { disabled: [{ hookId: "hook:session-start", authority: "enterprise" }] },
    );
    const [decision] = planned.decisions;
    expect(decision?.state).toBe("disabled");
    expect(decision?.authority).toBe("enterprise");
    expect(decision?.hosts.map((host) => [host.host, host.enforcement])).toEqual([
      ["claude", "unenforced"],
      ["codex", "not-applicable"],
      ["kiro", "not-applicable"],
      ["cursor", "unenforced"],
    ]);
    const claude = decision?.hosts.find((host) => host.host === "claude");
    expect(claude?.detail).toContain("no switch");
    expect(claude?.detail).toContain("Next route");
    expect(planned.actions).toHaveLength(1);
    const text = JSON.stringify(planned.actions);
    expect(text).toContain("enterprise");
    expect(text).toContain("claude, cursor");
  });

  it("never describes the third-party hook as withheld, blocked or unsupported", () => {
    const planned = planHookControls(operationContext({ targets: ["claude"] }), {
      disabled: [{ hookId: "hook:session-start", authority: "user" }],
    });
    expect(JSON.stringify(planned).toLowerCase()).not.toMatch(/withheld|blocked|unsupported/);
  });

  it("records enterprise as the authority when both enterprise and user disable a hook", () => {
    const planned = planHookControls(operationContext(), {
      disabled: [
        { hookId: "hook:session-start", authority: "user" },
        { hookId: "hook:session-start", authority: "enterprise" },
      ],
    });
    expect(planned.decisions[0]?.authority).toBe("enterprise");
  });

  it("records a user-only disable as user authority", () => {
    const planned = planHookControls(operationContext(), {
      disabled: [{ hookId: "hook:session-start", authority: "user" }],
    });
    expect(planned.decisions[0]?.authority).toBe("user");
  });

  it("emits no label when the disabled hook runs on none of the targeted hosts", () => {
    const planned = planHookControls(operationContext({ targets: ["codex", "kiro"] }), {
      disabled: [{ hookId: "hook:session-start", authority: "enterprise" }],
    });
    expect(planned.decisions[0]?.state).toBe("disabled");
    expect(planned.actions).toEqual([]);
  });

  it("refuses a hook id the pinned inventory does not contain, naming the known ids", () => {
    let caught: unknown;
    try {
      planHookControls(operationContext(), {
        disabled: [{ hookId: "hook:post-tool-use", authority: "enterprise" }],
      });
    } catch (error) {
      caught = error;
    }
    expect((caught as { code?: string }).code).toBe("AIH_CONFIG");
    expect((caught as Error).message).toContain("hook:post-tool-use");
    expect((caught as Error).message).toContain("hook:session-start");
  });

  it("accepts Core's hook-control carrier but refuses a profile, which Superpowers lacks", () => {
    expect(() =>
      planHookControls(operationContext(), {
        profile: { id: "standard", authority: "enterprise" },
        disabled: [],
      }),
    ).toThrow(
      /obra\/Superpowers has no hook profiles; the enterprise hook profile standard is refused/,
    );
  });
});
