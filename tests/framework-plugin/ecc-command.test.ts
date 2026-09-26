import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ALL_COMMAND_SPEC_PATHS, ALL_COMMAND_SPECS } from "../../src/commands/index.js";
import type {
  FrameworkCoreRuntimeV1,
  FrameworkOperationContextV1,
  FrameworkPolicyDeliveryHookV1,
} from "../../src/framework-plugin/contract-v1.js";
import {
  command,
  eccMcpAddCommand,
  eccMcpRemoveCommand,
  executeEccCommand,
  executeEccMcpAddCommand,
} from "../../src/framework-plugin/ecc-command.js";
import type { FrameworkPluginLoadV1 } from "../../src/framework-plugin/load-framework-plugin.js";
import {
  type FrameworkInvocationV1,
  type LoadedFrameworkPluginV1,
  prepareFrameworkPolicyDeliveryV1,
} from "../../src/framework-plugin/run-framework-command.js";
import { type PlanContext, plan } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import { loadEccFromSource } from "./plugin-source.js";
import { eccDescriptorLoad } from "./source-plugin-mocks.js";

// The real loader sees a Core install without its bundled plugins (D71): the
// one route to framework-plugin-unavailable, whether or not packages/*/dist is built.
vi.mock("../../src/framework-plugin/load-framework-plugin.js", async (importOriginal) => {
  const { withBundledPluginsMissing } = await import("./missing-bundled-plugins.js");
  return withBundledPluginsMissing(await importOriginal());
});

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aih-ecc-shell-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function ctx(over: Partial<PlanContext> = {}): PlanContext {
  const run = fakeRunner(() => undefined);
  return {
    root,
    contextDir: "ai-coding",
    posture: "vibe",
    apply: false,
    verify: true,
    json: false,
    run,
    host: makeHostAdapter({ platform: "linux", run, env: {} }),
    env: {},
    options: { cli: "windsurf" },
    ...over,
  };
}

const withPlugin = {
  loadPlugin: () => loadEccFromSource(),
  loadDescriptor: async () => eccDescriptorLoad(),
};

/** The ECC plugin with its `ecc` command replaced, for runtime-boundary tests. */
async function eccWithCommand(
  execute: (context: FrameworkOperationContextV1) => Promise<unknown>,
): Promise<FrameworkPluginLoadV1> {
  const loaded = await loadEccFromSource();
  if (!loaded.ok) throw new Error(loaded.refusal.detail);
  return {
    ...loaded,
    plugin: {
      ...loaded.plugin,
      commands: { ...loaded.plugin.commands, ecc: { execute } },
    },
  } as FrameworkPluginLoadV1;
}

describe("aih ecc — the Core command shell", () => {
  it("keeps the command surface in Core and has no standalone plan", () => {
    expect(command.name).toBe("ecc");
    expect(command.options?.map((option) => option.flags)).toContain("--profile <profile>");
    expect(() => command.plan(ctx())).toThrow(/runs through @aihq\/framework-ecc/);
  });

  it("publishes the nested mcp add/remove specs in the command registry metadata", () => {
    expect(ALL_COMMAND_SPECS).toContain(eccMcpAddCommand);
    expect(ALL_COMMAND_SPECS).toContain(eccMcpRemoveCommand);
    expect(ALL_COMMAND_SPEC_PATHS).toContainEqual(["ecc", "mcp", "add"]);
    expect(ALL_COMMAND_SPEC_PATHS).toContainEqual(["ecc", "mcp", "remove"]);
  });

  it("refuses by name and names the reinstall command when the bundled plugin is missing", async () => {
    await expect(executeEccCommand(ctx())).rejects.toThrow(
      /framework-plugin-unavailable: .*npm install/,
    );
    await expect(executeEccMcpAddCommand(ctx({ options: { id: "x" } }))).rejects.toThrow(
      /framework-plugin-unavailable/,
    );
  });

  it("runs the plugin's consult route through Core's runtime", async () => {
    const result = await executeEccCommand(ctx(), withPlugin);
    const docs = result.docs.map((entry) => entry.describe).join("\n");
    expect(docs).toContain("Install ECC for windsurf (via the consult advisor)");
    expect(docs).toContain("supply chain — ECC runs LATEST upstream unless you pin it");
  });

  it("binds the runtime to the invocation root and revokes it when the invocation ends", async () => {
    let kept: FrameworkCoreRuntimeV1 | undefined;
    const loaded = await eccWithCommand(async (context) => {
      const runtime = context.host.runtime;
      if (runtime === undefined) throw new Error("expected Core's runtime");
      kept = runtime;
      expect(runtime.planContext.root).toBe(root);
      await expect(
        runtime.executePlan(plan("elsewhere"), { ...runtime.planContext, root: tmpdir() }),
      ).rejects.toThrow(/another root than its invocation/);
      return runtime.executePlan(plan("ecc"), runtime.planContext);
    });
    const result = await executeEccCommand(ctx(), {
      loadPlugin: async () => loaded,
      loadDescriptor: async () => eccDescriptorLoad(),
    });
    expect(result.capability).toBe("ecc");
    const later = kept as FrameworkCoreRuntimeV1;
    await expect(later.executePlan(plan("late"), later.planContext)).rejects.toThrow(
      /after its invocation ended/,
    );
    expect(() => later.readOrgPolicy(root, {})).toThrow(/after its invocation ended/);
  });

  it("refuses a result the plugin did not get from Core's runtime", async () => {
    const loaded = await eccWithCommand(async (context) => {
      const produced = await context.host.runtime?.executePlan(
        plan("ecc"),
        context.host.runtime.planContext,
      );
      return { ...produced };
    });
    await expect(
      executeEccCommand(ctx(), {
        loadPlugin: async () => loaded,
        loadDescriptor: async () => eccDescriptorLoad(),
      }),
    ).rejects.toThrow(/did not produce/);
  });
});

