import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PlanContext } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import {
  defaultNativeRuntimeLayout,
  managedCodeReviewGraphCliInvocation,
} from "../../src/mcp/default-native-runtime.js";
import { makeHostAdapter } from "../../src/platform/detect.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function context(): PlanContext {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "aih-graph-helper-project-")));
  const state = realpathSync(mkdtempSync(join(tmpdir(), "aih-graph-helper-state-")));
  roots.push(root, state);
  const run = fakeRunner(() => undefined);
  const tools = join(state, "host-tools");
  mkdirSync(tools);
  writeFileSync(join(tools, process.platform === "win32" ? "uv.exe" : "uv"), "fixture executable", {
    mode: 0o755,
  });
  const env = { XDG_STATE_HOME: state, PATH: tools, OPENAI_API_KEY: "do-not-pass" };
  return {
    root,
    contextDir: "ai-coding",
    apply: false,
    verify: false,
    json: false,
    run,
    env,
    host: makeHostAdapter({ platform: "linux", run, env }),
    options: {},
  };
}

describe("managed Code Review Graph CLI invocation", () => {
  it("uses compact Windows-only state segments for Python import path headroom", () => {
    const ctx = context();
    const localAppData = ctx.env.XDG_STATE_HOME as string;
    const windowsContext: PlanContext = {
      ...ctx,
      env: { ...ctx.env, LOCALAPPDATA: localAppData },
      host: makeHostAdapter({ platform: "windows", run: ctx.run, env: ctx.env }),
    };

    const layout = defaultNativeRuntimeLayout(windowsContext);
    const normalized = (path: string) => relative(localAppData, path).replaceAll("\\", "/");

    expect(normalized(layout.graphStateRoot)).toMatch(/^aih\/d\/p\/[a-f0-9]{20}\/g$/u);
    expect(normalized(layout.serenaStateRoot)).toMatch(/^aih\/d\/p\/[a-f0-9]{20}\/s$/u);
    expect(normalized(layout.uvCache)).toBe("aih/d/r/u");
    expect(normalized(layout.memoryPayloadRoot)).toBe("aih/d/r/m");
    expect(normalized(layout.tokenOptimizerRoot)).toBe("aih/d/r/t");
  });

  it("authenticates the packaged lock and places run-only uv flags after run", () => {
    const invocation = managedCodeReviewGraphCliInvocation(context(), "status");
    expect(invocation.argv.slice(0, 9)).toEqual([
      expect.stringMatching(/[\\/]host-tools[\\/]uv(?:\.exe)?$/u),
      "--project",
      expect.stringMatching(/[\\/]default-mcp-runtime$/u),
      "run",
      "--offline",
      "--no-python-downloads",
      "--no-env-file",
      "--frozen",
      "code-review-graph",
    ]);
    expect(invocation.argv).toContain("status");
    expect(invocation.argv).toContain("--json");
    expect(invocation.argv[invocation.argv.indexOf("--repo") + 1]).toBe(invocation.cwd);
    expect(invocation.env.CRG_OPENAI_API_KEY).toBeUndefined();
    expect(invocation.env.OPENAI_API_KEY).toBeUndefined();
    expect(invocation.env.UV_OFFLINE).toBe("1");
  });

  it("resolves uv outside the project even when a project executable precedes it on PATH", () => {
    const ctx = context();
    const name = process.platform === "win32" ? "uv.exe" : "uv";
    writeFileSync(join(ctx.root, name), "untrusted project executable", { mode: 0o755 });
    ctx.env.PATH = [ctx.root, ctx.env.PATH].join(process.platform === "win32" ? ";" : ":");
    expect(managedCodeReviewGraphCliInvocation(ctx, "status").argv[0]).not.toBe(
      join(ctx.root, name),
    );
    ctx.env.PATH = ctx.root;
    expect(() => managedCodeReviewGraphCliInvocation(ctx, "status")).toThrow(
      "external absolute PATH",
    );
  });

  it.each(["graphStateRoot", "uvCache"] as const)(
    "rejects redirected %s before returning an invocation",
    (field) => {
      const ctx = context();
      const target = realpathSync(mkdtempSync(join(tmpdir(), "aih-foreign-graph-state-")));
      roots.push(target);
      const layout = defaultNativeRuntimeLayout(ctx);
      mkdirSync(dirname(layout[field]), { recursive: true });
      symlinkSync(target, layout[field], process.platform === "win32" ? "junction" : "dir");
      expect(() => managedCodeReviewGraphCliInvocation(ctx, "status")).toThrow(
        /linked path segment/,
      );
      expect(existsSync(join(target, "runtime-env"))).toBe(false);
    },
  );

  it("rejects a linked ancestor of the state cache", () => {
    const ctx = context();
    const target = realpathSync(mkdtempSync(join(tmpdir(), "aih-foreign-graph-cache-")));
    roots.push(target);
    const cacheParent = dirname(defaultNativeRuntimeLayout(ctx).uvCache);
    mkdirSync(dirname(cacheParent), { recursive: true });
    symlinkSync(target, cacheParent, process.platform === "win32" ? "junction" : "dir");
    expect(() => managedCodeReviewGraphCliInvocation(ctx, "status")).toThrow(/linked path segment/);
    expect(existsSync(join(target, "uv-cache"))).toBe(false);
  });

  it("refuses project-contained state before creating directories", () => {
    const ctx = context();
    ctx.env.XDG_STATE_HOME = ctx.root;
    expect(() => managedCodeReviewGraphCliInvocation(ctx, "status")).toThrow(
      /disjoint from the project/,
    );
    expect(existsSync(join(ctx.root, "aih"))).toBe(false);
  });
});
