import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { builtinCommandNames } from "../../src/commands/index.js";
import { type CommandSpec, digest, type PlanContext, plan } from "../../src/internals/plan.js";
import {
  loadExternalCommands,
  PLUGIN_PACKAGE,
  type PluginLoadResult,
} from "../../src/plugins/registry.js";
import { buildProgram, buildProgramWithPlugins } from "../../src/program.js";

const builtins = builtinCommandNames();

/** Importer that resolves to the given module shape — never touches the real resolver. */
const moduleOf =
  (mod: unknown): (() => Promise<unknown>) =>
  () =>
    Promise.resolve(mod);

/** A node-shaped module-not-found rejection (`code` + the standard message). */
function notFound(message: string): Error {
  return Object.assign(new Error(message), { code: "ERR_MODULE_NOT_FOUND" });
}

/** A structurally valid plugin spec; `onPlan` observes the PlanContext it received. */
function validSpec(name: string, onPlan?: (ctx: PlanContext) => void): CommandSpec {
  return {
    name,
    summary: `test plugin command ${name}`,
    plan: (ctx) => {
      onPlan?.(ctx);
      return plan(name, digest(name, "plugin plan ran"));
    },
  };
}

/** Load a single raw spec through the gate. */
function gate(raw: unknown): Promise<PluginLoadResult> {
  return loadExternalCommands(builtins, moduleOf({ aihCommands: [raw] }));
}

// The registry reads AIH_NO_PLUGINS from process.env and the standard action
// path resolves posture from it — scrub both around every test so an operator's
// ambient environment can't flip outcomes, then restore exactly what was there.
let savedNoPlugins: string | undefined;
let savedPosture: string | undefined;
beforeEach(() => {
  savedNoPlugins = process.env.AIH_NO_PLUGINS;
  savedPosture = process.env.AIH_POSTURE;
  delete process.env.AIH_NO_PLUGINS;
  delete process.env.AIH_POSTURE;
});
afterEach(() => {
  if (savedNoPlugins === undefined) delete process.env.AIH_NO_PLUGINS;
  else process.env.AIH_NO_PLUGINS = savedNoPlugins;
  if (savedPosture === undefined) delete process.env.AIH_POSTURE;
  else process.env.AIH_POSTURE = savedPosture;
});

describe("loadExternalCommands — probe outcomes", () => {
  it("absent package (ERR_MODULE_NOT_FOUND naming it) is the silent unenrolled case", async () => {
    const err = notFound(`Cannot find package '${PLUGIN_PACKAGE}' imported from /x/dist/cli.js`);
    const res = await loadExternalCommands(builtins, () => Promise.reject(err));
    expect(res).toEqual({ commands: [], warnings: [] });
  });

  it("a message-only module-not-found naming the literal package is also silent", async () => {
    const err = new Error(`Failed to resolve import "${PLUGIN_PACKAGE}"`);
    const res = await loadExternalCommands(builtins, () => Promise.reject(err));
    expect(res).toEqual({ commands: [], warnings: [] });
  });

  it("an installed plugin with a broken transitive dep warns instead of silently vanishing", async () => {
    const err = notFound(
      `Cannot find package 'left-pad' imported from /x/node_modules/${PLUGIN_PACKAGE}/dist/index.js`,
    );
    const res = await loadExternalCommands(builtins, () => Promise.reject(err));
    expect(res.commands).toEqual([]);
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings[0]).toContain("failed to load");
    expect(res.warnings[0]).toContain("left-pad");
  });

  it("AIH_NO_PLUGINS=1 short-circuits without ever invoking the importer", async () => {
    process.env.AIH_NO_PLUGINS = "1";
    let calls = 0;
    const res = await loadExternalCommands(builtins, () => {
      calls += 1;
      return Promise.resolve({ aihCommands: [validSpec("zap")] });
    });
    expect(res).toEqual({ commands: [], warnings: [] });
    expect(calls).toBe(0);
  });

  it("any non-absence import failure degrades to one one-line warning with the message", async () => {
    const res = await loadExternalCommands(builtins, () =>
      Promise.reject(new Error("boom at line 1\nstack line 2")),
    );
    expect(res.commands).toEqual([]);
    expect(res.warnings).toEqual([
      `${PLUGIN_PACKAGE} is installed but failed to load (boom at line 1); running local-only`,
    ]);
  });

  it("a module without an aihCommands export warns naming the expected export", async () => {
    const res = await loadExternalCommands(builtins, moduleOf({ somethingElse: [] }));
    expect(res.commands).toEqual([]);
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings[0]).toContain("aihCommands");
    expect(res.warnings[0]).toContain("the export is missing");
  });

  it("an aihCommands export that is not an array warns naming the expected shape", async () => {
    const res = await loadExternalCommands(builtins, moduleOf({ aihCommands: { name: "zap" } }));
    expect(res.commands).toEqual([]);
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings[0]).toContain("aihCommands");
    expect(res.warnings[0]).toContain("got object");
  });
});

