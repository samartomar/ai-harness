import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BaselineAuthorization } from "../../src/baseline-evidence/verify.js";
import type { EccComponentSelection } from "../../src/ecc/components.js";
import { eccEvidenceComponentIdsForSelection } from "../../src/ecc/evidence.js";
import {
  emptyRegistrationLedger,
  readRegistrationLedger,
  registrationLedgerPath,
} from "../../src/ecc/registration.js";
import { verifiedEccInstallPlan } from "../../src/ecc/verified.js";
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
    issuer: "@aihq/harness release",
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
  // Steps ride a temp FILE, never argv (Windows 32K command-line cap; the
  // driver deletes it on execution — unexecuted plan actions leave it for us).
  const stepsPath = driver?.argv.at(-1);
  if (!stepsPath) throw new Error("missing verified ECC steps file path");
  return JSON.parse(readFileSync(stepsPath, "utf8")) as Array<{
    argv: string[];
    cwd: string;
    env?: Record<string, string>;
    input?: string;
  }>;
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
        [authorization("module:rules-core")],
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
      [authorization(), authorization("module:rules-core")],
    );
    const steps = driverSteps(built.actions);
    const materializationPayload = JSON.parse(steps[1]?.input ?? "null") as {
      spec: { wholeModules: string[] };
    };
    const ledgerPayload = JSON.parse(steps.at(-1)?.input ?? "null") as { contents: string };
    const ledger = JSON.parse(ledgerPayload.contents) as {
      projects: Array<{ components: string[] }>;
      targets: Array<{ components: Array<{ id: string }> }>;
    };

    expect(materializationPayload.spec.wholeModules).toEqual(["rules-core"]);
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
    const specB64 = steps[1]?.argv.at(-2);
    if (specB64 === undefined) throw new Error("missing Codex materialization spec");
    expect(JSON.parse(Buffer.from(specB64, "base64").toString("utf8"))).toMatchObject({
      scope: "scoped",
      moduleIds: expect.arrayContaining(["agents-core", "platform-configs"]),
      agents: ["code-reviewer"],
    });
    const mcpB64 = steps[1]?.argv.at(-1);
    if (mcpB64 === undefined) throw new Error("missing Codex MCP registration spec");
    expect(JSON.parse(Buffer.from(mcpB64, "base64").toString("utf8"))).toMatchObject({
      servers: {
        "sequential-thinking": {
          type: "stdio",
          command: "npx",
          args: ["-y", "@modelcontextprotocol/server-sequential-thinking@2025.12.18"],
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
    expect(steps[1]?.argv[2]).toContain("if (!mcpSpec)");
    expect(
      plan.actions.some(
        (action) => action.kind === "write" && action.describe.includes("Codex config.toml"),
      ),
    ).toBe(true);
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
    writeFileSync(join(home, ".codex", "config.toml"), "", "utf8");
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
            args: ["-y", "@modelcontextprotocol/server-sequential-thinking@2025.12.18"],
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
      [authorization(), authorization("module:rules-core")],
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
      const stepsFile = join(root, `det-steps-${firstExit}.json`);
      writeFileSync(stepsFile, JSON.stringify(deterministic), "utf8");
      return spawnSync(executable, [...driver.argv.slice(1, -1), stepsFile], {
        cwd: root,
        env: { ...process.env, ...env },
        encoding: "utf8",
      });
    };

    expect(run(7).status).toBe(7);
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
