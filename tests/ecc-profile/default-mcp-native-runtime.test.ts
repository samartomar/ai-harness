import { EventEmitter } from "node:events";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { CODE_REVIEW_GRAPH_ALLOWED_TOOLS } from "../../src/ecc-profile/code-review-graph-runtime.js";
import { codebaseMemoryCoordinationRoot } from "../../src/ecc-profile/codebase-memory-coordination.js";
import { DEFAULT_MCP_DEPENDENCY_LOCK_SHA256 } from "../../src/ecc-profile/default-mcp-runtime-lock.js";
import { runNativeEccRuntime } from "../../src/ecc-profile/native-runtime-cli.js";

const lockRoot = fileURLToPath(
  new URL("../../src/ecc-profile/default-mcp-runtime", import.meta.url),
);
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const project = realpathSync(mkdtempSync(join(tmpdir(), "aih-default-mcp-project-")));
  const stateBase = realpathSync(mkdtempSync(join(tmpdir(), "aih-default-mcp-state-")));
  roots.push(project, stateBase);
  const directories = {
    project,
    graph: join(stateBase, "graph"),
    memory: join(stateBase, "memory"),
    payload: join(stateBase, "payload"),
    uv: join(stateBase, "uv"),
  };
  for (const path of Object.values(directories).slice(1)) mkdirSync(path);
  const tools = join(stateBase, "tools");
  mkdirSync(tools);
  const executableName = process.platform === "win32" ? "uv.exe" : "uv";
  const projectUv = join(project, executableName);
  const uvExecutable = join(tools, executableName);
  writeFileSync(projectUv, "untrusted project executable\n");
  writeFileSync(uvExecutable, "trusted test executable\n");
  if (process.platform !== "win32") {
    chmodSync(projectUv, 0o700);
    chmodSync(uvExecutable, 0o700);
  }
  return { ...directories, stateBase, tools, uvExecutable: realpathSync.native(uvExecutable) };
}

function memoryEnvironment(scope: ReturnType<typeof fixture>): NodeJS.ProcessEnv {
  return {
    PATH: "fixture-path",
    HOME: scope.stateBase,
    LOCALAPPDATA: scope.stateBase,
    XDG_RUNTIME_DIR: join(scope.stateBase, "xdg-runtime"),
  };
}

function fakeChild(onRequest?: (request: Record<string, unknown>, child: FakeChild) => void) {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: () => true,
  }) as FakeChild;
  let buffer = "";
  child.stdin.on("data", (chunk) => {
    buffer += chunk.toString();
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const raw = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (raw) onRequest?.(JSON.parse(raw), child);
    }
  });
  child.stdin.on("finish", () => {
    child.stdout.end();
    child.stderr.end();
    setImmediate(() => child.emit("exit", 0, null));
  });
  return child;
}

type FakeChild = EventEmitter & {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: () => boolean;
};

function rendered(stream: PassThrough): { value: string } {
  const result = { value: "" };
  stream.on("data", (chunk) => {
    result.value += chunk.toString();
  });
  return result;
}

