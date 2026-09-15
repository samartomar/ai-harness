import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SERENA_ALLOWED_TOOLS } from "../../src/ecc-profile/mcp-profile.js";
import { renderSerenaRuntimeConfig } from "../../src/ecc-profile/serena-runtime-config.js";
import type { PlanContext } from "../../src/internals/plan.js";
import { defaultRunner, type Runner, type RunOptions } from "../../src/internals/proc.js";
import { defaultNativeRuntimeLayout } from "../../src/mcp/default-native-runtime.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import {
  createDefaultDeveloperToolRuntimeOperations,
  verifyContext7DocumentationOperation,
} from "../../src/tools/developer-tools-operations.js";

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(run: Runner): PlanContext {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "aih-developer-operations-project-")));
  const state = realpathSync(mkdtempSync(join(tmpdir(), "aih-developer-operations-state-")));
  roots.push(root, state);
  writeFileSync(join(root, "main.ts"), "export const answer = 42;\n");
  const tools = join(state, "tools");
  mkdirSync(tools);
  const uv = join(tools, process.platform === "win32" ? "uv.exe" : "uv");
  writeFileSync(uv, "fixture uv", { mode: 0o755 });
  const env: NodeJS.ProcessEnv = {
    PATH: tools,
    HOME: state,
    USERPROFILE: state,
    LOCALAPPDATA: state,
    XDG_STATE_HOME: state,
  };
  return {
    root,
    contextDir: "ai-coding",
    apply: true,
    verify: false,
    json: true,
    run,
    env,
    host: makeHostAdapter({
      platform: process.platform === "win32" ? "windows" : "linux",
      run,
      env,
    }),
    options: { acceptTokenOptimizerLicense: true, tokenOptimizerProfile: "quiet" },
  };
}

function input(
  ctx: PlanContext,
  id: "code-review-graph" | "codebase-memory-mcp" | "context7" | "serena" | "token-optimizer",
) {
  return {
    id,
    ctx,
    selected: true,
    acceptTokenOptimizerLicense: true,
    tokenOptimizerProfile: "quiet" as const,
    layout: defaultNativeRuntimeLayout(ctx),
  };
}

function generatedMcpOutput(
  input: string | undefined,
  tools: readonly string[],
  callResult: (request: Record<string, unknown>) => Record<string, unknown>,
): string {
  return (input ?? "")
    .trim()
    .split(/\r?\n/u)
    .filter(Boolean)
    .flatMap((line) => {
      const request = JSON.parse(line) as Record<string, unknown>;
      if (typeof request.id !== "number") return [];
      const result =
        request.method === "initialize"
          ? { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "fixture" } }
          : request.method === "tools/list"
            ? { tools: tools.map((name) => ({ name })) }
            : callResult(request);
      return [JSON.stringify({ jsonrpc: "2.0", id: request.id, result })];
    })
    .join("\n");
}

function processInput(options: RunOptions | undefined): string | undefined {
  return options?.input ?? options?.inputSequence?.map((step) => step.input).join("");
}

function writeOrgPolicy(ctx: PlanContext, mcp: Record<string, unknown>): void {
  writeFileSync(
    join(ctx.root, "aih-org-policy.json"),
    `${JSON.stringify({
      schemaVersion: 2,
      minimumPosture: "enterprise",
      references: { repoContract: "ai-coding/project.json" },
      governance: {
        supportedClis: [
          "claude",
          "codex",
          "cursor",
          "antigravity",
          "gemini",
          "copilot",
          "windsurf",
          "opencode",
          "zed",
          "kimi",
          "kiro",
        ],
      },
      mcp,
    })}\n`,
  );
}

function memoryPayload(ctx: PlanContext, changed = false) {
  const path = join(ctx.env.LOCALAPPDATA as string, "memory-fixture.exe");
  writeFileSync(path, "fixture memory payload");
  return {
    path,
    sha256: "a".repeat(64),
    size: 22,
    version: "0.10.8",
    changed,
    reused: !changed,
    archiveName: "fixture.zip",
  };
}

const graphToolsList = {
  tools: [
    { name: "build_or_update_graph_tool" },
    { name: "get_impact_radius_tool" },
    { name: "get_affected_flows_tool" },
    { name: "get_review_context_tool" },
    { name: "detect_changes_tool" },
  ],
};

