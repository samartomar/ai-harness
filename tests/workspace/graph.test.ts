import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executePlan } from "../../src/internals/execute.js";
import type { PlanContext, WriteAction } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import { type WorkspaceGraph, workspaceGraphCommand } from "../../src/workspace/graph.js";

let parent: string;
beforeEach(() => {
  parent = mkdtempSync(join(tmpdir(), "aih-ws-graph-"));
});
afterEach(() => {
  rmSync(parent, { recursive: true, force: true });
});

/**
 * A declared two-repo workspace (#505). The child repo paths are intentionally
 * NOT created on disk: the projection must come from declarations alone — no
 * child checkout, no indexing, no tool inference.
 */
const TWO_REPO_MANIFEST = {
  schemaVersion: 1,
  workspaceType: "multi-repo",
  contextDir: "ai-coding",
  repos: [
    { id: "ui", path: "ui", kind: "frontend", router: "ai-coding/RULE_ROUTER.md" },
    {
      id: "backend",
      path: "backend",
      kind: "api",
      owner: "platform",
      router: "ai-coding/RULE_ROUTER.md",
    },
  ],
  edges: [
    {
      id: "ui-consumes-backend-api",
      from: "ui",
      to: "backend",
      kind: "api-contract",
      contractPath: "backend/openapi.yaml",
      consumerPath: "ui/src/api",
    },
  ],
  generatedBy: "aih workspace",
};

function declareWorkspace(manifest: unknown = TWO_REPO_MANIFEST): void {
  writeFileSync(join(parent, ".aih-workspace.json"), JSON.stringify(manifest, null, 2), "utf8");
}

function makeCtx(
  options: Record<string, unknown> = {},
  apply = false,
  recorded: string[][] = [],
): PlanContext {
  const run = fakeRunner((argv) => {
    recorded.push([...argv]);
    return undefined;
  });
  return {
    root: parent,
    contextDir: "ai-coding",
    apply,
    verify: false,
    json: false,
    run,
    host: makeHostAdapter({ platform: "linux", run, env: {} }),
    env: {},
    options,
  };
}

function graphWrite(actions: readonly { kind: string }[]): WriteAction {
  const write = actions.find(
    (action): action is WriteAction =>
      action.kind === "write" &&
      (action as WriteAction).path.replace(/\\/g, "/") === ".aih/workspace-graph.json",
  );
  expect(write).toBeDefined();
  return write as WriteAction;
}

