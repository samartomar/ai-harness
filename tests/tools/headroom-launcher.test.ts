import { EventEmitter } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { PassThrough, Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { runNativeEccRuntime } from "../../src/ecc-profile/native-runtime-cli.js";
import type { PlanContext } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import {
  HEADROOM_DEPENDENCY_LOCK_SHA256,
  HEADROOM_RUNTIME_SWITCHES,
  headroomLayout,
  headroomMcpServer,
  headroomPlatform,
} from "../../src/tools/headroom.js";
import { headroomReceiptFor, writeHeadroomReceipt } from "../../src/tools/headroom-receipt.js";

const roots: string[] = [];
const supported = headroomPlatform(process.platform, process.arch);

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporary(prefix: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  roots.push(root);
  return root;
}

function fixture(options: { receipt?: "valid" | "stale" | "absent"; environment?: boolean } = {}) {
  const project = temporary("aih-headroom-launch-project-");
  const state = temporary("aih-headroom-launch-state-");
  const tools = join(state, "tools");
  mkdirSync(tools);
  const executable = join(tools, process.platform === "win32" ? "uv.exe" : "uv");
  writeFileSync(executable, "fixture uv\n");
  if (process.platform !== "win32") chmodSync(executable, 0o700);
  writeFileSync(join(project, process.platform === "win32" ? "uv.exe" : "uv"), "untrusted\n");
  const run = fakeRunner(() => undefined);
  const env: NodeJS.ProcessEnv = {
    PATH: [project, tools].join(delimiter),
    XDG_STATE_HOME: state,
    LOCALAPPDATA: state,
    HOME: state,
    OPENAI_API_KEY: "must-not-reach-headroom",
    HEADROOM_PROXY_URL: "https://proxy.example.invalid",
    HEADROOM_MCP_READ: "on",
    HEADROOM_BEACON: "on",
  };
  const ctx: PlanContext = {
    root: project,
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
    options: {},
  };
  const layout = headroomLayout(ctx);
  const server = headroomMcpServer(ctx);
  mkdirSync(layout.workspace, { recursive: true });
  if (options.environment !== false) mkdirSync(layout.environment, { recursive: true });
  if ((options.receipt ?? "valid") !== "absent") {
    const receipt = headroomReceiptFor({
      layout,
      platform: supported ?? "linux-x64",
      acceptedAt: "2026-09-23T12:00:00.000Z",
      hosts: ["claude"],
      server,
    });
    writeHeadroomReceipt(
      layout,
      options.receipt === "stale"
        ? { ...receipt, pin: { ...receipt.pin, package: "headroom-ai[mcp]==0.37.0" } }
        : receipt,
      undefined,
    );
  }
  return { ctx, env, layout, server, uv: realpathSync.native(executable) };
}

function fakeChild() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: () => true,
  });
  child.stdin.on("data", (chunk) => {
    for (const line of chunk.toString().split("\n").filter(Boolean)) {
      const request = JSON.parse(line) as { id?: number };
      child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {} })}\n`);
    }
  });
  child.stdin.on("finish", () => {
    child.stdout.end();
    child.stderr.end();
    setImmediate(() => child.emit("exit", 0, null));
  });
  return child;
}

function launch(
  scope: ReturnType<typeof fixture>,
  args: readonly string[] = scope.server.args.slice(1),
) {
  const calls: {
    command: string;
    args: readonly string[];
    cwd?: string;
    env?: NodeJS.ProcessEnv;
  }[] = [];
  const stdout = new PassThrough();
  let output = "";
  stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  const result = runNativeEccRuntime([...args], {
    stdin: Readable.from([`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" })}\n`]),
    stdout,
    stderr: new PassThrough(),
    env: scope.env,
    spawnProcess: ((
      command: string,
      spawnArgs: readonly string[],
      options: { cwd?: string; env?: NodeJS.ProcessEnv },
    ) => {
      calls.push({ command, args: spawnArgs, cwd: options.cwd, env: options.env });
      return fakeChild();
    }) as never,
  });
  return { result, calls, output: () => output };
}

