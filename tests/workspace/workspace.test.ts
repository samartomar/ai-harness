import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executePlan } from "../../src/internals/execute.js";
import type { Action, PlanContext, ProbeAction, WriteAction } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import { detectChildRepos } from "../../src/workspace/detect.js";
import { command } from "../../src/workspace/index.js";

let parent: string;
beforeEach(() => {
  parent = mkdtempSync(join(tmpdir(), "aih-ws-"));
});
afterEach(() => {
  rmSync(parent, { recursive: true, force: true });
});

/** Create a child dir, optionally a git repo. */
function child(name: string, git = true): void {
  mkdirSync(join(parent, name), { recursive: true });
  if (git) mkdirSync(join(parent, name, ".git"), { recursive: true });
}

function makeCtx(options: Record<string, unknown> = {}, apply = false): PlanContext {
  const run = fakeRunner(() => undefined);
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

function writesByPath(actions: Action[]): Map<string, WriteAction> {
  const m = new Map<string, WriteAction>();
  for (const a of actions) if (a.kind === "write") m.set(a.path.replace(/\\/g, "/"), a);
  return m;
}

describe("detectChildRepos", () => {
  it("auto-detects immediate subdirs containing .git, sorted", () => {
    child("ui");
    child("backend");
    child("docs", false); // no .git → not a repo
    expect(detectChildRepos(parent)).toEqual(["backend", "ui"]);
  });

  it("honors an explicit repo list (filtered to existing)", () => {
    child("ui");
    expect(detectChildRepos(parent, ["ui", "missing"])).toEqual(["ui"]);
  });
});

describe("workspace.plan — generated artifacts", () => {
  it("writes the marker, .code-workspace, cross-repo canon, bootloaders, and spanning MCP", async () => {
    child("ui");
    child("backend");
    const w = writesByPath((await command.plan(makeCtx())).actions);
    expect(w.has(".aih-workspace.json")).toBe(true);
    expect([...w.keys()].some((p) => p.endsWith(".code-workspace"))).toBe(true);
    expect(w.has("ai-coding/cross-repo-architecture.md")).toBe(true);
    expect(w.has("ai-coding/repo-discipline.md")).toBe(true);
    expect(w.has("CLAUDE.md")).toBe(true);
    expect(w.has("AGENTS.md")).toBe(true);
    expect(w.has(".mcp.json")).toBe(true);
  });

  it("seeds the cross-repo map + spanning MCP with the detected repo names", async () => {
    child("ui");
    child("backend");
    const actions = (await command.plan(makeCtx())).actions;
    const w = writesByPath(actions);
    const arch = w.get("ai-coding/cross-repo-architecture.md")?.contents ?? "";
    expect(arch).toContain("ui/ai-coding/RULE_ROUTER.md");
    expect(arch).toContain("backend/ai-coding/RULE_ROUTER.md");
    // The marker + MCP carry the repo list.
    const marker = w.get(".aih-workspace.json")?.json as { repos: string[]; workspaceType: string };
    expect(marker.repos).toEqual(["backend", "ui"]);
    expect(marker.workspaceType).toBe("multi-repo");
    const mcp = w.get(".mcp.json")?.json as { mcpServers: { filesystem: { args: string[] } } };
    expect(mcp.mcpServers.filesystem.args).toEqual(expect.arrayContaining(["ui", "backend"]));
  });

  it("the cross-repo architecture map is write-once (never overwritten)", async () => {
    child("ui");
    const arch = writesByPath((await command.plan(makeCtx())).actions).get(
      "ai-coding/cross-repo-architecture.md",
    );
    expect(arch?.once).toBe(true);
  });

  it("honors --context-dir for the canon paths", async () => {
    child("ui");
    const w = writesByPath((await command.plan({ ...makeCtx(), contextDir: "ws-canon" })).actions);
    expect(w.has("ws-canon/cross-repo-architecture.md")).toBe(true);
    expect(w.has("ai-coding/cross-repo-architecture.md")).toBe(false);
  });

  it("adds a per-child scaffolded probe (skip until the child is init'd)", async () => {
    child("ui");
    const probeAction = (await command.plan(makeCtx())).actions.find(
      (a): a is ProbeAction => a.kind === "probe" && a.describe.includes("child ui"),
    );
    expect(probeAction).toBeDefined();
    const res = await probeAction?.run(makeCtx());
    expect(res?.verdict).toBe("skip"); // not scaffolded yet
  });
});

describe("workspace — write-once executor behavior", () => {
  it("preserves a user-edited cross-repo map on re-apply (effect: kept)", async () => {
    child("ui");
    const applied = makeCtx({}, true);
    await executePlan(await command.plan(applied), applied);

    // User edits the seeded map.
    const archPath = join(parent, "ai-coding/cross-repo-architecture.md");
    writeFileSync(archPath, "# My own cross-repo notes\n", "utf8");

    // Re-apply: the write-once file is kept, not overwritten.
    const res = await executePlan(await command.plan(applied), applied);
    expect(readFileSync(archPath, "utf8")).toBe("# My own cross-repo notes\n");
    const kept = res.writes.find(
      (x) => x.path.replace(/\\/g, "/") === "ai-coding/cross-repo-architecture.md",
    );
    expect(kept?.effect).toBe("kept");
  });
});
