import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ALL_COMMAND_SPEC_PATHS, ALL_COMMAND_SPECS } from "../../src/commands/index.js";
import type {
  FrameworkCoreRuntimeV1,
  FrameworkOperationContextV1,
} from "../../src/framework-plugin/contract-v1.js";
import {
  command,
  eccMcpAddCommand,
  eccMcpRemoveCommand,
  executeEccCommand,
  executeEccMcpAddCommand,
} from "../../src/framework-plugin/ecc-command.js";
import type { FrameworkPluginLoadV1 } from "../../src/framework-plugin/load-framework-plugin.js";
import { type PlanContext, plan } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import { loadEccFromSource } from "./plugin-source.js";
import { eccDescriptorLoad } from "./source-plugin-mocks.js";

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

  it("refuses by name and names the install command when the plugin is not installed", async () => {
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
