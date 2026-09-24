import {
  chmodSync,
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
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Cli } from "../../src/internals/clis.js";
import { executePlan } from "../../src/internals/execute.js";
import { digest, type PlanContext, plan } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { defaultNativeRuntimeLayout } from "../../src/mcp/default-native-runtime.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import {
  type DeveloperToolLifecycleResult,
  executeDeveloperToolsCommand,
} from "../../src/tools/developer-tools-command.js";
import { HEADROOM_MCP_TOOL_NAMES, headroomLayout } from "../../src/tools/headroom.js";
import { readHeadroomReceipt } from "../../src/tools/headroom-receipt.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function context(
  options: { apply?: boolean; policy?: unknown; commandOptions?: Record<string, unknown> } = {},
): PlanContext {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "aih-developer-tools-command-")));
  const state = realpathSync(mkdtempSync(join(tmpdir(), "aih-developer-tools-state-")));
  roots.push(root, state);
  if (options.policy !== undefined) {
    writeFileSync(join(root, "aih-org-policy.json"), `${JSON.stringify(options.policy)}\n`);
  }
  const run = fakeRunner(() => undefined);
  const env = { XDG_STATE_HOME: state, HOME: state, PATH: process.env.PATH };
  return {
    root,
    contextDir: "ai-coding",
    apply: options.apply ?? false,
    verify: false,
    json: true,
    run,
    env,
    host: makeHostAdapter({ platform: "linux", run, env }),
    options: options.commandOptions ?? {},
  };
}

function v3Policy(developerTools?: unknown, minimumCoreVersion = "0.6.0"): unknown {
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
    ...(developerTools === undefined ? {} : { developerTools }),
  };
}

