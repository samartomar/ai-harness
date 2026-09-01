import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BaselineAuthorization } from "../../src/baseline-evidence/verify.js";
import type { EccComponentSelection } from "../../src/ecc/components.js";
import { eccEvidenceComponentIdsForSelection } from "../../src/ecc/evidence.js";
import { buildEccRegistrationRequest } from "../../src/ecc/pipeline.js";
import {
  emptyRegistrationLedger,
  readRegistrationLedger,
  registrationLedgerPath,
} from "../../src/ecc/registration.js";
import { verifiedEccInstallPlan } from "../../src/ecc/verified.js";
import { registeredExecStdinPayload } from "../../src/internals/exec-stdin.js";
import type {
  Action,
  DigestAction,
  ExecAction,
  PlanContext,
  WriteAction,
} from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { makeHostAdapter } from "../../src/platform/detect.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aih-ecc-verified-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function ctx(): PlanContext {
  const run = fakeRunner(() => undefined);
  return {
    root,
    contextDir: "ai-coding",
    posture: "enterprise",
    apply: true,
    verify: true,
    json: false,
    run,
    host: makeHostAdapter({ platform: "linux", run, env: { HOME: root } }),
    env: { HOME: root },
    options: {},
  };
}

function authorization(componentId = "runtime:ecc-installer"): BaselineAuthorization {
  return {
    componentId,
    source: "affaan-m/ECC",
    pinnedSha: "a".repeat(40),
    treeSha256: "b".repeat(64),
    tier: "vendor",
    issuer: "@aihq/core release",
    evidenceSha256: "c".repeat(64),
  };
}

const execs = (actions: Action[]): ExecAction[] =>
  actions.filter((action): action is ExecAction => action.kind === "exec");
const writes = (actions: Action[]): WriteAction[] =>
  actions.filter((action): action is WriteAction => action.kind === "write");

function driverSteps(actions: Action[]): Array<{
  argv: string[];
  cwd: string;
  env?: Record<string, string>;
  input?: string;
}> {
  const driver = execs(actions).find((action) => action.describe.includes("verified ECC checkout"));
  expect(driver).toBeDefined();
  const serialized = driver === undefined ? undefined : registeredExecStdinPayload(driver)?.data;
  if (serialized === undefined) throw new Error("missing verified ECC steps stdin");
  return JSON.parse(serialized) as Array<{
    argv: string[];
    cwd: string;
    env?: Record<string, string>;
    input?: string;
  }>;
}

function codexInstallProgram(step: { argv: string[] } | undefined): string {
  const program = step?.argv[2];
  if (typeof program !== "string") throw new Error("missing Codex install program");
  const packed = /inflateRawSync\(Buffer\.from\("([^"\\]+)", "base64"\)\)/.exec(program);
  if (!packed?.[1]) return program;
  return inflateRawSync(Buffer.from(packed[1], "base64")).toString("utf8");
}

function selection(): EccComponentSelection {
  return {
    scope: "scoped",
    components: [
      "baseline:rules",
      "baseline:agents",
      "baseline:platform",
      "baseline:commands",
      "skill:tdd-workflow",
      "agent:code-reviewer",
      "lang:typescript",
    ],
    mcps: ["mcp:sequential-thinking"],
    recommendations: [],
  };
}

function authorizationsForSelection(
  target: "claude" | "codex",
  selected: EccComponentSelection,
): BaselineAuthorization[] {
  return eccEvidenceComponentIdsForSelection(target, selected).map((componentId) =>
    authorization(componentId),
  );
}

function put(path: string, contents: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, contents, "utf8");
}