describe("workspace graph — declared contract edges become queryable graph edges (#505)", () => {
  it("projects a declared two-repo workspace into cross-repo edges from declarations alone", async () => {
    declareWorkspace();
    const recorded: string[][] = [];
    const ctx = makeCtx({}, false, recorded);

    const plan = await workspaceGraphCommand.plan(ctx);
    const artifact = graphWrite(plan.actions).json as WorkspaceGraph;

    // Deterministic, pure projection of the manifest — exact equality pins that
    // no timestamps, inference results, or ambient state leak into the artifact.
    expect(artifact).toEqual({
      schemaVersion: 1,
      source: ".aih-workspace.json",
      topology: "declared",
      generatedBy: "aih workspace graph",
      nodes: [
        { id: "ui", path: "ui", kind: "frontend", router: "ai-coding/RULE_ROUTER.md" },
        {
          id: "backend",
          path: "backend",
          kind: "api",
          owner: "platform",
          router: "ai-coding/RULE_ROUTER.md",
        },
      ],
      edges: [
        {
          id: "ui-consumes-backend-api",
          from: "ui",
          to: "backend",
          kind: "api-contract",
          contractPath: "backend/openapi.yaml",
          consumerPath: "ui/src/api",
          provenance: "declared",
        },
      ],
    });
    // No inference required: planning ran no external tool at all.
    expect(recorded).toEqual([]);
  });

  it("writes the queryable artifact and the .aih ignore block under --apply", async () => {
    declareWorkspace();
    const ctx = makeCtx({}, true);

    await executePlan(await workspaceGraphCommand.plan(ctx), ctx);

    const artifact = JSON.parse(
      readFileSync(join(parent, ".aih", "workspace-graph.json"), "utf8"),
    ) as WorkspaceGraph;
    expect(artifact.topology).toBe("declared");
    expect(artifact.edges.map((edge) => edge.id)).toEqual(["ui-consumes-backend-api"]);
    expect(artifact.edges[0]?.provenance).toBe("declared");
    expect(readFileSync(join(parent, ".gitignore"), "utf8")).toContain(".aih/*");
  });

  it("answers cross-repo edge queries from declarations via the digest", async () => {
    declareWorkspace();
    const ctx = makeCtx({ repo: "ui" });

    const result = await executePlan(await workspaceGraphCommand.plan(ctx), ctx);

    expect(result.digests).toHaveLength(1);
    const digest = result.digests[0];
    expect(digest?.describe).toBe("Workspace graph — 2 repos · 1 declared edge · 1 match");
    const data = digest?.data as {
      graph: WorkspaceGraph;
      query?: Record<string, string>;
      matches?: WorkspaceGraph["edges"];
    };
    expect(data.query).toEqual({ repo: "ui" });
    expect(data.matches?.map((edge) => edge.id)).toEqual(["ui-consumes-backend-api"]);
    expect(data.graph.edges).toHaveLength(1);
    // The queryable view states the declared-over-inferred posture.
    expect(digest?.text).toContain("Declared topology is the source of truth");
    expect(digest?.text).toContain("optional enrichment");
    expect(digest?.text).toContain("| ui-consumes-backend-api | ui | backend | api-contract |");
  });

  it("filters by from/to/kind and reports honest zero-match counts", async () => {
    declareWorkspace();

    const from = makeCtx({ from: "backend" });
    const fromResult = await executePlan(await workspaceGraphCommand.plan(from), from);
    expect(fromResult.digests[0]?.describe).toBe(
      "Workspace graph — 2 repos · 1 declared edge · 0 matches",
    );
    const fromData = fromResult.digests[0]?.data as { matches?: unknown[] } | undefined;
    expect(fromData?.matches).toEqual([]);
    expect(fromResult.digests[0]?.text).toContain("No declared edges match the query.");

    const kind = makeCtx({ to: "backend", kind: "api-contract" });
    const kindResult = await executePlan(await workspaceGraphCommand.plan(kind), kind);
    expect(kindResult.digests[0]?.describe).toBe(
      "Workspace graph — 2 repos · 1 declared edge · 1 match",
    );
    const kindData = kindResult.digests[0]?.data as { matches?: { id: string }[] } | undefined;
    expect(kindData?.matches?.map((edge) => edge.id)).toEqual(["ui-consumes-backend-api"]);
  });

  it("keeps an edge-less declared workspace honest and routes to `aih workspace link`", async () => {
    declareWorkspace({ ...TWO_REPO_MANIFEST, edges: [] });
    const ctx = makeCtx();

    const result = await executePlan(await workspaceGraphCommand.plan(ctx), ctx);

    expect(result.digests[0]?.describe).toBe("Workspace graph — 2 repos · 0 declared edges");
    expect(result.digests[0]?.text).toContain("aih workspace link");
    const artifact = graphWrite((await workspaceGraphCommand.plan(ctx)).actions)
      .json as WorkspaceGraph;
    expect(artifact.nodes).toHaveLength(2);
    expect(artifact.edges).toEqual([]);
  });

  it("requires a workspace manifest", async () => {
    const ctx = makeCtx();
    await expect(workspaceGraphCommand.plan(ctx)).rejects.toThrow(
      /workspace graph requires \.aih-workspace\.json/,
    );
  });

  it("rejects an unparseable or invalid manifest", async () => {
    declareWorkspace({ ...TWO_REPO_MANIFEST, repos: [{ path: "../escape" }] });
    const ctx = makeCtx();
    await expect(workspaceGraphCommand.plan(ctx)).rejects.toThrow(
      /workspace graph requires a valid \.aih-workspace\.json/,
    );
  });

  it("fails closed when a declared edge references an undeclared repo id", async () => {
    declareWorkspace({
      ...TWO_REPO_MANIFEST,
      edges: [{ id: "ui-ghost", from: "ui", to: "ghost", kind: "api-contract" }],
    });
    const ctx = makeCtx();
    await expect(workspaceGraphCommand.plan(ctx)).rejects.toThrow(/undeclared repo id: ghost/);
  });

  it("fails closed on a query for an undeclared repo id", async () => {
    declareWorkspace();
    for (const options of [{ repo: "ghost" }, { from: "ghost" }, { to: "ghost" }]) {
      const ctx = makeCtx(options);
      await expect(workspaceGraphCommand.plan(ctx)).rejects.toThrow(
        /does not match a declared repo id: ghost/,
      );
    }
  });

  it("rejects unprintable or empty query values instead of coercing them", async () => {
    declareWorkspace();
    const unprintable = makeCtx({ repo: `ui${String.fromCharCode(7)}` });
    await expect(workspaceGraphCommand.plan(unprintable)).rejects.toThrow(
      /safe to print in workspace reports/,
    );
    const empty = makeCtx({ kind: "   " });
    await expect(workspaceGraphCommand.plan(empty)).rejects.toThrow(/must be a non-empty string/);
  });
});
