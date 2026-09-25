import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { methodologySteering } from "../../packages/framework-superpowers/src/kiro-steering.js";
import { hashComponentTree } from "../../src/baseline-evidence/hash.js";
import { componentIdentityPaths } from "../../src/baseline-evidence/license.js";
import { parseBaselineEvidenceLock } from "../../src/baseline-evidence/schema.js";
import { readVendorBaselineLock } from "../../src/baseline-evidence/vendor.js";
import type { FrameworkOperationContextV1 } from "../../src/framework-plugin/contract-v1.js";
import { frameworkHostServicesV1 } from "../../src/framework-plugin/host-services.js";
import {
  command,
  executeSuperpowersCommand,
  executeSuperpowersInitPhase,
} from "../../src/framework-plugin/superpowers-command.js";
import { executeInitCommand } from "../../src/init/index.js";
import type { PlanResult } from "../../src/internals/execute.js";
import { type PlanContext, plan, writeText } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import { buildProgram } from "../../src/program.js";
import { loadSuperpowersFromSource } from "./plugin-source.js";

const PIN = "b36e0829c6d0140e93cfef2ca599b1b07d4a7797";
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aih-superpowers-shell-"));
  process.exitCode = undefined;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  process.exitCode = undefined;
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
    options: {},
    ...over,
  };
}

const withPlugin = { loadPlugin: () => loadSuperpowersFromSource() };

async function runCli(args: string[]): Promise<{ stdout: string; exitCode: unknown }> {
  const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  try {
    const program = buildProgram();
    program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
    await program.parseAsync(["node", "aih", ...args]);
    return {
      stdout: stdout.mock.calls.map((call: unknown[]) => String(call[0])).join(""),
      exitCode: process.exitCode,
    };
  } finally {
    stdout.mockRestore();
  }
}

