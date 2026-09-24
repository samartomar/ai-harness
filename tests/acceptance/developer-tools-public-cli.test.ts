import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { executeInitCommand } from "../../src/init/index.js";
import type { PlanContext } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import {
  type DefaultNativeRuntimeLayout,
  defaultNativeRuntimeLayout,
} from "../../src/mcp/default-native-runtime.js";
import { mcpEntries } from "../../src/mcp/render.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import type { DeveloperToolId } from "../../src/tools/default-tool-selection.js";
import { executeDeveloperToolsCommand } from "../../src/tools/developer-tools-command.js";
import type { DeveloperToolRuntimeOperation } from "../../src/tools/developer-tools-runtime.js";
import {
  HEADROOM_MCP_TOOL_NAMES,
  headroomLayout,
  headroomMcpServer,
} from "../../src/tools/headroom.js";

const roots: string[] = [];
const developerTools = [
  "code-review-graph",
  "codebase-memory-mcp",
  "serena",
  "token-optimizer",
  "context7",
  "markitdown",
  "playwright",
  "headroom",
] as const;
const reconciledTools = developerTools.filter((id) => id !== "headroom");

function consumerRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "aih-developer-tools-consumer-"));
  roots.push(root);
  return root;
}

function invokeAih(root: string, argv: readonly string[], env: NodeJS.ProcessEnv = {}) {
  const repository = process.cwd();
  const tsx = join(repository, "node_modules", "tsx", "dist", "cli.mjs");
  return spawnSync(process.execPath, [tsx, join(repository, "src", "cli.ts"), ...argv], {
    cwd: repository,
    encoding: "utf8",
    timeout: 30_000,
    windowsHide: true,
    env: {
      ...process.env,
      AIH_LOG: "0",
      AIH_REPO_AI_TOOLS_HOME: join(root, "managed-tools"),
      AIH_WORKBENCH_DATA: join(root, "workbench-data"),
      AIH_WORKBENCH_VERIFIER_HOME: join(root, "workbench-verifier"),
      ...env,
    },
  });
}

function invoke(root: string, args: readonly string[] = [], env: NodeJS.ProcessEnv = {}) {
  return invokeAih(root, ["developer-tools", root, "--json", ...args], env);
}

function writePolicy(root: string, developerTools?: Record<string, unknown>): void {
  const requiresHeadroomFloor =
    [developerTools?.selected, developerTools?.excluded].some(
      (value) => Array.isArray(value) && value.includes("headroom"),
    ) || developerTools?.primaryCodeGraph !== undefined;
  writeFileSync(
    join(root, "aih-org-policy.json"),
    `${JSON.stringify({
      schemaVersion: 3,
      minimumCoreVersion: requiresHeadroomFloor ? "0.7.0" : "0.6.0",
      minimumPosture: "vibe",
      references: { repoContract: "ai-coding/project.json" },
      authoringSelections: {
        selectionVersion: "workbench-selection/v1",
        roots: [],
        exclusions: [],
        requests: [],
        drafts: [],
      },
      ...(developerTools === undefined ? {} : { developerTools }),
    })}\n`,
  );
}

function writeBindablePolicy(root: string, version = "1"): void {
  writeFileSync(
    join(root, "aih-org-policy.json"),
    `${JSON.stringify({
      schemaVersion: 2,
      minimumPosture: "vibe",
      references: { repoContract: "ai-coding/project.json" },
      governance: {
        policyVersion: version,
        supportedClis: ["claude"],
        catalog: { reviewed: [], custom: [] },
        activations: [],
        authority: { approvals: [] },
      },
    })}\n`,
  );
}

function bindPolicy(root: string): void {
  const result = invokeAih(root, [
    "policy",
    "bind",
    root,
    "--project",
    "developer-tools-consumer",
    "--cli",
    "claude",
    "--apply",
    "--json",
  ]);
  expect(result.status, result.stderr || result.stdout).toBe(0);
}

function snapshot(root: string, relative = ""): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of readdirSync(join(root, relative), { withFileTypes: true })) {
    const path = join(relative, entry.name);
    if (entry.isDirectory()) Object.assign(files, snapshot(root, path));
    else if (entry.isFile())
      files[path.replace(/\\/gu, "/")] = readFileSync(join(root, path), "utf8");
    else files[path.replace(/\\/gu, "/")] = `<${entry.isSymbolicLink() ? "symlink" : "other"}>`;
  }
  return files;
}