describe("verifiedEccInstallPlan", () => {
  it("constructs and renders a plan without touching an isolated temporary root", () => {
    const isolatedTemp = join(root, "isolated-temp");
    mkdirSync(isolatedTemp);
    const original = {
      TEMP: process.env.TEMP,
      TMP: process.env.TMP,
      TMPDIR: process.env.TMPDIR,
    };
    process.env.TEMP = isolatedTemp;
    process.env.TMP = isolatedTemp;
    process.env.TMPDIR = isolatedTemp;
    try {
      const selected = selection();
      const built = verifiedEccInstallPlan(
        ctx(),
        join(root, "quarantine", "tree"),
        { clis: ["claude"], profile: "core", packs: [], selection: selected },
        authorizationsForSelection("claude", selected),
      );
      const driver = execs(built.actions).find((action) =>
        action.describe.includes("verified ECC checkout"),
      );
      expect(driver?.argv).toEqual([process.execPath, "-e", expect.any(String)]);
      expect(driver?.stdin).toEqual({ maxBytes: 16 * 1024 * 1024 });
      const serialized =
        driver === undefined ? undefined : registeredExecStdinPayload(driver)?.data;
      expect(serialized?.length).toBeGreaterThan(0);
      expect(JSON.stringify(built)).not.toContain(serialized as string);
      expect(readdirSync(isolatedTemp)).toEqual([]);
    } finally {
      for (const [key, value] of Object.entries(original)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("refuses a partial Full install before any mutation", () => {
    const requested: EccComponentSelection = { ...selection(), scope: "full" };
    const everything = eccEvidenceComponentIdsForSelection("claude", requested);
    const withheld = "module:rules-core";
    expect(everything).toContain(withheld);

    expect(() =>
      verifiedEccInstallPlan(
        ctx(),
        join(root, "quarantine", "tree"),
        { clis: ["claude"], profile: "full", packs: [], selection: requested },
        everything.filter((id) => id !== withheld).map(authorization),
      ),
    ).toThrow(new RegExp(`refusing partial ECC Full install.*${withheld}`));
  });

  it("does not report a downgrade when the full profile is fully authorized", () => {
    const requested: EccComponentSelection = { ...selection(), scope: "full" };

    const built = verifiedEccInstallPlan(
      ctx(),
      join(root, "quarantine", "tree"),
      { clis: ["claude"], profile: "full", packs: [], selection: requested },
      authorizationsForSelection("claude", requested),
    );

    const text = built.actions
      .filter((action) => action.kind === "digest")
      .map((action) => (action as { text: string }).text)
      .join("\n");
    expect(text).not.toMatch(/reduced to scoped/);
  });

  it("refuses before runtime preparation when ecc-installer is not authorized", () => {
    expect(() =>
      verifiedEccInstallPlan(
        ctx(),
        join(root, "quarantine", "tree"),
        {
          clis: ["claude"],
          profile: "core",
          packs: [],
          selection: {
            scope: "scoped",
            components: ["baseline:rules"],
            mcps: [],
            recommendations: [],
          },
        },
        [authorization("baseline:rules")],
      ),
    ).toThrow(/unauthorized ECC runtime runtime:ecc-installer/);
  });

  it("refuses before runtime preparation when only the helper runtime is authorized", () => {
    expect(() =>
      verifiedEccInstallPlan(
        ctx(),
        join(root, "quarantine", "tree"),
        {
          clis: ["claude"],
          profile: "core",
          packs: [],
          selection: {
            scope: "scoped",
            components: ["baseline:rules"],
            mcps: [],
            recommendations: [],
          },
        },
        [authorization()],
      ),
    ).toThrow(/no selected ECC component has authorization/);
  });

  it("refuses an unscoped Kiro installer without its runtime authorization", () => {
    expect(() =>
      verifiedEccInstallPlan(
        ctx(),
        join(root, "quarantine", "tree"),
        { clis: ["kiro"], profile: "core", packs: [] },
        [authorization("runtime:ecc-installer")],
      ),
    ).toThrow(/unauthorized ECC runtime runtime:ecc-kiro/);
  });

  it("records only authorized installed components while retaining project intent", () => {
    const selected: EccComponentSelection = {
      scope: "scoped",
      components: ["baseline:rules", "baseline:hooks"],
      mcps: [],
      recommendations: [],
    };
    const built = verifiedEccInstallPlan(
      ctx(),
      join(root, "quarantine", "tree"),
      {
        clis: ["claude"],
        profile: "core",
        packs: [],
        selection: selected,
        project: {
          root,
          scope: "scoped",
          components: [...selected.components],
          mcps: [],
        },
        ledger: emptyRegistrationLedger(),
      },
      [authorization(), authorization("baseline:rules")],
    );
    const steps = driverSteps(built.actions);
    const materializationPayload = JSON.parse(steps[1]?.input ?? "null") as {
      spec: { wholeModules: string[]; sourceRoots: string[] };
    };
    const ledgerPayload = JSON.parse(steps.at(-1)?.input ?? "null") as { contents: string };
    const ledger = JSON.parse(ledgerPayload.contents) as {
      projects: Array<{ components: string[] }>;
      targets: Array<{ components: Array<{ id: string }> }>;
    };

    expect(materializationPayload.spec.wholeModules).toEqual([]);
    expect(materializationPayload.spec.sourceRoots).toEqual(["rules/README.md", "rules/common"]);
    expect(ledger.projects[0]?.components).toEqual(["baseline:hooks", "baseline:rules"]);
    expect(ledger.targets[0]?.components.map((component) => component.id)).toEqual([
      "baseline:rules",
    ]);
  });

  it("uses one sequential driver with a filtered manifest payload and never npx", () => {
    const sourceRoot = join(root, "quarantine", "tree");
    const selected = selection();
    const plan = verifiedEccInstallPlan(
      ctx(),
      sourceRoot,
      {
        clis: ["claude"],
        profile: "core",
        packs: ["typescript"],
        selection: selected,
      },
      authorizationsForSelection("claude", selected),
    );
    expect(execs(plan.actions)).toHaveLength(1);
    const steps = driverSteps(plan.actions);
    expect(steps[0]?.argv).toEqual([
      "npm",
      "ci",
      "--omit=dev",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
    ]);
    expect(steps[0]?.cwd).toBe(sourceRoot);
    expect(steps[1]?.argv.slice(0, 2)).toEqual([process.execPath, "-e"]);
    expect(steps[1]?.argv[2]).toContain('replace(/\\\\/g, "/")');
    expect(steps[1]?.argv[2]).not.toContain('replace(/\\\\\\\\/g, "/")');
    const raw = steps[1]?.input;
    if (raw === undefined) throw new Error("missing materialization payload");
    const payload = JSON.parse(raw) as {
      target: string;
      scope: string;
      moduleIds: string[];
      skills: string[];
      agents: string[];
    };
    expect(payload).toMatchObject({
      target: "claude",
      scope: "scoped",
      moduleIds: [
        "rules-core",
        "agents-core",
        "platform-configs",
        "commands-core",
        "workflow-quality",
        "framework-language",
      ],
      skills: expect.arrayContaining(["tdd-workflow", "api-design"]),
      agents: ["code-reviewer"],
    });
    expect(steps[1]?.env?.ECC_DISABLED_MCPS).toBe(
      "chrome-devtools,context7,exa,github,memory,playwright,supabase",
    );
    expect(steps[1]?.cwd).toBe(root);
    expect(JSON.stringify(steps)).not.toContain("npx");
    expect(JSON.stringify(steps)).not.toContain("https://");
    expect(JSON.stringify(steps)).not.toContain("install-apply.js");
  });

  it("fails the governed materialization driver when a content-looking manifest destination escapes its roots", () => {
    const sourceRoot = join(root, "ecc-source");
    const outside = join(tmpdir(), "aih-ecc-outside", "skills", "tdd-workflow", "SKILL.md");
    put(
      join(sourceRoot, "scripts", "lib", "install-executor.js"),
      `exports.createManifestInstallPlan = ({ homeDir }) => ({
        operations: [{ kind: "copy-file", moduleId: "workflow-quality", sourceRelativePath: "skills/tdd-workflow/SKILL.md", destinationPath: ${JSON.stringify(outside)} }],
        statePreview: { operations: [{ kind: "copy-file", moduleId: "workflow-quality", sourceRelativePath: "skills/tdd-workflow/SKILL.md", destinationPath: ${JSON.stringify(outside)} }] },
        installStatePath: require("node:path").join(homeDir, ".claude", "ecc", "install-state.json")
      });
      exports.applyInstallPlan = () => { throw new Error("outside-root operation reached apply"); };\n`,
    );
    const selected: EccComponentSelection = {
      scope: "scoped",
      components: ["skill:tdd-workflow"],
      mcps: [],
      recommendations: [],
    };
    const built = verifiedEccInstallPlan(
      ctx(),
      sourceRoot,
      { clis: ["claude"], profile: "minimal", packs: [], selection: selected, governance: true },
      authorizationsForSelection("claude", selected),
    );
    const step = driverSteps(built.actions)[1];
    if (step === undefined || step.input === undefined)
      throw new Error("missing materialization step");
    const executable = step.argv[0];
    if (executable === undefined) throw new Error("missing materialization executable");
    const result = spawnSync(executable, step.argv.slice(1), {
      cwd: step.cwd,
      input: step.input,
      encoding: "utf8",
    });

    expect(result.status).not.toBe(0);
    expect(`${result.stderr}${result.stdout}`).toContain("escapes authorized project/home roots");
  });

  it("fails the spawned governed materialization driver on case-normalized destination collisions", () => {
    const sourceRoot = join(root, "ecc-case-collision");
    const first = join(root, ".claude", "rules", "common", "Foo.md");
    const second = join(root, ".claude", "rules", "common", "foo.md");
    put(
      join(sourceRoot, "scripts", "lib", "install-executor.js"),
      `exports.createManifestInstallPlan = ({ homeDir }) => {
        const operations = [
          { kind: "copy-file", moduleId: "rules-core", sourceRelativePath: "rules/common/Foo.md", destinationPath: ${JSON.stringify(first)} },
          { kind: "copy-file", moduleId: "rules-core", sourceRelativePath: "rules/common/foo.md", destinationPath: ${JSON.stringify(second)} },
        ];
        return { operations, statePreview: { operations }, installStatePath: require("node:path").join(homeDir, ".claude", "ecc", "install-state.json") };
      };
      exports.applyInstallPlan = () => { throw new Error("case-colliding operations reached apply"); };\n`,
    );
    const selected: EccComponentSelection = {
      scope: "scoped",
      components: ["baseline:rules"],
      mcps: [],
      recommendations: [],
    };
    const built = verifiedEccInstallPlan(
      ctx(),
      sourceRoot,
      { clis: ["claude"], profile: "minimal", packs: [], selection: selected, governance: true },
      authorizationsForSelection("claude", selected),
    );
    const step = driverSteps(built.actions)[1];
    if (step === undefined || step.input === undefined || step.argv[0] === undefined) {
      throw new Error("missing materialization step");
    }
    const result = spawnSync(step.argv[0], step.argv.slice(1), {
      cwd: step.cwd,
      input: step.input,
      encoding: "utf8",
    });
    expect(result.status).not.toBe(0);
    expect(`${result.stderr}${result.stdout}`).toContain(
      "normalized governed ECC destination collision",
    );
  });

  it("fails the spawned governed materialization driver on an in-root cross-surface remap", () => {
    const sourceRoot = join(root, "ecc-cross-map");
    const remapped = join(root, ".claude", "skills", "common", "x.md");
    put(
      join(sourceRoot, "scripts", "lib", "install-executor.js"),
      `exports.createManifestInstallPlan = ({ homeDir }) => {
        const operations = [{ kind: "copy-file", moduleId: "rules-core", sourceRelativePath: "rules/common/x.md", destinationPath: ${JSON.stringify(remapped)} }];
        return { operations, statePreview: { operations }, installStatePath: require("node:path").join(homeDir, ".claude", "ecc", "install-state.json") };
      };
      exports.applyInstallPlan = () => { throw new Error("cross-surface remap reached apply"); };\n`,
    );
    const selected: EccComponentSelection = {
      scope: "scoped",
      components: ["baseline:rules"],
      mcps: [],
      recommendations: [],
    };
    const built = verifiedEccInstallPlan(
      ctx(),
      sourceRoot,
      { clis: ["claude"], profile: "minimal", packs: [], selection: selected, governance: true },
      authorizationsForSelection("claude", selected),
    );
    const step = driverSteps(built.actions)[1];
    if (step === undefined || step.input === undefined || step.argv[0] === undefined) {
      throw new Error("missing materialization step");
    }
    const result = spawnSync(step.argv[0], step.argv.slice(1), {
      cwd: step.cwd,
      input: step.input,
      encoding: "utf8",
    });
    expect(result.status).not.toBe(0);
    expect(`${result.stderr}${result.stdout}`).toContain(
      "unclassifiable governed ECC content operation",
    );
  });

  it("refuses governed Claude, Codex, and Kiro plans without an authorized component selection", () => {
    expect(() =>
      verifiedEccInstallPlan(
        ctx(),
        join(root, "quarantine", "tree"),
        { clis: ["claude", "codex", "kiro"], profile: "core", packs: [], governance: true },
        [],
      ),
    ).toThrow(/governed ECC install without an authorized component selection/);
  });

  it("rejects a governed direct materializer whose upstream state path is not the exact target state path", () => {
    const sourceRoot = join(root, "ecc-state-path");
    put(
      join(sourceRoot, "scripts", "lib", "install-executor.js"),
      `exports.createManifestInstallPlan = ({ homeDir }) => ({
        operations: [], statePreview: { operations: [] },
        installStatePath: require("node:path").join(homeDir, ".claude", "settings.json")
      });
      exports.applyInstallPlan = () => { throw new Error("malicious state path reached apply"); };\n`,
    );
    const selected: EccComponentSelection = {
      scope: "scoped",
      components: ["skill:tdd-workflow"],
      mcps: [],
      recommendations: [],
    };
    const built = verifiedEccInstallPlan(
      ctx(),
      sourceRoot,
      { clis: ["claude"], profile: "minimal", packs: [], selection: selected, governance: true },
      authorizationsForSelection("claude", selected),
    );
    const step = driverSteps(built.actions)[1];
    if (step === undefined || step.input === undefined)
      throw new Error("missing materialization step");
    const executable = step.argv[0];
    if (executable === undefined) throw new Error("missing materialization executable");
    const result = spawnSync(executable, step.argv.slice(1), {
      cwd: step.cwd,
      input: step.input,
      encoding: "utf8",
    });
    expect(result.status).not.toBe(0);
    expect(`${result.stderr}${result.stdout}`).toContain("exact authorized target state path");
  });

  it("rejects a governed Codex merge whose upstream state path aliases config.toml", () => {
    const sourceRoot = join(root, "codex-state-path");
    const home = join(root, "codex-home");
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex", "config.toml"), "user-owned = true\n", "utf8");
    put(
      join(sourceRoot, ".codex", "AGENTS.md"),
      "## Skills Discovery\n\nAvailable skills:\n- tdd-workflow\n\n## MCP Servers\n\n## External Action Boundaries\n",
    );
    put(
      join(sourceRoot, "scripts", "lib", "install-executor.js"),
      `exports.createManifestInstallPlan = ({ homeDir }) => ({
        operations: [], statePreview: { operations: [] },
        installStatePath: require("node:path").join(homeDir, ".codex", "config.toml")
      });\n`,
    );
    put(
      join(sourceRoot, "scripts", "lib", "install-state.js"),
      'exports.writeInstallState = () => { throw new Error("malicious state path reached writer"); };\n',
    );
    const context: PlanContext = {
      ...ctx(),
      env: { HOME: home },
      host: makeHostAdapter({
        platform: "linux",
        run: fakeRunner(() => undefined),
        env: { HOME: home },
      }),
    };
    const selected: EccComponentSelection = {
      scope: "scoped",
      components: ["skill:tdd-workflow"],
      mcps: [],
      recommendations: [],
    };
    const built = verifiedEccInstallPlan(
      context,
      sourceRoot,
      { clis: ["codex"], profile: "minimal", packs: [], selection: selected, governance: true },
      authorizationsForSelection("codex", selected),
    );
    const step = driverSteps(built.actions).find((candidate) =>
      codexInstallProgram(candidate).includes("codex-install-merge"),
    );
    if (step === undefined) throw new Error("missing Codex merge step");
    const executable = step.argv[0];
    if (executable === undefined) throw new Error("missing Codex merge executable");
    const result = spawnSync(executable, step.argv.slice(1), {
      cwd: step.cwd,
      env: { ...process.env, ...step.env, HOME: home, USERPROFILE: home },
      encoding: "utf8",
    });
    expect(result.status).not.toBe(0);
    expect(`${result.stderr}${result.stdout}`).toContain("exact authorized upstream state path");
    expect(readFileSync(join(home, ".codex", "config.toml"), "utf8")).toBe("user-owned = true\n");
    expect(existsSync(join(home, ".codex", "ecc-aih-install-state.json"))).toBe(false);
  });

  it("keeps Codex on the add-only merge path inside the same sequential driver", () => {
    const sourceRoot = join(root, "quarantine", "tree");
    const selected = selection();
    selected.mcps = ["mcp:sequential-thinking", "mcp:github"];
    const plan = verifiedEccInstallPlan(
      ctx(),
      sourceRoot,
      { clis: ["codex"], profile: "core", packs: [], selection: selected },
      authorizationsForSelection("codex", selected),
    );
    expect(execs(plan.actions)).toHaveLength(1);
    const steps = driverSteps(plan.actions);
    expect(steps[0]?.argv[0]).toBe("npm");
    expect(steps[1]?.argv.slice(0, 2)).toEqual(["node", "-e"]);
    expect(steps[1]?.argv).toContain(join(sourceRoot, "scripts", "codex", "merge-codex-config.js"));
    const specB64 = steps[1]?.argv.at(-3);
    if (specB64 === undefined) throw new Error("missing Codex materialization spec");
    expect(JSON.parse(Buffer.from(specB64, "base64").toString("utf8"))).toMatchObject({
      scope: "scoped",
      moduleIds: expect.arrayContaining(["agents-core", "platform-configs"]),
      agents: ["code-reviewer"],
    });
    const mcpB64 = steps[1]?.argv.at(-2);
    if (mcpB64 === undefined) throw new Error("missing Codex MCP registration spec");
    expect(JSON.parse(Buffer.from(mcpB64, "base64").toString("utf8"))).toMatchObject({
      servers: {
        "chrome-devtools": {
          type: "stdio",
          command: "npx",
          args: ["-y", "chrome-devtools-mcp@1.7.0"],
          startupTimeoutSec: 30,
        },
        "sequential-thinking": {
          type: "stdio",
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-sequential-thinking@2026.7.4"],
        },
        github: {
          type: "http",
          url: "https://api.githubcopilot.com/mcp/",
        },
      },
    });
    expect(steps[1]?.env?.ECC_DISABLED_MCPS).toBe(
      "chrome-devtools,context7,exa,memory,playwright,supabase",
    );
    const codexProgram = codexInstallProgram(steps[1]);
    expect(codexProgram).not.toContain("mergeMcpConfig");
    expect(codexProgram).toContain("prepareDestination(configPath)");
    expect(codexProgram).toContain("mergeCodexConfigCandidate");
  });

  it("carries OpenCode package runtime suppression into both governed execution drivers", () => {
    const selected = selection();
    const direct = verifiedEccInstallPlan(
      ctx(),
      join(root, "quarantine", "tree"),
      {
        clis: ["opencode"],
        profile: "core",
        packs: [],
        selection: selected,
        governance: true,
      },
      eccEvidenceComponentIdsForSelection("opencode", selected).map(authorization),
    );
    const directProgram = driverSteps(direct.actions).find((step) =>
      step.argv[2]?.includes("scoped ECC materialization payload"),
    )?.argv[2];
    if (directProgram === undefined) throw new Error("missing governed materialization driver");

    const codex = verifiedEccInstallPlan(
      ctx(),
      join(root, "quarantine", "tree"),
      {
        clis: ["codex"],
        profile: "core",
        packs: [],
        selection: selected,
        governance: true,
      },
      authorizationsForSelection("codex", selected),
    );
    const codexStep = driverSteps(codex.actions).find((step) =>
      codexInstallProgram(step).includes("codex-install-merge"),
    );
    if (codexStep === undefined) throw new Error("missing governed Codex merge driver");

    const completeOpenCodeTree = "(?:\\.opencode|\\.config\\/opencode)(?:\\/|$)";
    expect(directProgram).toContain(completeOpenCodeTree);
    expect(codexInstallProgram(codexStep)).toContain(completeOpenCodeTree);
  });

  it("projects Core's exact Chrome DevTools default through the unscoped verified Codex path", () => {
    const plan = verifiedEccInstallPlan(
      ctx(),
      join(root, "quarantine", "tree"),
      { clis: ["codex"], profile: "minimal", packs: [] },
      [authorization()],
    );
    const step = driverSteps(plan.actions)[1];
    const mcpB64 = step?.argv.at(-2);
    if (mcpB64 === undefined) throw new Error("missing Codex MCP registration spec");
    const rendered = Buffer.from(mcpB64, "base64").toString("utf8");

    expect(rendered).toContain("chrome-devtools-mcp@1.7.0");
    expect(rendered).toContain('"startupTimeoutSec":30');
    expect(rendered).not.toContain("@latest");
  });

  it("keeps the Core Chrome DevTools default out of governed verified Codex installs", () => {
    const selected = selection();
    const plan = verifiedEccInstallPlan(
      ctx(),
      join(root, "quarantine", "tree"),
      { clis: ["codex"], profile: "minimal", packs: [], selection: selected, governance: true },
      authorizationsForSelection("codex", selected),
    );
    const step = driverSteps(plan.actions)[1];
    const mcpB64 = step?.argv.at(-2);
    if (mcpB64 === undefined) throw new Error("missing Codex MCP registration spec");

    expect(JSON.parse(Buffer.from(mcpB64, "base64").toString("utf8"))).toEqual({ servers: {} });
  });

  it.each([
    ["project", "[mcp_servers.chrome-devtools]\nenabled = false\n"],
    ["global", '[mcp_servers.chrome-devtools]\nurl = "https://example.invalid/mcp"\n'],
  ])(
    "refuses a verified Codex install on a planned Core-name %s ambiguity",
    async (scope, config) => {
      const home = join(root, "collision-home");
      const projectConfig = join(root, ".codex", "config.toml");
      const globalConfig = join(home, ".codex", "config.toml");
      const target = scope === "project" ? projectConfig : globalConfig;
      mkdirSync(join(target, ".."), { recursive: true });
      writeFileSync(target, config, "utf8");
      const context = { ...ctx(), env: { HOME: home, USERPROFILE: home } };
      const selected = selection();

      const plan = verifiedEccInstallPlan(
        context,
        join(root, "quarantine", "tree"),
        { clis: ["codex"], profile: "minimal", packs: [], selection: selected },
        authorizationsForSelection("codex", selected),
      );

      expect(
        driverSteps(plan.actions).some((step) =>
          step.argv.join(" ").includes("codex-install-merge"),
        ),
      ).toBe(false);
      const checks = await Promise.all(
        plan.actions
          .filter((action): action is Extract<Action, { kind: "probe" }> => action.kind === "probe")
          .map((action) => action.run(context)),
      );
      expect(checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: "mcp.config-invalid", verdict: "fail" }),
        ]),
      );
    },
  );

  // #506 F1: the enterprise rollout observed the Codex merge receiving the core
  // profile regardless of `--profile full`. These two tests lock the resolved
  // profile end-to-end through the LIVE path (registration request → verified
  // install plan → merge argv/spec), so a reintroduced hardcode fails here.
  it("threads --profile full through the registration request into a full-scope Codex merge", () => {
    const context: PlanContext = { ...ctx(), options: { profile: "full", cli: "codex" } };
    const request = buildEccRegistrationRequest(context, ["codex"]);
    expect(request.profile).toBe("full");
    expect(request.selection.scope).toBe("full");

    const built = verifiedEccInstallPlan(
      context,
      join(root, "quarantine", "tree"),
      request,
      authorizationsForSelection("codex", request.selection),
    );
    const merge = driverSteps(built.actions).find((step) =>
      codexInstallProgram(step).includes("codex-install-merge"),
    );
    if (merge === undefined) throw new Error("missing Codex merge step");
    // argv: [node, -e, script, repoRoot, profileId, homeDir, …, governanceFlag, specB64, mcpB64, stateB64]
    expect(merge.argv[4]).toBe("full");
    const specB64 = merge.argv.at(-3);
    if (specB64 === undefined) throw new Error("missing Codex materialization spec");
    expect(JSON.parse(Buffer.from(specB64, "base64").toString("utf8"))).toMatchObject({
      scope: "full",
    });
  });

  it("--profile full executes the Codex merge as a full install (upstream profileId=full, every skill)", () => {
    const sourceRoot = join(root, "ecc-source");
    const home = join(root, "home");
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex", "config.toml"), "", "utf8");
    put(
      join(sourceRoot, "scripts", "lib", "install-executor.js"),
      `exports.createManifestInstallPlan = ({ profileId, moduleIds, homeDir }) => {
        require("node:fs").writeFileSync(
          require("node:path").join(homeDir, "captured-manifest-request.json"),
          JSON.stringify({ profileId, moduleIds }),
        );
        return {
          operations: [],
          statePreview: {
            schemaVersion: 1,
            installedAt: new Date().toISOString(),
            request: {},
            resolution: { selectedModules: [], skippedModules: [] },
            source: { manifestVersion: 1 },
            operations: [],
          },
          installStatePath: require("node:path").join(homeDir, ".codex", "ecc-install-state.json"),
        };
      };\n`,
    );
    put(
      join(sourceRoot, "scripts", "lib", "install-state.js"),
      'exports.writeInstallState = (path, state) => require("node:fs").writeFileSync(path, JSON.stringify(state), "utf8");\n',
    );
    for (const name of ["merge-codex-config.js", "merge-mcp-config.js"]) {
      put(join(sourceRoot, "scripts", "codex", name), "process.exit(0);\n");
    }
    put(
      join(sourceRoot, ".codex", "AGENTS.md"),
      [
        "## Skills Discovery",
        "",
        "old guidance",
        "",
        "Available skills:",
        "- alpha-skill — test",
        "",
        "## MCP Servers",
        "",
        "old MCP guidance",
        "",
        "## External Action Boundaries",
        "",
        "boundary",
        "",
        "| Skills | Skills loaded via plugin | `.agents/skills/` directory |",
        "",
      ].join("\n"),
    );
    put(join(sourceRoot, "skills", "alpha-skill", "SKILL.md"), "# Alpha\n");
    put(join(sourceRoot, "skills", "beta-skill", "SKILL.md"), "# Beta\n");

    const run = fakeRunner(() => undefined);
    const context: PlanContext = {
      ...ctx(),
      env: { HOME: home },
      host: makeHostAdapter({ platform: "linux", run, env: { HOME: home } }),
      run,
      options: { profile: "full", cli: "codex" },
    };
    const request = buildEccRegistrationRequest(context, ["codex"]);
    const built = verifiedEccInstallPlan(
      context,
      sourceRoot,
      request,
      authorizationsForSelection("codex", request.selection),
    );
    const step = driverSteps(built.actions)[1];
    if (step === undefined) throw new Error("missing Codex install step");
    const executable = step.argv[0];
    if (executable === undefined) throw new Error("missing Codex install executable");

    const result = spawnSync(executable, step.argv.slice(1), {
      cwd: step.cwd,
      env: { ...process.env, ...step.env, HOME: home, USERPROFILE: home },
      encoding: "utf8",
    });

    expect(result.status, result.stderr).toBe(0);
    // The upstream installer received the FULL profile, not a scoped module list.
    expect(JSON.parse(readFileSync(join(home, "captured-manifest-request.json"), "utf8"))).toEqual({
      profileId: "full",
      moduleIds: [],
    });
    // Every skill in the verified checkout materialized — the full set, not core.
    expect(readFileSync(join(home, ".codex", "skills", "alpha-skill", "SKILL.md"), "utf8")).toBe(
      "# Alpha\n",
    );
    expect(readFileSync(join(home, ".codex", "skills", "beta-skill", "SKILL.md"), "utf8")).toBe(
      "# Beta\n",
    );
  });

  it("does not treat its own scoped HTTP GitHub registration as a rerun collision", () => {
    const home = join(root, "home");
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(
      join(home, ".codex", "config.toml"),
      [
        "# >>> aih managed (mcp) >>>",
        '[mcp_servers."github"]',
        'url = "https://api.githubcopilot.com/mcp/"',
        "# <<< aih managed (mcp) <<<",
        "",
      ].join("\n"),
      "utf8",
    );
    const run = fakeRunner(() => undefined);
    const context: PlanContext = {
      ...ctx(),
      env: { HOME: home },
      host: makeHostAdapter({ platform: "linux", run, env: { HOME: home } }),
      run,
    };
    const selected = selection();
    selected.mcps = ["mcp:sequential-thinking", "mcp:github"];

    const built = verifiedEccInstallPlan(
      context,
      join(root, "quarantine", "tree"),
      { clis: ["codex"], profile: "core", packs: [], selection: selected },
      authorizationsForSelection("codex", selected),
    );

    expect(driverSteps(built.actions)).not.toHaveLength(0);
    expect(
      built.actions.some(
        (action) => action.kind === "doc" && action.describe.includes("MCP server name collision"),
      ),
    ).toBe(false);
  });

  it("materializes selected Codex skills into the real on-demand skill directory", () => {
    const sourceRoot = join(root, "ecc-source");
    const home = join(root, "home");
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex", "config.toml"), "# operator-owned\r\n", "utf8");
    put(
      join(sourceRoot, "scripts", "lib", "install-executor.js"),
      `exports.createManifestInstallPlan = ({ homeDir }) => ({
        operations: [],
        statePreview: {
          schemaVersion: 1,
          installedAt: process.hrtime.bigint().toString(),
          request: {},
          resolution: { selectedModules: [], skippedModules: [] },
          source: { manifestVersion: 1 },
          operations: [],
        },
        installStatePath: require("node:path").join(homeDir, ".codex", "ecc-install-state.json"),
      });\n`,
    );
    put(
      join(sourceRoot, "scripts", "lib", "install-state.js"),
      'exports.writeInstallState = (path, state) => require("node:fs").writeFileSync(path, JSON.stringify(state), "utf8");\n',
    );
    for (const name of ["merge-codex-config.js", "merge-mcp-config.js"]) {
      put(join(sourceRoot, "scripts", "codex", name), "process.exit(0);\n");
    }
    put(
      join(sourceRoot, ".codex", "AGENTS.md"),
      [
        "## Skills Discovery",
        "",
        "old guidance",
        "",
        "Available skills:",
        "- coding-standards — test",
        "",
        "## MCP Servers",
        "",
        "old MCP guidance",
        "",
        "## External Action Boundaries",
        "",
        "boundary",
        "",
        "| Skills | Skills loaded via plugin | `.agents/skills/` directory |",
        "",
      ].join("\n"),
    );
    put(join(sourceRoot, "skills", "coding-standards", "SKILL.md"), "# Coding standards\n");

    const selected: EccComponentSelection = {
      scope: "scoped",
      components: ["skill:coding-standards"],
      mcps: ["mcp:sequential-thinking"],
      recommendations: [],
    };
    const context = {
      ...ctx(),
      env: { HOME: home },
      host: makeHostAdapter({
        platform: "linux",
        run: fakeRunner(() => undefined),
        env: { HOME: home },
      }),
    };
    const built = verifiedEccInstallPlan(
      context,
      sourceRoot,
      { clis: ["codex"], profile: "core", packs: [], selection: selected },
      authorizationsForSelection("codex", selected),
    );
    const step = driverSteps(built.actions)[1];
    if (step === undefined) throw new Error("missing Codex install step");
    const executable = step.argv[0];
    if (executable === undefined) throw new Error("missing Codex install executable");

    const result = spawnSync(executable, step.argv.slice(1), {
      cwd: step.cwd,
      env: { ...process.env, ...step.env, HOME: home, USERPROFILE: home },
      encoding: "utf8",
    });

    expect(result.status, result.stderr).toBe(0);
    expect(
      readFileSync(join(home, ".codex", "skills", "coding-standards", "SKILL.md"), "utf8"),
    ).toBe("# Coding standards\n");
    const config = readFileSync(join(home, ".codex", "config.toml"), "utf8");
    expect(config).toContain("chrome-devtools-mcp@1.7.0");
    expect(config).toContain("startup_timeout_sec = 30");
    expect(config).not.toContain("@latest");
    expect(config).toContain("\r\n");
    expect(readFileSync(join(home, ".codex", "ecc-aih-install-state.json"), "utf8")).toContain(
      '"chrome-devtools"',
    );
    const statePath = join(home, ".codex", "ecc-install-state.json");
    const firstState = readFileSync(statePath, "utf8");
    const state = JSON.parse(firstState) as { operations: Array<{ destinationPath: string }> };
    expect(state.operations.map((operation) => operation.destinationPath)).toContain(
      join(home, ".codex", "skills", "coding-standards", "SKILL.md"),
    );

    const rerun = spawnSync(executable, step.argv.slice(1), {
      cwd: step.cwd,
      env: { ...process.env, ...step.env, HOME: home, USERPROFILE: home },
      encoding: "utf8",
    });
    expect(rerun.status, rerun.stderr).toBe(0);
    expect(readFileSync(statePath, "utf8")).toBe(firstState);
  });

  it("registers only the current project's validated MCPs in project-local config", () => {
    const selected = selection();
    selected.mcps = ["mcp:sequential-thinking", "mcp:github"];
    const built = verifiedEccInstallPlan(
      ctx(),
      join(root, "quarantine", "tree"),
      {
        clis: ["claude"],
        profile: "core",
        packs: [],
        selection: selected,
        project: {
          root,
          scope: "scoped",
          components: [...selected.components],
          mcps: ["mcp:sequential-thinking"],
        },
      },
      authorizationsForSelection("claude", selected),
    );

    const mcp = writes(built.actions).find((action) => action.path === ".mcp.json");
    expect(mcp).toMatchObject({
      merge: true,
      json: {
        mcpServers: {
          "sequential-thinking": {
            type: "stdio",
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-sequential-thinking@2026.7.4"],
          },
        },
      },
    });
    expect(JSON.stringify(mcp)).not.toContain("github");
    expect(JSON.stringify(mcp)).not.toContain("context7");
    expect(JSON.stringify(mcp)).not.toContain("exa");
    expect(JSON.stringify(mcp)).not.toContain("chrome-devtools");
  });

  it("degrades scoped Kiro registration to guidance instead of installing the whole surface", () => {
    const sourceRoot = join(root, "quarantine", "tree");
    const built = verifiedEccInstallPlan(
      ctx(),
      sourceRoot,
      { clis: ["kiro"], profile: "core", packs: [], selection: selection() },
      [authorization("runtime:ecc-kiro")],
    );
    expect(execs(built.actions)).toEqual([]);
    expect(
      built.actions
        .filter((action) => action.kind === "doc")
        .map((action) => action.text)
        .join("\n"),
    ).toContain('npx ecc consult "this repository" --target kiro');
  });

  it("emits machine-readable evidence authorization receipts", () => {
    const receipt = authorization();
    const plan = verifiedEccInstallPlan(
      ctx(),
      join(root, "tree"),
      { clis: ["claude"], profile: "core", packs: [] },
      [receipt],
    );
    const digest = plan.actions.find(
      (action): action is DigestAction =>
        action.kind === "digest" && action.describe.includes("evidence"),
    );
    expect(digest?.data).toEqual({ authorizations: [receipt] });
    expect(digest?.text).toContain("vendor");
    expect(digest?.text).toContain("runtime:ecc-installer");
  });

  it("commits the ledger only after every install step succeeds", () => {
    const sourceRoot = join(root, "quarantine", "tree");
    const built = verifiedEccInstallPlan(
      ctx(),
      sourceRoot,
      {
        clis: ["claude"],
        profile: "core",
        packs: [],
        selection: {
          scope: "scoped",
          components: ["baseline:rules"],
          mcps: [],
          recommendations: [],
        },
        project: {
          root,
          scope: "scoped",
          components: ["baseline:rules"],
          mcps: [],
        },
        ledger: emptyRegistrationLedger(),
      },
      [authorization(), authorization("baseline:rules")],
    );
    const driver = execs(built.actions).find((action) =>
      action.describe.includes("verified ECC checkout"),
    );
    if (driver === undefined) throw new Error("missing verified ECC driver");
    const executable = driver.argv[0];
    if (executable === undefined) throw new Error("missing verified ECC driver executable");
    const steps = driverSteps(built.actions);
    const ledgerStep = steps.at(-1);
    expect(ledgerStep?.argv.join(" ")).toContain("registration-ledger");

    const run = (firstExit: number, env: NodeJS.ProcessEnv = {}) => {
      const deterministic = steps.map((step, index) =>
        index === steps.length - 1
          ? step
          : {
              argv: [process.execPath, "-e", `process.exit(${index === 0 ? firstExit : 0})`],
              cwd: root,
            },
      );
      return spawnSync(executable, driver.argv.slice(1), {
        cwd: root,
        env: { ...process.env, ...env },
        input: JSON.stringify(deterministic),
        encoding: "utf8",
      });
    };

    const failed = run(7);
    expect(failed.status).toBe(7);
    expect(failed.stderr).toBe("");
    expect(existsSync(registrationLedgerPath(root))).toBe(false);
    const preload = join(root, "transient-rename.cjs");
    writeFileSync(
      preload,
      [
        'const fs = require("node:fs");',
        "const rename = fs.renameSync;",
        "let calls = 0;",
        "fs.renameSync = (...args) => {",
        "  if (calls++ === 0) {",
        '    const error = new Error("injected transient rename failure");',
        '    error.code = "EPERM";',
        "    throw error;",
        "  }",
        "  return rename(...args);",
        "};",
        "",
      ].join("\n"),
      "utf8",
    );
    expect(run(0, { NODE_OPTIONS: `--require=${preload}` }).status).toBe(0);
    expect(readRegistrationLedger(root).projects).toEqual([
      expect.objectContaining({ root: realpathSync(root), components: ["baseline:rules"] }),
    ]);
  });

  it("preserves consult-only guidance alongside verified mutating targets", () => {
    const built = verifiedEccInstallPlan(
      ctx(),
      join(root, "tree"),
      {
        clis: ["claude", "windsurf"],
        profile: "core",
        packs: [],
        stackSummary: "TypeScript using React",
      },
      [authorization()],
    );

    const guidance = built.actions
      .filter((action) => action.kind === "doc")
      .map((action) => action.text)
      .join("\n");
    expect(guidance).toContain('npx ecc consult "TypeScript using React" --target windsurf');
  });
});