describe("generated default MCP native launchers", () => {
  it("launches Graph from the authenticated offline lock and enforces protocol + environment", async () => {
    const scope = fixture();
    const stdout = new PassThrough();
    const output = rendered(stdout);
    let command = "";
    let args: readonly string[] = [];
    let options: { cwd?: string; env?: NodeJS.ProcessEnv } = {};
    const spawnProcess = ((
      nextCommand: string,
      nextArgs: readonly string[],
      nextOptions: { cwd?: string; env?: NodeJS.ProcessEnv },
    ) => {
      command = nextCommand;
      args = nextArgs;
      options = nextOptions;
      return fakeChild((request, child) => {
        if (request.method === "tools/list") {
          child.stdout.write(
            `${JSON.stringify({
              jsonrpc: "2.0",
              id: request.id,
              result: {
                tools: [
                  ...CODE_REVIEW_GRAPH_ALLOWED_TOOLS.map((name) => ({ name })),
                  { name: "embed_graph_tool" },
                ],
              },
            })}\n`,
          );
        } else {
          child.stdout.write(
            `${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { ok: true } })}\n`,
          );
        }
      });
    }) as never;
    const stdin = Readable.from(
      [
        { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: "build_or_update_graph_tool", arguments: {} },
        },
        {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: {
            name: "build_or_update_graph_tool",
            arguments: { embedding_provider: "openai", embedding_model: "fake" },
          },
        },
      ].map((value) => `${JSON.stringify(value)}\n`),
    );

    const exit = await runNativeEccRuntime(
      [
        "code-review-graph",
        "--package",
        "code-review-graph==2.3.8",
        "--dependency-lock-sha256",
        DEFAULT_MCP_DEPENDENCY_LOCK_SHA256,
        "--lock-root",
        lockRoot,
        "--project",
        scope.project,
        "--state-root",
        scope.graph,
        "--uv-cache",
        scope.uv,
      ],
      {
        stdin,
        stdout,
        spawnProcess,
        env: {
          PATH: [scope.project, scope.tools].join(delimiter),
          CRG_OPENAI_API_KEY: "fake",
          GOOGLE_API_KEY: "fake",
        },
      },
    );

    expect(exit).toBe(0);
    expect(command).toBe(scope.uvExecutable);
    expect(args).toEqual([
      "--project",
      realpathSync(lockRoot),
      "run",
      "--offline",
      "--no-python-downloads",
      "--no-env-file",
      "--frozen",
      "code-review-graph",
      "serve",
      "--repo",
      scope.project,
      "--tools",
      CODE_REVIEW_GRAPH_ALLOWED_TOOLS.join(","),
    ]);
    expect(options.cwd).toBe(scope.project);
    expect(options.env).toMatchObject({
      PATH: [scope.project, scope.tools].join(delimiter),
      CRG_DATA_DIR: scope.graph,
      UV_CACHE_DIR: scope.uv,
      UV_OFFLINE: "1",
    });
    expect(options.env?.CRG_OPENAI_API_KEY).toBeUndefined();
    expect(options.env?.GOOGLE_API_KEY).toBeUndefined();
    const messages = output.value
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(
      messages
        .find((message) => message.id === 1)
        .result.tools.map((tool: { name: string }) => tool.name),
    ).toEqual(CODE_REVIEW_GRAPH_ALLOWED_TOOLS);
    expect(messages.find((message) => message.id === 2).result.ok).toBe(true);
    expect(messages.find((message) => message.id === 3).error.code).toBe(-32003);
  });

  it("launches Memory from the same offline lock with isolated A-only state", async () => {
    const scope = fixture();
    const env = memoryEnvironment(scope);
    const coordination = codebaseMemoryCoordinationRoot(env, scope.project, process.platform);
    let command = "";
    let args: readonly string[] = [];
    let childEnv: NodeJS.ProcessEnv | undefined;
    let authenticatedRuntimeHome = "";
    const payloadPath = join(scope.payload, "authenticated-codebase-memory");
    const stdout = new PassThrough();
    const output = rendered(stdout);
    const spawnProcess = ((
      nextCommand: string,
      nextArgs: readonly string[],
      options: { env?: NodeJS.ProcessEnv },
    ) => {
      command = nextCommand;
      args = nextArgs;
      childEnv = options.env;
      return fakeChild((request, child) => {
        child.stdout.write(
          `${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2025-03-26" } })}\n`,
        );
      });
    }) as never;
    const exit = await runNativeEccRuntime(
      [
        "codebase-memory-mcp",
        "--package",
        "codebase-memory-mcp==0.10.8",
        "--dependency-lock-sha256",
        DEFAULT_MCP_DEPENDENCY_LOCK_SHA256,
        "--lock-root",
        lockRoot,
        "--project",
        scope.project,
        "--state-root",
        scope.memory,
        "--coordination-root",
        coordination,
        "--runtime-home",
        scope.payload,
        "--uv-cache",
        scope.uv,
      ],
      {
        stdin: Readable.from([
          `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`,
        ]),
        stdout,
        spawnProcess,
        env: { ...env, OPENAI_API_KEY: "must-not-pass" },
        authenticateCodebaseMemoryPayload: async ({ runtimeHome }) => {
          authenticatedRuntimeHome = runtimeHome;
          return {
            path: payloadPath,
            sha256: "a".repeat(64),
            size: 1,
            version: "0.10.8",
          };
        },
      },
    );

    expect(exit).toBe(0);
    expect(authenticatedRuntimeHome).toBe(scope.payload);
    expect(command).toBe(payloadPath);
    expect(args).toEqual([]);
    expect(childEnv).toMatchObject({
      CBM_ALLOWED_ROOT: scope.project,
      CBM_CACHE_DIR: join(scope.memory, "index"),
      CBM_RUNTIME_DIR: coordination,
      CBM_LOG_LEVEL: "none",
      LOCALAPPDATA: scope.payload,
      XDG_CACHE_HOME: scope.payload,
      UV_CACHE_DIR: scope.uv,
      UV_OFFLINE: "1",
    });
    expect(childEnv?.OPENAI_API_KEY).toBeUndefined();
    expect(JSON.parse(output.value).result.protocolVersion).toBe("2025-03-26");
  });

  it("refuses to spawn Memory when its extracted native payload fails authentication", async () => {
    const scope = fixture();
    const env = memoryEnvironment(scope);
    const coordination = codebaseMemoryCoordinationRoot(env, scope.project, process.platform);
    let spawned = false;

    await expect(
      runNativeEccRuntime(
        [
          "codebase-memory-mcp",
          "--package",
          "codebase-memory-mcp==0.10.8",
          "--dependency-lock-sha256",
          DEFAULT_MCP_DEPENDENCY_LOCK_SHA256,
          "--lock-root",
          lockRoot,
          "--project",
          scope.project,
          "--state-root",
          scope.memory,
          "--coordination-root",
          coordination,
          "--runtime-home",
          scope.payload,
          "--uv-cache",
          scope.uv,
        ],
        {
          stdin: Readable.from([]),
          env: { ...env, PATH: [scope.project, scope.tools].join(delimiter) },
          authenticateCodebaseMemoryPayload: async () => {
            throw new Error("Codebase Memory native payload failed SHA-256 authentication");
          },
          spawnProcess: (() => {
            spawned = true;
            throw new Error("must not spawn");
          }) as never,
        },
      ),
    ).rejects.toThrow(/failed SHA-256 authentication/i);
    expect(spawned).toBe(false);
  });

  it("rejects a foreign Memory coordination root before creating any mutable roots", async () => {
    const scope = fixture();
    const env = memoryEnvironment(scope);
    const expectedCoordination = codebaseMemoryCoordinationRoot(
      env,
      scope.project,
      process.platform,
    );
    const foreignCoordination = join(scope.stateBase, "foreign-coordination");
    rmSync(scope.memory, { recursive: true });
    rmSync(scope.payload, { recursive: true });
    rmSync(scope.uv, { recursive: true });
    let spawned = false;

    await expect(
      runNativeEccRuntime(
        [
          "codebase-memory-mcp",
          "--package",
          "codebase-memory-mcp==0.10.8",
          "--dependency-lock-sha256",
          DEFAULT_MCP_DEPENDENCY_LOCK_SHA256,
          "--lock-root",
          lockRoot,
          "--project",
          scope.project,
          "--state-root",
          scope.memory,
          "--coordination-root",
          foreignCoordination,
          "--runtime-home",
          scope.payload,
          "--uv-cache",
          scope.uv,
        ],
        {
          stdin: Readable.from([]),
          env,
          spawnProcess: (() => {
            spawned = true;
            throw new Error("must not spawn");
          }) as never,
        },
      ),
    ).rejects.toThrow("must match the derived project root");
    expect(spawned).toBe(false);
    expect(existsSync(scope.memory)).toBe(false);
    expect(existsSync(scope.payload)).toBe(false);
    expect(existsSync(scope.uv)).toBe(false);
    expect(existsSync(foreignCoordination)).toBe(false);
    expect(existsSync(expectedCoordination)).toBe(false);
  });
});
