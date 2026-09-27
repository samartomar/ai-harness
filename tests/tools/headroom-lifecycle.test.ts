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
import { afterEach, describe, expect, it } from "vitest";
import type { PlanContext } from "../../src/internals/plan.js";
import { fakeRunner, type RunOptions } from "../../src/internals/proc.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import {
  HEADROOM_EXCLUDE_NEWER,
  HEADROOM_MCP_TOOL_NAMES,
  headroomLayout,
  headroomMcpServer,
} from "../../src/tools/headroom.js";
import {
  activateHeadroom,
  headroomRequestFrom,
  removeHeadroomState,
  verifyActiveHeadroom,
} from "../../src/tools/headroom-lifecycle.js";
import { readHeadroomReceipt } from "../../src/tools/headroom-receipt.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporary(prefix: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  roots.push(root);
  return root;
}

interface Call {
  readonly argv: string[];
  readonly options?: RunOptions;
}

function mcpOutput(tools: readonly string[] = HEADROOM_MCP_TOOL_NAMES, statsError = false) {
  return [
    {
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2024-11-05",
        serverInfo: { name: "headroom", version: "1.30.0" },
      },
    },
    { jsonrpc: "2.0", id: 2, result: { tools: tools.map((name) => ({ name })) } },
    {
      jsonrpc: "2.0",
      id: 3,
      result: {
        content: [
          {
            type: "text",
            text: statsError
              ? '{"error": "stats unavailable"}'
              : JSON.stringify({ compressions: 0, retrievals: 0, total_tokens_saved: 0 }),
          },
        ],
        isError: statsError,
      },
    },
  ]
    .map((line) => JSON.stringify(line))
    .join("\n");
}

function fixture(
  behaviour: {
    sync?: { code: number; stderr?: string };
    tools?: readonly string[];
    statsError?: boolean;
    launcherCode?: number;
  } = {},
) {
  const root = temporary("aih-headroom-lifecycle-project-");
  const state = temporary("aih-headroom-lifecycle-state-");
  writeFileSync(join(root, "main.ts"), "export const answer = 42;\n");
  const tools = join(state, "tools");
  mkdirSync(tools);
  const uv = join(tools, process.platform === "win32" ? "uv.exe" : "uv");
  writeFileSync(uv, "fixture uv\n");
  if (process.platform !== "win32") chmodSync(uv, 0o700);
  const calls: Call[] = [];
  const env: NodeJS.ProcessEnv = {
    PATH: tools,
    XDG_STATE_HOME: state,
    LOCALAPPDATA: state,
    HOME: state,
    HTTPS_PROXY: "http://proxy.example:8443",
    OPENAI_API_KEY: "must-not-reach-headroom",
  };
  let layoutRef: ReturnType<typeof headroomLayout> | undefined;
  const run = fakeRunner((argv, options) => {
    calls.push({ argv, ...(options === undefined ? {} : { options }) });
    const layout = layoutRef;
    if (layout === undefined) throw new Error("layout is not ready");
    if (argv.includes("sync")) {
      if (behaviour.sync?.code) return { code: behaviour.sync.code, stderr: behaviour.sync.stderr };
      mkdirSync(layout.environment, { recursive: true });
      return { code: 0, stderr: "Installed 76 packages" };
    }
    if (argv.includes("-c")) return { code: 0, stdout: "aih-headroom-vocabularies-ready\n" };
    if (argv[0] === process.execPath && argv[2] === "headroom") {
      return {
        code: behaviour.launcherCode ?? 0,
        stdout: mcpOutput(behaviour.tools, behaviour.statsError),
      };
    }
    return { code: 127, stderr: `unexpected ${argv.join(" ")}` };
  });
  const ctx: PlanContext = {
    root,
    contextDir: "ai-coding",
    apply: true,
    verify: false,
    json: true,
    run,
    env,
    host: makeHostAdapter({ platform: "linux", run, env }),
    options: {},
  };
  layoutRef = headroomLayout(ctx);
  const deps = {
    platform: "linux" as const,
    arch: "x64",
    now: () => new Date("2026-09-23T12:34:56.789Z"),
    verifyVocabularies: () => undefined,
  };
  return { ctx, calls, layout: layoutRef, uv: realpathSync.native(uv), deps };
}