describe("governed ECC delivery — the Core invocation around policy projection", () => {
  function invocation(): FrameworkInvocationV1 {
    return {
      ctx: { ...ctx(), targets: ["windsurf"] },
      policy: undefined,
      transactionPins: {},
      options: {},
    };
  }

  async function withDelivery(
    delivery: Pick<FrameworkPolicyDeliveryHookV1, "prepare"> | undefined,
  ): Promise<LoadedFrameworkPluginV1> {
    const loaded = await loadEccFromSource();
    if (!loaded.ok) throw new Error(loaded.refusal.detail);
    const inspect = loaded.plugin.policyDelivery?.inspect;
    if (inspect === undefined) throw new Error("expected the source plugin's inspector");
    const policyDelivery = delivery === undefined ? undefined : { ...delivery, inspect };
    return { ...loaded, plugin: { ...loaded.plugin, policyDelivery } };
  }

  it("refuses a plugin without a policy delivery as incompatible", async () => {
    await expect(
      prepareFrameworkPolicyDeliveryV1(await withDelivery(undefined), invocation(), withPlugin),
    ).rejects.toThrow(/framework-plugin-incompatible: .*provides no policy delivery/);
  });

  it("keeps the runtime live until Core ends the invocation, and commits at most once", async () => {
    let kept: FrameworkCoreRuntimeV1 | undefined;
    const loaded = await withDelivery({
      prepare: async (context) => {
        const runtime = context.host.runtime;
        if (runtime === undefined) throw new Error("expected Core's runtime");
        kept = runtime;
        const result = await runtime.executePlan(plan("ecc: prepared"), runtime.planContext);
        return {
          result,
          commit: () => runtime.executePlan(plan("ecc: committed"), runtime.planContext),
        };
      },
    });
    const delivery = await prepareFrameworkPolicyDeliveryV1(loaded, invocation(), withPlugin);
    expect(delivery.result.capability).toBe("ecc: prepared");
    const committed = await delivery.commit?.(undefined);
    expect(committed?.capability).toBe("ecc: committed");
    await expect(delivery.commit?.(undefined)).rejects.toThrow(/already committed/);
    delivery.end();
    const later = kept as FrameworkCoreRuntimeV1;
    await expect(later.executePlan(plan("late"), later.planContext)).rejects.toThrow(
      /after its invocation ended/,
    );
  });

  it("refuses a prepared result Core's runtime did not produce, and ends the invocation", async () => {
    let kept: FrameworkCoreRuntimeV1 | undefined;
    const loaded = await withDelivery({
      prepare: async (context) => {
        kept = context.host.runtime;
        const produced = await context.host.runtime?.executePlan(
          plan("ecc"),
          context.host.runtime.planContext,
        );
        return { result: { ...produced } as never };
      },
    });
    await expect(
      prepareFrameworkPolicyDeliveryV1(loaded, invocation(), withPlugin),
    ).rejects.toThrow(/did not produce/);
    expect(() => kept?.readOrgPolicy(root, {})).toThrow(/after its invocation ended/);
  });
});