function toolStates(payload: {
  tools: Array<{ id: string; state: string }>;
}): Record<string, string> {
  return Object.fromEntries(payload.tools.map((tool) => [tool.id, tool.state]));
}

function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function consumerContext(
  root: string,
  stateRoot: string,
  options: Record<string, unknown> = {},
): PlanContext {
  const run = fakeRunner(() => undefined);
  const env: NodeJS.ProcessEnv = {
    XDG_STATE_HOME: realpathSync(stateRoot),
    HOME: realpathSync(stateRoot),
    PATH: process.env.PATH,
  };
  return {
    root: realpathSync(root),
    contextDir: "ai-coding",
    apply: true,
    verify: false,
    json: true,
    run,
    env,
    host: makeHostAdapter({ platform: "linux", run, env }),
    options,
  };
}

function fixtureOwnedPath(layout: DefaultNativeRuntimeLayout): string {
  return join(layout.serenaStateRoot, "serena_config.yml");
}

interface FixtureCall {
  readonly id: DeveloperToolId;
  readonly selected: boolean;
}

function fixtureOperation(
  id: DeveloperToolId,
  generation: string,
  calls: FixtureCall[] | undefined,
  blocked: DeveloperToolId | undefined,
): DeveloperToolRuntimeOperation {
  return async ({ layout, selected }) => {
    calls?.push({ id, selected });
    if (id === blocked) throw new Error(`${id} fixture prerequisite is unavailable`);
    if (!selected) {
      return {
        state: "policy-excluded",
        detail: `${id} fixture cleanup completed`,
        sourceDigest: sha(`fixture-source:${id}:${generation}`),
        ownedPaths: [],
        changed: false,
      };
    }

    const path = id === "serena" ? fixtureOwnedPath(layout) : undefined;
    const contents = `${id}:${generation}\n`;
    const before = path !== undefined && existsSync(path) ? readFileSync(path, "utf8") : undefined;
    if (path !== undefined) {
      mkdirSync(dirname(path), { recursive: true });
      if (before !== contents) writeFileSync(path, contents);
    }
    return {
      state: "verified",
      detail: `${id} fixture acquisition, configuration, and verification completed`,
      sourceDigest: sha(`fixture-source:${id}:${generation}`),
      // Token Optimizer has its own receipt. The shared receipt only permits
      // Serena's exact configuration path; the other MCP tools claim none.
      ownedPaths:
        path === undefined ? [] : [{ path, sha256: sha(contents), ownership: "file" as const }],
      changed: path !== undefined && before !== contents,
    };
  };
}

function fixtureOperations(
  generation: string,
  calls?: FixtureCall[],
  blocked?: DeveloperToolId,
): Partial<Record<DeveloperToolId, DeveloperToolRuntimeOperation>> {
  return Object.fromEntries(
    reconciledTools.map((id) => [id, fixtureOperation(id, generation, calls, blocked)]),
  ) as Partial<Record<DeveloperToolId, DeveloperToolRuntimeOperation>>;
}