describe("Headroom MCP launcher mode", () => {
  it.skipIf(supported === undefined)(
    "runs headroom mcp serve from the authenticated offline lock with the network switches off",
    async () => {
      const scope = fixture();
      const run = launch(scope);
      await expect(run.result).resolves.toBe(0);
      expect(run.calls).toHaveLength(1);
      const [call] = run.calls;
      expect(call?.command).toBe(scope.uv);
      expect(call?.args).toEqual([
        "--project",
        scope.layout.lockRoot,
        "run",
        "--offline",
        "--no-python-downloads",
        "--no-env-file",
        "--frozen",
        "--no-config",
        "python",
        "-m",
        "headroom.cli",
        "mcp",
        "serve",
      ]);
      expect(call?.cwd).toBe(scope.layout.workspace);
      expect(call?.env).toMatchObject({
        ...HEADROOM_RUNTIME_SWITCHES,
        UV_OFFLINE: "1",
        UV_PROJECT_ENVIRONMENT: scope.layout.environment,
        HEADROOM_WORKSPACE_DIR: scope.layout.workspace,
        TIKTOKEN_CACHE_DIR: scope.layout.tiktokenCache,
      });
      for (const key of ["OPENAI_API_KEY", "HEADROOM_PROXY_URL", "HEADROOM_MCP_READ"])
        expect(call?.env?.[key]).toBeUndefined();
      expect(JSON.parse(run.output().trim())).toMatchObject({ id: 1, result: {} });
    },
  );

  it.each([
    ["an unaccepted package pin", 2, "headroom-ai[mcp]==0.37.0", /package pin is not accepted/u],
    ["an unaccepted dependency lock", 4, "0".repeat(64), /dependency lock is not accepted/u],
  ])("refuses %s before starting anything", async (_label, index, value, message) => {
    const scope = fixture();
    const args = scope.server.args.slice(1);
    args[index] = value;
    const run = launch(scope, args);
    await expect(run.result).rejects.toThrow(message);
    expect(run.calls).toHaveLength(0);
  });

  it("refuses unknown or duplicate options", async () => {
    const scope = fixture();
    await expect(
      launch(scope, [...scope.server.args.slice(1), "--proxy-url", "http://x"]).result,
    ).rejects.toThrow(/invalid Headroom launcher options/u);
    const duplicate = [...scope.server.args.slice(1)];
    duplicate.splice(1, 0, "--project", scope.layout.project);
    await expect(launch(scope, duplicate).result).rejects.toThrow(/duplicate/u);
  });

  it.each([
    ["absent", /not activated/u],
    ["stale", /re-activate|--activate-headroom/u],
  ] as const)("refuses to start with an %s activation receipt", async (receipt, message) => {
    const scope = fixture({ receipt });
    const run = launch(scope);
    await expect(run.result).rejects.toThrow(message);
    expect(run.calls).toHaveLength(0);
  });

  it.skipIf(supported === undefined)(
    "refuses a receipt whose runtime environment is missing",
    async () => {
      const scope = fixture({ environment: false });
      const run = launch(scope);
      await expect(run.result).rejects.toThrow(/runtime environment is missing/u);
      expect(run.calls).toHaveLength(0);
    },
  );

  it("refuses a state root inside the project", async () => {
    const scope = fixture();
    const args = scope.server.args.slice(1);
    args[args.indexOf("--state-root") + 1] = join(scope.layout.project, "headroom");
    await expect(launch(scope, args).result).rejects.toThrow(/outside and disjoint/u);
  });

  it("keeps the generated launcher on the dependency lock it authenticates", () => {
    const scope = fixture();
    expect(scope.server.args).toContain(HEADROOM_DEPENDENCY_LOCK_SHA256);
  });
});
