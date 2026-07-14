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
import { basename, join, resolve } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCapability } from "../../src/commands/run.js";
import { executePlan } from "../../src/internals/execute.js";
import type { Action, PlanContext, ProbeAction, WriteAction } from "../../src/internals/plan.js";
import { writeText } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import type { Check } from "../../src/internals/verify.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import {
  assertDiscoverableChildGitRepoName,
  detectChildRepos,
} from "../../src/workspace/detect.js";
import { workspaceGitExecs, workspaceGitignorePatternForRepo } from "../../src/workspace/git.js";
import {
  command,
  snapshotCommand,
  taskPlanCommand,
  workspaceLinkCommand,
} from "../../src/workspace/index.js";
import { parseWorkspaceManifest } from "../../src/workspace/manifest.js";

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

function scaffoldedChild(name: string): void {
  child(name);
  mkdirSync(join(parent, name, "ai-coding"), { recursive: true });
  writeFileSync(join(parent, name, "ai-coding", "RULE_ROUTER.md"), "# Child Router\n", "utf8");
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

function workspaceCliCommand(argv: string[]): Command {
  const cmd = new Command("workspace");
  cmd.exitOverride();
  cmd.configureOutput({ writeOut: () => {}, writeErr: () => {} });
  cmd.argument("[root]");
  cmd
    .option("--apply")
    .option("--verify")
    .option("--json")
    .option("--root <dir>")
    .option("--context-dir <dir>", "", "ai-coding")
    .option("--posture <posture>", "", "vibe")
    .option("--cli <list>")
    .option("--all-tools")
    .option("--detect")
    .option("--force")
    .option("--repos <list>")
    .option("--git");
  cmd.parse(argv, { from: "user" });
  return cmd;
}

async function probeChecks(actions: Action[], ctx: PlanContext): Promise<Check[]> {
  const checks: Check[] = [];
  for (const action of actions) {
    if (action.kind !== "probe") continue;
    checks.push(await action.run(ctx));
  }
  return checks;
}

async function runWorkspace(argv: string[]): Promise<{ code: number; out: string }> {
  let out = "";
  const code = await runCapability(command, workspaceCliCommand(argv), {
    run: fakeRunner(() => undefined),
    env: {},
    write: (text) => {
      out += text;
    },
  });
  return { code, out };
}

function writesByPath(actions: Action[]): Map<string, WriteAction> {
  const m = new Map<string, WriteAction>();
  for (const a of actions) if (a.kind === "write") m.set(a.path.replace(/\\/g, "/"), a);
  return m;
}

describe("detectChildRepos", () => {
  it("does not silently auto-enroll immediate child git repos", () => {
    child("ui");
    child("backend");
    child("docs", false); // no .git → not a repo
    expect(detectChildRepos(parent)).toEqual([]);
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

  it("rejects dash-leading explicit repo path segments before graph MCP argv emission", () => {
    child("--help");
    child("packages/-api");

    expect(() => detectChildRepos(parent, ["--help"])).toThrow(/must not start with '-'/);
    expect(() => detectChildRepos(parent, ["packages/-api"])).toThrow(/must not start with '-'/);
  });

  it("rejects explicit repo paths that are unsafe to render in generated workspace docs", () => {
    expect(() => detectChildRepos(parent, ["bad|name"])).toThrow(/safe to print/);
    expect(() => detectChildRepos(parent, ["bad\nname"])).toThrow(
      "workspace repo path must be safe to print in workspace reports",
    );
  });

  it("fails closed on discovered child git repo names that cannot be reported or gitignored safely", () => {
    expect(() => assertDiscoverableChildGitRepoName("bad\nname")).toThrow(/safe to print/);
    expect(() => assertDiscoverableChildGitRepoName("bad|name")).toThrow(/safe to print/);
    expect(() => assertDiscoverableChildGitRepoName("bad\tname", { printableOnly: false })).toThrow(
      /represented safely in \.gitignore/,
    );
    expect(() =>
      assertDiscoverableChildGitRepoName(String.raw`bad\name`, { printableOnly: false }),
    ).toThrow(/represented safely in \.gitignore/);
    expect(() => assertDiscoverableChildGitRepoName("repo ", { printableOnly: false })).toThrow(
      /represented safely in \.gitignore/,
    );
  });

  it("does not follow linked child directories to git repos outside the workspace parent", () => {
    const external = mkdtempSync(join(tmpdir(), "aih-ws-external-"));
    try {
      mkdirSync(join(external, ".git"), { recursive: true });
      symlinkSync(external, join(parent, "linked"), "junction");

      expect(detectChildRepos(parent)).toEqual([]);
      expect(() => detectChildRepos(parent, ["linked"])).toThrow(/real directory/);
    } finally {
      rmSync(external, { recursive: true, force: true });
    }
  });
});

describe("workspace.plan — generated artifacts", () => {
  it("writes the marker, .code-workspace, cross-repo canon, default bootloader, and spanning MCP", async () => {
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
    expect(w.has("AGENTS.md")).toBe(false);
    expect(w.has("GEMINI.md")).toBe(false);
    expect(w.has(".cursor/rules/00-canon.mdc")).toBe(false);
    expect(w.has(".kiro/steering/00-canon.md")).toBe(false);
    expect(w.has(".mcp.json")).toBe(true);
  });

  it("applies the active managed-only allowlist to generated workspace graph MCPs", async () => {
    child("ui");
    writeFileSync(
      join(parent, "aih-org-policy.json"),
      JSON.stringify({
        schemaVersion: 1,
        minimumPosture: "enterprise",
        references: { repoContract: "ai-coding/project.json" },
        mcp: { allowedServers: [], allowManagedOnly: true },
      }),
    );
    const restrictedCtx: PlanContext = {
      ...makeCtx({ repos: "ui" }),
      posture: "enterprise",
    };
    const restricted = writesByPath((await command.plan(restrictedCtx)).actions).get(".mcp.json");
    expect((restricted?.json as { mcpServers?: Record<string, unknown> }).mcpServers).toEqual({});

    writeFileSync(
      join(parent, "aih-org-policy.json"),
      JSON.stringify({
        schemaVersion: 1,
        minimumPosture: "enterprise",
        references: { repoContract: "ai-coding/project.json" },
        mcp: { allowedServers: [], allowManagedOnly: false },
      }),
    );
    const unrestricted = writesByPath((await command.plan(restrictedCtx)).actions).get(".mcp.json");
    expect(Object.keys((unrestricted?.json as { mcpServers?: Record<string, unknown> }).mcpServers ?? {}))
      .toEqual(["aih-workspace-graph-ui"]);
  });

  it("writes workspace bootloaders for every targeted CLI", async () => {
    child("ui");
    const w = writesByPath(
      (await command.plan(makeCtx({ cli: "claude,codex,gemini,cursor,kiro" }))).actions,
    );

    expect(w.has("CLAUDE.md")).toBe(true);
    expect(w.has("AGENTS.md")).toBe(true);
    expect(w.has("GEMINI.md")).toBe(true);
    expect(w.has(".cursor/rules/00-canon.mdc")).toBe(true);
    expect(w.has(".kiro/steering/00-canon.md")).toBe(true);
    expect(w.get(".cursor/rules/00-canon.mdc")?.contents).toContain("alwaysApply: true");
    expect(w.get(".kiro/steering/00-canon.md")?.contents).toContain("inclusion: always");
    expect(w.get(".kiro/steering/00-canon.md")?.contents).toContain("Workspace graph MCP");
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

    const actions = (await command.plan(makeCtx({ git: true, repos: "service-api,web-client" })))
      .actions;
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
      "stage workspace git baseline files",
      "commit workspace git baseline files",
    ]);
  });

  it("uses an existing git-enabled marker as the workspace git source of truth", async () => {
    child("service-api");
    writeFileSync(
      join(parent, ".aih-workspace.json"),
      JSON.stringify({ contextDir: "ai-coding", repos: ["service-api"], git: true }),
    );

    const actions = (await command.plan(makeCtx())).actions;
    const w = writesByPath(actions);
    const marker = w.get(".aih-workspace.json")?.json as { git?: boolean };

    expect(marker.git).toBe(true);
    expect(w.get(".gitignore")?.contents).toContain("/service-api/");
    expect(actions.filter((a) => a.kind === "exec").map((a) => a.describe)).toEqual([
      "initialize git repository at workspace root",
      "stage workspace git baseline files",
      "commit workspace git baseline files",
    ]);
  });

  it("stages an existing baseline when initializing a missing workspace git repo", async () => {
    mkdirSync(join(parent, "ai-coding"), { recursive: true });
    writeFileSync(join(parent, "ai-coding", "workspace-router.md"), "# Existing\n", "utf8");
    const run = fakeRunner((argv) => {
      if (argv[0] === "git" && argv.includes("rev-parse")) return { code: 1 };
      return undefined;
    });

    const actions = await workspaceGitExecs(makeCtx({}, false, run), [
      writeText("ai-coding/workspace-router.md", "# Existing\n", "workspace router"),
    ]);

    expect(actions.map((a) => a.describe)).toEqual([
      "initialize git repository at workspace root",
      "stage workspace git baseline files",
      "commit workspace git baseline files",
    ]);
    expect(actions[1]?.argv).toEqual([
      "git",
      "-C",
      parent,
      "add",
      "--",
      "ai-coding/workspace-router.md",
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

  it("does not silently enroll undeclared child git repos into marker or MCP scope", async () => {
    child("service-api");
    child("notes");

    const w = writesByPath((await command.plan(makeCtx())).actions);
    const marker = w.get(".aih-workspace.json")?.json as { repos?: string[] };
    const mcp = w.get(".mcp.json")?.json as { mcpServers: Record<string, { args: string[] }> };

    expect(marker.repos).toEqual([]);
    expect(mcp.mcpServers).toEqual({});
  });

  it("with --git defensively ignores undeclared immediate child git repos", async () => {
    child("service-api");
    child("notes");
    child(" leading-space");

    const actions = (await command.plan(makeCtx({ git: true, repos: "service-api" }))).actions;
    const w = writesByPath(actions);
    const marker = w.get(".aih-workspace.json")?.json as { repos?: string[] };
    const ignore = w.get(".gitignore")?.contents ?? "";

    expect(marker.repos).toEqual(["service-api"]);
    expect(ignore.split(/\r?\n/)).toEqual(
      expect.arrayContaining(["/service-api/", "/notes/", "/ leading-space/"]),
    );
  });

  it("with --git escapes gitignore metacharacters in declared and undeclared repos", async () => {
    child("!declared");
    child("#scratch");
    child("literal[set]");

    const actions = (await command.plan(makeCtx({ git: true, repos: "!declared" }))).actions;
    const w = writesByPath(actions);
    const marker = w.get(".aih-workspace.json")?.json as { repos?: string[] };
    const ignore = w.get(".gitignore")?.contents ?? "";
    const ignoreLines = ignore.split(/\r?\n/);

    expect(marker.repos).toEqual(["!declared"]);
    expect(ignoreLines).toContain("/\\!declared/");
    expect(ignoreLines).toContain("/\\#scratch/");
    expect(ignoreLines).toContain("/literal\\[set\\]/");
    expect(ignoreLines).not.toContain("!declared/");
    expect(ignoreLines).not.toContain("#scratch/");
  });

  it("escapes wildcard gitignore metacharacters before writing repo ignore patterns", () => {
    expect(workspaceGitignorePatternForRepo("*")).toBe("/\\*/");
    expect(workspaceGitignorePatternForRepo("literal[set]?")).toBe("/literal\\[set\\]\\?/");
    expect(workspaceGitignorePatternForRepo(String.raw`packages\api`)).toBe("/packages/api/");
    expect(workspaceGitignorePatternForRepo("packages/api")).toBe("/packages/api/");
  });

  it("reports skipped candidates without constructing a shell command from their names", async () => {
    child("api;echo-pwned");

    const docAction = (await command.plan(makeCtx())).actions.find(
      (a) => a.kind === "doc" && a.describe === "workspace auto-enroll skipped",
    );

    expect(docAction?.kind).toBe("doc");
    if (docAction?.kind !== "doc") throw new Error("expected auto-enroll skipped doc");
    expect(docAction.text).toContain("- api;echo-pwned");
    expect(docAction.text).toContain("aih workspace --repos <comma-separated-child-repos> --apply");
    expect(docAction.text).not.toContain("aih workspace --repos api;echo-pwned --apply");
  });

  it("does not render declared repo paths into copy-paste init commands", async () => {
    child("api;echo-pwned");

    const actions = (await command.plan(makeCtx({ repos: "api;echo-pwned" }))).actions;
    const docAction = actions.find(
      (a) => a.kind === "doc" && a.describe === "workspace next steps (run `aih init` per child)",
    );
    const probeAction = actions.find(
      (a): a is ProbeAction => a.kind === "probe" && a.describe.includes("api;echo-pwned"),
    );

    expect(docAction?.kind).toBe("doc");
    if (docAction?.kind !== "doc") throw new Error("expected next steps doc");
    expect(docAction.text).toContain("Declared repos: api;echo-pwned.");
    expect(docAction.text).toContain("cd <child-repo>");
    expect(docAction.text).toContain("aih init --apply");
    expect(docAction.text).not.toContain("aih init ./api;echo-pwned --apply");
    expect(await probeAction?.run(makeCtx())).toMatchObject({
      verdict: "skip",
      detail: "not scaffolded — run `aih init --apply` inside the child repo",
    });
  });

  it("describes declared workspace repos rather than re-reporting candidates as none", async () => {
    child("service-api");

    const docAction = (await command.plan(makeCtx())).actions.find(
      (a) => a.kind === "doc" && a.describe.includes("next steps"),
    );

    expect(docAction?.kind).toBe("doc");
    if (docAction?.kind !== "doc") throw new Error("expected next steps doc");
    expect(docAction.text).toContain("Declared repos: none.");
    expect(docAction.text).not.toContain("Detected repos: none.");
    expect(docAction.text).toContain("no child repos declared");
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

  it("seeds the cross-repo map + spanning MCP with the declared repo names", async () => {
    child("ui");
    child("backend");
    const actions = (await command.plan(makeCtx({ repos: "ui,backend" }))).actions;
    const w = writesByPath(actions);
    const arch = w.get("ai-coding/cross-repo-architecture.md")?.contents ?? "";
    const discipline = w.get("ai-coding/repo-discipline.md")?.contents ?? "";
    expect(arch).toContain("ui/ai-coding/RULE_ROUTER.md");
    expect(arch).toContain("backend/ai-coding/RULE_ROUTER.md");
    expect(discipline).toContain("workspace graph MCP servers");
    expect(discipline).not.toContain("combined workspace graph");
    // The marker + MCP carry the declared repo list and graph scope.
    const marker = w.get(".aih-workspace.json")?.json as {
      repos: string[];
      workspaceType: string;
      graphScope: string;
    };
    expect(marker.repos).toEqual(["ui", "backend"]);
    expect(marker.workspaceType).toBe("multi-repo");
    expect(marker.graphScope).toBe("combined-child-repos");
    const mcp = w.get(".mcp.json")?.json as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    expect(Object.keys(mcp.mcpServers).sort()).toEqual([
      "aih-workspace-graph-backend",
      "aih-workspace-graph-ui",
    ]);
    expect(mcp.mcpServers["aih-workspace-graph-ui"]?.command).toBe("uvx");
    expect(mcp.mcpServers["aih-workspace-graph-ui"]?.args).toEqual([
      "--offline",
      "--no-python-downloads",
      "--no-env-file",
      "code-review-graph@2.3.6",
      "serve",
      "--repo",
      resolve(parent, "ui"),
    ]);
    expect(mcp.mcpServers["aih-workspace-graph-backend"]?.args).toEqual(
      expect.arrayContaining(["--repo", resolve(parent, "backend")]),
    );
    expect(mcp.mcpServers).not.toHaveProperty("filesystem");
  });

  it("uses declared object manifest repos for the VS Code and MCP workspace scopes", async () => {
    mkdirSync(join(parent, "packages", "api", ".git"), { recursive: true });
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
    const mcp = w.get(".mcp.json")?.json as {
      mcpServers: Record<string, { args: string[] }>;
    };

    expect(codeWorkspaceJson.folders).toContainEqual({ path: "packages/api" });
    expect(mcp.mcpServers["aih-workspace-graph-packages-api"]?.args).toEqual(
      expect.arrayContaining(["--repo", resolve(parent, "packages/api")]),
    );
    expect(mcp.mcpServers).not.toHaveProperty("filesystem");
  });

  it("skips absent manifest children from MCP scope and emits a hydrate note", async () => {
    child("ui");
    writeFileSync(
      join(parent, ".aih-workspace.json"),
      JSON.stringify({ contextDir: "ai-coding", repos: ["ui", "backend"] }),
    );

    const actions = (await command.plan(makeCtx())).actions;
    const mcp = writesByPath(actions).get(".mcp.json")?.json as {
      mcpServers: Record<string, { args: string[] }>;
    };
    const absentDoc = actions.find(
      (a) => a.kind === "doc" && a.describe === "workspace child repo absent",
    );
    const absentProbe = actions.find(
      (a): a is ProbeAction => a.kind === "probe" && a.describe === "child backend scaffolded",
    );

    expect(Object.keys(mcp.mcpServers)).toEqual(["aih-workspace-graph-ui"]);
    expect(mcp.mcpServers["aih-workspace-graph-ui"]?.args).toEqual(
      expect.arrayContaining(["--repo", resolve(parent, "ui")]),
    );
    expect(absentDoc?.kind).toBe("doc");
    if (absentDoc?.kind !== "doc") throw new Error("expected absent child doc");
    expect(absentDoc.text).toContain("- backend/");
    expect(absentDoc.text).toContain("aih workspace hydrate --apply");
    expect(absentProbe?.run(makeCtx())).toMatchObject({
      verdict: "skip",
      detail:
        "child repo path is missing — run `aih workspace hydrate --apply` or create the child repo",
    });
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

  it("omits filesystem MCP because client roots can broaden argv scopes", async () => {
    child("ui");
    const w = writesByPath((await command.plan(makeCtx({ repos: "ui" }))).actions);
    const mcp = w.get(".mcp.json")?.json as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };

    expect(mcp.mcpServers).not.toHaveProperty("filesystem");
    expect(mcp.mcpServers["aih-workspace-graph-ui"]?.args).toEqual(
      expect.arrayContaining(["--repo", resolve(parent, "ui")]),
    );
  });

  it("does not emit filesystem MCP even when AIH_MCP_FS_VERSION is set", async () => {
    child("ui");
    const base = makeCtx();
    const ctx = { ...base, env: { ...base.env, AIH_MCP_FS_VERSION: "2025.1.0" } };
    const w = writesByPath((await command.plan(ctx)).actions);
    const mcp = w.get(".mcp.json")?.json as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };

    expect(mcp.mcpServers).not.toHaveProperty("filesystem");
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
    const w = writesByPath((await command.plan(makeCtx({ repos: "ui,backend" }))).actions);
    const router = w.get("ai-coding/workspace-router.md")?.contents ?? "";

    expect(router).toContain("This is a federated workspace, not a monorepo.");
    expect(router).toContain("| backend | backend/ |  |  | backend/ai-coding/RULE_ROUTER.md |");
    expect(router).toContain("| ui | ui/ |  |  | ui/ai-coding/RULE_ROUTER.md |");
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
    const w = writesByPath(
      (await command.plan({ ...makeCtx({ repos: "ui" }), contextDir: "ws-canon" })).actions,
    );
    expect(w.has("ws-canon/cross-repo-architecture.md")).toBe(true);
    expect(w.has("ai-coding/cross-repo-architecture.md")).toBe(false);
    expect(w.get("ws-canon/workspace-router.md")?.contents).toContain("ui/ws-canon/RULE_ROUTER.md");
  });

  it("adds a per-child scaffolded probe (skip until the child is init'd)", async () => {
    child("ui");
    const probeAction = (await command.plan(makeCtx({ repos: "ui" }))).actions.find(
      (a): a is ProbeAction => a.kind === "probe" && a.describe.includes("child ui"),
    );
    expect(probeAction).toBeDefined();
    const res = await probeAction?.run(makeCtx());
    expect(res?.verdict).toBe("skip"); // not scaffolded yet
  });

  it("under enterprise fails when a child .mcp.json contains a policy-denied server", async () => {
    scaffoldedChild("ui");
    writeFileSync(
      join(parent, "ui", ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          "hosted-docs": { type: "http", url: "https://third-party.example/mcp" },
        },
      }),
      "utf8",
    );
    const ctx: PlanContext = { ...makeCtx({ repos: "ui" }), verify: true, posture: "enterprise" };

    const checks = await probeChecks((await command.plan(ctx)).actions, ctx);
    const denied = checks.find((check) => check.code === "mcp.policy-denied");

    expect(denied).toMatchObject({
      verdict: "fail",
      code: "mcp.policy-denied",
    });
    expect(denied?.detail).toContain("ui/.mcp.json");
    expect(denied?.detail).toContain("hosted-docs");
  });

  it("under default posture emits no on-disk MCP policy probe", async () => {
    scaffoldedChild("ui");
    writeFileSync(
      join(parent, "ui", ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          "hosted-docs": { type: "http", url: "https://third-party.example/mcp" },
        },
      }),
      "utf8",
    );

    const actions = (await command.plan(makeCtx({ repos: "ui" }))).actions;

    expect(
      actions.some((action) => action.kind === "probe" && action.describe.includes("MCP policy")),
    ).toBe(false);
  });

  it("sanitizes denied MCP server names before rendering human verification detail", async () => {
    scaffoldedChild("ui");
    writeFileSync(
      join(parent, "ui", ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          "bad\u001b[2Jname": { type: "http", url: "https://third-party.example/mcp" },
        },
      }),
      "utf8",
    );
    const ctx: PlanContext = { ...makeCtx({ repos: "ui" }), verify: true, posture: "enterprise" };

    const checks = await probeChecks((await command.plan(ctx)).actions, ctx);
    const denied = checks.find((check) => check.code === "mcp.policy-denied");

    expect(denied?.detail).not.toContain("\u001b");
    expect(denied?.detail).toContain("bad?[2Jname");
  });

  it("under enterprise skips a child MCP policy probe when .mcp.json is absent", async () => {
    scaffoldedChild("ui");
    const ctx: PlanContext = { ...makeCtx({ repos: "ui" }), verify: true, posture: "enterprise" };

    const checks = await probeChecks((await command.plan(ctx)).actions, ctx);
    const skipped = checks.find((check) => check.name === "child ui MCP policy");

    expect(skipped).toMatchObject({
      verdict: "skip",
      code: "mcp.config-missing",
    });
    expect(skipped?.detail).toContain("ui/.mcp.json is absent");
  });

  it("under enterprise fails closed when child .mcp.json is not a regular file", async () => {
    scaffoldedChild("ui");
    mkdirSync(join(parent, "ui", ".mcp.json"));
    const ctx: PlanContext = { ...makeCtx({ repos: "ui" }), verify: true, posture: "enterprise" };

    const checks = await probeChecks((await command.plan(ctx)).actions, ctx);
    const failed = checks.find((check) => check.name === "child ui MCP policy");

    expect(failed).toMatchObject({
      verdict: "fail",
      code: "mcp.config-invalid",
      detail: expect.stringContaining("not a regular file"),
    });
  });

  it("under enterprise fails closed when child .mcp.json is a symlink", async () => {
    scaffoldedChild("ui");
    const external = mkdtempSync(join(tmpdir(), "aih-ws-mcp-external-"));
    try {
      writeFileSync(
        join(external, "mcp.json"),
        JSON.stringify({ mcpServers: { external: { type: "http", url: "https://example.test" } } }),
        "utf8",
      );
      try {
        symlinkSync(join(external, "mcp.json"), join(parent, "ui", ".mcp.json"), "file");
      } catch {
        return;
      }
      const ctx: PlanContext = {
        ...makeCtx({ repos: "ui" }),
        verify: true,
        posture: "enterprise",
      };

      const checks = await probeChecks((await command.plan(ctx)).actions, ctx);
      const failed = checks.find((check) => check.name === "child ui MCP policy");

      expect(failed).toMatchObject({
        verdict: "fail",
        code: "mcp.config-invalid",
        detail: expect.stringContaining("symlink"),
      });
    } finally {
      rmSync(external, { recursive: true, force: true });
    }
  });

  it("under enterprise allows exact-version workspace graph MCP stdio entries", async () => {
    scaffoldedChild("ui");
    writeFileSync(
      join(parent, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          "aih-workspace-graph-ui": {
            command: "uvx",
            args: [
              "--offline",
              "--no-python-downloads",
              "--no-env-file",
              "code-review-graph@2.3.6",
              "serve",
              "--repo",
              resolve(parent, "ui"),
            ],
          },
        },
      }),
      "utf8",
    );
    const ctx: PlanContext = { ...makeCtx({ repos: "ui" }), verify: true, posture: "enterprise" };

    const checks = await probeChecks((await command.plan(ctx)).actions, ctx);

    expect(checks.some((check) => check.code === "mcp.policy-denied")).toBe(false);
    expect(checks.find((check) => check.name === "parent MCP policy")).toMatchObject({
      verdict: "pass",
    });
  });

  it("under enterprise fails relative stdio wrappers without an exact package pin", async () => {
    scaffoldedChild("ui");
    writeFileSync(
      join(parent, "ui", ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          "local-wrapper": { command: "node", args: ["server.js"] },
        },
      }),
      "utf8",
    );
    const ctx: PlanContext = { ...makeCtx({ repos: "ui" }), verify: true, posture: "enterprise" };

    const checks = await probeChecks((await command.plan(ctx)).actions, ctx);
    const denied = checks.find((check) => check.code === "mcp.policy-denied");

    expect(denied).toMatchObject({
      verdict: "fail",
      code: "mcp.policy-denied",
      detail: expect.stringContaining("local-wrapper"),
    });
    expect(denied?.detail).toContain("unpinned supply chain");
  });

  it("under enterprise ignores @latest-looking metadata outside the resolver package operand", async () => {
    scaffoldedChild("ui");
    writeFileSync(
      join(parent, "ui", ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          "local-graph": {
            command: "uvx",
            args: [
              "--offline",
              "--no-python-downloads",
              "--no-env-file",
              "code-review-graph@2.3.6",
              "--annotation=@latest-review",
            ],
          },
        },
      }),
      "utf8",
    );
    const ctx: PlanContext = { ...makeCtx({ repos: "ui" }), verify: true, posture: "enterprise" };

    const checks = await probeChecks((await command.plan(ctx)).actions, ctx);

    expect(checks.some((check) => check.code === "mcp.policy-denied")).toBe(false);
    expect(checks.find((check) => check.name === "child ui MCP policy")).toMatchObject({
      verdict: "pass",
    });
  });

  it("under enterprise does not apply name-only org-policy approvals to on-disk child MCP egress", async () => {
    scaffoldedChild("ui");
    writeFileSync(
      join(parent, "aih-org-policy.json"),
      JSON.stringify({
        schemaVersion: 1,
        minimumPosture: "team",
        references: { repoContract: "ai-coding/project.json" },
        mcp: {
          allowedServers: ["hosted-docs"],
          approvals: [
            {
              server: "hosted-docs",
              acceptEgress: true,
              reason: "vendor reviewed for workspace docs",
              approvedAt: "2026-07-05T00:00:00.000Z",
            },
          ],
        },
      }),
      "utf8",
    );
    writeFileSync(
      join(parent, "ui", ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          "hosted-docs": { type: "http", url: "https://third-party.example/mcp" },
        },
      }),
      "utf8",
    );
    const ctx: PlanContext = { ...makeCtx({ repos: "ui" }), verify: true, posture: "enterprise" };

    const checks = await probeChecks((await command.plan(ctx)).actions, ctx);
    const denied = checks.find((check) => check.code === "mcp.policy-denied");

    expect(denied).toMatchObject({
      verdict: "fail",
      code: "mcp.policy-denied",
      detail: expect.stringContaining("hosted-docs"),
    });
    expect(denied?.detail).toContain("third-party egress");
    expect(denied?.detail).toContain(
      "org-policy egress approvals do not apply to workspace on-disk MCP configs",
    );
  });

  it("honors org-policy disabled servers when evaluating on-disk child MCP configs", async () => {
    scaffoldedChild("ui");
    writeFileSync(
      join(parent, "aih-org-policy.json"),
      JSON.stringify({
        schemaVersion: 1,
        minimumPosture: "team",
        references: { repoContract: "ai-coding/project.json" },
        mcp: { disabledServers: ["local-graph"] },
      }),
      "utf8",
    );
    writeFileSync(
      join(parent, "ui", ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          "local-graph": {
            command: "uvx",
            args: [
              "--offline",
              "--no-python-downloads",
              "--no-env-file",
              "code-review-graph@2.3.6",
            ],
          },
        },
      }),
      "utf8",
    );
    const ctx: PlanContext = { ...makeCtx({ repos: "ui" }), verify: true, posture: "enterprise" };

    const checks = await probeChecks((await command.plan(ctx)).actions, ctx);
    const denied = checks.find((check) => check.code === "mcp.policy-denied");

    expect(denied).toMatchObject({
      verdict: "fail",
      code: "mcp.policy-denied",
      detail: expect.stringContaining("disabled by org policy"),
    });
  });

  it("under enterprise fails a resolver when the launched package operand is not exactly pinned", async () => {
    scaffoldedChild("ui");
    writeFileSync(
      join(parent, "ui", ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          "fake-pin": {
            command: "npx",
            args: ["-y", "attacker-cli", "code-review-graph@2.3.6"],
          },
        },
      }),
      "utf8",
    );
    const ctx: PlanContext = { ...makeCtx({ repos: "ui" }), verify: true, posture: "enterprise" };

    const checks = await probeChecks((await command.plan(ctx)).actions, ctx);
    const denied = checks.find((check) => check.code === "mcp.policy-denied");

    expect(denied).toMatchObject({
      verdict: "fail",
      code: "mcp.policy-denied",
      detail: expect.stringContaining("fake-pin"),
    });
    expect(denied?.detail).toContain("unpinned supply chain");
  });

  it("under enterprise allows the canonical self-hosted GitHub MCP Docker image", async () => {
    scaffoldedChild("ui");
    writeFileSync(
      join(parent, "ui", ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          github: {
            command: "docker",
            args: [
              "run",
              "-i",
              "--rm",
              "-e",
              "GITHUB_PERSONAL_ACCESS_TOKEN",
              "ghcr.io/github/github-mcp-server:v1.5.0",
            ],
            env: { GITHUB_PERSONAL_ACCESS_TOKEN: "$" + "{GITHUB_PERSONAL_ACCESS_TOKEN}" },
          },
        },
      }),
      "utf8",
    );
    const ctx: PlanContext = { ...makeCtx({ repos: "ui" }), verify: true, posture: "enterprise" };

    const checks = await probeChecks((await command.plan(ctx)).actions, ctx);

    expect(checks.some((check) => check.code === "mcp.policy-denied")).toBe(false);
    expect(checks.find((check) => check.name === "child ui MCP policy")).toMatchObject({
      verdict: "pass",
    });
  });

  it("under enterprise allows the canonical self-hosted GitHub MCP Docker image pinned by digest", async () => {
    scaffoldedChild("ui");
    writeFileSync(
      join(parent, "ui", ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          github: {
            command: "docker",
            args: [
              "run",
              "-i",
              "--rm",
              "-e",
              "GITHUB_PERSONAL_ACCESS_TOKEN",
              `ghcr.io/github/github-mcp-server@sha256:${"a".repeat(64)}`,
            ],
            env: { GITHUB_PERSONAL_ACCESS_TOKEN: "$" + "{GITHUB_PERSONAL_ACCESS_TOKEN}" },
          },
        },
      }),
      "utf8",
    );
    const ctx: PlanContext = { ...makeCtx({ repos: "ui" }), verify: true, posture: "enterprise" };

    const checks = await probeChecks((await command.plan(ctx)).actions, ctx);

    expect(checks.some((check) => check.code === "mcp.policy-denied")).toBe(false);
    expect(checks.find((check) => check.name === "child ui MCP policy")).toMatchObject({
      verdict: "pass",
    });
  });

  it("workspace --verify --posture enterprise --json keeps the error envelope for invalid org policy", async () => {
    child("ui");
    writeFileSync(join(parent, "aih-org-policy.json"), "{ broken", "utf8");

    const { code, out } = await runWorkspace([
      parent,
      "--repos",
      "ui",
      "--verify",
      "--posture",
      "enterprise",
      "--json",
    ]);
    const payload = JSON.parse(out) as { error?: { code?: string; message?: string } };

    expect(code).toBe(1);
    expect(payload.error).toMatchObject({ code: "AIH_ORG_POLICY" });
    expect(payload.error?.message).toContain("aih-org-policy");
  });

  it("workspace --verify --posture enterprise exits non-zero for child MCP policy denial", async () => {
    scaffoldedChild("ui");
    writeFileSync(
      join(parent, "ui", ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          "hosted-docs": { type: "http", url: "https://third-party.example/mcp" },
        },
      }),
      "utf8",
    );

    const { code, out } = await runWorkspace([
      parent,
      "--repos",
      "ui",
      "--verify",
      "--posture",
      "enterprise",
      "--json",
    ]);
    const payload = JSON.parse(out) as { report?: { checks?: Check[] } };

    expect(code).toBe(1);
    expect(payload.report?.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          verdict: "fail",
          code: "mcp.policy-denied",
          detail: expect.stringContaining("hosted-docs"),
        }),
      ]),
    );
  });
});