function expectedStates(selected: readonly string[]): Record<string, string> {
  return Object.fromEntries(
    developerTools.map((id) => [
      id,
      selected.includes(id)
        ? id === "headroom"
          ? "selected-pending"
          : "verified"
        : "policy-excluded",
    ]),
  );
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("public developer-tools setup", () => {
  it("keeps an explicit Headroom-only choice inert through production reconciliation and MCP projection", async () => {
    const root = consumerRoot();
    const stateRoot = consumerRoot();
    writePolicy(root, { selected: ["headroom"] });
    const calls: FixtureCall[] = [];
    let headroomOperationCalled = false;
    const context = consumerContext(root, stateRoot);
    const result = await executeDeveloperToolsCommand(context, {
      runtime: {
        operations: {
          ...fixtureOperations("pin-1", calls),
          headroom: async () => {
            headroomOperationCalled = true;
            throw new Error("Headroom must not enter the runtime reconciler");
          },
        },
      },
    });

    expect(result.selection).toMatchObject({
      source: "explicit",
      selected: ["headroom"],
    });
    expect(headroomOperationCalled).toBe(false);
    expect(calls).toEqual([{ id: "token-optimizer", selected: false }]);
    expect(result.tools.find((tool) => tool.id === "headroom")).toMatchObject({
      state: "selected-pending",
      changed: false,
      detail: expect.stringMatching(/not activated/u),
    });
    expect(
      result.report?.checks.find((check) => check.name === "headroom developer tool"),
    ).toMatchObject({
      verdict: "skip",
    });
    expect(result.report?.ok).toBe(true);
    const layout = defaultNativeRuntimeLayout(context);
    if (existsSync(layout.runtimeReceiptPath))
      expect(JSON.parse(readFileSync(layout.runtimeReceiptPath, "utf8")).tools).not.toHaveProperty(
        "headroom",
      );
    const mcpPath = join(root, ".mcp.json");
    if (existsSync(mcpPath))
      expect(JSON.parse(readFileSync(mcpPath, "utf8")).mcpServers).not.toHaveProperty("headroom");
  });

  it("keeps MarkItDown CLI excluded through repeat setup, restart and a copied worktree policy", async () => {
    const rootA = consumerRoot();
    const rootB = consumerRoot();
    const stateRoot = consumerRoot();
    const calls: FixtureCall[] = [];
    const selected = developerTools.filter((id) => id !== "markitdown");
    writePolicy(rootA, { selected, excluded: ["markitdown"] });
    writePolicy(rootB, { selected, excluded: ["markitdown"] });
    for (const root of [rootA, rootA, rootB, rootA]) {
      const result = await executeDeveloperToolsCommand(
        consumerContext(root, stateRoot, { acceptTokenOptimizerLicense: true }),
        { runtime: { operations: fixtureOperations("pin-1", calls) } },
      );
      expect(result.tools.find((tool) => tool.id === "markitdown")?.state).toBe("policy-excluded");
      expect(result.selection.excluded).toEqual(["markitdown"]);
      const projected = JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8"));
      expect(projected.mcpServers.markitdown).toBeUndefined();
      expect(projected.mcpServers["markitdown-mcp"]).toBeUndefined();
    }
    expect(calls.some((call) => call.id === "markitdown")).toBe(false);
  });

  it("selects every default tool through the public CLI when the consumer has no policy", () => {
    const result = invoke(consumerRoot());

    expect(result.status, result.stderr || result.stdout).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      accepted: true,
      selection: {
        source: "default",
        selected: developerTools,
        excluded: [],
      },
      tools: developerTools.map((id) => ({ id, state: "selected-pending" })),
      changed: false,
    });
  });

  it("includes the same eight-tool selection in the ordinary public init preview", () => {
    const root = consumerRoot();
    const before = snapshot(root);

    const result = invokeAih(root, ["init", root, "--json"]);

    expect(result.status, result.stderr || result.stdout).toBe(0);
    const output = JSON.stringify(JSON.parse(result.stdout));
    expect(output).toContain("Developer tool lifecycle");
    expect(output).toContain("selected-pending");
    expect(output).toContain("token-optimizer");
    expect(snapshot(root)).toEqual(before);
  });

  it.each([
    {
      name: "a supplied subset",
      developerTools: { selected: ["serena", "context7"] },
      source: "explicit",
      selected: ["serena", "context7"],
      excluded: [],
    },
    {
      name: "an explicit exclusion",
      developerTools: {
        selected: ["code-review-graph", "codebase-memory-mcp", "serena", "token-optimizer"],
        excluded: ["context7"],
      },
      source: "explicit",
      selected: ["code-review-graph", "codebase-memory-mcp", "serena", "token-optimizer"],
      excluded: ["context7"],
    },
    {
      name: "an explicit empty selection",
      developerTools: { selected: [] },
      source: "explicit",
      selected: [],
      excluded: [],
    },
    {
      name: "a legacy policy with no developer-tool decision",
      developerTools: undefined,
      source: "legacy-unspecified",
      selected: developerTools,
      excluded: [],
    },
  ])(
    "preserves $name without reapplying defaults",
    ({ developerTools: selection, source, selected, excluded }) => {
      const root = consumerRoot();
      writePolicy(root, selection);

      const result = invoke(root);

      expect(result.status, result.stderr || result.stdout).toBe(0);
      const payload = JSON.parse(result.stdout) as {
        accepted: boolean;
        selection: { source: string; selected: string[]; excluded: string[] };
        tools: Array<{ id: string; state: string }>;
      };
      expect(payload).toMatchObject({
        accepted: true,
        selection: { source, selected, excluded },
      });
      expect(toolStates(payload)).toEqual(
        Object.fromEntries(
          developerTools.map((id) => [
            id,
            selected.includes(id) ? "selected-pending" : "policy-excluded",
          ]),
        ),
      );
    },
  );

  it.each([
    {
      name: "an invalid supplied developer-tool selection",
      prepare(root: string): NodeJS.ProcessEnv {
        writePolicy(root, { selected: ["unknown-tool"] });
        return {};
      },
    },
    {
      name: "an invalid binding marker",
      prepare(root: string): NodeJS.ProcessEnv {
        writeFileSync(join(root, ".aih-config.json"), "{ malformed binding marker");
        return {};
      },
    },
    {
      name: "a missing bound policy source",
      prepare(root: string): NodeJS.ProcessEnv {
        writeBindablePolicy(root);
        bindPolicy(root);
        rmSync(join(root, "aih-org-policy.json"));
        return {};
      },
    },
    {
      name: "changed bound policy bytes",
      prepare(root: string): NodeJS.ProcessEnv {
        writeBindablePolicy(root);
        bindPolicy(root);
        writeBindablePolicy(root, "2");
        return {};
      },
    },
    {
      name: "a revoked binding",
      prepare(root: string): NodeJS.ProcessEnv {
        writeBindablePolicy(root);
        bindPolicy(root);
        const result = invokeAih(root, [
          "policy",
          "revoke",
          root,
          "--project",
          "developer-tools-consumer",
          "--apply",
          "--json",
        ]);
        expect(result.status, result.stderr || result.stdout).toBe(0);
        return {};
      },
    },
    {
      name: "a conflicting explicit policy source",
      prepare(root: string): NodeJS.ProcessEnv {
        writeBindablePolicy(root);
        bindPolicy(root);
        const conflict = join(root, "conflicting-policy.json");
        writeFileSync(conflict, readFileSync(join(root, "aih-org-policy.json"), "utf8"));
        return { AIH_ORG_POLICY: conflict };
      },
    },
  ])("fails closed for $name before modifying the consumer", ({ prepare }) => {
    const root = consumerRoot();
    const env = prepare(root);
    const before = snapshot(root);

    const result = invoke(root, ["--apply"], env);

    expect(result.status, result.stderr || result.stdout).not.toBe(0);
    const payload = JSON.parse(result.stdout) as { error?: { message?: string } };
    expect(payload.error?.message).toMatch(/(?:policy|binding)/iu);
    expect(snapshot(root)).toEqual(before);
  });

  it("reconciles all seven through repeated setup, restart, worktree switching, and a later pin change", async () => {
    const stateRoot = consumerRoot();
    const worktreeA = consumerRoot();
    const worktreeB = consumerRoot();
    const options = { acceptTokenOptimizerLicense: true };

    const firstContext = consumerContext(worktreeA, stateRoot, options);
    const first = await executeDeveloperToolsCommand(firstContext, {
      runtime: { operations: fixtureOperations("pin-1") },
      projectMcp: false,
    });

    expect(first.selection).toMatchObject({
      source: "default",
      selected: developerTools,
      excluded: [],
    });
    expect(toolStates(first)).toEqual(expectedStates(developerTools));
    expect(first.changed).toBe(true);
    const layoutA = defaultNativeRuntimeLayout(firstContext);
    const firstReceipt = readFileSync(layoutA.runtimeReceiptPath, "utf8");
    expect(JSON.parse(firstReceipt)).toMatchObject({
      canonicalRoot: realpathSync(worktreeA),
      tools: {
        serena: { sourceDigest: sha("fixture-source:serena:pin-1") },
      },
    });

    const restarted = await executeDeveloperToolsCommand(
      consumerContext(worktreeA, stateRoot, options),
      { runtime: { operations: fixtureOperations("pin-1") }, projectMcp: false },
    );
    expect(restarted.changed).toBe(false);
    expect(readFileSync(layoutA.runtimeReceiptPath, "utf8")).toBe(firstReceipt);

    const firstContextB = consumerContext(worktreeB, stateRoot, options);
    const worktreeBSetup = await executeDeveloperToolsCommand(firstContextB, {
      runtime: { operations: fixtureOperations("pin-1") },
      projectMcp: false,
    });
    const layoutB = defaultNativeRuntimeLayout(firstContextB);
    expect(worktreeBSetup.selection.selected).toEqual(developerTools);
    expect(layoutB.projectStateRoot).not.toBe(layoutA.projectStateRoot);
    expect(JSON.parse(readFileSync(layoutB.runtimeReceiptPath, "utf8"))).toMatchObject({
      canonicalRoot: realpathSync(worktreeB),
    });
    expect(readFileSync(layoutA.runtimeReceiptPath, "utf8")).toBe(firstReceipt);

    const returnedToA = await executeDeveloperToolsCommand(
      consumerContext(worktreeA, stateRoot, options),
      { runtime: { operations: fixtureOperations("pin-1") }, projectMcp: false },
    );
    expect(returnedToA.changed).toBe(false);
    expect(returnedToA.selection.selected).toEqual(developerTools);

    const afterPinChange = await executeDeveloperToolsCommand(
      consumerContext(worktreeA, stateRoot, options),
      { runtime: { operations: fixtureOperations("pin-2") }, projectMcp: false },
    );
    expect(afterPinChange.changed).toBe(true);
    expect(afterPinChange.selection).toMatchObject({ source: "default", selected: developerTools });
    expect(JSON.parse(readFileSync(layoutA.runtimeReceiptPath, "utf8"))).toMatchObject({
      tools: { serena: { sourceDigest: sha("fixture-source:serena:pin-2") } },
    });
  });

  it("runs default developer-tool setup as part of one ordinary init journey", async () => {
    const root = consumerRoot();
    const stateRoot = consumerRoot();
    const calls: FixtureCall[] = [];
    const context = consumerContext(root, stateRoot, {
      acceptTokenOptimizerLicense: true,
      tokenOptimizerProfile: "balanced",
    });

    const result = await executeInitCommand(context, {
      developerTools: { runtime: { operations: fixtureOperations("pin-1", calls) } },
    });

    expect(result.capability).toBe("init");
    expect(calls).toEqual(reconciledTools.map((id) => ({ id, selected: true })));
    const layout = defaultNativeRuntimeLayout(context);
    expect(JSON.parse(readFileSync(layout.runtimeReceiptPath, "utf8"))).toMatchObject({
      canonicalRoot: realpathSync(root),
      tools: {
        serena: { sourceDigest: sha("fixture-source:serena:pin-1") },
      },
    });
    const projected = JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(Object.keys(projected.mcpServers)).toEqual(
      expect.arrayContaining([
        "code-review-graph",
        "codebase-memory-mcp",
        "serena",
        "context7",
        "playwright",
      ]),
    );
  });

  it("keeps a custom client entry while an explicit exclusion removes only unchanged owned material", async () => {
    const root = consumerRoot();
    const stateRoot = consumerRoot();
    const options = { acceptTokenOptimizerLicense: true };
    writePolicy(root, { selected: developerTools });
    writeFileSync(
      join(root, ".mcp.json"),
      `${JSON.stringify({
        mcpServers: {
          "operator-owned": { type: "stdio", command: "operator-tool", args: ["serve"] },
        },
      })}\n`,
    );

    const initialContext = consumerContext(root, stateRoot, options);
    const initial = await executeDeveloperToolsCommand(initialContext, {
      runtime: { operations: fixtureOperations("pin-1") },
    });
    expect(toolStates(initial)).toEqual(expectedStates(developerTools));
    const layout = defaultNativeRuntimeLayout(initialContext);
    const customState = join(layout.serenaStateRoot, "operator-owned.yml");
    mkdirSync(dirname(customState), { recursive: true });
    writeFileSync(customState, "operator owned\n");

    const selectedWithoutSerena = developerTools.filter((id) => id !== "serena");
    writePolicy(root, { selected: selectedWithoutSerena, excluded: ["serena"] });
    const exclusion = await executeDeveloperToolsCommand(
      consumerContext(root, stateRoot, options),
      {
        runtime: { operations: fixtureOperations("pin-1") },
      },
    );

    expect(exclusion.selection).toMatchObject({
      source: "explicit",
      selected: selectedWithoutSerena,
      excluded: ["serena"],
    });
    expect(toolStates(exclusion).serena).toBe("policy-excluded");
    expect(existsSync(fixtureOwnedPath(layout))).toBe(false);
    expect(readFileSync(customState, "utf8")).toBe("operator owned\n");
    const projected = JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(projected.mcpServers["operator-owned"]).toEqual({
      type: "stdio",
      command: "operator-tool",
      args: ["serve"],
    });
    expect(projected.mcpServers.serena).toBeUndefined();
  });

  it.each([
    {
      name: "a supplied subset",
      policy: { selected: ["serena", "context7"] },
      source: "explicit",
      selected: ["serena", "context7"],
    },
    {
      name: "an explicit empty selection",
      policy: { selected: [] },
      source: "explicit",
      selected: [],
    },
    {
      name: "a legacy unspecified policy",
      policy: undefined,
      source: "legacy-unspecified",
      selected: developerTools,
    },
  ])("provisions only the tools selected by $name", async ({ policy, source, selected }) => {
    const root = consumerRoot();
    const stateRoot = consumerRoot();
    const calls: FixtureCall[] = [];
    writePolicy(root, policy);

    const result = await executeDeveloperToolsCommand(
      consumerContext(root, stateRoot, { acceptTokenOptimizerLicense: true }),
      { runtime: { operations: fixtureOperations("pin-1", calls) }, projectMcp: false },
    );

    expect(result.selection).toMatchObject({ source, selected });
    expect(toolStates(result)).toEqual(expectedStates(selected));
    expect(calls.filter((call) => call.selected).map((call) => call.id)).toEqual(
      selected.filter((id) => id !== "headroom"),
    );
  });

  it("reports one blocked prerequisite while continuing the other selected tool setups", async () => {
    const root = consumerRoot();
    const stateRoot = consumerRoot();
    const calls: FixtureCall[] = [];
    const result = await executeDeveloperToolsCommand(
      consumerContext(root, stateRoot, { acceptTokenOptimizerLicense: true }),
      {
        runtime: {
          operations: fixtureOperations("pin-1", calls, "codebase-memory-mcp"),
        },
        projectMcp: false,
      },
    );

    expect(calls.map((call) => call.id)).toEqual(reconciledTools);
    expect(toolStates(result)).toEqual({
      "code-review-graph": "verified",
      "codebase-memory-mcp": "blocked",
      serena: "verified",
      "token-optimizer": "verified",
      context7: "verified",
      markitdown: "verified",
      playwright: "verified",
      headroom: "selected-pending",
    });
    expect(result.report?.ok).toBe(false);
  });
});