describe("aih superpowers — the Core command shell", () => {
  it("keeps the command's summary and options", () => {
    expect(command.name).toBe("superpowers");
    expect(command.summary).toBe(
      "Verify exact-pinned obra/Superpowers components and emit evidence-bound target guidance",
    );
    expect(command.options).toEqual([]);
    expect(command.alwaysVerify).toBe(true);
  });

  it("refuses by name and names the install command when the plugin is not installed", async () => {
    const { stdout, exitCode } = await runCli([
      "superpowers",
      "--json",
      "--no-log",
      "--root",
      root,
    ]);
    const payload = JSON.parse(stdout) as { error: { code: string; message: string } };
    expect(exitCode).toBe(1);
    expect(payload.error.code).toBe("AIH_FRAMEWORK_PLUGIN");
    expect(payload.error.message).toMatch(/^framework-plugin-unavailable: /);
    expect(payload.error.message).toContain(
      "npm install -g @aihq/core @aihq/framework-superpowers",
    );
    expect(existsSync(join(root, ".aih"))).toBe(false);
  }, 20_000);

  it("never plans outside the plugin's evidence-gated executor", () => {
    expect(() => command.plan(ctx())).toThrow(/runs through @aihq\/framework-superpowers/);
  });

  it("refuses an incompatible plugin instead of treating it as absent", async () => {
    await expect(
      executeSuperpowersCommand(ctx(), {
        loadPlugin: () =>
          loadSuperpowersFromSource({
            importPlugin: async () => ({ aihFrameworkPluginV1: { contractVersion: 2 } }),
          }),
      }),
    ).rejects.toMatchObject({
      code: "AIH_FRAMEWORK_PLUGIN",
      message: expect.stringMatching(/^framework-plugin-incompatible: /),
    });
  });

  it("refuses an ordinary policy override before any Superpowers source or receipt effect", async () => {
    const policyPath = join(root, "ordinary-policy.json");
    writeFileSync(
      policyPath,
      JSON.stringify({
        schemaVersion: 2,
        minimumPosture: "enterprise",
        references: { repoContract: "ai-coding/project.json" },
        governance: { supportedClis: ["claude"] },
      }),
    );
    const context = ctx({
      apply: true,
      posture: "enterprise",
      env: { AIH_ORG_POLICY: policyPath },
    });
    await expect(executeSuperpowersCommand(context, withPlugin)).rejects.toThrow(
      /configuration mutation requires the committed default policy or a trusted managed channel/,
    );
    expect(existsSync(join(root, ".aih"))).toBe(false);
  });

  it("previews exact-pinned acquisition before any target guidance", async () => {
    const result = await executeSuperpowersCommand(
      ctx({ options: { cli: "antigravity,copilot" } }),
      withPlugin,
    );
    expect(result.capability).toBe("superpowers: acquire exact baseline source");
    expect(result.execs).toEqual([expect.objectContaining({ ran: false })]);
    expect(JSON.stringify(result)).toContain(PIN);
    expect(JSON.stringify(result)).not.toContain("agy");
    expect(JSON.stringify(result)).not.toContain('"copilot","plugin"');
  });

  it("hands the plugin the user list's hook disables through Core's policy view", async () => {
    writeFileSync(
      join(root, ".aih-config.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        contextDir: "ai-coding",
        frameworkHookControls: { superpowers: { disabledHookIds: ["hook:session-start"] } },
      })}\n`,
    );
    const loaded = await loadSuperpowersFromSource();
    if (!loaded.ok) throw new Error(loaded.refusal.detail);
    let seen: FrameworkOperationContextV1["policy"] | undefined;
    const observing = {
      ...loaded,
      plugin: {
        ...loaded.plugin,
        commands: {
          superpowers: {
            execute: async (context: FrameworkOperationContextV1) => {
              seen = context.policy;
              return context.host.executePlan(plan("superpowers"));
            },
          },
        },
      },
    };
    await executeSuperpowersCommand(ctx(), { loadPlugin: async () => observing });
    expect(seen?.hookControls).toEqual({
      disabled: [{ hookId: "hook:session-start", authority: "user" }],
    });
  });

  it("refuses a result the plugin fabricated instead of one Core's services produced", async () => {
    const forged: PlanResult = {
      capability: "superpowers",
      applied: true,
      writes: [],
      docs: [],
      probes: [],
      execs: [],
      digests: [],
      backups: [],
      removed: [],
    };
    const loaded = await loadSuperpowersFromSource();
    if (!loaded.ok) throw new Error(loaded.refusal.detail);
    const forging = {
      ...loaded,
      plugin: { ...loaded.plugin, commands: { superpowers: { execute: async () => forged } } },
    };
    await expect(
      executeSuperpowersCommand(ctx(), { loadPlugin: async () => forging }),
    ).rejects.toThrow(/did not produce/);
  });

  it("refuses a copy of a result Core's evidence gate produced", async () => {
    const loaded = await loadSuperpowersFromSource();
    if (!loaded.ok) throw new Error(loaded.refusal.detail);
    const real = loaded.plugin.commands.superpowers;
    if (real === undefined) throw new Error("no superpowers command");
    const copying = {
      ...loaded,
      plugin: {
        ...loaded.plugin,
        commands: {
          superpowers: {
            execute: async (context: FrameworkOperationContextV1) => ({
              ...(await real.execute(context)),
            }),
          },
        },
      },
    };
    await expect(
      executeSuperpowersCommand(ctx(), { loadPlugin: async () => copying }),
    ).rejects.toThrow(/did not produce/);
  });

  it("refuses a plugin that writes through executePlan instead of the evidence gate", async () => {
    const loaded = await loadSuperpowersFromSource();
    if (!loaded.ok) throw new Error(loaded.refusal.detail);
    const bypassing = {
      ...loaded,
      plugin: {
        ...loaded.plugin,
        commands: {
          superpowers: {
            execute: (context: FrameworkOperationContextV1) =>
              context.host.executePlan(
                plan("superpowers", writeText("CLAUDE.md", "unverified\n", "bypass")),
              ),
          },
        },
      },
    };
    await expect(
      executeSuperpowersCommand(ctx({ apply: true, options: { cli: "claude" } }), {
        loadPlugin: async () => bypassing,
      }),
    ).rejects.toMatchObject({
      code: "AIH_FRAMEWORK_PLUGIN",
      message: expect.stringContaining("runEvidenceGatedInstall"),
    });
    expect(existsSync(join(root, "CLAUDE.md"))).toBe(false);
  });
});

/** A synthetic obra/Superpowers tree at the pinned component paths, plus exact vendor evidence for it. */
function verifiedLocalSource(): { lock: ReturnType<typeof parseBaselineEvidenceLock> } {
  const real = readVendorBaselineLock().sources.find((source) => source.id === "superpowers");
  if (real === undefined) throw new Error("no superpowers vendor evidence");
  const tree = join(root, "obra", "Superpowers");
  mkdirSync(tree, { recursive: true });
  writeFileSync(join(tree, "LICENSE"), "MIT\n");
  for (const component of real.components) {
    for (const path of component.paths) {
      const target = join(tree, ...path.split("/"));
      if (/\.json$/.test(path)) {
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, `{"component":"${component.id}"}\n`);
      } else {
        mkdirSync(target, { recursive: true });
        writeFileSync(join(target, "README.md"), `# ${component.id} ${path}\n`);
      }
    }
  }
  const components = real.components.map((component) => ({
    ...component,
    treeSha256: hashComponentTree(tree, componentIdentityPaths(tree, component.paths)).treeSha256,
  }));
  const { sourceTreeSha256: _unused, ...source } = real;
  return {
    lock: parseBaselineEvidenceLock({
      schemaVersion: 2,
      sources: [{ ...source, components }],
    }),
  };
}

