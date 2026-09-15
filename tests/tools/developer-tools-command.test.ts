import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PlanContext } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import {
  type DeveloperToolLifecycleResult,
  executeDeveloperToolsCommand,
} from "../../src/tools/developer-tools-command.js";

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

function v3Policy(developerTools?: unknown): unknown {
  return {
    schemaVersion: 3,
    minimumCoreVersion: "0.6.0",
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
  it("returns the six no-policy defaults as selected-pending without side effects", async () => {
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
      ],
      changed: false,
    });
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
    ]);
    expect(result.tools.find((tool) => tool.id === "codebase-memory-mcp")).toMatchObject({
      state: "blocked",
      detail: "archive unavailable",
    });
    expect(result.tools.filter((tool) => tool.state === "verified")).toHaveLength(5);
    expect(result.report?.ok).toBe(false);
    expect(
      result.report?.checks.find((check) => check.name === "codebase-memory-mcp developer tool"),
    ).toMatchObject({
      code: "developer-tools.runtime-verification",
      detail: "archive unavailable",
    });
    expect(result.changed).toBe(true);
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
      ]);
      expect(result.tools.find((tool) => tool.id === "codebase-memory-mcp")).toMatchObject({
        state: "blocked",
        detail: expect.stringContaining("XDG_RUNTIME_DIR"),
      });
      expect(result.tools.filter((tool) => tool.state === "verified")).toHaveLength(4);
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
