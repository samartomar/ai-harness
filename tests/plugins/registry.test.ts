import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addSharedFlags, builtinCommandNames } from "../../src/commands/index.js";
import { type CommandSpec, digest, type PlanContext, plan } from "../../src/internals/plan.js";
import {
  allowedPluginRoots,
  loadExternalCommands,
  PLUGIN_PACKAGE,
  type PluginLoadResult,
  SHARED_FLAG_TOKENS,
} from "../../src/plugins/registry.js";
import {
  buildProgram,
  buildProgramWithPlugins,
  isMethodologyNoPluginFastPath,
  isVersionFastPath,
} from "../../src/program.js";

const builtins = builtinCommandNames();

/** Matches any C0/C1 control byte or DEL — escape sequences only, no raw bytes in source. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: the assertion hunts for control bytes leaking into warnings
const CONTROL_BYTES = /[\u0000-\u001f\u007f-\u009f]/;
const BIDI_CONTROLS = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;

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
  return loadExternalCommands(builtins, { importer: moduleOf({ aihCommands: [raw] }) });
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
    const res = await loadExternalCommands(builtins, { importer: () => Promise.reject(err) });
    expect(res).toEqual({ commands: [], warnings: [] });
  });

  it("a message-only module-not-found naming the literal package is also silent", async () => {
    const err = new Error(`Failed to resolve import "${PLUGIN_PACKAGE}"`);
    const res = await loadExternalCommands(builtins, { importer: () => Promise.reject(err) });
    expect(res).toEqual({ commands: [], warnings: [] });
  });

  it("an installed plugin with a broken transitive dep warns instead of silently vanishing", async () => {
    const err = notFound(
      `Cannot find package 'left-pad' imported from /x/node_modules/${PLUGIN_PACKAGE}/dist/index.js`,
    );
    const res = await loadExternalCommands(builtins, { importer: () => Promise.reject(err) });
    expect(res.commands).toEqual([]);
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings[0]).toContain("failed to load");
    expect(res.warnings[0]).toContain("left-pad");
  });

  it("AIH_NO_PLUGINS=1 short-circuits without ever invoking the importer", async () => {
    process.env.AIH_NO_PLUGINS = "1";
    let calls = 0;
    const res = await loadExternalCommands(builtins, {
      importer: () => {
        calls += 1;
        return Promise.resolve({ aihCommands: [validSpec("zap")] });
      },
    });
    expect(res).toEqual({ commands: [], warnings: [] });
    expect(calls).toBe(0);
  });

  it("opts.env AIH_NO_PLUGINS=1 short-circuits even when process.env lacks it", async () => {
    // beforeEach scrubbed process.env.AIH_NO_PLUGINS — only opts.env carries the switch.
    let calls = 0;
    const res = await loadExternalCommands(builtins, {
      importer: () => {
        calls += 1;
        return Promise.resolve({ aihCommands: [validSpec("zap")] });
      },
      env: { AIH_NO_PLUGINS: "1" },
    });
    expect(res).toEqual({ commands: [], warnings: [] });
    expect(calls).toBe(0);
  });

  it("any non-absence import failure degrades to one one-line warning with the message", async () => {
    const res = await loadExternalCommands(builtins, {
      importer: () => Promise.reject(new Error("boom at line 1\nstack line 2")),
    });
    expect(res.commands).toEqual([]);
    expect(res.warnings).toEqual([
      `${PLUGIN_PACKAGE} is installed but failed to load (boom at line 1); running local-only`,
    ]);
  });

  it("a module without an aihCommands export warns naming the expected export", async () => {
    const res = await loadExternalCommands(builtins, { importer: moduleOf({ somethingElse: [] }) });
    expect(res.commands).toEqual([]);
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings[0]).toContain("aihCommands");
    expect(res.warnings[0]).toContain("the export is missing");
  });

  it("an aihCommands export that is not an array warns naming the expected shape", async () => {
    const res = await loadExternalCommands(builtins, {
      importer: moduleOf({ aihCommands: { name: "zap" } }),
    });
    expect(res.commands).toEqual([]);
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings[0]).toContain("aihCommands");
    expect(res.warnings[0]).toContain("got object");
  });
});

describe("loadExternalCommands — install-tree boundary", () => {
  it("refuses a plugin resolving OUTSIDE aih's own install tree without importing it", async () => {
    const outside = mkdtempSync(join(tmpdir(), "aih-outside-"));
    let calls = 0;
    try {
      const res = await loadExternalCommands(builtins, {
        resolver: () => outside,
        importer: () => {
          calls += 1;
          return Promise.resolve({ aihCommands: [validSpec("zap")] });
        },
      });
      expect(res.commands).toEqual([]);
      expect(res.warnings).toHaveLength(1);
      expect(res.warnings[0]).toContain("outside aih's own install tree");
      expect(res.warnings[0]).toContain("running local-only");
      // Fail closed BEFORE the module ever executes.
      expect(calls).toBe(0);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("loads a plugin resolving INSIDE an allowed root", async () => {
    const roots = allowedPluginRoots();
    const first = roots[0];
    if (first === undefined) throw new Error("test env resolved no allowed plugin roots");
    // Hermetic-ish: a throwaway temp dir INSIDE the real allowed root, removed after.
    const inside = mkdtempSync(join(first, "aih-inside-"));
    try {
      const res = await loadExternalCommands(builtins, {
        resolver: () => inside,
        importer: moduleOf({ aihCommands: [validSpec("zap")] }),
      });
      expect(res.warnings).toEqual([]);
      expect(res.commands.map((c) => c.name)).toEqual(["zap"]);
    } finally {
      rmSync(inside, { recursive: true, force: true });
    }
  });

  it("resolves and imports only the literal reserved package specifier", async () => {
    const roots = allowedPluginRoots();
    const first = roots[0];
    if (first === undefined) throw new Error("test env resolved no allowed plugin roots");
    const inside = mkdtempSync(join(first, "aih-literal-"));
    const seen: string[] = [];
    try {
      const res = await loadExternalCommands(builtins, {
        resolver: (specifier) => {
          seen.push(`resolve:${specifier}`);
          return inside;
        },
        importer: (specifier) => {
          seen.push(`import:${specifier}`);
          return Promise.resolve({ aihCommands: [validSpec("zap")] });
        },
        env: { AIH_ENTERPRISE_PACKAGE: "evil-package", AIH_NO_PLUGINS: "0" },
      });

      expect(seen).toEqual([`resolve:${PLUGIN_PACKAGE}`, `import:${PLUGIN_PACKAGE}`]);
      expect(res.warnings).toEqual([]);
      expect(res.commands.map((c) => c.name)).toEqual(["zap"]);
    } finally {
      rmSync(inside, { recursive: true, force: true });
    }
  });

  it("a resolver module-not-found naming the package is the silent unenrolled case", async () => {
    let calls = 0;
    const res = await loadExternalCommands(builtins, {
      resolver: () => {
        throw notFound(`Cannot find package '${PLUGIN_PACKAGE}' imported from /x/dist/cli.js`);
      },
      importer: () => {
        calls += 1;
        return Promise.resolve({ aihCommands: [validSpec("zap")] });
      },
    });
    expect(res).toEqual({ commands: [], warnings: [] });
    expect(calls).toBe(0);
  });
});

describe("loadExternalCommands — startup availability", () => {
  it("a never-settling import times out to local-only with the timeout warning", async () => {
    const res = await loadExternalCommands(builtins, {
      importer: () => new Promise<never>(() => {}),
      timeoutMs: 10,
    });
    expect(res.commands).toEqual([]);
    expect(res.warnings).toEqual([
      `plugin ${PLUGIN_PACKAGE} load timed out after 10ms — continuing without it`,
    ]);
  });
});

describe("isVersionFastPath — the --version sync route", () => {
  it("matches exactly --version or -V as the FIRST user arg", () => {
    expect(isVersionFastPath(["node", "aih", "--version"])).toBe(true);
    expect(isVersionFastPath(["node", "aih", "-V"])).toBe(true);
  });

  it("everything else takes the plugin-probing path (--help must list plugin commands)", () => {
    expect(isVersionFastPath(["node", "aih"])).toBe(false);
    expect(isVersionFastPath(["node", "aih", "--help"])).toBe(false);
    expect(isVersionFastPath(["node", "aih", "doctor"])).toBe(false);
    expect(isVersionFastPath(["node", "aih", "doctor", "--version"])).toBe(false);
  });
});

describe("methodology no-plugin fast path", () => {
  it("selects the local-only builder before methodology parsing, including invalid argv", () => {
    expect(isMethodologyNoPluginFastPath(["node", "aih", "methodology", "inspect"])).toBe(true);
    expect(
      isMethodologyNoPluginFastPath(["node", "aih", "methodology", "unknown", "--json"]),
    ).toBe(true);
    expect(isMethodologyNoPluginFastPath(["node", "aih", "doctor"])).toBe(false);
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

  it("skips a spec claiming a SHARED aih flag, naming the flag", async () => {
    const res = await gate({
      ...validSpec("zap"),
      options: [{ flags: "--apply <x>", description: "hijack attempt" }],
    });
    expect(res.commands).toEqual([]);
    expect(res.warnings).toEqual([
      'skipping command "zap": option flag `--apply` collides with a shared aih flag',
    ]);
  });

  it("skips specs claiming shared runner option keys by alternate spelling", async () => {
    for (const [flags, key] of [
      ["--contextDir <dir>", "contextDir"],
      ["--supportOut <dir>", "supportOut"],
      ["--allTools", "allTools"],
      ["--log", "log"],
    ]) {
      const res = await gate({
        ...validSpec("zap"),
        options: [{ flags, description: "hijack attempt" }],
      });
      expect(res.commands).toEqual([]);
      expect(res.warnings).toEqual([
        `skipping command "zap": option \`${flags}\` resolves to shared aih option key \`${key}\``,
      ]);
    }
  });

  it("skips a spec claiming a RESERVED flag, naming the flag", async () => {
    const res = await gate({
      ...validSpec("zap"),
      options: [{ flags: "--help", description: "d" }],
    });
    expect(res.commands).toEqual([]);
    expect(res.warnings).toEqual(['skipping command "zap": option flag `--help` is reserved']);
  });

  it("skips a spec whose option default is neither string nor boolean, naming the rule", async () => {
    const res = await gate({
      ...validSpec("zap"),
      options: [{ flags: "--level <n>", description: "d", default: { nested: true } }],
    });
    expect(res.commands).toEqual([]);
    expect(res.warnings).toEqual([
      'skipping command "zap": option `--level <n>` default must be a string or boolean',
    ]);
  });

  it("sanitizes hostile spec names in warnings: no control bytes, truncated with an ellipsis", async () => {
    const esc = String.fromCharCode(0x1b);
    const bel = String.fromCharCode(0x07);
    const hostile = `${esc}]0;pwn${bel}\r\n${"a".repeat(10_000)}`;
    // The spec also carries an empty summary; the gate checks name first, so
    // the LABEL (not which rule fired) is what this test pins.
    const res = await gate({ name: hostile, summary: "", plan: () => plan("zap") });
    expect(res.commands).toEqual([]);
    expect(res.warnings).toHaveLength(1);
    const warning = res.warnings[0] ?? "";
    expect(warning).toContain("skipping command ");
    expect(warning).toContain("]0;pwn"); // ESC/BEL stripped, printable remainder kept
    expect(warning).toContain("…"); // the 10k-char tail is truncated
    expect(warning).not.toMatch(CONTROL_BYTES); // zero control bytes escape into stderr
    expect(warning.length).toBeLessThan(200);
  });

  it("sanitizes bidi controls from warning labels", async () => {
    const res = await gate({ ...validSpec("bad\u202ename"), summary: "" });
    expect(res.commands).toEqual([]);
    const warning = res.warnings[0] ?? "";
    expect(warning).toContain("badname");
    expect(warning).not.toMatch(BIDI_CONTROLS);
  });

  it("labels a non-object entry by its array position", async () => {
    const res = await gate("not-a-spec");
    expect(res.commands).toEqual([]);
    expect(res.warnings).toEqual(["skipping aihCommands[0]: not a CommandSpec object"]);
  });

  it("an invalid spec does not sink the valid ones beside it", async () => {
    const res = await loadExternalCommands(builtins, {
      importer: moduleOf({ aihCommands: [{ name: "Broken" }, validSpec("zap")] }),
    });
    expect(res.commands.map((c) => c.name)).toEqual(["zap"]);
    expect(res.warnings).toHaveLength(1);
  });
});

describe("SHARED_FLAG_TOKENS — mirror pinned to addSharedFlags", () => {
  it("matches the long+short tokens of the real shared-flag registration", () => {
    const probe = addSharedFlags(new Command());
    const real = new Set<string>();
    for (const option of probe.options) {
      if (option.long) real.add(option.long);
      if (option.short) real.add(option.short);
    }
    expect(new Set(SHARED_FLAG_TOKENS)).toEqual(real);
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

  it("refuses plugin commands named `help` or `version` (commander's own surface)", async () => {
    for (const reserved of ["help", "version"]) {
      const res = await gate(validSpec(reserved));
      expect(res.commands).toEqual([]);
      expect(res.warnings).toHaveLength(1);
      expect(res.warnings[0]).toContain("refusing to shadow");
      expect(res.warnings[0]).toContain(reserved);
    }
  });

  it("a plugin name colliding with a built-in's deprecated alias is refused (old names stay reserved)", async () => {
    // Zero built-ins carry an alias today, so exercise the reservation through
    // builtinCommandNames' spec-list seam: a renamed built-in keeps its old name
    // in the reserved set for the whole grace window, and the registry's name
    // check refuses a plugin squatting on it exactly like a live name.
    const reserved = builtinCommandNames([
      {
        name: "renamed-demo",
        summary: "renamed built-in",
        deprecatedAliases: ["old-demo"],
        plan: () => plan("renamed-demo"),
      },
    ]);
    expect(reserved.has("renamed-demo")).toBe(true);
    expect(reserved.has("old-demo")).toBe(true);

    const res = await loadExternalCommands(reserved, {
      importer: moduleOf({ aihCommands: [validSpec("old-demo")] }),
    });
    expect(res.commands).toEqual([]);
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings[0]).toContain("refusing to shadow");
    expect(res.warnings[0]).toContain("old-demo");
  });

  it("a plugin name colliding with a built-in's current alias is refused", async () => {
    expect(builtins.has("clean")).toBe(true);

    const res = await gate(validSpec("clean"));
    expect(res.commands).toEqual([]);
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings[0]).toContain("refusing to shadow");
    expect(res.warnings[0]).toContain("clean");
  });

  it("duplicate plugin names — the first registration wins", async () => {
    const first = { ...validSpec("zap"), summary: "first zap" };
    const second = { ...validSpec("zap"), summary: "second zap" };
    const res = await loadExternalCommands(builtins, {
      importer: moduleOf({ aihCommands: [first, second] }),
    });
    expect(res.commands.map((c) => c.summary)).toEqual(["first zap"]);
    expect(res.warnings).toHaveLength(1);
    expect(res.warnings[0]).toContain("first registration wins");
  });
});

describe("loadExternalCommands — ungated field strip", () => {
  it("strips skipWorktreeGate from the registered copy, warns, and never mutates the plugin's object", async () => {
    const original = { ...validSpec("zap"), skipWorktreeGate: true };
    const res = await loadExternalCommands(builtins, {
      importer: moduleOf({ aihCommands: [original] }),
    });
    expect(res.commands).toHaveLength(1);
    expect(res.commands[0]).not.toHaveProperty("skipWorktreeGate");
    // Shallow clone: the plugin's own object is untouched.
    expect(original.skipWorktreeGate).toBe(true);
    expect(res.warnings).toEqual([
      'plugin command "zap": skipWorktreeGate is not honored for plugin commands (dirty-worktree preflight applies)',
    ]);
  });

  it("strips deprecatedAliases from the registered copy, warns, and never mutates the plugin's object", async () => {
    const original = { ...validSpec("zap"), deprecatedAliases: ["old-zap"] };
    const res = await loadExternalCommands(builtins, {
      importer: moduleOf({ aihCommands: [original] }),
    });
    expect(res.commands).toHaveLength(1);
    expect(res.commands[0]).not.toHaveProperty("deprecatedAliases");
    // Shallow clone: the plugin's own object is untouched.
    expect(original.deprecatedAliases).toEqual(["old-zap"]);
    expect(res.warnings).toEqual([
      'plugin command "zap": deprecatedAliases is not honored for plugin commands (deprecation aliases are core-only); dropped',
    ]);
  });

  it("strips aliases from the registered copy, warns, and never mutates the plugin's object", async () => {
    const original = { ...validSpec("zap"), aliases: ["zap-clean"] };
    const res = await loadExternalCommands(builtins, {
      importer: moduleOf({ aihCommands: [original] }),
    });
    expect(res.commands).toHaveLength(1);
    expect(res.commands[0]).not.toHaveProperty("aliases");
    // Shallow clone: the plugin's own object is untouched.
    expect(original.aliases).toEqual(["zap-clean"]);
    expect(res.warnings).toEqual([
      'plugin command "zap": aliases is not honored for plugin commands (aliases are core-only); dropped',
    ]);
  });

  it("passes install-is-trust behavior fields through untouched", async () => {
    const spec = {
      ...validSpec("zap"),
      readOnly: true,
      alwaysVerify: true,
      wantsInstallPrompt: true,
    };
    const res = await loadExternalCommands(builtins, {
      importer: moduleOf({ aihCommands: [spec] }),
    });
    expect(res.warnings).toEqual([]);
    expect(res.commands[0]).toMatchObject({
      readOnly: true,
      alwaysVerify: true,
      wantsInstallPrompt: true,
    });
  });
});

describe("registerCommands — plugin registration containment", () => {
  it("a Commander throw drops that spec with a warning; built-ins stay live", () => {
    const broken: CommandSpec = {
      ...validSpec("clash"),
      // Passes the structural gate (both options are well-formed and collide
      // with nothing shared/reserved) but makes Commander throw on the
      // duplicate flag at registration time.
      options: [
        { flags: "--dup <a>", description: "first" },
        { flags: "--dup <b>", description: "second — Commander throws here" },
      ],
    };
    const warnings: string[] = [];
    const program = buildProgram([broken], warnings);
    const names = program.commands.map((c) => c.name());
    expect(names).not.toContain("clash");
    expect(names).toContain("doctor"); // built-ins unaffected
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('plugin command "clash" failed to register');
    expect(warnings[0]).toContain("dropped");
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
    const res = await loadExternalCommands(builtins, {
      importer: moduleOf({ aihCommands: [spec] }),
    });
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

  it("plugin report-like option names do not imply apply mode", async () => {
    let seenApply: boolean | undefined;
    let seenDemo: unknown;
    const spec: CommandSpec = {
      ...validSpec("enterprise-preview", (ctx) => {
        seenApply = ctx.apply;
        seenDemo = ctx.options.demo;
      }),
      options: [{ flags: "--demo", description: "plugin-owned preview mode" }],
    };
    const res = await loadExternalCommands(builtins, {
      importer: moduleOf({ aihCommands: [spec] }),
    });
    expect(res.warnings).toEqual([]);

    const program = buildProgram(res.commands);
    program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
    const root = mkdtempSync(join(tmpdir(), "aih-plugin-"));
    try {
      await program.parseAsync([
        "node",
        "aih",
        "enterprise-preview",
        "--json",
        "--no-log",
        "--root",
        root,
        "--demo",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }

    expect(seenApply).toBe(false);
    expect(seenDemo).toBe(true);
    expect(process.exitCode ?? 0).toBe(0);
  }, 20000);

  it("buildProgramWithPlugins under the kill switch is the exact local-only surface", async () => {
    process.env.AIH_NO_PLUGINS = "1";
    const { program, warnings } = await buildProgramWithPlugins();
    expect(warnings).toEqual([]);
    const names = program.commands.map((c) => c.name());
    expect(names).toContain("doctor");
    expect(names).toContain("marketplace");
  });
});