describe("aih superpowers — through Core's real evidence gate", () => {
  it("verifies every component, then writes the Kiro bridge under --apply", async () => {
    const { lock } = verifiedLocalSource();
    const result = await executeSuperpowersCommand(ctx({ apply: true, options: { cli: "kiro" } }), {
      ...withPlugin,
      pipelineDeps: { vendorLock: lock, vendorLockSha256: "e".repeat(64) },
    });
    expect(result.report?.ok).toBe(true);
    expect(
      readFileSync(join(root, ".kiro", "steering", "superpowers-methodology.md"), "utf8"),
    ).toBe(methodologySteering());
    const receipts = result.digests.find(
      (entry) => entry.describe === "Superpowers baseline evidence authorizations",
    );
    if (receipts === undefined) throw new Error("no evidence receipts digest");
    const authorizations = (receipts.data as { authorizations: Array<Record<string, string>> })
      .authorizations;
    expect(authorizations).toHaveLength(15);
    expect(
      authorizations.every((entry) => entry.tier === "vendor" && entry.pinnedSha === PIN),
    ).toBe(true);
    const expected = lock.sources[0]?.components.map((component) => component.treeSha256);
    expect(authorizations.map((entry) => entry.treeSha256)).toEqual(expected);
  });

  it("keeps the verified tree untouched and writes nothing without --apply", async () => {
    const { lock } = verifiedLocalSource();
    await executeSuperpowersCommand(ctx({ options: { cli: "kiro" } }), {
      ...withPlugin,
      pipelineDeps: { vendorLock: lock, vendorLockSha256: "e".repeat(64) },
    });
    expect(existsSync(join(root, ".kiro"))).toBe(false);
    expect(existsSync(join(root, "obra", "Superpowers", "LICENSE"))).toBe(true);
  });

  it.each([
    ["writes after verification with no pins", {}, true],
    [
      "carries Core's policy custody pins into the gated transaction",
      { commitNotAfter: "2000-01-01T00:00:00.000Z" },
      false,
    ],
  ])("the gated install %s", async (_label, transactionPins, writes) => {
    const { lock } = verifiedLocalSource();
    const components = (lock.sources[0]?.components ?? []).map(({ id, paths }) => ({
      id,
      paths,
    }));
    const host = frameworkHostServicesV1({
      frameworkId: "superpowers",
      ctx: ctx({ apply: true, targets: ["claude"] }),
      policy: undefined,
      transactionPins,
      produced: new WeakSet(),
      pipelineDeps: { vendorLock: lock, vendorLockSha256: "e".repeat(64) },
    });
    const install = host.runEvidenceGatedInstall({
      source: { owner: "obra", repo: "Superpowers", commit: PIN },
      components,
      componentIds: components.map((component) => component.id),
      buildInstallPlan: () => plan("gated", writeText("gated.md", "verified\n", "write")),
    });
    if (writes) await install;
    else await expect(install).rejects.toThrow();
    expect(existsSync(join(root, "gated.md"))).toBe(writes);
  });
});

