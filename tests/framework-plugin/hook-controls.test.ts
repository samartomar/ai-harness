import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fixtureDescriptorBytes as eccDescriptorBytes } from "../../packages/framework-ecc/tests/context.js";
import type { FrameworkDescriptorLoadV1 } from "../../src/catalog-package/framework-descriptors.js";
import { AIH_CONFIG_FILE } from "../../src/config/marker.js";
import { SettingsError } from "../../src/errors.js";
import type { FrameworkIdV1 } from "../../src/framework-plugin/contract-v1.js";
import { frameworkHookControlPlansV1 } from "../../src/framework-plugin/hook-control-plans.js";
import {
  frameworkHookControlRequestV1,
  mergeFrameworkHookControlRequestV1,
  readUserFrameworkHookControlsV1,
} from "../../src/framework-plugin/hook-controls.js";
import type { FrameworkPluginLoadV1 } from "../../src/framework-plugin/load-framework-plugin.js";
import type { PlanContext } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { type OrgPolicy, parseOrgPolicy } from "../../src/org-policy/schema.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import { loadEccFromSource, loadSuperpowersFromSource } from "./plugin-source.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aih-framework-hook-carrier-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function ctx(): PlanContext {
  const run = fakeRunner(() => ({ code: 0, stdout: "" }));
  return {
    root,
    contextDir: "ai-coding",
    posture: "enterprise",
    apply: false,
    verify: false,
    json: false,
    run,
    host: makeHostAdapter({ platform: "linux", run, env: {} }),
    env: {},
    options: {},
    targets: ["claude"],
  };
}

function v3Policy(governance: Record<string, unknown>, minimumCoreVersion = "0.7.0") {
  return {
    schemaVersion: 3,
    minimumCoreVersion,
    minimumPosture: "vibe",
    references: { repoContract: "ai-coding/project.json" },
    authoringSelections: {
      selectionVersion: "workbench-selection/v1",
      roots: [],
      exclusions: [],
      requests: [],
      drafts: [],
    },
    governance: {
      supportedClis: ["claude"],
      policyVersion: "2026-09-24.1",
      catalog: { reviewed: [], custom: [] },
      ...governance,
    },
  };
}

function userList(value: unknown): void {
  writeFileSync(
    join(root, AIH_CONFIG_FILE),
    `${JSON.stringify({ schemaVersion: 1, contextDir: "ai-coding", frameworkHookControls: value })}\n`,
  );
}

