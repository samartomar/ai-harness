import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { command as bootstrapAiCommand } from "../../src/bootstrap-ai/index.js";
import { ECC_MCP_EXPLICIT_ADD_RECEIPT_PATH } from "../../src/ecc/mcp-explicit-add-receipt.js";
import type { FrameworkPluginLoadV1 } from "../../src/framework-plugin/load-framework-plugin.js";
import { executePlan } from "../../src/internals/execute.js";
import type { PlanContext } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import { executeUninstallCommand } from "../../src/uninstall/index.js";
import { loadEccFromSource } from "../framework-plugin/plugin-source.js";
import { eccDescriptorLoad } from "../framework-plugin/source-plugin-mocks.js";

/**
 * `aih uninstall` preflights EVERY piece of aih ECC state — the project's
 * `.aih/ecc/` receipts, its explicit MCP receipt, the machine registration
 * ledger and aih's Codex install state — before any cleanup: with such state and
 * a missing or broken plugin it refuses by name, naming the state, and touches
 * nothing. The materialization removal is conditioned separately.
 */

let base: string;
let root: string;
let home: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "aih-uninstall-ecc-preflight-"));
  root = join(base, "project");
  home = join(base, "home");
  mkdirSync(root);
  mkdirSync(home);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

function context(): PlanContext {
  const run = fakeRunner(() => ({ code: 0, stdout: "" }));
  const env = { HOME: home, USERPROFILE: home };
  return {
    root,
    contextDir: "ai-coding",
    apply: true,
    verify: false,
    json: false,
    run,
    host: makeHostAdapter({ platform: "linux", run, env }),
    env,
    options: {},
    targets: ["claude"],
  };
}

function put(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

function snapshot(directory: string): string {
  const files: string[] = [];
  const visit = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) visit(path);
      else
        files.push(
          `${path.slice(directory.length)}:${createHash("sha256").update(readFileSync(path)).digest("hex")}`,
        );
    }
  };
  visit(directory);
  return files.sort().join("\n");
}

async function installed(): Promise<void> {
  const ctx = context();
  await executePlan(await bootstrapAiCommand.plan(ctx), ctx, { skipWorktreeGate: true });
}

const unavailable = async (): Promise<FrameworkPluginLoadV1> => ({
  ok: false,
  refusal: {
    reason: "framework-plugin-unavailable",
    frameworkId: "ecc",
    packageName: "@aihq/framework-ecc",
    detail:
      "@aihq/framework-ecc ships inside @aihq/core but is missing from this install. Reinstall @aihq/core with: npm install -g @aihq/core",
  },
});
const incompatible = async (): Promise<FrameworkPluginLoadV1> => ({
  ok: false,
  refusal: {
    reason: "framework-plugin-incompatible",
    frameworkId: "ecc",
    packageName: "@aihq/framework-ecc",
    detail: "@aihq/framework-ecc 0.0.1 does not satisfy this Core",
  },
});

describe("aih uninstall preflights all aih ECC state", () => {
  it.each([
    ["the explicit MCP receipt", () => join(root, ECC_MCP_EXPLICIT_ADD_RECEIPT_PATH)],
    ["the machine registration ledger", () => join(home, ".aih", "ecc", "registrations.json")],
    ["aih's Codex install state", () => join(home, ".codex", "ecc-aih-install-state.json")],
  ])(
    "refuses before any cleanup when only %s exists and the plugin is missing",
    async (_, path) => {
      await installed();
      put(path(), "{}\n");
      const before = snapshot(base);
      const refused = executeUninstallCommand(context(), {
        frameworks: { loadPlugin: unavailable },
      });
      await expect(refused).rejects.toThrow(/framework-plugin-unavailable: .*npm install/);
      await expect(
        executeUninstallCommand(context(), { frameworks: { loadPlugin: unavailable } }),
      ).rejects.toThrow(/aih ECC state found: /);
      expect(snapshot(base)).toBe(before);
    },
  );

  it("refuses an incompatible plugin by name, naming the state found", async () => {
    await installed();
    const receipt = join(root, ECC_MCP_EXPLICIT_ADD_RECEIPT_PATH);
    put(receipt, "{}\n");
    const before = snapshot(base);
    await expect(
      executeUninstallCommand(context(), { frameworks: { loadPlugin: incompatible } }),
    ).rejects.toThrow(
      new RegExp(
        `framework-plugin-incompatible: .*aih ECC state found: ${receipt.replace(/[\\.]/g, "\\$&")}`,
      ),
    );
    expect(snapshot(base)).toBe(before);
  });

  it("does not load the plugin when no aih ECC state exists", async () => {
    await installed();
    let loads = 0;
    const result = await executeUninstallCommand(context(), {
      frameworks: {
        loadPlugin: async () => {
          loads += 1;
          return unavailable();
        },
      },
    });
    expect(result.applied).toBe(true);
    expect(loads).toBe(0);
  });

  it("with the plugin and only non-materialization state, cleans up without an ECC removal", async () => {
    await installed();
    put(join(home, ".aih", "ecc", "registrations.json"), "{}\n");
    let removals = 0;
    const result = await executeUninstallCommand(context(), {
      frameworks: {
        loadPlugin: () => loadEccFromSource(),
        loadDescriptor: async () => eccDescriptorLoad(),
      },
      removeMaterialization: () => {
        removals += 1;
        return { removed: [], advisories: [] };
      },
    });
    expect(result.applied).toBe(true);
    expect(removals).toBe(0);
  });
});
