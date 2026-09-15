import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
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

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(statuses = ['{"nodes":18,"files":2}'], failed = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "aih-scale-managed-project-")));
  const state = realpathSync(mkdtempSync(join(tmpdir(), "aih-scale-managed-state-")));
  roots.push(root, state);
  const tools = join(state, "host-tools");
  mkdirSync(tools);
  const uvPath = join(tools, process.platform === "win32" ? "uv.exe" : "uv");
  writeFileSync(uvPath, "fixture executable", { mode: 0o755 });
  const uv = realpathSync.native(uvPath);
  const calls: { argv: string[]; options?: RunOptions }[] = [];
  let statusIndex = 0;
  const run = fakeRunner((argv, options) => {
    calls.push({ argv, options });
    if (argv[0] === "git") return { code: 0, stdout: "sample.ts\n" };
    if (argv[0] === uv && argv.includes("run")) {
      if (failed) return { code: 1, stderr: "fixture runtime unavailable" };
      return {
        code: 0,
        stdout: argv.includes("status") ? statuses[statusIndex++] : "",
      };
    }
    if (argv[0] === "which") return { code: 0, stdout: `/ambient/${argv[1]}` };
    return { code: 0, stdout: "Nodes: 999\nFiles: 99\n" };
  });
  const env = {
    XDG_STATE_HOME: state,
    PATH: tools,
    OPENAI_API_KEY: "fixture-do-not-forward",
    CRG_OPENAI_BASE_URL: "https://fixture.invalid",
    CRG_OPENAI_EMBEDDING_MODEL: "fixture-model",
  };
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
  const server = defaultNativeMcpServers(ctx)["code-review-graph"];
  if (server?.type !== "stdio" || !server.args)
    throw new Error("fixture Graph registration is missing");
  const writeServer = () =>
    writeFileSync(
      join(root, ".mcp.json"),
      JSON.stringify({ mcpServers: { "code-review-graph": server } }),
    );
  writeServer();
  return { ctx, calls, server, writeServer, uv };
}

describe("scale safety with the managed Graph runtime", () => {
  it("checks the authenticated lock and project state instead of an ambient graph", async () => {
    const { ctx, calls, uv } = fixture();
    const result = await scaleSafetyCheck(ctx, { requireGraph: true });
    expect(result.verdict).toBe("pass");
    expect(result.detail).toContain("2 files, 18 nodes");
    const probes = calls.filter(({ argv }) => argv[0] !== "git");
    expect(probes).toHaveLength(1);
    const probe = probes[0];
    if (!probe) throw new Error("Graph status invocation is missing");
    const layout = defaultNativeRuntimeLayout(ctx);
    expect(probe.argv.slice(0, 4)).toEqual([uv, "--project", layout.defaultMcpLockRoot, "run"]);
    expect(probe.argv).toContain("--frozen");
    expect(probe.argv).toContain("--json");
    expect(probe.argv[probe.argv.indexOf("--data-dir") + 1]).toBe(layout.graphStateRoot);
    expect(probe.options?.cwd).toBe(ctx.root);
    expect(probe.options?.env?.UV_OFFLINE).toBe("1");
    expect(probe.options?.env?.OPENAI_API_KEY).toBeUndefined();
    expect(probe.options?.env?.CRG_OPENAI_BASE_URL).toBeUndefined();
    expect(probe.options?.env?.CRG_OPENAI_EMBEDDING_MODEL).toBeUndefined();
  });

  it("rebuilds an empty managed graph offline in the same isolated state", async () => {
    const { ctx, calls } = fixture(['{"nodes":0,"files":0}', '{"nodes":18,"files":2}']);
    const result = await scaleSafetyCheck(ctx, { requireGraph: true });
    expect(result.verdict).toBe("pass");
    expect(result.detail).toContain("rebuilt offline");
    const probes = calls.filter(({ argv }) => argv[0] !== "git");
    expect(probes.map(({ argv }) => (argv.includes("build") ? "build" : "status"))).toEqual([
      "status",
      "build",
      "status",
    ]);
    expect(
      probes.every(
        ({ argv, options }) =>
          argv.includes("--offline") && options?.env?.OPENAI_API_KEY === undefined,
      ),
    ).toBe(true);
  });

  it("reports a failed managed runtime without accepting an ambient healthy graph", async () => {
    const { ctx, calls } = fixture(undefined, true);
    const result = await scaleSafetyCheck(ctx, { requireGraph: true });
    expect(result.verdict).not.toBe("pass");
    expect(result.detail).toContain("fixture runtime unavailable");
    expect(calls.filter(({ argv }) => argv[0] !== "git")).toHaveLength(1);
  });

  it.each(["worktree", "launcher", "mode", "env"])(
    "rejects a stale managed %s without running it",
    async (field) => {
      const { ctx, calls, server, writeServer } = fixture();
      if (!server.args) throw new Error("fixture Graph args are missing");
      switch (field) {
        case "worktree":
          server.args[server.args.indexOf("--project") + 1] = join(ctx.root, "other-worktree");
          break;
        case "launcher":
          server.args[0] = join(ctx.root, "untrusted-launcher.js");
          break;
        case "mode":
          server.args[1] = "wrong-mode";
          break;
        case "env":
          server.env = { OPENAI_API_KEY: "fixture-do-not-forward" };
          break;
      }
      writeServer();
      const result = await scaleSafetyCheck(ctx, { requireGraph: true });
      expect(result.verdict).not.toBe("pass");
      expect(result.detail).toContain("managed Graph registration is stale");
      expect(calls.filter(({ argv }) => argv[0] !== "git")).toHaveLength(0);
    },
  );

  it("does not rebuild or claim readiness from malformed managed status counts", async () => {
    const { ctx, calls } = fixture(['{"nodes":"18","files":2}']);
    const result = await scaleSafetyCheck(ctx, { requireGraph: true });
    expect(result.verdict).not.toBe("pass");
    expect(result.detail).toContain("status output was invalid");
    expect(calls.filter(({ argv }) => argv[0] !== "git")).toHaveLength(1);
  });
});