describe("developer-tools command", () => {
  it("returns eight no-policy defaults as selected-pending without side effects", async () => {
    const reconcileTool = vi.fn();

    const result = await executeDeveloperToolsCommand(context(), {
      reconcileTool,
      projectMcp: false,
    });

    expect(reconcileTool).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      capability: "developer-tools",
      applied: false,
      accepted: true,
      selection: {
        source: "default",
        selected: [
          "code-review-graph",
          "codebase-memory-mcp",
          "serena",
          "token-optimizer",
          "context7",
          "markitdown",
          "playwright",
          "headroom",
        ],
        excluded: [],
      },
      tools: [
        { id: "code-review-graph", state: "selected-pending" },
        { id: "codebase-memory-mcp", state: "selected-pending" },
        { id: "serena", state: "selected-pending" },
        { id: "token-optimizer", state: "selected-pending" },
        { id: "context7", state: "selected-pending" },
        { id: "markitdown", state: "selected-pending" },
        { id: "playwright", state: "selected-pending" },
        { id: "headroom", state: "selected-pending" },
      ],
      changed: false,
    });
  });

  it("keeps selected Headroom pending on apply until it is explicitly activated", async () => {
    const visited: string[] = [];
    const reconcileTool = vi.fn(async ({ id }): Promise<DeveloperToolLifecycleResult> => {
      visited.push(id);
      return { id, state: "verified", detail: "fixture verified", changed: false };
    });
    const result = await executeDeveloperToolsCommand(context({ apply: true }), {
      reconcileTool,
      projectMcp: false,
    });
    expect(visited).not.toContain("headroom");
    expect(result.tools.find((tool) => tool.id === "headroom")).toMatchObject({
      state: "selected-pending",
      changed: false,
      detail: expect.stringMatching(/--activate-headroom --accept-headroom-egress/u),
    });
    expect(
      result.report?.checks.find((check) => check.name === "headroom developer tool"),
    ).toMatchObject({
      verdict: "skip",
      detail: expect.stringMatching(/not activated/u),
    });
    expect(result.report?.ok).toBe(true);
  });

  it("preserves an explicit empty selection as policy-excluded", async () => {
    const result = await executeDeveloperToolsCommand(
      context({ policy: v3Policy({ selected: [] }) }),
      { projectMcp: false },
    );

    expect(result.selection).toMatchObject({ source: "explicit", selected: [], excluded: [] });
    expect(result.tools.every((tool) => tool.state === "policy-excluded")).toBe(true);
  });

  it("continues independent apply work after one prerequisite blocks", async () => {
    const visited: string[] = [];
    const reconcileTool = vi.fn(async ({ id }): Promise<DeveloperToolLifecycleResult> => {
      visited.push(id);
      if (id === "codebase-memory-mcp") throw new Error("archive unavailable");
      return { id, state: "verified", detail: `${id} exercised`, changed: true };
    });

    const result = await executeDeveloperToolsCommand(context({ apply: true }), {
      reconcileTool,
      projectMcp: false,
    });

    expect(visited).toEqual([
      "code-review-graph",
      "codebase-memory-mcp",
      "serena",
      "token-optimizer",
      "context7",
      "markitdown",
      "playwright",
    ]);
    expect(result.tools.find((tool) => tool.id === "codebase-memory-mcp")).toMatchObject({
      state: "blocked",
      detail: "archive unavailable",
    });
    expect(result.tools.filter((tool) => tool.state === "verified")).toHaveLength(6);
    expect(result.report?.ok).toBe(false);
    expect(
      result.report?.checks.find((check) => check.name === "codebase-memory-mcp developer tool"),
    ).toMatchObject({
      code: "developer-tools.runtime-verification",
      detail: "archive unavailable",
    });
    expect(result.changed).toBe(true);
  });

  it("reports an unavailable Playwright browser engine as blocked", async () => {
    const reconcileTool = vi.fn(async ({ id }): Promise<DeveloperToolLifecycleResult> => {
      if (id === "playwright") {
        throw new Error(
          "Playwright browser_navigate returned an MCP tool error — browser executable is unavailable",
        );
      }
      return { id, state: "verified", detail: `${id} exercised`, changed: false };
    });

    const result = await executeDeveloperToolsCommand(context({ apply: true }), {
      reconcileTool,
      projectMcp: false,
    });

    expect(result.tools.find((tool) => tool.id === "playwright")).toMatchObject({
      state: "blocked",
      detail: expect.stringContaining("browser executable is unavailable"),
      changed: false,
    });
    expect(result.report?.ok).toBe(false);
  });

  it("contains a reconciler response that claims a different tool identity", async () => {
    const visited: string[] = [];
    const reconcileTool = vi.fn(async ({ id }): Promise<DeveloperToolLifecycleResult> => {
      visited.push(id);
      return {
        id: id === "serena" ? "context7" : id,
        state: "verified",
        detail: `${id} fixture verified`,
        changed: false,
      };
    });

    const result = await executeDeveloperToolsCommand(context({ apply: true }), {
      reconcileTool,
      projectMcp: false,
    });

    expect(visited).toEqual([
      "code-review-graph",
      "codebase-memory-mcp",
      "serena",
      "token-optimizer",
      "context7",
      "markitdown",
      "playwright",
    ]);
    expect(result.tools.find((tool) => tool.id === "serena")).toMatchObject({
      state: "blocked",
      detail: "developer-tool reconciler returned a different id",
    });
    expect(result.tools.find((tool) => tool.id === "context7")).toMatchObject({
      state: "verified",
    });
    expect(result.report?.ok).toBe(false);
  });

  it.skipIf(process.platform === "win32")(
    "contains an unusable Memory runtime directory to Memory while siblings still reconcile",
    async () => {
      const ctx = context({ apply: true });
      ctx.env.XDG_RUNTIME_DIR = `/run/${"overlong".repeat(20)}`;
      writeFileSync(join(ctx.root, "main.ts"), "export const runtimeBoundary = true;\n");
      const visited: string[] = [];
      const siblingOperation = async ({ id }: { id: string }) => {
        visited.push(id);
        return {
          state: "verified" as const,
          detail: `${id} verified`,
          sourceDigest: "a".repeat(64),
          ownedPaths: [],
          changed: false,
        };
      };

      const result = await executeDeveloperToolsCommand(ctx, {
        projectMcp: false,
        runtime: {
          operations: {
            "code-review-graph": siblingOperation,
            serena: siblingOperation,
            "token-optimizer": siblingOperation,
            context7: siblingOperation,
            markitdown: siblingOperation,
            playwright: siblingOperation,
          },
          production: {
            acquireMemory: async () => ({
              path: join(ctx.root, "unused-memory-runtime"),
              sha256: "b".repeat(64),
              size: 1,
              version: "0.10.8",
              changed: false,
              reused: true,
              archiveName: "fixture.zip",
            }),
            run: fakeRunner((argv) =>
              argv.includes("codebase-memory-mcp")
                ? {
                    code: 1,
                    stderr:
                      "Memory coordination root exceeds the native socket path limit; set XDG_RUNTIME_DIR to a shorter private user runtime directory",
                  }
                : undefined,
            ),
          },
        },
      });

      expect(visited).toEqual([
        "code-review-graph",
        "serena",
        "token-optimizer",
        "context7",
        "markitdown",
        "playwright",
      ]);
      expect(result.tools.find((tool) => tool.id === "codebase-memory-mcp")).toMatchObject({
        state: "blocked",
        detail: expect.stringContaining("XDG_RUNTIME_DIR"),
      });
      expect(result.tools.filter((tool) => tool.state === "verified")).toHaveLength(6);
    },
  );

  it("invokes reconciliation with selected false so exclusions can remove owned integration", async () => {
    const calls: Array<{ id: string; selected: boolean }> = [];
    const reconcileTool = vi.fn(async ({ id, selected }): Promise<DeveloperToolLifecycleResult> => {
      calls.push({ id, selected });
      return {
        id,
        state: selected ? "verified" : "policy-excluded",
        detail: selected ? "verified" : "owned integration ceased",
        changed: !selected,
      };
    });

    const result = await executeDeveloperToolsCommand(
      context({ apply: true, policy: v3Policy({ selected: ["serena"] }) }),
      { reconcileTool, projectMcp: false },
    );

    expect(calls).toEqual([
      { id: "code-review-graph", selected: false },
      { id: "codebase-memory-mcp", selected: false },
      { id: "serena", selected: true },
      { id: "token-optimizer", selected: false },
      { id: "context7", selected: false },
      { id: "markitdown", selected: false },
      { id: "playwright", selected: false },
    ]);
    expect(result.tools.find((tool) => tool.id === "code-review-graph")?.state).toBe(
      "policy-excluded",
    );
  });

  it("rejects an invalid profile before starting apply work", async () => {
    const reconcileTool = vi.fn();
    await expect(
      executeDeveloperToolsCommand(
        context({ apply: true, commandOptions: { tokenOptimizerProfile: "loud" } }),
        { reconcileTool, projectMcp: false },
      ),
    ).rejects.toThrow("--token-optimizer-profile must be quiet or balanced");
    expect(reconcileTool).not.toHaveBeenCalled();
  });
});