const deps = {
  loadPlugin: (id: FrameworkIdV1): Promise<FrameworkPluginLoadV1> =>
    id === "ecc" ? loadEccFromSource() : loadSuperpowersFromSource(),
  loadDescriptor: async (id: FrameworkIdV1): Promise<FrameworkDescriptorLoadV1> => {
    if (id !== "ecc") throw new Error("test descriptor is ECC only");
    const bytes = eccDescriptorBytes();
    return {
      ok: true,
      frameworkId: "ecc",
      bytes,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  },
};

describe("governance.frameworkHookControls", () => {
  it("is accepted in a schema-3 policy with minimumCoreVersion 0.7.0", () => {
    const policy = parseOrgPolicy(
      v3Policy({
        frameworkHookControls: {
          ecc: { profile: "standard", disabledHookIds: ["session:start"] },
        },
      }),
    );
    expect(policy.governance?.frameworkHookControls).toEqual({
      ecc: { profile: "standard", disabledHookIds: ["session:start"] },
    });
  });

  it("requires schema 3 and Core 0.7.0", () => {
    const controls = { frameworkHookControls: { ecc: { disabledHookIds: [] } } };
    expect(() => parseOrgPolicy(v3Policy(controls, "0.6.0"))).toThrow(
      /frameworkHookControls requires schemaVersion 3 and minimumCoreVersion 0.7.0/,
    );
    const v2 = { ...v3Policy(controls), schemaVersion: 2 } as Record<string, unknown>;
    delete v2.minimumCoreVersion;
    delete v2.authoringSelections;
    expect(() => parseOrgPolicy(v2)).toThrow(/frameworkHookControls requires schemaVersion 3/);
  });

  it("refuses the removed eccHookControls and names its replacement", () => {
    expect(() => parseOrgPolicy(v3Policy({ eccHookControls: { profile: "standard" } }))).toThrow(
      /eccHookControls was replaced by governance.frameworkHookControls.ecc/,
    );
  });

  it("refuses an unknown framework key and malformed ids", () => {
    expect(() =>
      parseOrgPolicy(v3Policy({ frameworkHookControls: { other: { disabledHookIds: [] } } })),
    ).toThrow();
    expect(() =>
      parseOrgPolicy(v3Policy({ frameworkHookControls: { ecc: { disabledHookIds: ["Bad Id"] } } })),
    ).toThrow(/framework hook id/);
  });
});

describe("the user list in .aih-config.json", () => {
  it("is absent without a marker or key, and read strictly when present", () => {
    expect(readUserFrameworkHookControlsV1(root)).toBeUndefined();
    userList({ superpowers: { disabledHookIds: ["hook:session-start"] } });
    expect(readUserFrameworkHookControlsV1(root)).toEqual({
      superpowers: { disabledHookIds: ["hook:session-start"] },
    });
  });

  it("fails closed on a malformed list instead of treating it as absent", () => {
    userList({ ecc: { disabledHookIds: "session:start" } });
    expect(() => readUserFrameworkHookControlsV1(root)).toThrow(
      /invalid frameworkHookControls in \.aih-config\.json/,
    );
    userList({ nope: { disabledHookIds: [] } });
    expect(() => readUserFrameworkHookControlsV1(root)).toThrow(/frameworkHookControls/);
  });

  it("refuses a profile in the user list even where enterprise sets none", () => {
    // Enterprise policy is the only profile source: a user profile would change
    // every hook at once, past individual disable eligibility.
    userList({ ecc: { profile: "minimal", disabledHookIds: [] } });
    expect(() => readUserFrameworkHookControlsV1(root)).toThrow(
      /the user list may only add disables; ecc.profile is set only by enterprise policy/,
    );
    expect(() => frameworkHookControlRequestV1("ecc", undefined, root)).toThrow(SettingsError);
    userList({ superpowers: { disabledHookIds: [], extra: true } });
    expect(() => readUserFrameworkHookControlsV1(root)).toThrow(
      /the user list may only add disables; superpowers.extra is not a user control/,
    );
  });
});

describe("mergeFrameworkHookControlRequestV1", () => {
  it("adds user disables to enterprise ones, and enterprise outranks user", () => {
    expect(
      mergeFrameworkHookControlRequestV1(
        { profile: "standard", disabledHookIds: ["session:start"] },
        { disabledHookIds: ["session:start", "pre:observe"] },
      ),
    ).toEqual({
      profile: { id: "standard", authority: "enterprise" },
      disabled: [
        { hookId: "session:start", authority: "enterprise" },
        { hookId: "pre:observe", authority: "user" },
      ],
    });
  });

  it("takes the profile only from enterprise; the user list carries none", () => {
    expect(
      mergeFrameworkHookControlRequestV1(undefined, { disabledHookIds: ["pre:observe"] }),
    ).toEqual({ disabled: [{ hookId: "pre:observe", authority: "user" }] });
    expect(
      mergeFrameworkHookControlRequestV1({ profile: "minimal", disabledHookIds: [] }, undefined),
    ).toEqual({ profile: { id: "minimal", authority: "enterprise" }, disabled: [] });
  });

  it("reads both authorities for one framework", () => {
    userList({ ecc: { disabledHookIds: ["pre:observe"] } });
    const policy = parseOrgPolicy(
      v3Policy({ frameworkHookControls: { ecc: { disabledHookIds: ["session:start"] } } }),
    );
    expect(frameworkHookControlRequestV1("ecc", policy, root).disabled).toEqual([
      { hookId: "session:start", authority: "enterprise" },
      { hookId: "pre:observe", authority: "user" },
    ]);
    expect(frameworkHookControlRequestV1("superpowers", policy, root)).toEqual({ disabled: [] });
  });
});

describe("frameworkHookControlPlansV1", () => {
  it("asks the ECC plugin for its plan and returns the Claude env patch", async () => {
    userList({ ecc: { disabledHookIds: ["pre:write:doc-file-warning"] } });
    const policy = parseOrgPolicy(
      v3Policy({
        frameworkHookControls: { ecc: { profile: "standard", disabledHookIds: ["session:start"] } },
      }),
    );
    const plans = (await frameworkHookControlPlansV1(ctx(), policy, deps)).environments;
    expect(plans.get("ecc")).toEqual({
      host: "claude",
      keys: ["ECC_HOOK_PROFILE", "ECC_DISABLED_HOOKS"],
      set: {
        ECC_HOOK_PROFILE: "standard",
        ECC_DISABLED_HOOKS: expect.stringContaining("session:start"),
      },
    });
    expect(plans.get("ecc")?.set.ECC_DISABLED_HOOKS?.split(",").sort()).toEqual([
      "pre:write:doc-file-warning",
      "session:start",
    ]);
  });

  it("loads no plugin when no authority declares controls", async () => {
    const plans = await frameworkHookControlPlansV1(ctx(), undefined, {
      loadPlugin: () => {
        throw new Error("must not load");
      },
    });
    expect(plans.environments.size).toBe(0);
    expect(plans.actions).toEqual([]);
  });

  it("refuses with framework-plugin-unavailable when the plugin is not installed", async () => {
    userList({ ecc: { disabledHookIds: ["session:start"] } });
    await expect(
      frameworkHookControlPlansV1(ctx(), undefined as OrgPolicy | undefined, {
        loadPlugin: async () => ({
          ok: false,
          refusal: {
            reason: "framework-plugin-unavailable",
            frameworkId: "ecc",
            packageName: "@aihq/framework-ecc",
            detail: "not installed",
          },
        }),
      }),
    ).rejects.toThrow(/framework-plugin-unavailable|npm install/);
  });

  it("surfaces the plugin's refusal of an id its inventory does not have", async () => {
    userList({ ecc: { disabledHookIds: ["hook:nope"] } });
    await expect(frameworkHookControlPlansV1(ctx(), undefined, deps)).rejects.toThrow(
      /unknown ECC hook id\(s\) hook:nope/,
    );
  });

  it("carries enterprise and user disables of ECC's OpenCode plugin row to the plugin", async () => {
    const document = JSON.parse(new TextDecoder().decode(eccDescriptorBytes())) as {
      sections: { hookControlInventory: { hooks: unknown[] } };
    };
    // Catalog carries the OpenCode plugin row itself from ECC v2.2.1.
    expect(
      document.sections.hookControlInventory.hooks.filter(
        (hook) => (hook as { id: string }).id === "opencode:ecc-hooks",
      ),
    ).toHaveLength(1);
    const bytes = new TextEncoder().encode(`${JSON.stringify(document)}
`);
    const withOpenCode = {
      ...deps,
      loadDescriptor: async (): Promise<FrameworkDescriptorLoadV1> => ({
        ok: true,
        frameworkId: "ecc",
        bytes,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      }),
    };
    userList({ ecc: { disabledHookIds: ["opencode:ecc-hooks"] } });
    const policy = parseOrgPolicy(
      v3Policy({ frameworkHookControls: { ecc: { disabledHookIds: ["session:start"] } } }),
    );
    const mixed = { ...ctx(), targets: ["claude", "opencode"] as PlanContext["targets"] };
    const plans = await frameworkHookControlPlansV1(mixed, policy, withOpenCode);
    // ECC has no switch for its OpenCode plugin: it is planned, labelled
    // unenforced with a next route, and only switchable hooks reach the env.
    expect(plans.environments.get("ecc")?.set).toEqual({ ECC_DISABLED_HOOKS: "session:start" });
    const labels = plans.actions.filter((action) => action.kind === "doc");
    expect(labels.map((action) => action.describe)).toEqual(["ecc hook controls"]);
    const text = labels[0]?.kind === "doc" ? labels[0].text : "";
    expect(text).toContain("opencode:ecc-hooks: disabled (user)");
    expect(text).toMatch(
      /opencode: unenforced — aih cannot turn opencode:ecc-hooks off on opencode.*Next route: /,
    );
    expect(text).toContain("session:start: disabled (enterprise)");
    expect(text).toMatch(/claude: upstream-switch — ECC skips session:start/);

    // An OpenCode-only target still plans (and validates) the controls; the
    // plan carries its labels and owns no Claude environment write.
    const openCodeOnly = { ...ctx(), targets: ["opencode"] as PlanContext["targets"] };
    const onlyOpenCode = await frameworkHookControlPlansV1(openCodeOnly, policy, withOpenCode);
    expect(onlyOpenCode.actions.map((action) => action.describe)).toEqual(["ecc hook controls"]);

    userList({ ecc: { disabledHookIds: ["opencode:not-a-hook"] } });
    await expect(frameworkHookControlPlansV1(ctx(), policy, withOpenCode)).rejects.toThrow(
      "unknown ECC hook id(s) opencode:not-a-hook",
    );
    await expect(frameworkHookControlPlansV1(openCodeOnly, policy, withOpenCode)).rejects.toThrow(
      "unknown ECC hook id(s) opencode:not-a-hook",
    );
  });
});

describe("frameworkHookControlPlansV1 decision coverage", () => {
  type Plan = { decisions: Array<{ hookId: string; state: string; hosts: unknown[] }> };

  async function brokenPlan(mutate: (plan: Plan) => void) {
    const loaded = await loadEccFromSource();
    if (!loaded.ok) throw new Error("ECC source plugin did not load");
    const original = loaded.plugin.planHookControls.bind(loaded.plugin);
    return {
      ...deps,
      loadPlugin: async (): Promise<FrameworkPluginLoadV1> => ({
        ...loaded,
        plugin: {
          ...loaded.plugin,
          planHookControls: (context, request) => {
            const plan = structuredClone(original(context, request)) as unknown as Plan;
            mutate(plan);
            return plan as never;
          },
        },
      }),
    };
  }

  const mixed = (): PlanContext => ({
    ...ctx(),
    targets: ["claude", "opencode"] as PlanContext["targets"],
  });
  const incompatible = /framework-plugin-incompatible: .*hook-control plan/;

  beforeEach(() => {
    userList({ ecc: { disabledHookIds: ["session:start"] } });
  });

  it("accepts the plugin's own complete plan for every targeted host", async () => {
    const plans = await frameworkHookControlPlansV1(mixed(), undefined, await brokenPlan(() => {}));
    expect(plans.actions.map((action) => action.describe)).toEqual(["ecc hook controls"]);
  });

  it("refuses a plan that omits the decision for a requested disable", async () => {
    const plugin = await brokenPlan((plan) => {
      plan.decisions = [];
    });
    await expect(frameworkHookControlPlansV1(ctx(), undefined, plugin)).rejects.toThrow(
      incompatible,
    );
    await expect(frameworkHookControlPlansV1(ctx(), undefined, plugin)).rejects.toThrow(
      /session:start/,
    );
  });

  it("refuses a requested disable the plan reports as enabled", async () => {
    const plugin = await brokenPlan((plan) => {
      const decision = plan.decisions.find((item) => item.hookId === "session:start");
      if (decision === undefined) throw new Error("fixture has no session:start decision");
      decision.state = "enabled";
      decision.hosts = [];
    });
    await expect(frameworkHookControlPlansV1(ctx(), undefined, plugin)).rejects.toThrow(
      incompatible,
    );
  });

  it("refuses a disabled decision with no host decisions", async () => {
    const plugin = await brokenPlan((plan) => {
      for (const decision of plan.decisions) if (decision.state === "disabled") decision.hosts = [];
    });
    await expect(frameworkHookControlPlansV1(ctx(), undefined, plugin)).rejects.toThrow(
      incompatible,
    );
  });

  it("refuses a disabled decision that omits one targeted host", async () => {
    const plugin = await brokenPlan((plan) => {
      for (const decision of plan.decisions)
        if (decision.state === "disabled") decision.hosts = decision.hosts.slice(0, 1);
    });
    await expect(frameworkHookControlPlansV1(mixed(), undefined, plugin)).rejects.toThrow(
      incompatible,
    );
  });

  it("refuses a duplicated host decision", async () => {
    const plugin = await brokenPlan((plan) => {
      for (const decision of plan.decisions)
        if (decision.state === "disabled") decision.hosts = [decision.hosts[0], decision.hosts[0]];
    });
    await expect(frameworkHookControlPlansV1(ctx(), undefined, plugin)).rejects.toThrow(
      incompatible,
    );
  });

  /** Turn the first enabled (unrequested) decision into a valid disabled one. */
  function disableUnrequested(authority: string) {
    let hookId = "";
    const plugin = brokenPlan((plan) => {
      const requested = plan.decisions.find((item) => item.hookId === "session:start");
      const target = plan.decisions.find((item) => item.state === "enabled");
      if (requested === undefined || target === undefined)
        throw new Error("fixture has no requested and unrequested decisions");
      hookId = target.hookId;
      Object.assign(target, structuredClone(requested), { hookId, authority });
    });
    return { plugin, hookId: () => hookId };
  }

  it.each(["enterprise", "user"])(
    "refuses a valid disabled decision for an unrequested hook under an invented %s authority",
    async (authority) => {
      const invented = disableUnrequested(authority);
      const plugin = await invented.plugin;
      await expect(frameworkHookControlPlansV1(ctx(), undefined, plugin)).rejects.toThrow(
        incompatible,
      );
      expect(invented.hookId()).not.toBe("");
      await expect(frameworkHookControlPlansV1(ctx(), undefined, plugin)).rejects.toThrow(
        `${invented.hookId()} is disabled, but no authority requested its disable`,
      );
    },
  );

  it("keeps the enabled inventory decisions and labels only the requested disable", async () => {
    const plans = await frameworkHookControlPlansV1(ctx(), undefined, await brokenPlan(() => {}));
    const label = plans.actions[0];
    const text = label?.kind === "doc" ? label.text : "";
    expect(text).toMatch(/^session:start: disabled \(user\)\n/);
    expect(text.match(/: disabled \(/g)).toHaveLength(1);
  });

  it("refuses duplicated decisions for one hook", async () => {
    const plugin = await brokenPlan((plan) => {
      const decision = plan.decisions.find((item) => item.hookId === "session:start");
      if (decision === undefined) throw new Error("fixture has no session:start decision");
      plan.decisions.push(structuredClone(decision));
    });
    await expect(frameworkHookControlPlansV1(ctx(), undefined, plugin)).rejects.toThrow(
      incompatible,
    );
  });
});

describe("frameworkHookControlPlansV1 and hosts aih does not control", () => {
  it("carries a muse declaration as an unenforced label, planned for targets only", async () => {
    const document = JSON.parse(new TextDecoder().decode(eccDescriptorBytes())) as {
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
    const bytes = new TextEncoder().encode(`${JSON.stringify(document)}\n`);
    const withMuse = {
      ...deps,
      loadDescriptor: async (): Promise<FrameworkDescriptorLoadV1> => ({
        ok: true,
        frameworkId: "ecc",
        bytes,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      }),
    };
    userList({ ecc: { disabledHookIds: ["muse:session-start"] } });
    const plans = await frameworkHookControlPlansV1(ctx(), undefined, withMuse);
    expect(plans.environments.size).toBe(0);
    const text = plans.actions
      .map((action) => (action.kind === "doc" ? action.text : ""))
      .join("\n");
    expect(text).toContain("muse:session-start: disabled (user)");
    expect(text).toMatch(/claude: not-applicable/);
    expect(text).toMatch(/muse: unenforced — .*Next route: .*muse's own/);
    expect(text).not.toMatch(/muse: (upstream-switch|not-applicable)/);
  });
});