function headroomHost(context: PlanContext): void {
  const tools = join(context.env.HOME as string, "host-tools");
  mkdirSync(tools, { recursive: true });
  writeFileSync(join(tools, process.platform === "win32" ? "uv.exe" : "uv"), "fixture uv\n", {
    mode: 0o700,
  });
  context.env.PATH = tools;
}

function headroomDeps(context: PlanContext) {
  const layout = headroomLayout(context);
  return {
    run: fakeRunner((argv) => {
      if (argv.includes("sync")) {
        mkdirSync(layout.environment, { recursive: true });
        return { code: 0 };
      }
      if (argv.includes("-c")) return { code: 0, stdout: "aih-headroom-vocabularies-ready\n" };
      if (argv[2] === "headroom")
        return {
          code: 0,
          stdout: [
            { jsonrpc: "2.0", id: 1, result: { serverInfo: { name: "headroom" } } },
            {
              jsonrpc: "2.0",
              id: 2,
              result: { tools: HEADROOM_MCP_TOOL_NAMES.map((name) => ({ name })) },
            },
            {
              jsonrpc: "2.0",
              id: 3,
              result: { content: [{ type: "text", text: JSON.stringify({ compressions: 0 }) }] },
            },
          ]
            .map((line) => JSON.stringify(line))
            .join("\n"),
        };
      return { code: 127, stderr: `unexpected ${argv.join(" ")}` };
    }),
    platform: "linux" as const,
    arch: "x64",
    now: () => new Date("2026-09-23T12:00:00.000Z"),
    verifyVocabularies: () => undefined,
  };
}

