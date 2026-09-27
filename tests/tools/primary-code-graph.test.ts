import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PlanContext } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { defaultNativeRuntimeLayout } from "../../src/mcp/default-native-runtime.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import { resolveDefaultToolSelection } from "../../src/tools/default-tool-selection.js";
import {
  createDeveloperToolReconciler,
  readDeveloperToolPrimaryCodeGraph,
  recordDeveloperToolPrimaryCodeGraph,
} from "../../src/tools/developer-tools-runtime.js";
import {
  effectivePrimaryCodeGraph,
  resolvePrimaryCodeGraphChoice,
} from "../../src/tools/primary-code-graph.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function context(options: Record<string, unknown> = {}, policy?: unknown): PlanContext {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "aih-primary-graph-project-")));
  const state = realpathSync(mkdtempSync(join(tmpdir(), "aih-primary-graph-state-")));
  roots.push(root, state);
  if (policy !== undefined)
    writeFileSync(join(root, "aih-org-policy.json"), `${JSON.stringify(policy)}\n`);
  const run = fakeRunner(() => undefined);
  const env = { XDG_STATE_HOME: state, HOME: state, PATH: process.env.PATH };
  return {
    root,
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

function v3(developerTools: Record<string, unknown>) {
  return {
    schemaVersion: 3,
    minimumCoreVersion: "0.7.0",
    minimumPosture: "vibe",
    references: { repoContract: "ai-coding/project.json" },
    authoringSelections: {
      selectionVersion: "workbench-selection/v1",
      roots: [],
      exclusions: [],
      requests: [],
      drafts: [],
    },
    developerTools,
  };
}

const all = resolveDefaultToolSelection({ policy: { kind: "none" } });

describe("primary code-graph choice", () => {
  it("has no primary until someone chooses one, and accepts the user's choice otherwise", () => {
    expect(resolvePrimaryCodeGraphChoice(all, undefined, undefined)).toBeUndefined();
    expect(resolvePrimaryCodeGraphChoice(all, "codebase-memory-mcp", undefined)).toEqual({
      id: "codebase-memory-mcp",
      source: "user",
    });
    expect(
      resolvePrimaryCodeGraphChoice(all, undefined, { id: "code-review-graph", source: "user" }),
    ).toEqual({ id: "code-review-graph", source: "user" });
    // A recorded policy value is history, not a user choice.
    expect(
      resolvePrimaryCodeGraphChoice(all, undefined, { id: "code-review-graph", source: "policy" }),
    ).toBeUndefined();
  });

  it("binds the enterprise policy value and refuses a different user flag", () => {
    const policy = resolveDefaultToolSelection({
      policy: { kind: "bound", binding: "valid", primaryCodeGraph: "codebase-memory-mcp" },
    });
    expect(resolvePrimaryCodeGraphChoice(policy, undefined, undefined)).toEqual({
      id: "codebase-memory-mcp",
      source: "policy",
    });
    expect(resolvePrimaryCodeGraphChoice(policy, "codebase-memory-mcp", undefined)).toEqual({
      id: "codebase-memory-mcp",
      source: "policy",
    });
    expect(
      resolvePrimaryCodeGraphChoice(policy, undefined, { id: "code-review-graph", source: "user" }),
    ).toEqual({ id: "codebase-memory-mcp", source: "policy" });
    expect(() => resolvePrimaryCodeGraphChoice(policy, "code-review-graph", undefined)).toThrow(
      /policy sets developerTools\.primaryCodeGraph to codebase-memory-mcp/u,
    );
  });

  it("rejects an unsupported value and a primary the policy excludes", () => {
    expect(() => resolvePrimaryCodeGraphChoice(all, "serena", undefined)).toThrow(
      /--primary-code-graph must be code-review-graph or codebase-memory-mcp/u,
    );
    expect(() => resolvePrimaryCodeGraphChoice(all, true, undefined)).toThrow(/must be/u);
    const excluded = resolveDefaultToolSelection({
      policy: { kind: "bound", binding: "valid", excluded: ["codebase-memory-mcp"] },
    });
    expect(() => resolvePrimaryCodeGraphChoice(excluded, "codebase-memory-mcp", undefined)).toThrow(
      /excluded|does not select/u,
    );
    // A recorded choice that policy has since excluded is not carried forward.
    expect(
      resolvePrimaryCodeGraphChoice(excluded, undefined, {
        id: "codebase-memory-mcp",
        source: "user",
      }),
    ).toBeUndefined();
  });

  it("records the choice in the developer-tools receipt and keeps it across reconciliation", async () => {
    const ctx = context();
    const layout = defaultNativeRuntimeLayout(ctx);
    expect(readDeveloperToolPrimaryCodeGraph(layout)).toBeUndefined();
    expect(
      recordDeveloperToolPrimaryCodeGraph(layout, { id: "codebase-memory-mcp", source: "user" }),
    ).toBe(true);
    expect(
      recordDeveloperToolPrimaryCodeGraph(layout, { id: "codebase-memory-mcp", source: "user" }),
    ).toBe(false);
    expect(JSON.parse(readFileSync(layout.runtimeReceiptPath, "utf8"))).toMatchObject({
      version: "aih-developer-tools-receipt/v1",
      primaryCodeGraph: { id: "codebase-memory-mcp", source: "user" },
      tools: {},
    });
    const reconcile = createDeveloperToolReconciler(ctx, {
      operations: {
        context7: async () => ({
          state: "verified",
          detail: "fixture",
          sourceDigest: "a".repeat(64),
          ownedPaths: [],
          changed: false,
        }),
      },
    });
    await reconcile({
      id: "context7",
      ctx,
      selected: true,
      acceptTokenOptimizerLicense: false,
      tokenOptimizerProfile: "quiet",
    });
    expect(readDeveloperToolPrimaryCodeGraph(layout)).toEqual({
      id: "codebase-memory-mcp",
      source: "user",
    });
    expect(recordDeveloperToolPrimaryCodeGraph(layout, undefined)).toBe(true);
    expect(JSON.parse(readFileSync(layout.runtimeReceiptPath, "utf8"))).not.toHaveProperty(
      "primaryCodeGraph",
    );
  });

  it("rejects a malformed recorded primary", () => {
    const ctx = context();
    const layout = defaultNativeRuntimeLayout(ctx);
    mkdirSync(layout.projectStateRoot, { recursive: true });
    writeFileSync(
      layout.runtimeReceiptPath,
      `${JSON.stringify({
        version: "aih-developer-tools-receipt/v1",
        canonicalRoot: layout.project,
        primaryCodeGraph: { id: "serena", source: "user" },
        tools: {},
      })}\n`,
    );
    expect(() => readDeveloperToolPrimaryCodeGraph(layout)).toThrow(/primary code graph/u);
  });

  it("resolves the effective primary from policy, flag and the recorded choice", () => {
    const flagged = context({ primaryCodeGraph: "codebase-memory-mcp" });
    expect(effectivePrimaryCodeGraph(flagged)).toEqual({
      id: "codebase-memory-mcp",
      source: "user",
    });
    const recorded = context();
    recordDeveloperToolPrimaryCodeGraph(defaultNativeRuntimeLayout(recorded), {
      id: "code-review-graph",
      source: "user",
    });
    expect(effectivePrimaryCodeGraph(recorded)).toEqual({
      id: "code-review-graph",
      source: "user",
    });
    const governed = context({}, v3({ primaryCodeGraph: "code-review-graph" }));
    expect(effectivePrimaryCodeGraph(governed)).toEqual({
      id: "code-review-graph",
      source: "policy",
    });
    expect(effectivePrimaryCodeGraph(context())).toBeUndefined();
  });
});