describe("loadExternalCommands — structural gate", () => {
  it("skips a spec whose name has invalid characters, naming the rule", async () => {
    const res = await gate({ ...validSpec("zap"), name: "za p!" });
    expect(res.commands).toEqual([]);
    expect(res.warnings).toEqual([
      'skipping command "za p!": name must be a string matching /^[a-z][a-z0-9-]*$/',
    ]);
  });

  it("skips a spec whose name is uppercase", async () => {
    const res = await gate({ ...validSpec("zap"), name: "Zap" });
    expect(res.commands).toEqual([]);
    expect(res.warnings[0]).toContain("name must be a string matching");
  });

  it("skips a spec without a summary, naming the rule", async () => {
    const res = await gate({ name: "zap", plan: () => plan("zap") });
    expect(res.commands).toEqual([]);
    expect(res.warnings).toEqual(['skipping command "zap": summary must be a non-empty string']);
  });

  it("skips a spec whose plan is not a function, naming the rule", async () => {
    const res = await gate({ name: "zap", summary: "s", plan: "not-a-function" });
    expect(res.commands).toEqual([]);
    expect(res.warnings).toEqual(['skipping command "zap": plan must be a function']);
  });

  it("skips a spec whose options is not an array, naming the rule", async () => {
    const res = await gate({ ...validSpec("zap"), options: "nope" });
    expect(res.commands).toEqual([]);
    expect(res.warnings).toEqual(['skipping command "zap": options must be an array']);
  });

  it("skips a spec with an option missing string flags, naming the rule", async () => {
    const res = await gate({ ...validSpec("zap"), options: [{ description: "d" }] });
    expect(res.commands).toEqual([]);
    expect(res.warnings).toEqual([
      'skipping command "zap": every option must be an object with string `flags` + string `description`',
    ]);
  });

  it("labels a non-object entry by its array position", async () => {
    const res = await gate("not-a-spec");
    expect(res.commands).toEqual([]);
    expect(res.warnings).toEqual(["skipping aihCommands[0]: not a CommandSpec object"]);
  });

  it("an invalid spec does not sink the valid ones beside it", async () => {
    const res = await loadExternalCommands(
      builtins,
      moduleOf({ aihCommands: [{ name: "Broken" }, validSpec("zap")] }),
    );
    expect(res.commands.map((c) => c.name)).toEqual(["zap"]);
    expect(res.warnings).toHaveLength(1);
  });
});

describe("loadExternalCommands — collisions (built-ins always win)", () => {
  it("refuses to shadow the built-in `doctor`", async () => {
    const res = await gate(validSpec("doctor"));
    expect(res.commands).toEqual([]);
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings[0]).toContain("refusing to shadow");
    expect(res.warnings[0]).toContain("doctor");
  });

  it("refuses to shadow the `marketplace` parent group", async () => {
    const res = await gate(validSpec("marketplace"));
    expect(res.commands).toEqual([]);
    expect(res.warnings[0]).toContain("refusing to shadow");
    expect(res.warnings[0]).toContain("marketplace");
  });

  it("duplicate plugin names — the first registration wins", async () => {
    const first = { ...validSpec("zap"), summary: "first zap" };
    const second = { ...validSpec("zap"), summary: "second zap" };
    const res = await loadExternalCommands(builtins, moduleOf({ aihCommands: [first, second] }));
    expect(res.commands.map((c) => c.summary)).toEqual(["first zap"]);
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings[0]).toContain("first registration wins");
  });
});

describe("plugin registration — the standard action path", () => {
  it("a valid plugin spec registers like a built-in and its plan runs through runCapability", async () => {
    let seenPosture: string | undefined;
    let seenLevel: unknown;
    const spec: CommandSpec = {
      ...validSpec("enterprise-audit", (ctx) => {
        seenPosture = ctx.posture;
        seenLevel = ctx.options.level;
      }),
      options: [{ flags: "--level <n>", description: "test option" }],
    };
    const res = await loadExternalCommands(builtins, moduleOf({ aihCommands: [spec] }));
    expect(res.warnings).toEqual([]);
    expect(res.commands.map((c) => c.name)).toEqual(["enterprise-audit"]);

    const program = buildProgram(res.commands);
    program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
    const cmd = program.commands.find((c) => c.name() === "enterprise-audit");
    expect(cmd).toBeDefined();
    // Shared capability flags landed on the plugin command — the same registration loop.
    const longs = (cmd?.options ?? []).map((o) => o.long);
    expect(longs).toEqual(
      expect.arrayContaining(["--apply", "--posture", "--json", "--no-log", "--level"]),
    );

    const root = mkdtempSync(join(tmpdir(), "aih-plugin-"));
    try {
      await program.parseAsync([
        "node",
        "aih",
        "enterprise-audit",
        "--json",
        "--no-log",
        "--root",
        root,
        "--level",
        "9",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    // The plan executed through runCapability: posture resolved by the shared
    // ladder, the per-spec option extracted, and the dry-run exited clean.
    expect(seenPosture).toBe("vibe");
    expect(seenLevel).toBe("9");
    expect(process.exitCode ?? 0).toBe(0);
  }, 20000); // full-program registration + parse can edge past 5s on slow Windows CI

  it("buildProgramWithPlugins under the kill switch is the exact local-only surface", async () => {
    process.env.AIH_NO_PLUGINS = "1";
    const { program, warnings } = await buildProgramWithPlugins();
    expect(warnings).toEqual([]);
    const names = program.commands.map((c) => c.name());
    expect(names).toContain("doctor");
    expect(names).toContain("marketplace");
  });
});