describe("workspace link command", () => {
  it("registers a child repo, preserves string repos, and authors a contract edge", async () => {
    writeFileSync(
      join(parent, ".aih-workspace.json"),
      JSON.stringify(
        {
          contextDir: "ai-coding",
          repos: ["ui"],
          unknownFutureField: { keep: true },
        },
        null,
        2,
      ),
    );

    const actions = (
      await workspaceLinkCommand.plan(
        makeCtx({
          path: "backend",
          repoKind: "api",
          owner: "platform",
          from: "ui",
          to: "backend",
          kind: "api-contract",
          contract: "backend/openapi.yaml",
          consumer: "ui/src/api",
        }),
      )
    ).actions;
    const writes = writesByPath(actions);
    const marker = writes.get(".aih-workspace.json")?.json as {
      repos?: unknown[];
      edges?: unknown[];
      unknownFutureField?: unknown;
    };
    const router = writes.get("ai-coding/workspace-router.md")?.contents ?? "";
    const contracts = writes.get("ai-coding/workspace-contracts.md")?.contents ?? "";

    expect([...writes.keys()].sort()).toEqual([
      ".aih-workspace.json",
      "ai-coding/workspace-contracts.md",
      "ai-coding/workspace-router.md",
    ]);
    expect(marker.unknownFutureField).toEqual({ keep: true });
    expect(marker.repos).toEqual([
      "ui",
      {
        id: "backend",
        path: "backend",
        kind: "api",
        owner: "platform",
        router: "ai-coding/RULE_ROUTER.md",
      },
    ]);
    expect(marker.edges).toEqual([
      {
        id: "ui-backend-api-contract",
        from: "ui",
        to: "backend",
        kind: "api-contract",
        contractPath: "backend/openapi.yaml",
        consumerPath: "ui/src/api",
      },
    ]);
    expect(router).toContain(
      "| backend | backend/ | api | platform | backend/ai-coding/RULE_ROUTER.md |",
    );
    expect(contracts).toContain(
      "| ui-backend-api-contract | ui | backend | api-contract | backend/openapi.yaml | ui/src/api |",
    );
  });

  it("fails verify without writing when an edge references a missing repo id", async () => {
    writeFileSync(
      join(parent, ".aih-workspace.json"),
      JSON.stringify({ contextDir: "ai-coding", repos: ["ui"] }),
    );

    const actions = (
      await workspaceLinkCommand.plan(
        makeCtx({
          path: "backend",
          from: "ui",
          to: "missing",
          kind: "api-contract",
        }),
      )
    ).actions;
    const checks = await probeChecks(actions, makeCtx());

    expect(writesByPath(actions).size).toBe(0);
    expect(checks).toEqual([
      expect.objectContaining({
        verdict: "fail",
        detail: expect.stringContaining("missing"),
      }),
    ]);
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
      if (tail === "rev-parse HEAD")
        return { stdout: "abcdef0123456789abcdef0123456789abcdef01\n" };
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
      repos: [
        {
          id: "ui",
          path: "ui",
          branch: "main",
          sha: "abcdef0123456789abcdef0123456789abcdef01",
          dirty: false,
        },
      ],
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

  it("rejects unsafe snapshot labels before writing local or shared snapshots", async () => {
    child("ui");
    writeFileSync(
      join(parent, ".aih-workspace.json"),
      JSON.stringify({ repos: ["ui"], contextDir: "ai-coding" }),
    );

    for (const label of [
      "known\n## Injected",
      "<img src=x onerror=alert(1)>",
      "[run this](command:workbench.action.terminal.new)",
      "`aih workspace hydrate --apply`",
    ]) {
      await expect(snapshotCommand.plan(makeCtx({ label, lock: true }))).rejects.toThrow(
        /workspace snapshot label must be safe to print/,
      );
    }
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

  it("rejects unsafe task text before generating Markdown", async () => {
    child("ui");
    writeFileSync(
      join(parent, ".aih-workspace.json"),
      JSON.stringify({ repos: ["ui"], contextDir: "ai-coding" }),
    );

    for (const task of [
      "ship fix\n## Injected",
      "<img src=x onerror=alert(1)>",
      "[run this](command:workbench.action.terminal.new)",
      "`aih workspace hydrate --apply`",
    ]) {
      await expect(taskPlanCommand.plan(makeCtx({ task }))).rejects.toThrow(
        /workspace task description must be safe to print/,
      );
    }
  });
});

describe("workspace docs/source alignment", () => {
  it("does not document unimplemented latest snapshots or commit-count deltas", () => {
    const bridge = readFileSync(
      join(process.cwd(), "docs", "workspace", "federated-bridge.md"),
      "utf8",
    );
    const roadmap = readFileSync(
      join(process.cwd(), "docs", "roadmap", "workspace-and-skills-roadmap.md"),
      "utf8",
    );

    expect(bridge).not.toContain(".aih/workspace-snapshots/latest.json");
    expect(bridge).not.toMatch(/\+\d+ commits/);
    expect(roadmap).not.toContain(".aih/workspace-snapshots/latest.json");
    expect(roadmap).not.toContain("updates latest.json");
    expect(roadmap).toContain("<contextDir>/workspace-lock.json");
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
    expect(ignore.split(/\r?\n/)).toEqual(
      expect.arrayContaining(["/service-api/", "/web-client/"]),
    );
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

  it("replaces stale managed graph MCP scope while preserving user MCP servers", async () => {
    child("service-api");
    child("notes");
    writeFileSync(
      join(parent, ".mcp.json"),
      JSON.stringify(
        {
          mcpServers: {
            filesystem: {
              command: "npx",
              args: ["-y", "@modelcontextprotocol/server-filesystem@2026.1.14", "notes"],
            },
            "code-review-graph": {
              command: "uvx",
              args: [
                "--offline",
                "--no-python-downloads",
                "--no-env-file",
                "code-review-graph@2.3.6",
                "serve",
              ],
            },
            "aih-workspace-graph-notes": {
              command: "uvx",
              args: [
                "--offline",
                "--no-python-downloads",
                "--no-env-file",
                "code-review-graph@2.3.6",
                "serve",
                "--repo",
                "notes",
              ],
            },
            "user-owned": {
              command: "node",
              args: ["server.js"],
            },
          },
        },
        null,
        2,
      ),
    );

    await executePlan(
      await command.plan(makeCtx({ repos: "service-api" }, true)),
      makeCtx({}, true),
    );

    const mcp = JSON.parse(readFileSync(join(parent, ".mcp.json"), "utf8")) as {
      mcpServers: Record<string, { command: string; args: string[] } | undefined>;
    };
    expect(mcp.mcpServers.filesystem).toEqual({
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem@2026.1.14", "notes"],
    });
    expect(mcp.mcpServers).not.toHaveProperty("code-review-graph");
    expect(mcp.mcpServers).not.toHaveProperty("aih-workspace-graph-notes");
    expect(mcp.mcpServers["aih-workspace-graph-service-api"]?.args).toEqual([
      "--offline",
      "--no-python-downloads",
      "--no-env-file",
      "code-review-graph@2.3.6",
      "serve",
      "--repo",
      resolve(parent, "service-api"),
    ]);
    expect(mcp.mcpServers["user-owned"]).toEqual({ command: "node", args: ["server.js"] });
  });

  it("preserves user-owned MCP servers that use formerly managed names", async () => {
    child("service-api");
    writeFileSync(
      join(parent, ".mcp.json"),
      JSON.stringify(
        {
          mcpServers: {
            filesystem: {
              command: "npx",
              args: ["-y", "@modelcontextprotocol/server-filesystem@2026.1.14", "."],
            },
            "code-review-graph": {
              command: "uvx",
              args: ["custom-wrapper", "code-review-graph@2.3.6", "serve"],
            },
            "aih-workspace-graph-notes": {
              command: "uvx",
              args: ["custom-wrapper", "code-review-graph@2.3.6", "serve", "--repo", "notes"],
            },
          },
        },
        null,
        2,
      ),
    );

    await executePlan(
      await command.plan(makeCtx({ repos: "service-api" }, true)),
      makeCtx({}, true),
    );

    const mcp = JSON.parse(readFileSync(join(parent, ".mcp.json"), "utf8")) as {
      mcpServers: Record<string, { command: string; args: string[] } | undefined>;
    };
    expect(mcp.mcpServers.filesystem).toEqual({
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem@2026.1.14", "."],
    });
    expect(mcp.mcpServers["code-review-graph"]).toEqual({
      command: "uvx",
      args: ["custom-wrapper", "code-review-graph@2.3.6", "serve"],
    });
    expect(mcp.mcpServers["aih-workspace-graph-notes"]).toEqual({
      command: "uvx",
      args: ["custom-wrapper", "code-review-graph@2.3.6", "serve", "--repo", "notes"],
    });
    expect(mcp.mcpServers["aih-workspace-graph-service-api"]?.args).toEqual(
      expect.arrayContaining(["--repo", resolve(parent, "service-api")]),
    );
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
    expect(ignore.match(/^\/service-api\/$/gm)).toHaveLength(1);
    expect(ignore.match(/^\*\.aih\.bak$/gm)).toHaveLength(1);
    expect(ran).not.toContain(`git -C ${parent} init`);
    expect(ran.some((cmd) => cmd.includes(" commit "))).toBe(false);
  });

  it("applies --repos over an object-form manifest without corrupting the repo list", async () => {
    child("api");
    child("web");
    child("worker");
    writeFileSync(
      join(parent, ".aih-workspace.json"),
      JSON.stringify(
        {
          contextDir: "ai-coding",
          repos: [
            { id: "api", path: "api", kind: "backend", owner: "platform" },
            { id: "web", path: "web", kind: "frontend" },
          ],
          edges: [
            {
              id: "web-api",
              from: "web",
              to: "api",
              kind: "api-contract",
              contractPath: "api/openapi.yaml",
            },
          ],
          unknownFutureField: { keep: true },
        },
        null,
        2,
      ),
    );
    const ctx = makeCtx({ repos: "api,web,worker" }, true);

    await executePlan(await command.plan(ctx), ctx);

    const raw = JSON.parse(readFileSync(join(parent, ".aih-workspace.json"), "utf8"));
    const parsed = parseWorkspaceManifest(raw, "ai-coding");
    expect(parsed.status).toBe("OK");
    expect(raw.repos).toEqual([
      { id: "api", path: "api", kind: "backend", owner: "platform" },
      { id: "web", path: "web", kind: "frontend" },
      { id: "worker", path: "worker", router: "ai-coding/RULE_ROUTER.md" },
    ]);
    expect(raw.edges).toHaveLength(1);
    expect(raw.unknownFutureField).toEqual({ keep: true });
  });

  it("round-trips per-child remote and ref when re-applying an object manifest", async () => {
    child("api");
    child("web");
    writeFileSync(
      join(parent, ".aih-workspace.json"),
      JSON.stringify(
        {
          contextDir: "ai-coding",
          repos: [
            {
              id: "api",
              path: "api",
              kind: "backend",
              remote: "https://github.com/acme/api.git",
              ref: "release/v1.5.0",
            },
          ],
        },
        null,
        2,
      ),
    );
    const ctx = makeCtx({ repos: "api,web" }, true);

    await executePlan(await command.plan(ctx), ctx);

    const raw = JSON.parse(readFileSync(join(parent, ".aih-workspace.json"), "utf8"));
    const parsed = parseWorkspaceManifest(raw, "ai-coding");
    expect(parsed.status).toBe("OK");
    expect(raw.repos).toEqual([
      {
        id: "api",
        path: "api",
        kind: "backend",
        remote: "https://github.com/acme/api.git",
        ref: "release/v1.5.0",
      },
      { id: "web", path: "web", router: "ai-coding/RULE_ROUTER.md" },
    ]);
    expect(parsed.repos[0]).toMatchObject({
      id: "api",
      path: "api",
      remote: "https://github.com/acme/api.git",
      ref: "release/v1.5.0",
    });
  });

  it("honors explicit --repos paths even when an existing object id matches another path", async () => {
    child("api");
    writeFileSync(
      join(parent, ".aih-workspace.json"),
      JSON.stringify(
        {
          contextDir: "ai-coding",
          repos: [{ id: "api", path: "services/api", kind: "backend" }],
        },
        null,
        2,
      ),
    );
    const ctx = makeCtx({ repos: "api" }, true);

    await executePlan(await command.plan(ctx), ctx);

    const raw = JSON.parse(readFileSync(join(parent, ".aih-workspace.json"), "utf8"));
    expect(raw.repos).toEqual([{ id: "api", path: "api", router: "ai-coding/RULE_ROUTER.md" }]);
  });
});