function projectedServers(root: string): Record<string, unknown> {
  return (
    JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8")) as {
      mcpServers: Record<string, unknown>;
    }
  ).mcpServers;
}

describe("public Headroom activation", () => {
  it("refuses activation without egress consent before touching the consumer", () => {
    const root = consumerRoot();
    const before = snapshot(root);
    for (const args of [["--activate-headroom"], ["--activate-headroom", "--apply"]]) {
      const result = invoke(root, args);
      expect(result.status, result.stderr || result.stdout).not.toBe(0);
      expect(JSON.parse(result.stdout).error.message).toMatch(/--accept-headroom-egress/u);
    }
    expect(snapshot(root)).toEqual(before);
  });

  it("previews a consented activation without installing, registering or recording anything", () => {
    const root = consumerRoot();
    const before = snapshot(root);
    const result = invoke(root, ["--activate-headroom", "--accept-headroom-egress"]);
    expect(result.status, result.stderr || result.stdout).toBe(0);
    const payload = JSON.parse(result.stdout) as {
      tools: Array<{ id: string; state: string; detail: string }>;
    };
    expect(payload.tools.find((tool) => tool.id === "headroom")).toMatchObject({
      state: "selected-pending",
      detail: expect.stringMatching(/activation requested/u),
    });
    expect(snapshot(root)).toEqual(before);
  });

  it("rejects an unsupported or policy-conflicting primary code graph through the public CLI", () => {
    const root = consumerRoot();
    const unsupported = invoke(root, ["--primary-code-graph", "serena"]);
    expect(unsupported.status).not.toBe(0);
    expect(JSON.parse(unsupported.stdout).error.message).toMatch(/--primary-code-graph must be/u);
    writePolicy(root, { primaryCodeGraph: "codebase-memory-mcp" });
    const conflicting = invoke(root, ["--primary-code-graph", "code-review-graph"]);
    expect(conflicting.status).not.toBe(0);
    expect(JSON.parse(conflicting.stdout).error.message).toMatch(/policy sets/u);
    const matching = invoke(root, ["--primary-code-graph", "codebase-memory-mcp"]);
    expect(matching.status, matching.stderr || matching.stdout).toBe(0);
    expect(JSON.parse(matching.stdout).primaryCodeGraph).toEqual({
      id: "codebase-memory-mcp",
      source: "policy",
    });
  });

  it("registers the exact generated entry after consent and removes only AIH-owned material on deactivation", async () => {
    const root = consumerRoot();
    const stateRoot = consumerRoot();
    writeFileSync(
      join(root, ".mcp.json"),
      `${JSON.stringify({ mcpServers: { "operator-owned": { command: "operator-tool" } } })}\n`,
    );
    const options = {
      acceptTokenOptimizerLicense: true,
      activateHeadroom: true,
      acceptHeadroomEgress: true,
    };
    const activation = consumerContext(root, stateRoot, options);
    headroomHost(activation);
    const activated = await executeDeveloperToolsCommand(activation, {
      runtime: { operations: fixtureOperations("pin-1") },
      headroom: headroomDeps(activation),
    });
    expect(activated.tools.find((tool) => tool.id === "headroom")).toMatchObject({
      state: "verified",
    });
    const generated = mcpEntries("claude", { headroom: headroomMcpServer(activation) }).headroom;
    expect(projectedServers(root).headroom).toEqual(generated);
    expect(projectedServers(root)["operator-owned"]).toEqual({ command: "operator-tool" });
    const layout = headroomLayout(activation);
    expect(existsSync(layout.receiptPath)).toBe(true);

    const deactivation = consumerContext(root, stateRoot, { deactivateHeadroom: true });
    headroomHost(deactivation);
    const deactivated = await executeDeveloperToolsCommand(deactivation, {
      runtime: { operations: fixtureOperations("pin-1") },
      headroom: headroomDeps(deactivation),
    });
    expect(deactivated.tools.find((tool) => tool.id === "headroom")).toMatchObject({
      state: "selected-pending",
      changed: true,
    });
    expect(projectedServers(root).headroom).toBeUndefined();
    expect(projectedServers(root)["operator-owned"]).toEqual({ command: "operator-tool" });
    expect(existsSync(layout.stateRoot)).toBe(false);
  });

  it("preserves a user-edited Headroom entry while removing AIH-owned state", async () => {
    const root = consumerRoot();
    const stateRoot = consumerRoot();
    const activation = consumerContext(root, stateRoot, {
      activateHeadroom: true,
      acceptHeadroomEgress: true,
    });
    headroomHost(activation);
    await executeDeveloperToolsCommand(activation, {
      runtime: { operations: fixtureOperations("pin-1") },
      headroom: headroomDeps(activation),
    });
    const edited = JSON.parse(readFileSync(join(root, ".mcp.json"), "utf8"));
    edited.mcpServers.headroom.args = [...edited.mcpServers.headroom.args, "--user-flag"];
    writeFileSync(join(root, ".mcp.json"), `${JSON.stringify(edited, null, 2)}\n`);

    writePolicy(root, { excluded: ["headroom"] });
    const excluded = consumerContext(root, stateRoot);
    headroomHost(excluded);
    const result = await executeDeveloperToolsCommand(excluded, {
      runtime: { operations: fixtureOperations("pin-1") },
      headroom: headroomDeps(excluded),
    });
    expect(result.tools.find((tool) => tool.id === "headroom")).toMatchObject({
      state: "policy-excluded",
      changed: true,
    });
    expect(projectedServers(root).headroom).toEqual(edited.mcpServers.headroom);
    expect(existsSync(headroomLayout(excluded).stateRoot)).toBe(false);
  });

  it("removes an unchanged activation when policy excludes Headroom and refuses re-activation", async () => {
    const root = consumerRoot();
    const stateRoot = consumerRoot();
    const activation = consumerContext(root, stateRoot, {
      activateHeadroom: true,
      acceptHeadroomEgress: true,
    });
    headroomHost(activation);
    await executeDeveloperToolsCommand(activation, {
      runtime: { operations: fixtureOperations("pin-1") },
      headroom: headroomDeps(activation),
    });
    expect(projectedServers(root).headroom).toBeDefined();

    writePolicy(root, { excluded: ["headroom"] });
    const excluded = consumerContext(root, stateRoot);
    headroomHost(excluded);
    await executeDeveloperToolsCommand(excluded, {
      runtime: { operations: fixtureOperations("pin-1") },
      headroom: headroomDeps(excluded),
    });
    expect(projectedServers(root).headroom).toBeUndefined();
    expect(existsSync(headroomLayout(excluded).stateRoot)).toBe(false);

    const refused = consumerContext(root, stateRoot, {
      activateHeadroom: true,
      acceptHeadroomEgress: true,
    });
    headroomHost(refused);
    await expect(
      executeDeveloperToolsCommand(refused, { headroom: headroomDeps(refused) }),
    ).rejects.toThrow(/Headroom activation refused/u);
  });

  it("activates Headroom during an ordinary init journey and projects it afterwards", async () => {
    const root = consumerRoot();
    const stateRoot = consumerRoot();
    const context = consumerContext(root, stateRoot, {
      activateHeadroom: true,
      acceptHeadroomEgress: true,
      primaryCodeGraph: "codebase-memory-mcp",
    });
    headroomHost(context);
    const result = await executeInitCommand(context, {
      developerTools: {
        runtime: { operations: fixtureOperations("pin-1") },
        headroom: headroomDeps(context),
      },
    });
    expect(result.capability).toBe("init");
    expect(projectedServers(root).headroom).toEqual(
      mcpEntries("claude", { headroom: headroomMcpServer(context) }).headroom,
    );
    expect(
      readFileSync(join(root, "ai-coding", "rules", "agent-behavior-core.md"), "utf8"),
    ).toContain("Primary code graph: **codebase-memory-mcp**");
  });
});