describe("Headroom activation request", () => {
  it("requires explicit egress consent and rejects contradictory flags", () => {
    expect(headroomRequestFrom({})).toEqual({ activate: false, deactivate: false });
    expect(headroomRequestFrom({ activateHeadroom: true, acceptHeadroomEgress: true })).toEqual({
      activate: true,
      deactivate: false,
    });
    expect(headroomRequestFrom({ deactivateHeadroom: true })).toEqual({
      activate: false,
      deactivate: true,
    });
    expect(() => headroomRequestFrom({ activateHeadroom: true })).toThrow(
      /--activate-headroom requires --accept-headroom-egress/u,
    );
    expect(() => headroomRequestFrom({ acceptHeadroomEgress: true })).toThrow(
      /only valid with --activate-headroom/u,
    );
    expect(() =>
      headroomRequestFrom({
        activateHeadroom: true,
        acceptHeadroomEgress: true,
        deactivateHeadroom: true,
      }),
    ).toThrow(/cannot be combined/u);
  });
});

describe("Headroom activation", () => {
  it("installs the locked runtime, pre-provisions vocabularies, records consent and proves the MCP handshake", async () => {
    const { ctx, calls, layout, uv, deps } = fixture();
    const outcome = await activateHeadroom(ctx, ["claude", "codex"], deps);

    expect(outcome).toMatchObject({ state: "verified", changed: true });
    expect(outcome.detail).toContain("headroom_stats");
    const [sync, vocabularies, handshake] = calls;
    expect(sync?.argv).toEqual([
      uv,
      "--project",
      layout.lockRoot,
      "sync",
      "--locked",
      "--no-python-downloads",
      "--no-config",
      "--no-build",
      "--compile-bytecode",
    ]);
    expect(sync?.options?.env).toMatchObject({
      UV_PROJECT_ENVIRONMENT: layout.environment,
      UV_CACHE_DIR: layout.uvCache,
      UV_EXCLUDE_NEWER: HEADROOM_EXCLUDE_NEWER,
      HTTPS_PROXY: "http://proxy.example:8443",
      HEADROOM_BEACON: "off",
    });
    expect(sync?.options?.env?.UV_OFFLINE).toBeUndefined();
    expect(sync?.options?.env?.OPENAI_API_KEY).toBeUndefined();
    expect(vocabularies?.argv).toEqual([
      uv,
      "--project",
      layout.lockRoot,
      "run",
      "--offline",
      "--no-python-downloads",
      "--no-env-file",
      "--frozen",
      "--no-config",
      "python",
      "-c",
      expect.stringContaining("tiktoken.get_encoding"),
    ]);
    expect(vocabularies?.options?.env?.TIKTOKEN_CACHE_DIR).toBe(layout.tiktokenCache);
    expect(vocabularies?.options?.env?.HTTPS_PROXY).toBe("http://proxy.example:8443");
    const server = headroomMcpServer(ctx);
    expect(handshake?.argv).toEqual([server.command, ...server.args]);
    expect(handshake?.options?.inputSequence).toHaveLength(3);
    expect(calls).toHaveLength(3);

    const receipt = readHeadroomReceipt(layout);
    expect(receipt).toMatchObject({
      state: "valid",
      receipt: {
        consent: {
          activateHeadroom: true,
          acceptHeadroomEgress: true,
          acceptedAt: "2026-09-23T12:34:56.789Z",
        },
        hosts: ["claude", "codex"],
        pin: { package: "headroom-ai[mcp]==0.38.0", platform: "linux-x64" },
        launcher: { server },
      },
    });
  });

  it("keeps the original consent time when an unchanged activation is repeated", async () => {
    const { ctx, layout, deps } = fixture();
    await activateHeadroom(ctx, ["claude"], deps);
    const first = readFileSync(layout.receiptPath, "utf8");
    const again = await activateHeadroom(ctx, ["claude"], {
      ...deps,
      now: () => new Date("2026-09-24T00:00:00.000Z"),
    });
    expect(again).toMatchObject({ state: "verified", changed: false });
    expect(readFileSync(layout.receiptPath, "utf8")).toBe(first);
  });

  it("restores the earlier activation when a changed re-activation fails its handshake", async () => {
    const { ctx, layout, deps } = fixture();
    await activateHeadroom(ctx, ["claude"], deps);
    const first = readFileSync(layout.receiptPath, "utf8");
    const failing = fixture({ launcherCode: 1 });
    const outcome = await activateHeadroom({ ...ctx, run: failing.ctx.run }, ["claude", "codex"], {
      ...deps,
      now: () => new Date("2026-09-24T00:00:00.000Z"),
    });
    expect(outcome.state).toBe("blocked");
    expect(readFileSync(layout.receiptPath, "utf8")).toBe(first);
  });

  it("refuses an unsupported platform before any download", async () => {
    const { ctx, calls, layout, deps } = fixture();
    const outcome = await activateHeadroom(ctx, ["claude"], {
      ...deps,
      platform: "darwin",
      arch: "x64",
    });
    expect(outcome).toMatchObject({ state: "blocked", changed: false });
    expect(outcome.detail).toMatch(/darwin-x64/u);
    expect(calls).toHaveLength(0);
    expect(existsSync(layout.stateRoot)).toBe(false);
  });

  it("reports the exact sync failure and writes no receipt", async () => {
    const { ctx, calls, layout, deps } = fixture({
      sync: { code: 2, stderr: "error: No interpreter found for Python >=3.11, <3.15" },
    });
    const outcome = await activateHeadroom(ctx, ["claude"], deps);
    expect(outcome.state).toBe("blocked");
    expect(outcome.detail).toContain("No interpreter found");
    expect(calls).toHaveLength(1);
    expect(readHeadroomReceipt(layout)).toEqual({ state: "absent" });
  });

  it.each([
    ["a missing tool", { tools: ["headroom_compress", "headroom_retrieve"] }, /omitted/u],
    [
      "an unexpected extra tool",
      { tools: [...HEADROOM_MCP_TOOL_NAMES, "headroom_read"] },
      /outside the reviewed/u,
    ],
    ["a failing stats call", { statsError: true }, /headroom_stats/u],
    ["a launcher exit failure", { launcherCode: 1 }, /launcher failed/u],
  ])("rolls back the receipt when the handshake shows %s", async (_label, behaviour, message) => {
    const { ctx, layout, deps } = fixture(behaviour);
    const outcome = await activateHeadroom(ctx, ["claude"], deps);
    expect(outcome.state).toBe("blocked");
    expect(outcome.detail).toMatch(message);
    expect(readHeadroomReceipt(layout)).toEqual({ state: "absent" });
  });
});