describe("aih init — the Superpowers phase", () => {
  it("reports the phase as refused with the reason when the plugin is not installed", async () => {
    const result = await executeSuperpowersInitPhase(ctx({ verify: false, targets: ["claude"] }));
    expect(result.docs.map((entry) => entry.describe)).toContain(
      "init: superpowers — refused (framework-plugin-unavailable)",
    );
    const check = result.report?.checks.find(
      (entry) => entry.code === "framework-plugin.unavailable",
    );
    expect(check?.verdict).toBe("skip");
    expect(check?.detail).toContain("npm install -g @aihq/core @aihq/framework-superpowers");
    expect(result.report?.ok).toBe(true);
  });

  it("fails the phase for an incompatible plugin; never treats it as absent", async () => {
    const result = await executeSuperpowersInitPhase(ctx({ targets: ["claude"] }), {
      loadPlugin: () =>
        loadSuperpowersFromSource({
          importPlugin: async () => {
            throw new Error("broken module body");
          },
        }),
    });
    const check = result.report?.checks.find(
      (entry) => entry.code === "framework-plugin.incompatible",
    );
    expect(check?.verdict).toBe("fail");
    expect(result.report?.ok).toBe(false);
  });

  it("aih init (dry-run) keeps the phase header in order and reports the missing plugin", async () => {
    const result = await executeInitCommand(ctx({ verify: false, posture: undefined }));
    expect(result.capability).toBe("init");
    const describes = result.docs.map((entry) => entry.describe);
    expect(describes.indexOf("init: superpowers")).toBeLessThan(
      describes.indexOf("init: bootstrap-ai"),
    );
    expect(describes).toContain("init: superpowers — refused (framework-plugin-unavailable)");
    expect(
      result.report?.checks.find((entry) => entry.code === "framework-plugin.unavailable")?.verdict,
    ).toBe("skip");
    expect(result.report?.ok).toBe(true);
  }, 30_000);

  it("aih init (dry-run) runs the plugin's evidence-gated preview after the local bootstrap", async () => {
    const result = await executeInitCommand(ctx({ verify: false, posture: undefined }), {
      frameworks: withPlugin,
    });
    expect(result.capability).toBe("init");
    const acquisition = result.execs.filter((entry) =>
      entry.describe.includes(`obra/Superpowers@${PIN}`),
    );
    expect(acquisition).toEqual([expect.objectContaining({ ran: false })]);
    expect(existsSync(join(root, ".kiro"))).toBe(false);
  }, 30_000);

  it("runs the plugin's evidence-gated path with init's resolved targets", async () => {
    const result = await executeSuperpowersInitPhase(
      ctx({ verify: false, targets: ["antigravity"] }),
      withPlugin,
    );
    expect(result.capability).toBe("superpowers: acquire exact baseline source");
    expect(result.execs).toEqual([expect.objectContaining({ ran: false })]);
    expect(JSON.stringify(result)).toContain(PIN);
  });
});
