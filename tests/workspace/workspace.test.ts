import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executePlan } from "../../src/internals/execute.js";
import type { Action, PlanContext, ProbeAction, WriteAction } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import { detectChildRepos } from "../../src/workspace/detect.js";
import { command, snapshotCommand, taskPlanCommand } from "../../src/workspace/index.js";

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

  it("rejects explicit repo paths that are unsafe to render in generated workspace docs", () => {
    expect(() => detectChildRepos(parent, ["bad|name"])).toThrow(/safe to print/);
    expect(() => detectChildRepos(parent, ["bad\nname"])).toThrow(
      "workspace repo path must be safe to print in workspace reports",
    );
  });

  it("does not follow linked child directories to git repos outside the workspace parent", () => {
    const external = mkdtempSync(join(tmpdir(), "aih-ws-external-"));
    try {
      mkdirSync(join(external, ".git"), { recursive: true });
      symlinkSync(external, join(parent, "linked"), "junction");

      expect(detectChildRepos(parent)).toEqual([]);
      expect(() => detectChildRepos(parent, ["linked"])).toThrow(/not git repos/);
    } finally {
      rmSync(external, { recursive: true, force: true });
    }
  });
});

describe("workspace.plan — generated artifacts", () => {
  it("writes the marker, .code-workspace, cross-repo canon, bootloaders, and spanning MCP", async () => {
    child("ui");
    child("backend");
    const w = writesByPath((await command.plan(makeCtx())).actions);
    expect(w.has(".aih-workspace.json")).toBe(true);
    expect([...w.keys()].some((p) => p.endsWith(".code-workspace"))).toBe(true);
    expect(w.has("ai-coding/workspace-router.md")).toBe(true);
    expect(w.has("ai-coding/workspace-contracts.md")).toBe(true);
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
    const ignoreLines = ignore.split(/\r?\n/);
    expect(ignore).toContain("service-api/");
    expect(ignore).toContain("web-client/");
    expect(ignoreLines).toContain(".aih/");
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

  it("with --git supports an empty workspace root", async () => {
    const actions = (await command.plan(makeCtx({ git: true }))).actions;
    const w = writesByPath(actions);
    const marker = w.get(".aih-workspace.json")?.json as { git?: boolean; repos?: string[] };
    const ignore = w.get(".gitignore")?.contents ?? "";

    expect(marker.git).toBe(true);
    expect(marker.repos).toEqual([]);
    expect(ignore.split(/\r?\n/)).toEqual(
      expect.arrayContaining([".aih/", ".aih/reports/", ".aih/runs/", "*.aih.bak", "*.aih.tmp"]),
    );
    expect(actions.filter((a) => a.kind === "exec")).toHaveLength(3);
    expect(actions.some((a) => a.kind === "probe" && a.describe.includes("child"))).toBe(false);
  });

  it("with --git keeps remote setup explicitly user-owned", async () => {
    child("service-api");
    const actions = (await command.plan(makeCtx({ git: true }))).actions;
    const doc = actions.find((a) => a.kind === "doc" && a.describe.includes("next steps"));

    expect(doc?.kind).toBe("doc");
    if (doc?.kind !== "doc") throw new Error("expected next-steps doc");
    expect(doc.text).toContain("Remote setup is user/team-owned");
    expect(doc.text).not.toContain("git remote add");
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
    expect(mcp.mcpServers["code-review-graph"].args).toEqual([
      "--offline",
      "--no-python-downloads",
      "--no-env-file",
      "code-review-graph@2.3.6",
      "serve",
    ]);
    expect(mcp.mcpServers.filesystem.args).toEqual(expect.arrayContaining(["ui", "backend"]));
  });

  it("uses declared object manifest repos for the VS Code and MCP workspace scopes", async () => {
    writeFileSync(
      join(parent, ".aih-workspace.json"),
      JSON.stringify({
        contextDir: "ai-coding",
        repos: [{ id: "api", path: "packages/api", kind: "service" }],
      }),
    );

    const w = writesByPath((await command.plan(makeCtx())).actions);
    const codeWorkspaceWrite = [...w.values()].find((write) =>
      write.path.endsWith(".code-workspace"),
    );
    const codeWorkspaceJson = codeWorkspaceWrite?.json as { folders: { path: string }[] };
    const mcp = w.get(".mcp.json")?.json as { mcpServers: { filesystem: { args: string[] } } };

    expect(codeWorkspaceJson.folders).toContainEqual({ path: "packages/api" });
    expect(mcp.mcpServers.filesystem.args).toEqual(expect.arrayContaining(["packages/api"]));
  });

  it("rejects manifest-declared repo paths that point through links outside the workspace", async () => {
    const external = mkdtempSync(join(tmpdir(), "aih-ws-external-"));
    try {
      mkdirSync(join(external, ".git"), { recursive: true });
      symlinkSync(external, join(parent, "linked"), "junction");
      writeFileSync(
        join(parent, ".aih-workspace.json"),
        JSON.stringify({ contextDir: "ai-coding", repos: [{ id: "linked", path: "linked" }] }),
      );

      await expect(command.plan(makeCtx())).rejects.toThrow(/real directory/);
    } finally {
      rmSync(external, { recursive: true, force: true });
    }
  });

  it("fails closed when the existing workspace manifest has validation errors", async () => {
    child("ui");
    writeFileSync(
      join(parent, ".aih-workspace.json"),
      JSON.stringify({ repos: ["ui", "../escape"], contextDir: "ai-coding" }),
    );

    await expect(command.plan(makeCtx())).rejects.toThrow(/valid \.aih-workspace\.json/);
  });

  it("pins the filesystem MCP package by default", async () => {
    child("ui");
    const w = writesByPath((await command.plan(makeCtx())).actions);
    const mcp = w.get(".mcp.json")?.json as { mcpServers: { filesystem: { args: string[] } } };

    expect(mcp.mcpServers.filesystem.args).toContain(
      "@modelcontextprotocol/server-filesystem@2026.1.14",
    );
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

  it("rejects non-version filesystem MCP specs from AIH_MCP_FS_VERSION", async () => {
    child("ui");
    const base = makeCtx();
    const ctx = { ...base, env: { ...base.env, AIH_MCP_FS_VERSION: "latest" } };

    await expect(command.plan(ctx)).rejects.toThrow(/exact semver/);
  });

  it("the cross-repo architecture map is write-once (never overwritten)", async () => {
    child("ui");
    const arch = writesByPath((await command.plan(makeCtx())).actions).get(
      "ai-coding/cross-repo-architecture.md",
    );
    expect(arch?.once).toBe(true);
  });

  it("generates a federated workspace router that links child rule routers", async () => {
    child("ui");
    child("backend");
    const w = writesByPath((await command.plan(makeCtx())).actions);
    const router = w.get("ai-coding/workspace-router.md")?.contents ?? "";

    expect(router).toContain("This is a federated workspace, not a monorepo.");
    expect(router).toContain("| backend | backend/ |  | backend/ai-coding/RULE_ROUTER.md |");
    expect(router).toContain("| ui | ui/ |  | ui/ai-coding/RULE_ROUTER.md |");
    expect(router).toContain("Before editing a child repo, read that child repo's router first.");
  });

  it("generates parent-owned workspace contract docs from declared manifest edges", async () => {
    child("ui");
    child("backend");
    writeFileSync(
      join(parent, ".aih-workspace.json"),
      JSON.stringify(
        {
          repos: ["ui", "backend"],
          edges: [
            {
              id: "ui-backend-api",
              from: "ui",
              to: "backend",
              kind: "api-contract",
              contractPath: "backend/openapi.yaml",
              consumerPath: "ui/src/api",
            },
          ],
        },
        null,
        2,
      ),
    );

    const w = writesByPath((await command.plan(makeCtx())).actions);
    const contracts = w.get("ai-coding/workspace-contracts.md")?.contents ?? "";

    expect(contracts).toContain("| ui-backend-api | ui | backend | api-contract |");
    expect(contracts).toContain("backend/openapi.yaml");
    expect(contracts).toContain("No child files are modified by this workspace contract document.");
  });

  it("honors --context-dir for the canon paths", async () => {
    child("ui");
    const w = writesByPath((await command.plan({ ...makeCtx(), contextDir: "ws-canon" })).actions);
    expect(w.has("ws-canon/cross-repo-architecture.md")).toBe(true);
    expect(w.has("ai-coding/cross-repo-architecture.md")).toBe(false);
    expect(w.get("ws-canon/workspace-router.md")?.contents).toContain("ui/ws-canon/RULE_ROUTER.md");
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

describe("workspace snapshot command", () => {
  it("writes a local snapshot of child branches, SHAs, and dirty state", async () => {
    child("ui");
    writeFileSync(
      join(parent, ".aih-workspace.json"),
      JSON.stringify({ repos: ["ui"], contextDir: "ai-coding" }),
    );
    const run = fakeRunner((argv) => {
      if (argv[0] !== "git") return undefined;
      const tail = argv.slice(3).join(" ");
      if (tail === "rev-parse --is-inside-work-tree") return { stdout: "true\n" };
      if (tail === "rev-parse --abbrev-ref HEAD") return { stdout: "main\n" };
      if (tail === "rev-parse --short HEAD") return { stdout: "abc123\n" };
      if (tail === "status --porcelain") return { stdout: "" };
      return undefined;
    });

    const actions = (await snapshotCommand.plan(makeCtx({ label: "known good" }, false, run)))
      .actions;
    const writes = writesByPath(actions);
    const snapshot = [...writes.values()].find((w) =>
      w.path.replace(/\\/g, "/").startsWith(".aih/workspace-snapshots/"),
    );

    expect(snapshot?.path).toMatch(/known-good\.json$/);
    expect(snapshot?.json).toMatchObject({
      schemaVersion: 1,
      label: "known good",
      repos: [{ id: "ui", path: "ui", branch: "main", sha: "abc123", dirty: false }],
    });
    expect(writes.get(".gitignore")?.contents).toContain(".aih/");
  });

  it("--lock writes the shared workspace lock under the context dir", async () => {
    child("ui");
    writeFileSync(
      join(parent, ".aih-workspace.json"),
      JSON.stringify({ repos: ["ui"], contextDir: "ai-coding" }),
    );
    const actions = (await snapshotCommand.plan(makeCtx({ lock: true }))).actions;

    expect(writesByPath(actions).has("ai-coding/workspace-lock.json")).toBe(true);
  });

  it("fails closed when the workspace manifest has validation errors", async () => {
    child("ui");
    writeFileSync(
      join(parent, ".aih-workspace.json"),
      JSON.stringify({ repos: ["ui", "../escape"], contextDir: "ai-coding" }),
    );

    await expect(snapshotCommand.plan(makeCtx())).rejects.toThrow(/valid \.aih-workspace\.json/);
  });

  it("fails closed when a manifest repo path points through a link outside the workspace", async () => {
    const external = mkdtempSync(join(tmpdir(), "aih-ws-external-"));
    try {
      mkdirSync(join(external, ".git"), { recursive: true });
      symlinkSync(external, join(parent, "linked"), "junction");
      writeFileSync(
        join(parent, ".aih-workspace.json"),
        JSON.stringify({ repos: ["linked"], contextDir: "ai-coding" }),
      );

      await expect(snapshotCommand.plan(makeCtx())).rejects.toThrow(/real directory/);
    } finally {
      rmSync(external, { recursive: true, force: true });
    }
  });
});

describe("workspace plan command", () => {
  it("writes a multi-repo task plan under .aih/workspace-plans only under apply", async () => {
    child("ui");
    child("backend");
    writeFileSync(
      join(parent, ".aih-workspace.json"),
      JSON.stringify({
        contextDir: "ai-coding",
        repos: [
          { id: "ui", path: "ui", kind: "frontend" },
          { id: "backend", path: "backend", kind: "api" },
        ],
        edges: [
          {
            id: "ui-backend-api",
            from: "ui",
            to: "backend",
            kind: "api-contract",
            contractPath: "backend/openapi.yaml",
            consumerPath: "ui/src/api",
          },
        ],
      }),
    );

    const actions = (
      await taskPlanCommand.plan(makeCtx({ task: "change login API and update UI" }))
    ).actions;
    const writes = writesByPath(actions);
    const planWrite = [...writes.values()].find((w) =>
      w.path.replace(/\\/g, "/").startsWith(".aih/workspace-plans/"),
    );
    const text = planWrite?.contents ?? "";

    expect(planWrite?.path).toMatch(/change-login-api-and-update-ui\.md$/);
    expect(text).toContain("# Workspace Plan");
    expect(text).toContain("## Read Order");
    expect(text).toContain("backend/ai-coding/RULE_ROUTER.md");
    expect(text).toContain("ui/ai-coding/RULE_ROUTER.md");
    expect(text).toContain("ui-backend-api");
    expect(text).toContain("## Rollback");
    expect(writes.get(".gitignore")?.contents).toContain(".aih/");
  });

  it("fails closed when the workspace manifest has validation errors", async () => {
    child("ui");
    writeFileSync(
      join(parent, ".aih-workspace.json"),
      JSON.stringify({ repos: ["ui", "../escape"], contextDir: "ai-coding" }),
    );

    await expect(taskPlanCommand.plan(makeCtx({ task: "ship workspace fix" }))).rejects.toThrow(
      /valid \.aih-workspace\.json/,
    );
  });

  it("keeps task text on one printable line in generated Markdown", async () => {
    child("ui");
    writeFileSync(
      join(parent, ".aih-workspace.json"),
      JSON.stringify({ repos: ["ui"], contextDir: "ai-coding" }),
    );

    const actions = (
      await taskPlanCommand.plan(makeCtx({ task: "ship fix\n## Injected\n| bad | table |" }))
    ).actions;
    const text =
      actions.find((action): action is WriteAction => action.kind === "write")?.contents ?? "";

    expect(text).toContain("Task: ship fix ## Injected bad table");
    expect(text).not.toContain("\n## Injected");
    expect(text).not.toContain("| bad | table |");
  });
});

describe("workspace — relative root (regression: AIH_PATH_CONTAINMENT on '..code-workspace')", () => {
  it("derives the workspace name from the resolved root when invoked with '.'", async () => {
    child("ui");
    const prevCwd = process.cwd();
    process.chdir(parent);
    try {
      // basename(".") is "." — before resolving, the plan wrote "..code-workspace",
      // which the executor's containment guard rejected as a parent escape.
      const ctx = { ...makeCtx({}, true), root: "." };
      await executePlan(await command.plan(ctx), ctx);
      expect(existsSync(join(parent, `${basename(process.cwd())}.code-workspace`))).toBe(true);
      expect(existsSync(join(parent, "..code-workspace"))).toBe(false);
    } finally {
      process.chdir(prevCwd);
    }
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
      if (argv[0] === "git" && argv.slice(3).join(" ") === "config --get user.email") {
        return { stdout: "agent@example.test" };
      }
      if (argv[0] === "git" && argv.slice(3).join(" ") === "config --get user.name") {
        return { stdout: "AI Harness" };
      }
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

  it("fails before writing when a baseline commit needs missing git identity", async () => {
    child("service-api");
    const run = fakeRunner((argv) => {
      if (argv[0] === "git" && argv.includes("rev-parse")) return { code: 1 };
      if (argv[0] === "git" && argv.slice(3).join(" ") === "config --get user.email") {
        return { code: 1 };
      }
      if (argv[0] === "git" && argv.slice(3).join(" ") === "config --get user.name") {
        return { code: 1 };
      }
      return undefined;
    });
    const ctx = makeCtx({ git: true }, true, run);

    await expect(command.plan(ctx)).rejects.toThrow(/git identity/);
    expect(existsSync(join(parent, ".aih-workspace.json"))).toBe(false);
    expect(existsSync(join(parent, ".gitignore"))).toBe(false);
  });

  it("re-applies --git without duplicating ignores or committing a clean tree", async () => {
    child("service-api");
    writeFileSync(join(parent, ".gitignore"), "custom.log\nservice-api/\n*.aih.bak\n", "utf8");
    const ran: string[] = [];
    const run = fakeRunner((argv) => {
      if (argv[0] === "git") ran.push(argv.join(" "));
      if (argv[0] === "git" && argv.includes("rev-parse")) return { stdout: "true" };
      if (argv[0] === "git" && argv.slice(3).join(" ") === "config --get user.email") {
        return { stdout: "agent@example.test" };
      }
      if (argv[0] === "git" && argv.slice(3).join(" ") === "config --get user.name") {
        return { stdout: "AI Harness" };
      }
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
