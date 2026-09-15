import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { PlanContext } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { defaultNativeMcpServers } from "../../src/mcp/default-native-runtime.js";
import { coreLocalMcpServers } from "../../src/mcp/servers.js";
import { makeHostAdapter } from "../../src/platform/detect.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function context(): PlanContext {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "aih-native-route-project-")));
  const state = realpathSync(mkdtempSync(join(tmpdir(), "aih-native-route-state-")));
  roots.push(root, state);
  const tools = join(state, "tools");
  mkdirSync(tools);
  writeFileSync(join(tools, process.platform === "win32" ? "uv.exe" : "uv"), "uv", {
    mode: 0o755,
  });
  const run = fakeRunner(() => undefined);
  const env = { XDG_STATE_HOME: state, HOME: state, PATH: tools };
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

describe("qualified native MCP routes", () => {
  it("emits 2.3.8 and native Memory 0.10.8 only through the root-aware guarded catalog", () => {
    const legacy = coreLocalMcpServers();
    const graphLegacy = legacy["code-review-graph"];
    const memoryLegacy = legacy["codebase-memory-mcp"];
    expect(graphLegacy?.type === "stdio" ? graphLegacy.args : []).toContain(
      "code-review-graph@2.3.7",
    );
    expect(graphLegacy?.type === "stdio" ? graphLegacy.args : []).not.toContain(
      "code-review-graph@2.3.8",
    );
    expect(memoryLegacy?.type === "stdio" ? memoryLegacy.args : []).toContain(
      "codebase-memory-mcp@0.10.5",
    );
    expect(memoryLegacy?.type === "stdio" ? memoryLegacy.args : []).not.toContain(
      "codebase-memory-mcp@0.10.8",
    );

    const managed = defaultNativeMcpServers(context());
    expect(JSON.stringify(managed["code-review-graph"])).toContain("code-review-graph==2.3.8");
    expect(JSON.stringify(managed["codebase-memory-mcp"])).toContain("codebase-memory-mcp==0.10.8");
    expect(
      managed["code-review-graph"]?.type === "stdio"
        ? managed["code-review-graph"].command
        : undefined,
    ).toBe(process.execPath);
    expect(
      managed["codebase-memory-mcp"]?.type === "stdio"
        ? managed["codebase-memory-mcp"].command
        : undefined,
    ).toBe(process.execPath);
  });
});
