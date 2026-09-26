import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PlanContext } from "../src/internals/plan.js";
import { fakeRunner, type RunOptions } from "../src/internals/proc.js";
import {
  defaultNativeMcpServers,
  defaultNativeRuntimeLayout,
} from "../src/mcp/default-native-runtime.js";
import { makeHostAdapter } from "../src/platform/detect.js";
import { scaleSafetyCheck } from "../src/scale-safety.js";
import { recordDeveloperToolPrimaryCodeGraph } from "../src/tools/developer-tools-runtime.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function toolText(value: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value };
}

function fixture(behaviour: { indexed?: boolean; failed?: boolean; nodes?: number } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "aih-scale-memory-project-")));
  const state = realpathSync(mkdtempSync(join(tmpdir(), "aih-scale-memory-state-")));
  roots.push(root, state);
  let indexed = behaviour.indexed ?? true;
  const calls: {
    argv: string[];
    tool?: string;
    args?: Record<string, unknown>;
    options?: RunOptions;
  }[] = [];
  const run = fakeRunner((argv, options) => {
    if (argv[0] === "git") return { code: 0, stdout: "sample.ts\n" };
    const requests = (options?.inputSequence ?? [])
      .map((step) => step.input)
      .join("")
      .split("\n")
      .filter(Boolean)
      .map(
        (line) =>
          JSON.parse(line) as {
            id?: number;
            method: string;
            params?: { name?: string; arguments?: Record<string, unknown> };
          },
      );
    const call = requests.find((request) => request.method === "tools/call");
    calls.push({ argv, tool: call?.params?.name, args: call?.params?.arguments, options });
    if (behaviour.failed) return { code: 1, stderr: "fixture memory runtime unavailable" };
    const name = call?.params?.name;
    let result: unknown;
    if (name === "list_projects") {
      result = toolText({
        projects: indexed ? [{ name: "fixture-project", root_path: root }] : [],
        total: indexed ? 1 : 0,
      });
    } else if (name === "index_repository") {
      indexed = true;
      result = toolText({ project: "fixture-project", nodes: 9, edges: 4, status: "indexed" });
    } else {
      result = toolText({
        project: "fixture-project",
        nodes: behaviour.nodes ?? 7,
        edges: 3,
        status: "ready",
        root_path: root,
      });
    }
    return {
      code: 0,
      stdout: [
        { jsonrpc: "2.0", id: 1, result: { serverInfo: { name: "codebase-memory-mcp" } } },
        {
          jsonrpc: "2.0",
          id: 2,
          result: {
            tools: ["index_repository", "list_projects", "index_status", "search_graph"].map(
              (tool) => ({ name: tool }),
            ),
          },
        },
        { jsonrpc: "2.0", id: 3, result },
      ]
        .map((line) => JSON.stringify(line))
        .join("\n"),
    };
  });
  const env = { XDG_STATE_HOME: state, HOME: state, PATH: process.env.PATH };
  const ctx: PlanContext = {
    root,
    contextDir: "ai-coding",
    apply: false,
    verify: true,
    json: false,
    run,
    env,
    host: makeHostAdapter({ platform: "linux", run, env }),
    options: {},
  };
  const server = defaultNativeMcpServers(ctx)["codebase-memory-mcp"];
  writeFileSync(
    join(root, ".mcp.json"),
    JSON.stringify({ mcpServers: { "codebase-memory-mcp": server } }),
  );
  recordDeveloperToolPrimaryCodeGraph(defaultNativeRuntimeLayout(ctx), {
    id: "codebase-memory-mcp",
    source: "user",
  });
  return { ctx, calls, server, root };
}

describe("scale safety with Codebase Memory as the primary code graph", () => {
  it("proves readiness through the managed launcher's populated index", async () => {
    const { ctx, calls, server } = fixture();
    const result = await scaleSafetyCheck(ctx, { requireGraph: true });
    expect(result.verdict).toBe("pass");
    expect(result.detail).toContain("codebase-memory-mcp");
    expect(result.detail).toContain("7 nodes");
    expect(calls.map((call) => call.tool)).toEqual(["list_projects", "index_status"]);
    // Memory 0.11.0 answers both with compact text unless JSON is requested.
    expect(calls.map((call) => call.args?.format)).toEqual(["json", "json"]);
    if (server?.type !== "stdio") throw new Error("fixture server is not stdio");
    expect(calls[0]?.argv).toEqual([server.command, ...server.args]);
  });

  it("indexes an unindexed project offline and then reports it populated", async () => {
    const { ctx, calls } = fixture({ indexed: false });
    const result = await scaleSafetyCheck(ctx, { requireGraph: true });
    expect(result.verdict).toBe("pass");
    expect(result.detail).toContain("indexed offline");
    expect(calls.map((call) => call.tool)).toEqual([
      "list_projects",
      "index_repository",
      "index_status",
    ]);
  });

  it("does not claim readiness for an empty index", async () => {
    const { ctx } = fixture({ nodes: 0 });
    const result = await scaleSafetyCheck(ctx, { requireGraph: true });
    expect(result.verdict).not.toBe("pass");
    expect(result.detail).toContain("empty");
  });

  it("reports a failed managed runtime without falling back to Code Review Graph", async () => {
    const { ctx, calls } = fixture({ failed: true });
    const result = await scaleSafetyCheck(ctx, { requireGraph: true });
    expect(result.verdict).not.toBe("pass");
    expect(result.detail).toContain("fixture memory runtime unavailable");
    expect(calls).toHaveLength(1);
  });

  it("rejects a stale managed registration without running it", async () => {
    const { ctx, calls, server, root } = fixture();
    if (server?.type !== "stdio") throw new Error("fixture server is not stdio");
    writeFileSync(
      join(root, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          "codebase-memory-mcp": { ...server, args: [...server.args.slice(0, -1), "elsewhere"] },
        },
      }),
    );
    const result = await scaleSafetyCheck(ctx, { requireGraph: true });
    expect(result.verdict).not.toBe("pass");
    expect(result.detail).toContain("managed Codebase Memory registration is stale");
    expect(calls).toHaveLength(0);
  });
});
