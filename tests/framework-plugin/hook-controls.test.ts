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
import { frameworkHookEnvironmentPlansV1 } from "../../src/framework-plugin/hook-control-plans.js";
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

describe("frameworkHookEnvironmentPlansV1", () => {
  it("asks the ECC plugin for its plan and returns the Claude env patch", async () => {
    userList({ ecc: { disabledHookIds: ["pre:write:doc-file-warning"] } });
    const policy = parseOrgPolicy(
      v3Policy({
        frameworkHookControls: { ecc: { profile: "standard", disabledHookIds: ["session:start"] } },
      }),
    );
    const plans = await frameworkHookEnvironmentPlansV1(ctx(), policy, deps);
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
    const plans = await frameworkHookEnvironmentPlansV1(ctx(), undefined, {
      loadPlugin: () => {
        throw new Error("must not load");
      },
    });
    expect(plans.size).toBe(0);
  });

  it("refuses with framework-plugin-unavailable when the plugin is not installed", async () => {
    userList({ ecc: { disabledHookIds: ["session:start"] } });
    await expect(
      frameworkHookEnvironmentPlansV1(ctx(), undefined as OrgPolicy | undefined, {
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
    await expect(frameworkHookEnvironmentPlansV1(ctx(), undefined, deps)).rejects.toThrow(
      /unknown ECC hook id\(s\) hook:nope/,
    );
  });

  it("carries enterprise and user disables of ECC's OpenCode plugin row to the plugin", async () => {
    const document = JSON.parse(new TextDecoder().decode(eccDescriptorBytes())) as {
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
    const plans = await frameworkHookEnvironmentPlansV1(ctx(), policy, withOpenCode);
    // ECC has no switch for its OpenCode plugin: it is planned (labelled
    // unenforced by the plugin), and only switchable hooks reach the env.
    expect(plans.get("ecc")?.set).toEqual({ ECC_DISABLED_HOOKS: "session:start" });

    userList({ ecc: { disabledHookIds: ["opencode:not-a-hook"] } });
    await expect(frameworkHookEnvironmentPlansV1(ctx(), policy, withOpenCode)).rejects.toThrow(
      "unknown ECC hook id(s) opencode:not-a-hook",
    );
  });
});