describe("Active Headroom verification and removal", () => {
  it("re-verifies an activated runtime offline without syncing or downloading", async () => {
    const { ctx, calls, deps } = fixture();
    await activateHeadroom(ctx, ["claude"], deps);
    calls.length = 0;
    const outcome = await verifyActiveHeadroom(ctx, deps);
    expect(outcome).toMatchObject({ state: "verified", changed: false });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.argv[2]).toBe("headroom");
  });

  it("reports a failed health check without deactivating", async () => {
    const { ctx, layout, deps } = fixture();
    await activateHeadroom(ctx, ["claude"], deps);
    const failing = fixture({ launcherCode: 1 });
    const outcome = await verifyActiveHeadroom({ ...ctx, run: failing.ctx.run }, deps).catch(
      (error: unknown) => ({ state: "threw", detail: String(error), changed: false }),
    );
    expect(outcome.state).toBe("blocked");
    expect(readHeadroomReceipt(layout).state).toBe("valid");
  });

  it("reports a stale activation with re-activation guidance", async () => {
    const { ctx, layout, deps } = fixture();
    await activateHeadroom(ctx, ["claude"], deps);
    const receipt = JSON.parse(readFileSync(layout.receiptPath, "utf8"));
    receipt.pin.package = "headroom-ai[mcp]==0.37.0";
    writeFileSync(layout.receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
    const outcome = await verifyActiveHeadroom(ctx, deps);
    expect(outcome.state).toBe("blocked");
    expect(outcome.detail).toMatch(/--activate-headroom --accept-headroom-egress/u);
  });

  it("removes the whole AIH-owned Headroom root, runtime and receipt included", async () => {
    const { ctx, layout, deps } = fixture();
    await activateHeadroom(ctx, ["claude"], deps);
    mkdirSync(join(layout.workspace, "nested"), { recursive: true });
    writeFileSync(join(layout.workspace, "nested", "ccr_store.db"), "cached originals");
    expect(removeHeadroomState(ctx)).toMatchObject({ changed: true });
    expect(existsSync(layout.stateRoot)).toBe(false);
    expect(removeHeadroomState(ctx)).toMatchObject({ changed: false });
    expect(existsSync(ctx.root)).toBe(true);
    expect(readFileSync(join(ctx.root, "main.ts"), "utf8")).toContain("answer");
  });
});