describe("concrete developer-tool operations", () => {
  it("syncs Graph into its isolated environment and verifies a populated supported status", async () => {
    const calls: Array<{ argv: string[]; env?: NodeJS.ProcessEnv }> = [];
    const run: Runner = async (argv, options) => {
      calls.push({ argv, env: options?.env });
      if (argv.some((argument) => argument.endsWith("ecc-runtime.js"))) {
        return {
          code: 0,
          stdout: generatedMcpOutput(
            processInput(options),
            [
              "build_or_update_graph_tool",
              "get_impact_radius_tool",
              "get_affected_flows_tool",
              "get_review_context_tool",
              "detect_changes_tool",
            ],
            () => ({
              content: [
                {
                  type: "text",
                  text: JSON.stringify({ status: "ok", changed_files: ["main.ts"] }),
                },
              ],
            }),
          ),
          stderr: "",
        };
      }
      if (argv.includes("status")) {
        return { code: 0, stdout: '{"nodes":12,"files":2}\n', stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    const ctx = fixture(run);
    const graphStateRoot = defaultNativeRuntimeLayout(ctx).graphStateRoot;
    mkdirSync(graphStateRoot, { recursive: true });
    writeFileSync(join(graphStateRoot, "graph.db"), "existing graph fixture");
    const operation = createDefaultDeveloperToolRuntimeOperations(ctx)["code-review-graph"];

    const result = await operation(input(ctx, "code-review-graph"));

    expect(result.state).toBe("verified");
    expect(calls.some((call) => call.argv.includes("sync"))).toBe(true);
    const sync = calls.find((call) => call.argv.includes("sync"));
    const status = calls.find((call) => call.argv.includes("status"));
    expect(sync?.env?.UV_OFFLINE).toBeUndefined();
    expect(status?.env?.UV_OFFLINE).toBe("1");
    expect(status?.env?.UV_PROJECT_ENVIRONMENT).toBe(join(graphStateRoot, "runtime-env"));
    expect(calls.some((call) => call.argv.includes("build"))).toBe(false);
    expect(
      calls.some((call) => call.argv.some((argument) => argument.endsWith("ecc-runtime.js"))),
    ).toBe(true);
  });

  it("builds Graph before status when the owned database is absent", async () => {
    const operations: string[] = [];
    const run: Runner = async (argv, options) => {
      if (argv.some((argument) => argument.endsWith("ecc-runtime.js"))) {
        return {
          code: 0,
          stdout: generatedMcpOutput(
            processInput(options),
            [
              "build_or_update_graph_tool",
              "get_impact_radius_tool",
              "get_affected_flows_tool",
              "get_review_context_tool",
              "detect_changes_tool",
            ],
            () => ({ content: [{ type: "text", text: '{"status":"ok"}' }] }),
          ),
          stderr: "",
        };
      }
      if (argv.includes("sync")) return { code: 0, stdout: "", stderr: "" };
      if (argv.includes("build")) {
        operations.push("build");
        return { code: 0, stdout: "", stderr: "" };
      }
      if (argv.includes("status")) {
        operations.push("status");
        return { code: 0, stdout: '{"nodes":12,"files":2}\n', stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    const ctx = fixture(run);
    const operation = createDefaultDeveloperToolRuntimeOperations(ctx)["code-review-graph"];

    await expect(operation(input(ctx, "code-review-graph"))).resolves.toMatchObject({
      state: "verified",
      changed: true,
    });

    expect(operations).toEqual(["build", "status"]);
  });

  it("repairs a stale but present Graph database before exposing its MCP tools", async () => {
    const operations: string[] = [];
    const run: Runner = async (argv, options) => {
      if (argv.some((argument) => argument.endsWith("ecc-runtime.js"))) {
        return {
          code: 0,
          stdout: generatedMcpOutput(
            processInput(options),
            [
              "build_or_update_graph_tool",
              "get_impact_radius_tool",
              "get_affected_flows_tool",
              "get_review_context_tool",
              "detect_changes_tool",
            ],
            () => ({ content: [{ type: "text", text: '{"status":"ok"}' }] }),
          ),
          stderr: "",
        };
      }
      if (argv.includes("sync")) return { code: 0, stdout: "", stderr: "" };
      if (argv.includes("build")) {
        operations.push("build");
        return { code: 0, stdout: "", stderr: "" };
      }
      if (argv.includes("status")) {
        operations.push("status");
        const rebuilt = operations.includes("build");
        return {
          code: 0,
          stdout: rebuilt ? '{"nodes":9,"files":2}\n' : '{"nodes":0,"files":0}\n',
          stderr: "",
        };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    const ctx = fixture(run);
    const graphStateRoot = defaultNativeRuntimeLayout(ctx).graphStateRoot;
    mkdirSync(graphStateRoot, { recursive: true });
    writeFileSync(join(graphStateRoot, "graph.db"), "stale graph fixture");

    await expect(
      createDefaultDeveloperToolRuntimeOperations(ctx)["code-review-graph"](
        input(ctx, "code-review-graph"),
      ),
    ).resolves.toMatchObject({ state: "verified", changed: true });
    expect(operations).toEqual(["status", "build", "status"]);
  });

  it("keeps a bounded traceback tail with the terminal process cause", async () => {
    const terminalCause = "ImportError: DLL load failed while importing _binding";
    const run: Runner = async (argv) =>
      argv.includes("sync")
        ? {
            code: 1,
            stdout: "",
            stderr: `Traceback (most recent call last):\napi_key=EARLYSECRET\n${"repeated stack frame ".repeat(100)}\n${terminalCause}\n`,
          }
        : { code: 0, stdout: "", stderr: "" };
    const ctx = fixture(run);
    const operation = createDefaultDeveloperToolRuntimeOperations(ctx)["code-review-graph"];

    const failure = await operation(input(ctx, "code-review-graph")).then(
      () => {
        throw new Error("Graph sync fixture unexpectedly succeeded");
      },
      (error: unknown) => {
        if (!(error instanceof Error)) throw new Error("Graph sync fixture threw a non-Error");
        return error;
      },
    );

    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toContain("Traceback (most recent call last):");
    expect(failure.message).toContain(terminalCause);
    expect(failure.message).toContain("api_key=[redacted]");
    expect(failure.message).not.toContain("EARLYSECRET");
    expect(failure.message.length).toBeLessThan(900);
  });

  it.each([
    { failedId: 1, kind: "error" as const },
    { failedId: 2, kind: "error" as const },
    { failedId: 1, kind: "malformed" as const },
    { failedId: 2, kind: "malformed" as const },
    { failedId: 1, kind: "malformed-prefix" as const },
    { failedId: 2, kind: "malformed-prefix" as const },
  ])(
    "does not send a Graph tool call after JSON-RPC response $failedId is $kind",
    async ({ failedId, kind }) => {
      let marker = "";
      const run: Runner = async (argv, options) => {
        if (argv.some((argument) => argument.endsWith("ecc-runtime.js"))) {
          const script = [
            "const fs = require('node:fs');",
            "const readline = require('node:readline');",
            `const failedId = ${String(failedId)};`,
            `const failureKind = ${JSON.stringify(kind)};`,
            `const marker = ${JSON.stringify(marker)};`,
            "const input = readline.createInterface({ input: process.stdin });",
            "input.on('line', (line) => {",
            "  const request = JSON.parse(line);",
            "  if (request.id === undefined) return;",
            "  if (request.id === 3) fs.writeFileSync(marker, 'tool call received');",
            "  const valid = { jsonrpc: '2.0', id: request.id, result: request.id === 1 ? { protocolVersion: '2024-11-05' } : { tools: [] } };",
            "  const envelope = request.id === failedId && failureKind !== 'malformed-prefix'",
            "    ? failureKind === 'error'",
            "      ? { jsonrpc: '2.0', id: request.id, error: { code: -32000, message: 'rejected' } }",
            "      : { jsonrpc: '2.0', id: request.id, result: null }",
            "    : valid;",
            "  const prefix = request.id === failedId && failureKind === 'malformed-prefix' ? 'not-json\\n' : '';",
            "  process.stdout.write(prefix + JSON.stringify(envelope) + '\\n');",
            "});",
          ].join("\n");
          return defaultRunner([process.execPath, "-e", script], options);
        }
        if (argv.includes("status")) {
          return { code: 0, stdout: '{"nodes":12,"files":2}\n', stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      };
      const ctx = fixture(run);
      marker = join(ctx.env.LOCALAPPDATA as string, `unexpected-tool-call-${String(failedId)}`);
      const graphStateRoot = defaultNativeRuntimeLayout(ctx).graphStateRoot;
      mkdirSync(graphStateRoot, { recursive: true });
      writeFileSync(join(graphStateRoot, "graph.db"), "existing graph fixture");
      const operation = createDefaultDeveloperToolRuntimeOperations(ctx)["code-review-graph"];

      await expect(operation(input(ctx, "code-review-graph"))).rejects.toThrow(
        kind === "error"
          ? `MCP response ${String(failedId)} returned an error`
          : `MCP response ${String(failedId)} was malformed`,
      );
      expect(existsSync(marker)).toBe(false);
    },
  );

  it("rejects a Graph launcher that exposes an operation outside the reviewed allowlist", async () => {
    const run: Runner = async (argv, options) => {
      if (argv.some((argument) => argument.endsWith("ecc-runtime.js"))) {
        return {
          code: 0,
          stdout: generatedMcpOutput(
            processInput(options),
            [
              "build_or_update_graph_tool",
              "get_impact_radius_tool",
              "get_affected_flows_tool",
              "get_review_context_tool",
              "detect_changes_tool",
              "unreviewed_escape_hatch",
            ],
            () => ({ content: [{ type: "text", text: '{"status":"ok"}' }] }),
          ),
          stderr: "",
        };
      }
      if (argv.includes("status"))
        return { code: 0, stdout: '{"nodes":3,"files":1}\n', stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    };
    const ctx = fixture(run);
    const graphStateRoot = defaultNativeRuntimeLayout(ctx).graphStateRoot;
    mkdirSync(graphStateRoot, { recursive: true });
    writeFileSync(join(graphStateRoot, "graph.db"), "existing graph fixture");

    await expect(
      createDefaultDeveloperToolRuntimeOperations(ctx)["code-review-graph"](
        input(ctx, "code-review-graph"),
      ),
    ).rejects.toThrow("MCP tools/list exposed operations outside the reviewed allowlist");
  });

  it("executes Serena tools/list and a guarded supported operation after isolated sync", async () => {
    const requests: unknown[] = [];
    const run: Runner = async (argv, options) => {
      if (argv.includes("sync")) return { code: 0, stdout: "", stderr: "" };
      const stateIndex = argv.indexOf("--state-root");
      const stateRoot = argv[stateIndex + 1];
      if (stateRoot !== undefined) {
        mkdirSync(stateRoot, { recursive: true });
        writeFileSync(
          join(stateRoot, "serena_config.yml"),
          renderSerenaRuntimeConfig({
            project: ctx.root,
            home: stateRoot,
            allowedTools: SERENA_ALLOWED_TOOLS,
          }),
        );
      }
      requests.push(
        ...(processInput(options) ?? "")
          .trim()
          .split(/\r?\n/u)
          .filter(Boolean)
          .map((line) => JSON.parse(line) as unknown),
      );
      return {
        code: 0,
        stdout: generatedMcpOutput(
          processInput(options),
          [
            "get_symbols_overview",
            "find_symbol",
            "find_referencing_symbols",
            "find_implementations",
          ],
          () => ({ content: [{ type: "text", text: "exactSymbol" }] }),
        ),
        stderr: "",
      };
    };
    const ctx = fixture(run);
    const operation = createDefaultDeveloperToolRuntimeOperations(ctx).serena;

    const result = await operation(input(ctx, "serena"));

    expect(result.state).toBe("verified");
    expect(result.ownedPaths).toHaveLength(1);
    expect(requests).toContainEqual(
      expect.objectContaining({
        method: "tools/call",
        params: {
          name: "get_symbols_overview",
          arguments: { relative_path: "main.ts", depth: 1 },
        },
      }),
    );
  });

  it("retains a bounded actionable Serena tool error", async () => {
    const run: Runner = async (argv, options) => {
      if (argv.includes("sync")) return { code: 0, stdout: "", stderr: "" };
      const stateIndex = argv.indexOf("--state-root");
      const stateRoot = argv[stateIndex + 1];
      if (stateRoot !== undefined) {
        mkdirSync(stateRoot, { recursive: true });
        writeFileSync(
          join(stateRoot, "serena_config.yml"),
          renderSerenaRuntimeConfig({
            project: ctx.root,
            home: stateRoot,
            allowedTools: SERENA_ALLOWED_TOOLS,
          }),
        );
      }
      return {
        code: 0,
        stdout: generatedMcpOutput(
          processInput(options),
          [
            "get_symbols_overview",
            "find_symbol",
            "find_referencing_symbols",
            "find_implementations",
          ],
          () => ({
            isError: true,
            content: [{ type: "text", text: "relative_path must be relative to the project" }],
          }),
        ),
        stderr: "",
      };
    };
    const ctx = fixture(run);
    const operation = createDefaultDeveloperToolRuntimeOperations(ctx).serena;

    await expect(operation(input(ctx, "serena"))).rejects.toThrow(
      /relative_path must be relative to the project/u,
    );
  });

  it("runs the authenticated native Memory index operation with root-scoped state", async () => {
    const calls: Array<{ argv: string[]; env?: NodeJS.ProcessEnv; input?: string }> = [];
    const run: Runner = async (argv, options) => {
      calls.push({ argv, env: options?.env, input: processInput(options) });
      return {
        code: 0,
        stdout: generatedMcpOutput(
          processInput(options),
          ["index_repository", "search_graph", "list_projects"],
          (request) => {
            const params = request.params as Record<string, unknown>;
            const name = (params.name ?? "") as string;
            const structuredContent =
              name === "index_repository"
                ? { project: "fixture", status: "indexed", nodes: 7, edges: 3 }
                : name === "list_projects"
                  ? {
                      total: 1,
                      projects: [{ name: "fixture", root_path: ctx.root }],
                    }
                  : {
                      total: 1,
                      count: 1,
                      groups: [{ qn_prefix: "main", file: "main.ts", rows: [] }],
                    };
            return {
              content: [{ type: "text", text: JSON.stringify(structuredContent) }],
              structuredContent,
              isError: false,
            };
          },
        ),
        stderr: "",
      };
    };
    const ctx = fixture(run);
    const payload = join(ctx.env.LOCALAPPDATA as string, "memory.exe");
    writeFileSync(payload, "fixture");
    const operation = createDefaultDeveloperToolRuntimeOperations(ctx, {
      acquireMemory: async () => ({
        path: payload,
        sha256: "a".repeat(64),
        size: 7,
        version: "0.10.8",
        changed: true,
        reused: false,
        archiveName: "fixture.zip",
      }),
    })["codebase-memory-mcp"];

    const result = await operation(input(ctx, "codebase-memory-mcp"));

    expect(result).toMatchObject({ state: "verified", sourceDigest: "a".repeat(64) });
    expect(calls).toHaveLength(3);
    expect(
      calls.every((call) => call.argv.some((argument) => argument.endsWith("ecc-runtime.js"))),
    ).toBe(true);
    expect(calls.map((call) => call.argv[2])).toEqual([
      "codebase-memory-mcp",
      "codebase-memory-mcp",
      "codebase-memory-mcp",
    ]);
    const searchRequests = (calls[2]?.input ?? "")
      .trim()
      .split(/\r?\n/u)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(searchRequests).toContainEqual(
      expect.objectContaining({
        method: "tools/call",
        params: {
          name: "search_graph",
          arguments: expect.objectContaining({ project: "fixture" }),
        },
      }),
    );
  });

  it("rejects a forged Memory acquisition identity before launching the native runtime", async () => {
    const calls: string[][] = [];
    const ctx = fixture(async (argv) => {
      calls.push(argv);
      return { code: 0, stdout: "", stderr: "" };
    });
    const operation = createDefaultDeveloperToolRuntimeOperations(ctx, {
      acquireMemory: async () => ({
        path: join(ctx.root, "forged-memory-runtime"),
        sha256: "not-a-sha256",
        size: 1,
        version: "0.10.8",
        changed: false,
        reused: true,
        archiveName: "forged.zip",
      }),
    })["codebase-memory-mcp"];

    await expect(operation(input(ctx, "codebase-memory-mcp"))).rejects.toThrow(
      "Codebase Memory acquisition returned an invalid native payload identity",
    );
    expect(calls).toEqual([]);
  });

  it("performs an initialized Context7 query-docs exchange and forwards its session", async () => {
    const messages: Array<{ body: Record<string, unknown>; headers: Headers }> = [];
    const fakeFetch = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const headers = new Headers(init?.headers);
      messages.push({ body, headers });
      const id = body.id;
      if (id === undefined) return new Response(null, { status: 202 });
      const result =
        id === 1
          ? { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "context7" } }
          : id === 2
            ? { tools: [{ name: "query-docs" }] }
            : { content: [{ type: "text", text: "Effect cleanup runs before re-running." }] };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          ...(id === 1 ? { "mcp-session-id": "session-1" } : {}),
        },
      });
    });

    await expect(verifyContext7DocumentationOperation(fakeFetch)).resolves.toMatch(
      /query-docs returned documentation/u,
    );

    expect(messages.map((message) => message.body.method)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
      "tools/call",
    ]);
    expect(messages[3]?.body).toMatchObject({
      params: {
        name: "query-docs",
        arguments: { libraryId: "/facebook/react" },
      },
    });
    expect(messages[3]?.headers.get("mcp-session-id")).toBe("session-1");
  });

  it("rejects an invalid Context7 session identifier before issuing a follow-up request", async () => {
    const fakeFetch = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { protocolVersion: "2024-11-05", capabilities: {} },
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json",
              "mcp-session-id": "bad session id",
            },
          },
        ),
    );

    await expect(verifyContext7DocumentationOperation(fakeFetch)).rejects.toThrow(
      "Context7 returned an invalid MCP session identifier",
    );
    expect(fakeFetch).toHaveBeenCalledTimes(1);
  });

  it("leaves Token Optimizer executable discovery to its guarded lazy defaults", async () => {
    const ctx = fixture(async () => ({ code: 0, stdout: "", stderr: "" }));
    writeFileSync(
      join(ctx.root, ".aih-config.json"),
      `${JSON.stringify({ schemaVersion: 1, contextDir: "ai-coding", targets: ["codex"] })}\n`,
    );
    const layout = defaultNativeRuntimeLayout(ctx);
    const cacheBin = join(layout.tokenOptimizerRoot, "shadow-bin");
    mkdirSync(cacheBin, { recursive: true });
    for (const executable of process.platform === "win32"
      ? ["python.exe", "curl.exe"]
      : ["python3", "curl"]) {
      writeFileSync(join(cacheBin, executable), "cache-shadowed fixture", { mode: 0o755 });
    }
    ctx.env.PATH = `${cacheBin}${delimiter}${ctx.env.PATH ?? ""}`;
    const reconciliations: Array<{ selected: boolean; depsSupplied: boolean }> = [];
    const operation = createDefaultDeveloperToolRuntimeOperations(ctx, {
      tokenOptimizer: async (request, deps) => {
        reconciliations.push({ selected: request.selected, depsSupplied: deps !== undefined });
        return {
          toolId: "token-optimizer",
          state: request.selected ? "verified" : "policy-excluded",
          detail: request.selected ? "fixture verified" : "fixture removed",
          changed: true,
        };
      },
    })["token-optimizer"];

    await operation(input(ctx, "token-optimizer"));
    await operation({ ...input(ctx, "token-optimizer"), selected: false });

    expect(reconciliations).toEqual([
      { selected: true, depsSupplied: false },
      { selected: false, depsSupplied: false },
    ]);
  });

  it("blocks selected Token setup for non-Codex targets but still delegates cleanup", async () => {
    const ctx = fixture(async () => ({ code: 0, stdout: "", stderr: "" }));
    ctx.targets = ["claude"];
    const reconciliations: boolean[] = [];
    const operation = createDefaultDeveloperToolRuntimeOperations(ctx, {
      tokenOptimizer: async (request) => {
        reconciliations.push(request.selected);
        return {
          toolId: "token-optimizer",
          state: "policy-excluded",
          detail: "fixture removed",
          changed: true,
        };
      },
    })["token-optimizer"];

    await expect(operation(input(ctx, "token-optimizer"))).resolves.toMatchObject({
      state: "blocked",
      changed: false,
      detail: expect.stringMatching(/supports Codex only/u),
    });
    await expect(
      operation({ ...input(ctx, "token-optimizer"), selected: false }),
    ).resolves.toMatchObject({ state: "policy-excluded", changed: true });

    expect(reconciliations).toEqual([false]);
  });

  it("honors managed-server policy exclusions before Graph setup begins", async () => {
    const calls: string[][] = [];
    const ctx = fixture(async (argv) => {
      calls.push(argv);
      return { code: 0, stdout: "", stderr: "" };
    });
    writeOrgPolicy(ctx, { allowManagedOnly: true, allowedServers: ["serena"] });

    await expect(
      createDefaultDeveloperToolRuntimeOperations(ctx)["code-review-graph"](
        input(ctx, "code-review-graph"),
      ),
    ).resolves.toMatchObject({
      state: "policy-excluded",
      detail: "code-review-graph is outside the org-managed MCP allowlist",
      changed: false,
    });
    expect(calls).toEqual([]);
  });

  it("does not issue Context7 egress without the enterprise approval record", async () => {
    const ctx = fixture(async () => ({ code: 0, stdout: "", stderr: "" }));
    ctx.posture = "enterprise";
    writeOrgPolicy(ctx, {
      allowManagedOnly: true,
      allowedServers: ["context7"],
      approvals: [],
    });
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new Error("enterprise policy should stop before network use");
    });

    await expect(
      createDefaultDeveloperToolRuntimeOperations(ctx, { fetch: fetchImpl }).context7(
        input(ctx, "context7"),
      ),
    ).resolves.toMatchObject({
      state: "policy-excluded",
      detail: "Context7 third-party egress is not approved by the enterprise org policy",
      changed: false,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses Graph setup when uv cannot resolve outside the project", async () => {
    const calls: string[][] = [];
    const ctx = fixture(async (argv) => {
      calls.push(argv);
      return { code: 0, stdout: "", stderr: "" };
    });
    ctx.env.PATH = "";

    await expect(
      createDefaultDeveloperToolRuntimeOperations(ctx)["code-review-graph"](
        input(ctx, "code-review-graph"),
      ),
    ).rejects.toThrow("uv must resolve to an absolute executable outside the target project");
    expect(calls).toEqual([]);
  });

  it("requires a source fixture outside skipped dependency directories before Graph MCP work", async () => {
    const calls: string[][] = [];
    const run: Runner = async (argv) => {
      calls.push(argv);
      if (argv.includes("sync") || argv.includes("build"))
        return { code: 0, stdout: "", stderr: "" };
      if (argv.includes("status"))
        return { code: 0, stdout: '{"nodes":3,"files":1}\n', stderr: "" };
      throw new Error("Graph MCP launch must not occur without a source fixture");
    };
    const ctx = fixture(run);
    rmSync(join(ctx.root, "main.ts"));
    mkdirSync(join(ctx.root, "node_modules"), { recursive: true });
    writeFileSync(join(ctx.root, "node_modules", "ignored.ts"), "export const ignored = true;\n");

    await expect(
      createDefaultDeveloperToolRuntimeOperations(ctx)["code-review-graph"](
        input(ctx, "code-review-graph"),
      ),
    ).rejects.toThrow(
      "developer-tool runtime verification requires at least one supported source file in the project",
    );
    expect(calls.some((argv) => argv.some((part) => part.endsWith("ecc-runtime.js")))).toBe(false);
  });

  it("fails closed when Graph remains empty after its supported rebuild", async () => {
    const operations: string[] = [];
    const run: Runner = async (argv) => {
      if (argv.includes("sync")) return { code: 0, stdout: "", stderr: "" };
      if (argv.includes("status")) {
        operations.push("status");
        return { code: 0, stdout: '{"nodes":0,"files":0}\n', stderr: "" };
      }
      if (argv.includes("build")) {
        operations.push("build");
        return { code: 0, stdout: "", stderr: "" };
      }
      throw new Error("Graph MCP launch must not occur after an empty rebuild");
    };
    const ctx = fixture(run);
    const stateRoot = defaultNativeRuntimeLayout(ctx).graphStateRoot;
    mkdirSync(stateRoot, { recursive: true });
    writeFileSync(join(stateRoot, "graph.db"), "stale empty graph");

    await expect(
      createDefaultDeveloperToolRuntimeOperations(ctx)["code-review-graph"](
        input(ctx, "code-review-graph"),
      ),
    ).rejects.toThrow("Code Review Graph remained empty after its supported build operation");
    expect(operations).toEqual(["status", "build", "status"]);
  });

  it("rejects Graph MCP launches that omit a required reviewed tool", async () => {
    const run: Runner = async (argv, options) => {
      if (argv.some((argument) => argument.endsWith("ecc-runtime.js"))) {
        return {
          code: 0,
          stdout: generatedMcpOutput(
            processInput(options),
            ["build_or_update_graph_tool", "get_impact_radius_tool"],
            () => ({ content: [{ type: "text", text: '{"status":"ok"}' }] }),
          ),
          stderr: "",
        };
      }
      if (argv.includes("status"))
        return { code: 0, stdout: '{"nodes":3,"files":1}\n', stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    };
    const ctx = fixture(run);
    const stateRoot = defaultNativeRuntimeLayout(ctx).graphStateRoot;
    mkdirSync(stateRoot, { recursive: true });
    writeFileSync(join(stateRoot, "graph.db"), "ready graph");

    await expect(
      createDefaultDeveloperToolRuntimeOperations(ctx)["code-review-graph"](
        input(ctx, "code-review-graph"),
      ),
    ).rejects.toThrow("MCP tools/list omitted required tools");
  });

  it("rejects an existing Serena configuration that no longer matches the hardened profile", async () => {
    const run: Runner = async () => ({ code: 0, stdout: "", stderr: "" });
    const ctx = fixture(run);
    const stateRoot = defaultNativeRuntimeLayout(ctx).serenaStateRoot;
    mkdirSync(stateRoot, { recursive: true });
    writeFileSync(
      join(stateRoot, "serena_config.yml"),
      renderSerenaRuntimeConfig({
        project: ctx.root,
        home: stateRoot,
        allowedTools: SERENA_ALLOWED_TOOLS,
      }).replace("web_dashboard: false", "web_dashboard: true"),
    );

    await expect(
      createDefaultDeveloperToolRuntimeOperations(ctx).serena(input(ctx, "serena")),
    ).rejects.toThrow("Serena config conflicts with the AIH-owned hardened profile");
  });

  it("fails if a generated Serena session does not retain its authenticated configuration", async () => {
    const run: Runner = async (argv, options) => {
      if (argv.includes("sync")) return { code: 0, stdout: "", stderr: "" };
      return {
        code: 0,
        stdout: generatedMcpOutput(
          processInput(options),
          [
            "get_symbols_overview",
            "find_symbol",
            "find_referencing_symbols",
            "find_implementations",
          ],
          () => ({ content: [{ type: "text", text: "fixture symbols" }] }),
        ),
        stderr: "",
      };
    };
    const ctx = fixture(run);

    await expect(
      createDefaultDeveloperToolRuntimeOperations(ctx).serena(input(ctx, "serena")),
    ).rejects.toThrow("Serena did not retain the authenticated hardened configuration");
  });

  it("fails closed across unhealthy Memory index, foreign inventory, and missing search result", async () => {
    const scenarios = [
      {
        label: "unhealthy index",
        expected: "Codebase Memory index_repository did not produce a populated healthy index",
        calls: 1,
      },
      {
        label: "foreign inventory",
        expected: "Codebase Memory list_projects returned a foreign or invalid project",
        calls: 2,
      },
      {
        label: "malformed inventory",
        expected: "Codebase Memory list_projects returned a malformed project",
        calls: 2,
      },
      {
        label: "nonisolated inventory",
        expected: "Codebase Memory list_projects did not return one isolated project",
        calls: 2,
      },
      {
        label: "missing index structured result",
        expected: "Codebase Memory index_repository returned no structured result",
        calls: 1,
      },
      {
        label: "missing search result",
        expected: "Codebase Memory search_graph did not retrieve the indexed source fixture",
        calls: 3,
      },
    ];

    for (const scenario of scenarios) {
      let calls = 0;
      const run: Runner = async (_argv, options) => {
        calls += 1;
        return {
          code: 0,
          stdout: generatedMcpOutput(
            processInput(options),
            ["index_repository", "search_graph", "list_projects"],
            (request) => {
              const params = request.params as Record<string, unknown>;
              const name = params.name as string;
              if (
                scenario.label === "missing index structured result" &&
                name === "index_repository"
              ) {
                return { content: [{ type: "text", text: '{"status":"indexed"}' }] };
              }
              const structuredContent =
                name === "index_repository"
                  ? scenario.label === "unhealthy index"
                    ? { status: "indexed", nodes: 0, edges: 0 }
                    : { status: "indexed", nodes: 4, edges: 1 }
                  : name === "list_projects"
                    ? scenario.label === "malformed inventory"
                      ? { total: 1, projects: [[]] }
                      : scenario.label === "nonisolated inventory"
                        ? { total: 2, projects: [] }
                        : {
                            total: 1,
                            projects: [
                              {
                                name: "fixture",
                                root_path:
                                  scenario.label === "foreign inventory"
                                    ? join(ctx.root, "missing-memory-project")
                                    : ctx.root,
                              },
                            ],
                          }
                    : scenario.label === "missing search result"
                      ? { count: 0, groups: [] }
                      : { count: 1, groups: [{ file: "main.ts", rows: [] }] };
              return {
                content: [{ type: "text", text: JSON.stringify(structuredContent) }],
                structuredContent,
              };
            },
          ),
          stderr: "",
        };
      };
      const ctx = fixture(run);
      const operation = createDefaultDeveloperToolRuntimeOperations(ctx, {
        acquireMemory: async () => memoryPayload(ctx),
      })["codebase-memory-mcp"];

      await expect(operation(input(ctx, "codebase-memory-mcp")), scenario.label).rejects.toThrow(
        scenario.expected,
      );
      expect(calls).toBe(scenario.calls);
    }
  });

  it("accepts Context7 Server-Sent Events and carries the negotiated session", async () => {
    const messages: Array<{ body: Record<string, unknown>; headers: Headers }> = [];
    const fakeFetch = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const headers = new Headers(init?.headers);
      messages.push({ body, headers });
      if (body.id === undefined) return new Response(null, { status: 202 });
      const result =
        body.id === 1
          ? { protocolVersion: "2024-11-05", capabilities: {} }
          : body.id === 2
            ? { tools: [{ name: "query-docs" }] }
            : { content: [{ type: "text", text: "SSE documentation" }] };
      const envelope = JSON.stringify({ jsonrpc: "2.0", id: body.id, result });
      return new Response(`event: message\ndata: ${envelope}\n\n`, {
        status: 200,
        headers: {
          "content-type": "text/event-stream",
          ...(body.id === 1 ? { "mcp-session-id": "sse-session" } : {}),
        },
      });
    });

    await expect(verifyContext7DocumentationOperation(fakeFetch)).resolves.toMatch(/query-docs/u);
    expect(messages.map((message) => message.body.method)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
      "tools/call",
    ]);
    expect(messages[2]?.headers.get("mcp-session-id")).toBe("sse-session");
  });

  it.each([
    {
      label: "an oversized announced response",
      response: () =>
        new Response("{}", {
          status: 200,
          headers: { "content-type": "application/json", "content-length": "4194305" },
        }),
      message: "Context7 response exceeds its byte limit",
    },
    {
      label: "an HTTP failure",
      response: () => new Response("service unavailable", { status: 503 }),
      message: "Context7 returned HTTP 503",
    },
    {
      label: "an invalid negotiated protocol version",
      response: () =>
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { protocolVersion: "", capabilities: {} },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      message: "Context7 returned an invalid MCP protocol version",
    },
    {
      label: "a JSON-RPC error envelope",
      response: () =>
        new Response(
          JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "no" } }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      message: "Context7 returned an error for response 1",
    },
  ])("rejects Context7 $label", async ({ response, message }) => {
    const fakeFetch = vi.fn<typeof fetch>(async () => response());

    await expect(verifyContext7DocumentationOperation(fakeFetch)).rejects.toThrow(message);
    expect(fakeFetch).toHaveBeenCalledTimes(1);
  });

  it("rejects a selected Token Optimizer operation that remains pending", async () => {
    const ctx = fixture(async () => ({ code: 0, stdout: "", stderr: "" }));
    ctx.targets = ["codex"];
    const operation = createDefaultDeveloperToolRuntimeOperations(ctx, {
      tokenOptimizer: async () => ({
        toolId: "token-optimizer",
        state: "selected-pending",
        detail: "fixture remains pending",
        changed: false,
      }),
    })["token-optimizer"];

    await expect(operation(input(ctx, "token-optimizer"))).rejects.toThrow(
      "Token Optimizer reconciliation returned a non-final lifecycle state",
    );
  });

  it.each([
    {
      label: "an omitted tools/list reply",
      response2: undefined,
      response3: {
        jsonrpc: "2.0",
        id: 3,
        result: { content: [{ type: "text", text: '{"status":"ok"}' }] },
      },
      message: "MCP runtime omitted response 2",
    },
    {
      label: "a tools/list error envelope",
      response2: { jsonrpc: "2.0", id: 2, error: { code: -32000, message: "rejected" } },
      response3: {
        jsonrpc: "2.0",
        id: 3,
        result: { content: [{ type: "text", text: '{"status":"ok"}' }] },
      },
      message: "MCP runtime returned an error for response 2",
    },
    {
      label: "a malformed tools/list result",
      response2: { jsonrpc: "2.0", id: 2, result: null },
      response3: {
        jsonrpc: "2.0",
        id: 3,
        result: { content: [{ type: "text", text: '{"status":"ok"}' }] },
      },
      message: "MCP runtime returned a malformed result for response 2",
    },
    {
      label: "a non-array tools/list payload",
      response2: { jsonrpc: "2.0", id: 2, result: { tools: {} } },
      response3: {
        jsonrpc: "2.0",
        id: 3,
        result: { content: [{ type: "text", text: '{"status":"ok"}' }] },
      },
      message: "MCP tools/list result is malformed",
    },
    {
      label: "a rejected tool result with a sensitive diagnostic",
      response2: {
        jsonrpc: "2.0",
        id: 2,
        result: graphToolsList,
      },
      response3: {
        jsonrpc: "2.0",
        id: 3,
        result: {
          isError: true,
          content: [{ type: "text", text: "api_key=mock-value" }],
        },
      },
      message:
        "Code Review Graph detect_changes_tool returned an MCP tool error — api_key=[redacted]",
    },
    {
      label: "a tool result with no content",
      response2: { jsonrpc: "2.0", id: 2, result: graphToolsList },
      response3: { jsonrpc: "2.0", id: 3, result: { content: [] } },
      message: "Code Review Graph detect_changes_tool returned no content",
    },
    {
      label: "a tool result that reports an operation error",
      response2: { jsonrpc: "2.0", id: 2, result: graphToolsList },
      response3: {
        jsonrpc: "2.0",
        id: 3,
        result: { content: [{ type: "text", text: '{"state":"error"}' }] },
      },
      message: "Code Review Graph detect_changes_tool reported an operation error",
    },
  ])("fails closed when Graph MCP emits $label", async ({ response2, response3, message }) => {
    const run: Runner = async (argv) => {
      if (argv.some((argument) => argument.endsWith("ecc-runtime.js"))) {
        return {
          code: 0,
          stdout: [
            JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              result: { protocolVersion: "2024-11-05", capabilities: {} },
            }),
            ...(response2 === undefined ? [] : [JSON.stringify(response2)]),
            JSON.stringify(response3),
          ].join("\n"),
          stderr: "",
        };
      }
      if (argv.includes("status"))
        return { code: 0, stdout: '{"nodes":3,"files":1}\n', stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    };
    const ctx = fixture(run);
    const stateRoot = defaultNativeRuntimeLayout(ctx).graphStateRoot;
    mkdirSync(stateRoot, { recursive: true });
    writeFileSync(join(stateRoot, "graph.db"), "ready graph");

    await expect(
      createDefaultDeveloperToolRuntimeOperations(ctx)["code-review-graph"](
        input(ctx, "code-review-graph"),
      ),
    ).rejects.toThrow(message);
  });

  it("rejects a streaming Context7 response that exceeds its byte budget", async () => {
    const fakeFetch = vi.fn<typeof fetch>(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(Buffer.alloc(4 * 1024 * 1024 + 1, "x"));
              controller.close();
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );

    await expect(verifyContext7DocumentationOperation(fakeFetch)).rejects.toThrow(
      "Context7 response exceeds its byte limit",
    );
    expect(fakeFetch).toHaveBeenCalledTimes(1);
  });

  it("rejects an SSE reply that does not correlate with the Context7 request", async () => {
    const fakeFetch = vi.fn<typeof fetch>(
      async () =>
        new Response(
          'event: message\ndata: {"jsonrpc":"2.0","id":99,"result":{"protocolVersion":"2024-11-05"}}\n\n',
          { status: 200, headers: { "content-type": "text/event-stream" } },
        ),
    );

    await expect(verifyContext7DocumentationOperation(fakeFetch)).rejects.toThrow(
      "Context7 omitted MCP response 1",
    );
    expect(fakeFetch).toHaveBeenCalledTimes(1);
  });

  it("rejects an accepted Context7 tools/list request with no response body", async () => {
    const fakeFetch = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (body.id === 1) {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { protocolVersion: "2024-11-05", capabilities: {} },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(null, { status: 202 });
    });

    await expect(verifyContext7DocumentationOperation(fakeFetch)).rejects.toThrow(
      "Context7 omitted MCP response 2",
    );
    expect(fakeFetch).toHaveBeenCalledTimes(3);
  });

  it("rejects invalid Graph status counts before launching its MCP session", async () => {
    const calls: string[][] = [];
    const ctx = fixture(async (argv) => {
      calls.push(argv);
      if (argv.includes("status"))
        return { code: 0, stdout: '{"nodes":"3","files":1}\n', stderr: "" };
      return { code: 0, stdout: "", stderr: "" };
    });
    const stateRoot = defaultNativeRuntimeLayout(ctx).graphStateRoot;
    mkdirSync(stateRoot, { recursive: true });
    writeFileSync(join(stateRoot, "graph.db"), "invalid graph");

    await expect(
      createDefaultDeveloperToolRuntimeOperations(ctx)["code-review-graph"](
        input(ctx, "code-review-graph"),
      ),
    ).rejects.toThrow("Code Review Graph status did not contain valid node and file counts");
    expect(calls.some((argv) => argv.some((part) => part.endsWith("ecc-runtime.js")))).toBe(false);
  });

  it("bounds the Graph semantic fixture walk before a large source tree can launch MCP", async () => {
    const calls: string[][] = [];
    const run: Runner = async (argv) => {
      calls.push(argv);
      if (argv.includes("status"))
        return { code: 0, stdout: '{"nodes":3,"files":1}\n', stderr: "" };
      if (argv.some((part) => part.endsWith("ecc-runtime.js"))) {
        throw new Error("Graph MCP launch must not follow an unbounded semantic scan");
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    const ctx = fixture(run);
    const stateRoot = defaultNativeRuntimeLayout(ctx).graphStateRoot;
    mkdirSync(stateRoot, { recursive: true });
    writeFileSync(join(stateRoot, "graph.db"), "ready graph");
    rmSync(join(ctx.root, "main.ts"));
    const manyFiles = join(ctx.root, "many-files");
    mkdirSync(manyFiles);
    for (let index = 0; index < 4_096; index += 1) {
      writeFileSync(join(manyFiles, `fixture-${String(index).padStart(4, "0")}.txt`), "fixture\n");
    }

    await expect(
      createDefaultDeveloperToolRuntimeOperations(ctx)["code-review-graph"](
        input(ctx, "code-review-graph"),
      ),
    ).rejects.toThrow("developer-tool semantic fixture scan exceeded its entry limit");
    expect(calls.some((argv) => argv.some((part) => part.endsWith("ecc-runtime.js")))).toBe(false);
  });

  it("rejects an SSE Context7 result with an invalid result payload", async () => {
    const fakeFetch = vi.fn<typeof fetch>(
      async () =>
        new Response('data: {"jsonrpc":"2.0","id":1,"result":null}\n\n', {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
    );

    await expect(verifyContext7DocumentationOperation(fakeFetch)).rejects.toThrow(
      "Context7 returned a malformed result for response 1",
    );
    expect(fakeFetch).toHaveBeenCalledTimes(1);
  });

  it("returns a verified Context7 operation only after the protocol exchange completes", async () => {
    const ctx = fixture(async () => ({ code: 0, stdout: "", stderr: "" }));
    const fakeFetch = vi.fn<typeof fetch>(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (body.id === undefined) return new Response(null, { status: 202 });
      const result =
        body.id === 1
          ? { protocolVersion: "2024-11-05", capabilities: {} }
          : body.id === 2
            ? { tools: [{ name: "query-docs" }] }
            : { content: [{ type: "text", text: "bounded docs" }] };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    await expect(
      createDefaultDeveloperToolRuntimeOperations(ctx, { fetch: fakeFetch }).context7(
        input(ctx, "context7"),
      ),
    ).resolves.toMatchObject({ state: "verified", changed: false });
    expect(fakeFetch).toHaveBeenCalledTimes(4);
  });
});
