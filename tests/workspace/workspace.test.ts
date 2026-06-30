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

function makeCtx(
  options: Record<string, unknown> = {},
  apply = false,
  run = fakeRunner(() => undefined),
): PlanContext {
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
    expect(detectChildRepos(parent, ["ui"])).toEqual(["ui"]);
  });

  it("fails closed when an explicit repo is missing or not a git repo", () => {
    child("ui");
    child("docs", false);
    expect(() => detectChildRepos(parent, ["ui", "missing"])).toThrow(/do not exist/);
    expect(() => detectChildRepos(parent, ["docs"])).toThrow(/not git repos/);
  });

  it("rejects absolute or parent-traversing explicit repo paths", () => {
    expect(() => detectChildRepos(parent, ["../other"])).toThrow(/traverse/);
    expect(() => detectChildRepos(parent, ["C:/other"])).toThrow(/relative/);
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

  it("without --git preserves parent-only workspace behavior", async () => {
    child("service-api");
    const actions = (await command.plan(makeCtx())).actions;
    const marker = writesByPath(actions).get(".aih-workspace.json")?.json as { git?: boolean };

    expect(marker.git).toBeUndefined();
    expect(actions.some((a) => a.kind === "write" && a.path === ".gitignore")).toBe(false);
    expect(actions.some((a) => a.kind === "exec")).toBe(false);
  });

  it("with --git records the workspace git marker and plans gitignore plus local git execs", async () => {
    child("service-api");
    child("web-client");

    const actions = (await command.plan(makeCtx({ git: true }))).actions;
    const w = writesByPath(actions);
    const marker = w.get(".aih-workspace.json")?.json as { git?: boolean; repos?: string[] };
    const ignore = w.get(".gitignore")?.contents ?? "";

    expect(marker.git).toBe(true);
    expect(marker.repos).toEqual(["service-api", "web-client"]);
    expect(ignore).toContain("service-api/");
    expect(ignore).toContain("web-client/");
    expect(ignore).toContain(".aih/reports/");
    expect(ignore).toContain(".aih/runs/");
    expect(ignore).toContain("*.aih.bak");
    expect(ignore).toContain("*.aih.tmp");
    expect(actions.filter((a) => a.kind === "exec").map((a) => a.describe)).toEqual([
      "initialize git repository at workspace root",
      "stage changed workspace git baseline files",
      "commit changed workspace git baseline files",
    ]);
  });

  it("seeds the cross-repo map + spanning MCP with the detected repo names", async () => {
    child("ui");
    child("backend");
    const actions = (await command.plan(makeCtx())).actions;
    const w = writesByPath(actions);
    const arch = w.get("ai-coding/cross-repo-architecture.md")?.contents ?? "";
    expect(arch).toContain("ui/ai-coding/RULE_ROUTER.md");
    expect(arch).toContain("backend/ai-coding/RULE_ROUTER.md");
    // The marker + MCP carry the repo list and combined graph scope.
    const marker = w.get(".aih-workspace.json")?.json as {
      repos: string[];
      workspaceType: string;
      graphScope: string;
    };
    expect(marker.repos).toEqual(["backend", "ui"]);
    expect(marker.workspaceType).toBe("multi-repo");
    expect(marker.graphScope).toBe("combined-child-repos");
    const mcp = w.get(".mcp.json")?.json as {
      mcpServers: {
        "code-review-graph": { command: string; args: string[] };
        filesystem: { args: string[] };
      };
    };
    expect(mcp.mcpServers["code-review-graph"].command).toBe("uvx");
    expect(mcp.mcpServers["code-review-graph"].args).toEqual(["code-review-graph@2.3.6", "serve"]);
    expect(mcp.mcpServers.filesystem.args).toEqual(expect.arrayContaining(["ui", "backend"]));
  });

  it("pins the filesystem MCP package via AIH_MCP_FS_VERSION (AIH-SUPPLY-001)", async () => {
    child("ui");
    const base = makeCtx();
    const ctx = { ...base, env: { ...base.env, AIH_MCP_FS_VERSION: "2025.1.0" } };
    const w = writesByPath((await command.plan(ctx)).actions);
    const mcp = w.get(".mcp.json")?.json as { mcpServers: { filesystem: { args: string[] } } };
    expect(mcp.mcpServers.filesystem.args).toContain(
      "@modelcontextprotocol/server-filesystem@2025.1.0",
    );
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

  it("applies --git by initializing and committing the workspace baseline", async () => {
    child("service-api");
    child("web-client");
    const ran: string[] = [];
    const run = fakeRunner((argv) => {
      if (argv[0] === "git") ran.push(argv.join(" "));
      if (argv[0] === "git" && argv.includes("rev-parse")) return { code: 1 };
      if (argv[0] === "git" && argv.includes("diff")) return { code: 1 };
      return undefined;
    });
    const ctx = makeCtx({ git: true }, true, run);

    await executePlan(await command.plan(ctx), ctx);

    const marker = JSON.parse(readFileSync(join(parent, ".aih-workspace.json"), "utf8")) as {
      git?: boolean;
    };
    const ignore = readFileSync(join(parent, ".gitignore"), "utf8");
    expect(marker.git).toBe(true);
    expect(ignore).toContain("service-api/");
    expect(ignore).toContain("web-client/");
    expect(ran).toContain(`git -C ${parent} init`);
    const stage = ran.find((cmd) => cmd.startsWith(`git -C ${parent} add -- `)) ?? "";
    const commit = ran.find((cmd) => cmd.startsWith(`git -C ${parent} commit -m `)) ?? "";
    expect(stage).toContain(".aih-workspace.json");
    expect(stage).toContain(".gitignore");
    expect(stage).not.toContain("service-api/");
    expect(stage).not.toContain("web-client/");
    expect(commit).toContain("chore: initialize workspace config (aih workspace --git)");
    expect(commit).toContain(".aih-workspace.json");
  });

  it("re-applies --git without duplicating ignores or committing a clean tree", async () => {
    child("service-api");
    writeFileSync(join(parent, ".gitignore"), "custom.log\nservice-api/\n*.aih.bak\n", "utf8");
    const ran: string[] = [];
    const run = fakeRunner((argv) => {
      if (argv[0] === "git") ran.push(argv.join(" "));
      if (argv[0] === "git" && argv.includes("rev-parse")) return { stdout: "true" };
      if (argv[0] === "git" && argv.includes("diff")) return { code: 0 };
      return undefined;
    });
    const ctx = makeCtx({ git: true }, true, run);

    await executePlan(await command.plan(ctx), ctx);
    ran.length = 0;
    await executePlan(await command.plan(ctx), ctx);

    const ignore = readFileSync(join(parent, ".gitignore"), "utf8");
    expect(ignore.match(/^service-api\/$/gm)).toHaveLength(1);
    expect(ignore.match(/^\*\.aih\.bak$/gm)).toHaveLength(1);
    expect(ran).not.toContain(`git -C ${parent} init`);
    expect(ran.some((cmd) => cmd.includes(" commit "))).toBe(false);
  });
});