function headroomScope(
  options: {
    policy?: unknown;
    commandOptions?: Record<string, unknown>;
    launcherCode?: number;
  } = {},
) {
  const ctx = context({
    apply: true,
    policy: options.policy,
    commandOptions: options.commandOptions ?? {},
  });
  const tools = join(ctx.env.HOME as string, "host-tools");
  mkdirSync(tools, { recursive: true });
  const uv = join(tools, process.platform === "win32" ? "uv.exe" : "uv");
  writeFileSync(uv, "fixture uv\n");
  if (process.platform !== "win32") chmodSync(uv, 0o700);
  ctx.env.PATH = tools;
  const layout = headroomLayout(ctx);
  const calls: string[][] = [];
  let launcherCode = options.launcherCode ?? 0;
  const run = fakeRunner((argv) => {
    calls.push(argv);
    if (argv.includes("sync")) {
      mkdirSync(layout.environment, { recursive: true });
      return { code: 0 };
    }
    if (argv.includes("-c")) return { code: 0, stdout: "aih-headroom-vocabularies-ready\n" };
    if (argv[2] === "headroom")
      return {
        code: launcherCode,
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
    return { code: 127, stderr: "unexpected" };
  });
  const receiptSeenByProjection: boolean[] = [];
  const deps = {
    reconcileTool: vi.fn(
      async ({ id, selected }): Promise<DeveloperToolLifecycleResult> => ({
        id,
        state: selected ? "verified" : "policy-excluded",
        detail: "fixture",
        changed: false,
      }),
    ),
    projectMcp: vi.fn(async (projectionCtx: PlanContext) => {
      receiptSeenByProjection.push(existsSync(layout.receiptPath));
      return executePlan(
        plan(
          "projection fixture",
          digest("fixture", "fixture", { options: projectionCtx.options }),
        ),
        projectionCtx,
      );
    }),
    headroom: {
      run,
      platform: "linux" as const,
      arch: "x64",
      now: () => new Date("2026-09-23T12:00:00.000Z"),
      verifyVocabularies: () => undefined,
    },
  };
  return {
    ctx,
    layout,
    calls,
    deps,
    receiptSeenByProjection,
    failLauncher: () => {
      launcherCode = 1;
    },
  };
}

function headroomTool(result: { tools: DeveloperToolLifecycleResult[] }) {
  return result.tools.find((tool) => tool.id === "headroom");
}

describe("developer-tools Headroom lifecycle", () => {
  it.each([
    [{ activateHeadroom: true }, /requires --accept-headroom-egress/u],
    [{ acceptHeadroomEgress: true }, /only valid with --activate-headroom/u],
    [
      { activateHeadroom: true, acceptHeadroomEgress: true, deactivateHeadroom: true },
      /cannot be combined/u,
    ],
  ])("refuses %o before any tool work", async (commandOptions, message) => {
    for (const apply of [false, true]) {
      const scope = headroomScope({ commandOptions });
      await expect(
        executeDeveloperToolsCommand({ ...scope.ctx, apply }, scope.deps),
      ).rejects.toThrow(message);
      expect(scope.deps.reconcileTool).not.toHaveBeenCalled();
      expect(scope.calls).toHaveLength(0);
      expect(existsSync(scope.layout.stateRoot)).toBe(false);
    }
  });

  it.each([
    ["excludes Headroom", v3Policy({ excluded: ["headroom"] }, "0.7.0"), /not selected|excluded/u],
    [
      "disables its MCP server",
      {
        ...(v3Policy(undefined, "0.7.0") as object),
        mcp: { disabledServers: ["headroom"] },
      },
      /disabled/u,
    ],
  ])("refuses activation when the policy %s", async (_label, policy, message) => {
    const scope = headroomScope({
      policy,
      commandOptions: { activateHeadroom: true, acceptHeadroomEgress: true },
    });
    await expect(executeDeveloperToolsCommand(scope.ctx, scope.deps)).rejects.toThrow(message);
    expect(scope.calls).toHaveLength(0);
    expect(existsSync(scope.layout.stateRoot)).toBe(false);
  });

  it("previews an activation request without installing anything", async () => {
    const scope = headroomScope({
      commandOptions: { activateHeadroom: true, acceptHeadroomEgress: true },
    });
    const result = await executeDeveloperToolsCommand({ ...scope.ctx, apply: false }, scope.deps);
    expect(headroomTool(result)).toMatchObject({
      state: "selected-pending",
      detail: expect.stringMatching(/--apply/u),
      changed: false,
    });
    expect(scope.calls).toHaveLength(0);
    expect(existsSync(scope.layout.stateRoot)).toBe(false);
  });

  it("activates, registers after the receipt exists, re-verifies, then deactivates cleanly", async () => {
    const scope = headroomScope({
      commandOptions: { activateHeadroom: true, acceptHeadroomEgress: true },
    });
    const activated = await executeDeveloperToolsCommand(scope.ctx, scope.deps);
    expect(headroomTool(activated)).toMatchObject({ state: "verified", changed: true });
    expect(
      activated.report?.checks.find((check) => check.name === "headroom developer tool"),
    ).toMatchObject({ verdict: "pass" });
    expect(scope.receiptSeenByProjection).toEqual([true]);
    expect(existsSync(scope.layout.receiptPath)).toBe(true);

    scope.calls.length = 0;
    const ordinary = await executeDeveloperToolsCommand({ ...scope.ctx, options: {} }, scope.deps);
    expect(headroomTool(ordinary)).toMatchObject({ state: "verified", changed: false });
    expect(scope.calls.map((argv) => argv[2] === "headroom")).toEqual([true]);

    const deactivated = await executeDeveloperToolsCommand(
      { ...scope.ctx, options: { deactivateHeadroom: true } },
      scope.deps,
    );
    expect(headroomTool(deactivated)).toMatchObject({
      state: "selected-pending",
      changed: true,
      detail: expect.stringMatching(/removed/u),
    });
    // The projection ran while the receipt still named the entry to remove.
    expect(scope.receiptSeenByProjection.at(-1)).toBe(true);
    expect(existsSync(scope.layout.stateRoot)).toBe(false);
  });

  it("removes an active install when the policy later excludes Headroom", async () => {
    const scope = headroomScope({
      commandOptions: { activateHeadroom: true, acceptHeadroomEgress: true },
    });
    await executeDeveloperToolsCommand(scope.ctx, scope.deps);
    writeFileSync(
      join(scope.ctx.root, "aih-org-policy.json"),
      `${JSON.stringify(v3Policy({ excluded: ["headroom"] }, "0.7.0"))}\n`,
    );
    const excluded = await executeDeveloperToolsCommand({ ...scope.ctx, options: {} }, scope.deps);
    expect(headroomTool(excluded)).toMatchObject({ state: "policy-excluded", changed: true });
    expect(existsSync(scope.layout.stateRoot)).toBe(false);
  });

  it("refuses to discard a user-edited Codex Headroom table and records the incomplete host", async () => {
    const scope = headroomScope({
      commandOptions: { activateHeadroom: true, acceptHeadroomEgress: true },
    });
    const deps = { ...scope.deps, projectMcp: undefined };
    const codex = { ...scope.ctx, targets: ["codex"] as Cli[] };
    const codexConfig = join(scope.ctx.env.HOME as string, ".codex", "config.toml");
    await executeDeveloperToolsCommand(codex, deps);
    const generated = readFileSync(codexConfig, "utf8");
    expect(generated).toContain('[mcp_servers."headroom"]');
    const edited = generated.replace(
      '[mcp_servers."headroom"]',
      '[mcp_servers."headroom"]\nstartup_timeout_sec = 45',
    );
    writeFileSync(codexConfig, edited);

    const refused = await executeDeveloperToolsCommand(
      { ...codex, options: { deactivateHeadroom: true } },
      deps,
    );
    expect(headroomTool(refused)).toMatchObject({
      state: "blocked",
      changed: false,
      detail: expect.stringMatching(
        /codex[\s\S]*config\.toml[\s\S]*edited[\s\S]*--deactivate-headroom/u,
      ),
    });
    expect(refused.report?.ok).toBe(false);
    expect(readFileSync(codexConfig, "utf8")).toContain("startup_timeout_sec = 45");
    const recorded = readHeadroomReceipt(scope.layout);
    expect(recorded.state).toBe("valid");
    expect(recorded.state === "valid" && recorded.receipt.deactivation).toMatchObject({
      incompleteHosts: [{ host: "codex", reason: expect.stringMatching(/edited/u) }],
    });
    expect(existsSync(scope.layout.environment)).toBe(true);

    // An ordinary run neither re-registers Headroom nor reports it active.
    const ordinary = await executeDeveloperToolsCommand({ ...codex, options: {} }, deps);
    expect(headroomTool(ordinary)).toMatchObject({
      state: "blocked",
      detail: expect.stringMatching(/deactivation is incomplete/u),
    });
    expect(readFileSync(codexConfig, "utf8")).toContain("startup_timeout_sec = 45");

    // Restoring AIH's bytes lets the removal finish.
    writeFileSync(codexConfig, generated);
    const finished = await executeDeveloperToolsCommand(
      { ...codex, options: { deactivateHeadroom: true } },
      deps,
    );
    expect(headroomTool(finished)).toMatchObject({ state: "selected-pending", changed: true });
    expect(readFileSync(codexConfig, "utf8")).not.toContain("headroom");
    expect(existsSync(scope.layout.stateRoot)).toBe(false);
  });

  it("reports a failed health check as blocked without deactivating", async () => {
    const scope = headroomScope({
      commandOptions: { activateHeadroom: true, acceptHeadroomEgress: true },
    });
    await executeDeveloperToolsCommand(scope.ctx, scope.deps);
    scope.failLauncher();
    const result = await executeDeveloperToolsCommand({ ...scope.ctx, options: {} }, scope.deps);
    expect(headroomTool(result)?.state).toBe("blocked");
    expect(result.report?.ok).toBe(false);
    expect(existsSync(scope.layout.receiptPath)).toBe(true);
  });
});

describe("developer-tools primary code graph", () => {
  it("records the user's choice on apply and only reports it in preview", async () => {
    const preview = headroomScope({ commandOptions: { primaryCodeGraph: "codebase-memory-mcp" } });
    const previewed = await executeDeveloperToolsCommand(
      { ...preview.ctx, apply: false },
      preview.deps,
    );
    expect(previewed.primaryCodeGraph).toEqual({ id: "codebase-memory-mcp", source: "user" });
    expect(existsSync(defaultNativeRuntimeLayout(preview.ctx).runtimeReceiptPath)).toBe(false);

    const scope = headroomScope({ commandOptions: { primaryCodeGraph: "codebase-memory-mcp" } });
    const applied = await executeDeveloperToolsCommand(scope.ctx, scope.deps);
    expect(applied.primaryCodeGraph).toEqual({ id: "codebase-memory-mcp", source: "user" });
    expect(applied.changed).toBe(true);
    const receipt = JSON.parse(
      readFileSync(defaultNativeRuntimeLayout(scope.ctx).runtimeReceiptPath, "utf8"),
    );
    expect(receipt.primaryCodeGraph).toEqual({ id: "codebase-memory-mcp", source: "user" });

    const switched = await executeDeveloperToolsCommand(
      { ...scope.ctx, options: { primaryCodeGraph: "code-review-graph" } },
      scope.deps,
    );
    expect(switched.primaryCodeGraph).toEqual({ id: "code-review-graph", source: "user" });
    const kept = await executeDeveloperToolsCommand({ ...scope.ctx, options: {} }, scope.deps);
    expect(kept.primaryCodeGraph).toEqual({ id: "code-review-graph", source: "user" });
  });

  it.each([
    [
      { primaryCodeGraph: "serena" },
      undefined,
      /must be code-review-graph or codebase-memory-mcp/u,
    ],
    [
      { primaryCodeGraph: "codebase-memory-mcp" },
      v3Policy({ excluded: ["codebase-memory-mcp"] }),
      /excluded/u,
    ],
    [
      { primaryCodeGraph: "code-review-graph" },
      v3Policy({ primaryCodeGraph: "codebase-memory-mcp" }, "0.7.0"),
      /policy sets developerTools\.primaryCodeGraph/u,
    ],
  ])("refuses %o under the given policy", async (commandOptions, policy, message) => {
    const scope = headroomScope({ commandOptions, policy });
    await expect(executeDeveloperToolsCommand(scope.ctx, scope.deps)).rejects.toThrow(message);
    expect(scope.deps.reconcileTool).not.toHaveBeenCalled();
  });

  it("applies an enterprise primary without a flag", async () => {
    const scope = headroomScope({
      policy: v3Policy({ primaryCodeGraph: "codebase-memory-mcp" }, "0.7.0"),
    });
    const result = await executeDeveloperToolsCommand(scope.ctx, scope.deps);
    expect(result.primaryCodeGraph).toEqual({ id: "codebase-memory-mcp", source: "policy" });
  });
});
