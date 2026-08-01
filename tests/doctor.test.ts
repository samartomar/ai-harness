import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AIH_CONFIG_FILE } from "../src/config/marker.js";
import { command } from "../src/doctor.js";
import { executePlan } from "../src/internals/execute.js";
import type { Action, PlanContext, ProbeAction } from "../src/internals/plan.js";
import { fakeRunner, type Runner } from "../src/internals/proc.js";
import { makeHostAdapter } from "../src/platform/detect.js";

/** A ctx whose `which` probe reports the given binaries as present. */
function ctx(present: string[] = []): PlanContext {
  const run = fakeRunner((argv) => {
    if ((argv[0] === "which" || argv[0] === "where") && present.includes(argv[1] ?? "")) {
      return { code: 0, stdout: `/usr/bin/${argv[1]}` };
    }
    return { code: 1, spawnError: true };
  });
  return {
    root: process.cwd(),
    contextDir: "ai-coding",
    apply: false,
    verify: true,
    json: false,
    run,
    host: makeHostAdapter({ platform: "linux", run, env: {} }),
    env: {},
    options: {},
  };
}

function findProbe(actions: Action[], needle: string): ProbeAction | undefined {
  return actions.find((a): a is ProbeAction => a.kind === "probe" && a.describe.includes(needle));
}

describe("doctor — dev tools probe", () => {
  it("passes when rg, fd, and jq are all present", async () => {
    const c = ctx(["rg", "fd", "jq"]);
    const probe = findProbe((await command.plan(c)).actions, "dev tools");
    expect(probe).toBeDefined();
    const res = await probe?.run(c);
    expect(res?.verdict).toBe("pass");
  });

  it("skips (never fails) and names what's missing, with a VDI hint", async () => {
    const c = ctx(["rg"]);
    const probe = findProbe((await command.plan(c)).actions, "dev tools");
    const res = await probe?.run(c);
    expect(res?.verdict).toBe("skip");
    expect(res?.detail).toContain("fd");
    expect(res?.detail).toContain("jq");
    expect(res?.detail).toContain("PATH");
  });
});

describe("doctor — large-repo graph safety", () => {
  function scaleCtx(files: number, present: string[] = []): PlanContext {
    const run = fakeRunner((argv) => {
      if (argv[0] === "git" && argv.slice(3).join(" ") === "ls-files") {
        return {
          code: 0,
          stdout: Array.from({ length: files }, (_, i) => `src/file-${i}.ts`).join("\n"),
        };
      }
      if ((argv[0] === "which" || argv[0] === "where") && present.includes(argv[1] ?? "")) {
        return { code: 0, stdout: `/usr/bin/${argv[1]}` };
      }
      return { code: 1, spawnError: true };
    });
    return {
      root: dir,
      contextDir: "ai-coding",
      apply: false,
      verify: true,
      json: false,
      run,
      host: makeHostAdapter({ platform: "linux", run, env: {} }),
      env: {},
      options: {},
    };
  }

  const populatedGraphStatus = [
    "Nodes: 5454",
    "Edges: 64205",
    "Files: 388",
    "Languages: javascript, bash, typescript",
  ].join("\n");

  const emptyGraphStatus = [
    "Nodes: 0",
    "Edges: 0",
    "Files: 0",
    "Languages: ",
    "Last updated: never",
  ].join("\n");

  function writeGraphMcp(): void {
    writeFileSync(
      join(dir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          "code-review-graph": {
            type: "stdio",
            command: "uvx",
            args: ["code-review-graph@2.3.6", "serve"],
          },
        },
      }),
    );
  }

  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "aih-doctor-scale-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("passes small repos without requiring code-review-graph", async () => {
    const c = scaleCtx(12);
    const probe = findProbe((await command.plan(c)).actions, "large-repo graph safety");
    const res = await probe?.run(c);
    expect(res?.verdict).toBe("pass");
    expect(res?.detail).toContain("tracked files <");
  });

  it("fails large repos when graph is neither installed nor MCP-configured", async () => {
    const c = scaleCtx(1000);
    const probe = findProbe((await command.plan(c)).actions, "large-repo graph safety");
    const res = await probe?.run(c);
    expect(res?.verdict).toBe("fail");
    expect(res?.code).toBe("scale.code-review-graph-missing");
    expect(res?.detail).toContain("advisory, not a gate");
    expect(res?.detail).toContain("warn once and continue with bounded rg/fd reconnaissance");
    expect(res?.detail).not.toContain("Stop repository work");
  });

  it("passes large repos when the repo MCP graph is configured and uvx is available", async () => {
    writeGraphMcp();
    const run = fakeRunner((argv) => {
      if (argv[0] === "git" && argv.slice(3).join(" ") === "ls-files") {
        return {
          code: 0,
          stdout: Array.from({ length: 1000 }, (_, i) => `src/file-${i}.ts`).join("\n"),
        };
      }
      if ((argv[0] === "which" || argv[0] === "where") && argv[1] === "uvx") {
        return { code: 0, stdout: "/usr/bin/uvx" };
      }
      if (argv[0] === "uvx" && argv.includes("status")) {
        return { code: 0, stdout: populatedGraphStatus };
      }
      return { code: 1, spawnError: true };
    });
    const c = {
      ...scaleCtx(1000, ["uvx"]),
      run,
      host: makeHostAdapter({ platform: "linux", run, env: {} }),
    };
    const probe = findProbe((await command.plan(c)).actions, "large-repo graph safety");
    const res = await probe?.run(c);
    expect(res?.verdict).toBe("pass");
    expect(res?.detail).toContain("repo MCP code-review-graph configured");
  });

  it("does not trust a symlinked repo MCP config for large-repo graph readiness", async () => {
    const outside = mkdtempSync(join(tmpdir(), "aih-doctor-scale-mcp-"));
    try {
      writeFileSync(
        join(outside, ".mcp.json"),
        JSON.stringify({
          mcpServers: {
            "code-review-graph": {
              type: "stdio",
              command: "uvx",
              args: ["code-review-graph@2.3.6", "serve"],
            },
          },
        }),
      );
      symlinkSync(join(outside, ".mcp.json"), join(dir, ".mcp.json"), "file");
      const c = scaleCtx(1000, ["uvx"]);

      const probe = findProbe((await command.plan(c)).actions, "large-repo graph safety");
      const res = await probe?.run(c);

      expect(res?.verdict).toBe("fail");
      expect(res?.code).toBe("scale.code-review-graph-missing");
      expect(res?.detail).toContain("no code-review-graph binary and no repo MCP");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("uses uv tool run when uvx is unavailable but uv is available", async () => {
    writeGraphMcp();
    const calls: string[][] = [];
    const run = fakeRunner((argv) => {
      calls.push(argv);
      if (argv[0] === "git" && argv.slice(3).join(" ") === "ls-files") {
        return {
          code: 0,
          stdout: Array.from({ length: 1000 }, (_, i) => `src/file-${i}.ts`).join("\n"),
        };
      }
      if ((argv[0] === "which" || argv[0] === "where") && argv[1] === "uv") {
        return { code: 0, stdout: "/usr/bin/uv" };
      }
      if (
        argv[0] === "uv" &&
        argv.slice(1, 3).join(" ") === "tool run" &&
        argv.includes("status")
      ) {
        return { code: 0, stdout: populatedGraphStatus };
      }
      return { code: 1, spawnError: true };
    });
    const c = {
      ...scaleCtx(1000, ["uv"]),
      run,
      host: makeHostAdapter({ platform: "linux", run, env: {} }),
    };

    const probe = findProbe((await command.plan(c)).actions, "large-repo graph safety");
    const res = await probe?.run(c);

    expect(res?.verdict).toBe("pass");
    expect(calls).toContainEqual([
      "uv",
      "tool",
      "run",
      "--offline",
      "--no-python-downloads",
      "--no-env-file",
      "code-review-graph@2.3.6",
      "status",
      "--repo",
      dir,
    ]);
  });

  it("builds the repo MCP graph offline when status reports zero nodes or files", async () => {
    writeGraphMcp();
    const calls: string[][] = [];
    let statusCalls = 0;
    const run = fakeRunner((argv) => {
      calls.push(argv);
      if (argv[0] === "git" && argv.slice(3).join(" ") === "ls-files") {
        return {
          code: 0,
          stdout: Array.from({ length: 1000 }, (_, i) => `src/file-${i}.ts`).join("\n"),
        };
      }
      if ((argv[0] === "which" || argv[0] === "where") && argv[1] === "uvx") {
        return { code: 0, stdout: "/usr/bin/uvx" };
      }
      if (argv[0] === "uvx" && argv.includes("status")) {
        statusCalls += 1;
        return { code: 0, stdout: statusCalls === 1 ? emptyGraphStatus : populatedGraphStatus };
      }
      if (argv[0] === "uvx" && argv.includes("build")) {
        return { code: 0, stdout: "Full build: 388 files, 5479 nodes, 64735 edges" };
      }
      return { code: 1, spawnError: true };
    });
    const c = {
      ...scaleCtx(1000, ["uvx"]),
      run,
      host: makeHostAdapter({ platform: "linux", run, env: {} }),
    };

    const probe = findProbe((await command.plan(c)).actions, "large-repo graph safety");
    const res = await probe?.run(c);

    expect(res?.verdict).toBe("pass");
    expect(res?.detail).toContain("rebuilt offline");
    expect(calls).toContainEqual([
      "uvx",
      "--offline",
      "--no-python-downloads",
      "--no-env-file",
      "code-review-graph@2.3.6",
      "build",
      "--repo",
      dir,
    ]);
  });

  it("fails large repo graph safety when offline rebuild still leaves an empty graph", async () => {
    writeGraphMcp();
    const run = fakeRunner((argv) => {
      if (argv[0] === "git" && argv.slice(3).join(" ") === "ls-files") {
        return {
          code: 0,
          stdout: Array.from({ length: 1000 }, (_, i) => `src/file-${i}.ts`).join("\n"),
        };
      }
      if ((argv[0] === "which" || argv[0] === "where") && argv[1] === "uvx") {
        return { code: 0, stdout: "/usr/bin/uvx" };
      }
      if (argv[0] === "uvx" && argv.includes("status")) {
        return { code: 0, stdout: emptyGraphStatus };
      }
      if (argv[0] === "uvx" && argv.includes("build")) {
        return { code: 0, stdout: "Full build: 0 files, 0 nodes, 0 edges" };
      }
      return { code: 1, spawnError: true };
    });
    const c = {
      ...scaleCtx(1000, ["uvx"]),
      run,
      host: makeHostAdapter({ platform: "linux", run, env: {} }),
    };

    const probe = findProbe((await command.plan(c)).actions, "large-repo graph safety");
    const res = await probe?.run(c);

    expect(res?.verdict).toBe("fail");
    expect(res?.code).toBe("scale.code-review-graph-missing");
    expect(res?.detail).toContain("offline rebuild did not populate the graph");
  });
});

describe("doctor — trust-lock local drift", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "aih-doctor-trust-drift-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function rooted(): PlanContext {
    const run = fakeRunner(() => ({ code: 1, spawnError: true }));
    return {
      root: dir,
      contextDir: "ai-coding",
      apply: false,
      verify: true,
      json: false,
      run,
      host: makeHostAdapter({ platform: "linux", run, env: {} }),
      env: {},
      options: {},
    };
  }

  it("skips a fresh repo without a trust-lock", async () => {
    const c = rooted();
    const probe = findProbe((await command.plan(c)).actions, "trust-lock local drift");
    expect(probe && "runStructuredLegacy" in probe).toBe(true);
    const res = await probe?.runMany?.(c);

    expect(res).toEqual([
      expect.objectContaining({
        name: "trust local drift",
        verdict: "skip",
      }),
    ]);
  });

  it("flags edited promoted artifacts without checking upstream refs", async () => {
    mkdirSync(join(dir, "ai-coding", "skills", "owner-repo", "clean"), { recursive: true });
    writeFileSync(
      join(dir, "ai-coding", "skills", "owner-repo", "clean", "SKILL.md"),
      "# Edited\n",
    );
    mkdirSync(join(dir, ".aih"), { recursive: true });
    writeFileSync(
      join(dir, ".aih", "trust-lock.json"),
      JSON.stringify({
        schemaVersion: 1,
        sources: [
          {
            id: "owner-repo",
            kind: "github",
            source: "owner/repo",
            ref: "main",
            pinnedSha: "a".repeat(40),
            promotedAt: "2026-06-30T00:00:00.000Z",
            promotedSkills: ["clean"],
            analyzersRun: ["aih-native"],
            artifactHashes: [{ path: "skills/clean/SKILL.md", sha256: "0".repeat(64) }],
            findings: [],
          },
        ],
      }),
    );
    const gitCalls: string[][] = [];
    const run = fakeRunner((argv) => {
      if (argv[0] === "git") gitCalls.push(argv);
      return { code: 1, spawnError: true };
    });
    const c: PlanContext = {
      ...rooted(),
      run,
      host: makeHostAdapter({ platform: "linux", run, env: {} }),
    };

    const probe = findProbe((await command.plan(c)).actions, "trust-lock local drift");
    expect(probe && "runStructuredLegacy" in probe).toBe(true);
    const res = await probe?.runMany?.(c);

    expect(gitCalls).toEqual([]);
    expect(res).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          verdict: "fail",
          code: "trust.source-changed",
          detail: expect.stringContaining("local drift"),
        }),
      ]),
    );

    const result = await executePlan(await command.plan(c), c);
    expect(
      result.verification?.results.some(
        (entry) => entry.passName === "trust local drift" && entry.verdict === "fail",
      ),
    ).toBe(true);
  });
});

describe("doctor — git-enabled workspace roots", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "aih-doctor-workspace-git-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function rooted(gitRoot = true): PlanContext {
    const run = fakeRunner((argv) => {
      if (argv[0] === "git" && argv.slice(3).join(" ") === "rev-parse --is-inside-work-tree") {
        return gitRoot ? { stdout: "true" } : { code: 1 };
      }
      if (argv[0] === "git" && argv.slice(3).join(" ") === "ls-files") {
        return { stdout: ".aih-workspace.json\n.gitignore\n" };
      }
      return { code: 1, spawnError: true };
    });
    return {
      root: dir,
      contextDir: "ai-coding",
      apply: false,
      verify: true,
      json: false,
      run,
      host: makeHostAdapter({ platform: "linux", run, env: {} }),
      env: {},
      options: {},
    };
  }

  function writeWorkspaceMarker(): void {
    writeFileSync(
      join(dir, ".aih-workspace.json"),
      JSON.stringify({
        workspaceType: "multi-repo",
        graphScope: "combined-child-repos",
        contextDir: "ai-coding",
        repos: ["service-api", "web-client"],
        git: true,
        generatedBy: "aih workspace",
      }),
    );
  }

  function writeEmptyWorkspaceMarker(): void {
    writeFileSync(
      join(dir, ".aih-workspace.json"),
      JSON.stringify({
        workspaceType: "multi-repo",
        graphScope: "combined-child-repos",
        contextDir: "ai-coding",
        repos: [],
        git: true,
        generatedBy: "aih workspace",
      }),
    );
  }

  function writeWorkspaceCanon(): void {
    mkdirSync(join(dir, "ai-coding"), { recursive: true });
    writeFileSync(join(dir, "CLAUDE.md"), "`ai-coding/cross-repo-architecture.md`\n");
    writeFileSync(join(dir, "ai-coding", "cross-repo-architecture.md"), "# Architecture\n");
    writeFileSync(join(dir, "ai-coding", "repo-discipline.md"), "# Discipline\n");
  }

  function childRepo(name: string): void {
    mkdirSync(join(dir, name, ".git"), { recursive: true });
  }

  it("fails when a git-enabled workspace marker is not backed by a git root", async () => {
    writeWorkspaceMarker();
    const c = rooted(false);
    const probe = findProbe((await command.plan(c)).actions, "workspace root git");
    const res = await probe?.run(c);

    expect(res?.verdict).toBe("fail");
    expect(res?.detail).toContain("run `aih workspace --apply --git`");
  });

  it("passes when child repos are gitignored", async () => {
    writeWorkspaceMarker();
    writeFileSync(join(dir, ".gitignore"), "service-api/\nweb-client/\n", "utf8");
    const c = rooted(true);
    const probe = findProbe((await command.plan(c)).actions, "workspace child repos gitignored");
    const res = await probe?.run(c);

    expect(res?.verdict).toBe("pass");
    expect(res?.detail).toContain("service-api");
    expect(res?.detail).toContain("web-client");
  });

  it("warns without failing when child repos are not gitignored", async () => {
    writeWorkspaceMarker();
    writeFileSync(join(dir, ".gitignore"), "/service-api/\n", "utf8");
    const c = rooted(true);
    const probe = findProbe((await command.plan(c)).actions, "workspace child repos gitignored");
    const res = await probe?.run(c);

    expect(res?.verdict).toBe("skip");
    expect(res?.detail).toContain("/web-client/");
  });

  it("warns when an undeclared immediate child repo is not gitignored", async () => {
    writeWorkspaceMarker();
    childRepo("service-api");
    childRepo("web-client");
    childRepo("notes");
    childRepo("bad[link](x)`repo");
    writeFileSync(join(dir, ".gitignore"), "/service-api/\n/web-client/\n", "utf8");
    const c = rooted(true);
    const probe = findProbe((await command.plan(c)).actions, "workspace child repos gitignored");
    const res = await probe?.run(c);

    expect(res?.verdict).toBe("skip");
    expect(res?.detail).toContain("/notes/");
    expect(res?.detail).toContain("/bad link x repo/");
    expect(res?.detail).not.toContain("bad[link](x)`repo");
  });

  it("passes the child-ignore probe for a git-enabled workspace with no child repos", async () => {
    writeEmptyWorkspaceMarker();
    writeFileSync(join(dir, ".gitignore"), ".aih/\n*.aih.bak\n*.aih.tmp\n", "utf8");
    const c = rooted(true);
    const probe = findProbe((await command.plan(c)).actions, "workspace child repos gitignored");
    const res = await probe?.run(c);

    expect(res?.verdict).toBe("pass");
    expect(res?.detail).toContain("no child repos");
  });

  it("checks graph coverage against each present child repo, not just the workspace parent", async () => {
    writeWorkspaceMarker();
    mkdirSync(join(dir, "service-api"), { recursive: true });
    writeFileSync(
      join(dir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          "aih-workspace-graph-service-api": {
            command: "uvx",
            args: [
              "--offline",
              "--no-python-downloads",
              "--no-env-file",
              "code-review-graph@2.3.7",
              "serve",
              "--repo",
              join(dir, "service-api"),
            ],
          },
        },
      }),
    );
    const childGraphStatus = ["Nodes: 5454", "Edges: 64205", "Files: 388"].join("\n");
    const calls: string[][] = [];
    const run = fakeRunner((argv) => {
      calls.push(argv);
      if (
        argv[0] === "git" &&
        argv[2] === dir &&
        argv.slice(3).join(" ") === "rev-parse --is-inside-work-tree"
      ) {
        return { stdout: "true" };
      }
      if (argv[0] === "git" && argv[2] === join(dir, "service-api") && argv[3] === "ls-files") {
        return {
          stdout: Array.from({ length: 1000 }, (_, i) => `src/file-${i}.ts`).join("\n"),
        };
      }
      if (argv[0] === "git" && argv[2] === dir && argv[3] === "ls-files") {
        return { stdout: ".aih-workspace.json\n.gitignore\n" };
      }
      if ((argv[0] === "which" || argv[0] === "where") && argv[1] === "uvx") {
        return { stdout: "/usr/bin/uvx" };
      }
      if (argv[0] === "uvx" && argv.includes("status")) {
        return { stdout: childGraphStatus };
      }
      return { code: 1, spawnError: true };
    });
    const c: PlanContext = {
      ...rooted(true),
      run,
      host: makeHostAdapter({ platform: "linux", run, env: {} }),
    };

    const probe = findProbe(
      (await command.plan(c)).actions,
      "workspace child service-api graph safety",
    );
    const res = await probe?.run(c);

    expect(res?.verdict).toBe("pass");
    expect(res?.detail).toContain("service-api");
    expect(calls).toContainEqual([
      "uvx",
      "--offline",
      "--no-python-downloads",
      "--no-env-file",
      "code-review-graph@2.3.7",
      "status",
      "--repo",
      join(dir, "service-api"),
    ]);
  });

  it("warns instead of silently passing when small child graph coverage is unverified", async () => {
    writeWorkspaceMarker();
    mkdirSync(join(dir, "service-api"), { recursive: true });
    const run = fakeRunner((argv) => {
      if (
        argv[0] === "git" &&
        argv[2] === dir &&
        argv.slice(3).join(" ") === "rev-parse --is-inside-work-tree"
      ) {
        return { stdout: "true" };
      }
      if (argv[0] === "git" && argv[2] === join(dir, "service-api") && argv[3] === "ls-files") {
        return { stdout: "src/index.ts\n" };
      }
      if (argv[0] === "git" && argv[2] === dir && argv[3] === "ls-files") {
        return { stdout: ".aih-workspace.json\n.gitignore\n" };
      }
      return { code: 1, spawnError: true };
    });
    const c: PlanContext = {
      ...rooted(true),
      run,
      host: makeHostAdapter({ platform: "linux", run, env: {} }),
    };

    const probe = findProbe(
      (await command.plan(c)).actions,
      "workspace child service-api graph safety",
    );
    const res = await probe?.run(c);

    expect(res?.verdict).toBe("skip");
    expect(res?.code).toBe("scale.code-review-graph-missing");
    expect(res?.detail).toContain("workspace graph coverage is unverified");
  });

  it("accepts a populated graph binary as workspace child graph coverage", async () => {
    writeWorkspaceMarker();
    mkdirSync(join(dir, "service-api"), { recursive: true });
    const calls: string[][] = [];
    const run = fakeRunner((argv) => {
      calls.push(argv);
      if (
        argv[0] === "git" &&
        argv[2] === dir &&
        argv.slice(3).join(" ") === "rev-parse --is-inside-work-tree"
      ) {
        return { stdout: "true" };
      }
      if (argv[0] === "git" && argv[2] === join(dir, "service-api") && argv[3] === "ls-files") {
        return { stdout: "src/index.ts\n" };
      }
      if (argv[0] === "git" && argv[2] === dir && argv[3] === "ls-files") {
        return { stdout: ".aih-workspace.json\n.gitignore\n" };
      }
      if ((argv[0] === "which" || argv[0] === "where") && argv[1] === "code-review-graph") {
        return { stdout: "/usr/bin/code-review-graph" };
      }
      if (argv[0] === "code-review-graph" && argv.includes("status")) {
        return { stdout: ["Nodes: 5454", "Edges: 64205", "Files: 388"].join("\n") };
      }
      return { code: 1, spawnError: true };
    });
    const c: PlanContext = {
      ...rooted(true),
      run,
      host: makeHostAdapter({ platform: "linux", run, env: {} }),
    };

    const probe = findProbe(
      (await command.plan(c)).actions,
      "workspace child service-api graph safety",
    );
    const res = await probe?.run(c);

    expect(res?.verdict).toBe("pass");
    expect(res?.detail).toContain("code-review-graph binary on PATH");
    expect(res?.detail).toContain("graph populated (388 files, 5454 nodes)");
    expect(calls).toContainEqual([
      "code-review-graph",
      "status",
      "--repo",
      join(dir, "service-api"),
    ]);
  });

  it("does not rebuild an empty workspace child graph through a PATH binary", async () => {
    writeWorkspaceMarker();
    mkdirSync(join(dir, "service-api"), { recursive: true });
    const calls: string[][] = [];
    const run = fakeRunner((argv) => {
      calls.push(argv);
      if (
        argv[0] === "git" &&
        argv[2] === dir &&
        argv.slice(3).join(" ") === "rev-parse --is-inside-work-tree"
      ) {
        return { stdout: "true" };
      }
      if (argv[0] === "git" && argv[2] === join(dir, "service-api") && argv[3] === "ls-files") {
        return { stdout: "src/index.ts\n" };
      }
      if (argv[0] === "git" && argv[2] === dir && argv[3] === "ls-files") {
        return { stdout: ".aih-workspace.json\n.gitignore\n" };
      }
      if ((argv[0] === "which" || argv[0] === "where") && argv[1] === "code-review-graph") {
        return { stdout: "/usr/bin/code-review-graph" };
      }
      if (argv[0] === "code-review-graph" && argv.includes("status")) {
        return { stdout: ["Nodes: 0", "Edges: 0", "Files: 0"].join("\n") };
      }
      return { code: 1, spawnError: true };
    });
    const c: PlanContext = {
      ...rooted(true),
      run,
      host: makeHostAdapter({ platform: "linux", run, env: {} }),
    };

    const probe = findProbe(
      (await command.plan(c)).actions,
      "workspace child service-api graph safety",
    );
    const res = await probe?.run(c);

    expect(res?.verdict).toBe("skip");
    expect(res?.code).toBe("scale.code-review-graph-missing");
    expect(res?.detail).toContain("graph status was empty");
    expect(calls).not.toContainEqual([
      "code-review-graph",
      "build",
      "--repo",
      join(dir, "service-api"),
    ]);
  });

  it("fails closed before probing graph coverage for linked child repo paths", async () => {
    const external = mkdtempSync(join(tmpdir(), "aih-doctor-workspace-external-"));
    try {
      mkdirSync(join(external, ".git"), { recursive: true });
      symlinkSync(external, join(dir, "linked"), "junction");
      writeFileSync(
        join(dir, ".aih-workspace.json"),
        JSON.stringify({
          workspaceType: "multi-repo",
          graphScope: "combined-child-repos",
          contextDir: "ai-coding",
          repos: ["linked"],
          git: true,
          generatedBy: "aih workspace",
        }),
      );
      const calls: string[][] = [];
      const run = fakeRunner((argv) => {
        calls.push(argv);
        return { code: 1, spawnError: true };
      });
      const c: PlanContext = {
        ...rooted(true),
        run,
        host: makeHostAdapter({ platform: "linux", run, env: {} }),
      };

      const probe = findProbe(
        (await command.plan(c)).actions,
        "workspace child linked graph safety",
      );
      const res = await probe?.run(c);

      expect(res?.verdict).toBe("fail");
      expect(res?.detail).toContain("real directory");
      expect(calls).toEqual([]);
    } finally {
      rmSync(external, { recursive: true, force: true });
    }
  });

  it("does not render child repo paths into scaffold guidance commands", async () => {
    writeFileSync(
      join(dir, ".aih-workspace.json"),
      JSON.stringify({
        workspaceType: "multi-repo",
        graphScope: "combined-child-repos",
        contextDir: "ai-coding",
        repos: ["api;echo-pwned"],
        git: true,
        generatedBy: "aih workspace",
      }),
    );
    const c = rooted(true);
    const probe = findProbe((await command.plan(c)).actions, "workspace child api-echo-pwned");
    const res = await probe?.run(c);

    expect(res?.verdict).toBe("skip");
    expect(res?.detail).toContain("run `aih init --apply` inside the child repo");
    expect(res?.detail).not.toContain("aih init ./api;echo-pwned --apply");
  });

  it("emits a manual loadability check for structurally valid workspace bootloaders", async () => {
    writeWorkspaceMarker();
    writeWorkspaceCanon();
    const c = rooted(true);
    const probe = findProbe((await command.plan(c)).actions, "CLI context loadability");
    const res = await probe?.run(c);

    expect(res?.verdict).toBe("skip");
    expect(res?.detail).toContain("manual checks: claude");
  });
});

describe("doctor — AI CLI runnable vs config-only inventory", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "aih-doctor-clis-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function rooted(home: string, present: string[] = []): PlanContext {
    const run = fakeRunner((argv) => {
      if ((argv[0] === "which" || argv[0] === "where") && present.includes(argv[1] ?? "")) {
        return { code: 0, stdout: `/usr/bin/${argv[1]}` };
      }
      // A present binary answers its cheap sanity exec cleanly (a healthy install).
      if (present.includes(argv[0] ?? "") && argv[1] === "--version") {
        return { code: 0, stdout: "9.9.9" };
      }
      return { code: 1, spawnError: true };
    });
    return {
      root: dir,
      contextDir: "ai-coding",
      apply: false,
      verify: true,
      json: false,
      run,
      host: makeHostAdapter({ platform: "linux", run, env: {} }),
      env: { HOME: home },
      options: {},
    };
  }

  it("passes on runnable CLIs and calls out config-only traces separately", async () => {
    mkdirSync(join(dir, ".windsurf"), { recursive: true });
    const c = rooted(dir, ["codex"]);
    const probe = findProbe((await command.plan(c)).actions, "AI CLIs detected");
    const res = await probe?.run(c);
    expect(res?.verdict).toBe("pass");
    expect(res?.detail).toContain("runnable: codex");
    expect(res?.detail).toContain("config-only traces");
    expect(res?.detail).toContain("windsurf");
  });

  it("does not count config-only traces as runnable setup targets", async () => {
    mkdirSync(join(dir, ".windsurf"), { recursive: true });
    const c = rooted(dir);
    const probe = findProbe((await command.plan(c)).actions, "AI CLIs detected");
    const res = await probe?.run(c);
    expect(res?.verdict).toBe("skip");
    expect(res?.detail).toContain("no runnable CLIs");
    expect(res?.detail).toContain("windsurf");
  });

  /** which/where resolves `bins`, but a bin in `dead` hard-fails its own exec. */
  function deadCliCtx(bins: string[], dead: string[]): PlanContext {
    const run = fakeRunner((argv) => {
      if ((argv[0] === "which" || argv[0] === "where") && bins.includes(argv[1] ?? "")) {
        return { code: 0, stdout: `/usr/bin/${argv[1]}` };
      }
      if (bins.includes(argv[0] ?? "") && argv[1] === "--version") {
        return dead.includes(argv[0] ?? "")
          ? { code: 1, stderr: "fatal: configured model requires a newer CLI" }
          : { code: 0, stdout: "9.9.9" };
      }
      return { code: 1, spawnError: true };
    });
    return {
      root: dir,
      contextDir: "ai-coding",
      apply: false,
      verify: true,
      json: false,
      run,
      host: makeHostAdapter({ platform: "linux", run, env: { HOME: dir } }),
      env: { HOME: dir },
      options: {},
    };
  }

  it("a detected binary whose every exec hard-fails is NOT green (dead CLI, issue #502)", async () => {
    // `where/which` resolves codex, but the CLI itself cannot execute even
    // `--version` — "binary launches" is not "CLI usable".
    const c = deadCliCtx(["codex"], ["codex"]);
    const probe = findProbe((await command.plan(c)).actions, "AI CLIs detected");
    const res = await probe?.run(c);
    expect(res?.verdict).toBe("fail");
    expect(res?.code).toBe("cli.binary-broken");
    expect(res?.detail).toContain("codex");
  });

  it("a broken CLI is surfaced (never hidden) even when another CLI is healthy", async () => {
    const c = deadCliCtx(["codex", "gemini"], ["gemini"]);
    const probe = findProbe((await command.plan(c)).actions, "AI CLIs detected");
    const res = await probe?.run(c);
    expect(res?.verdict).toBe("pass");
    expect(res?.detail).toContain("runnable: codex");
    expect(res?.detail).toContain("broken");
    expect(res?.detail).toContain("gemini");
  });

  it("a healthy exec keeps the runnable pass exactly as before", async () => {
    const c = deadCliCtx(["codex"], []);
    const probe = findProbe((await command.plan(c)).actions, "AI CLIs detected");
    const res = await probe?.run(c);
    expect(res?.verdict).toBe("pass");
    expect(res?.detail).toContain("runnable: codex");
    expect(res?.detail).not.toContain("broken");
  });
});

describe("doctor — MCP managed allowlist drift", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "aih-doctor-mcp-drift-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function rooted(): PlanContext {
    const run = fakeRunner(() => ({ code: 1, spawnError: true }));
    return {
      root: dir,
      contextDir: "ai-coding",
      apply: false,
      verify: true,
      json: false,
      run,
      host: makeHostAdapter({ platform: "linux", run, env: {} }),
      env: {},
      options: {},
    };
  }

  function writeMcp(command = "uvx", args = ["code-review-graph@2.3.6", "serve"]): void {
    writeFileSync(
      join(dir, ".mcp.json"),
      JSON.stringify({ mcpServers: { "code-review-graph": { type: "stdio", command, args } } }),
    );
  }

  function writeAllowlist(serverCommand: string[]): void {
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(
      join(dir, ".claude", "managed-settings.json"),
      JSON.stringify({ allowManagedMcpServersOnly: true, allowedMcpServers: [{ serverCommand }] }),
    );
  }

  it("passes when managed-settings allowlist matches the stdio MCP commands", async () => {
    writeMcp();
    writeAllowlist(["uvx", "code-review-graph@2.3.6", "serve"]);
    const c = rooted();
    const probe = findProbe((await command.plan(c)).actions, "MCP managed allowlist");
    const res = await probe?.run(c);
    expect(res?.verdict).toBe("pass");
  });

  it("fails when the allowlist drifts from .mcp.json", async () => {
    writeMcp();
    writeAllowlist(["uvx", "code-review-graph@2.0.0", "serve"]);
    const c = rooted();
    const probe = findProbe((await command.plan(c)).actions, "MCP managed allowlist");
    const res = await probe?.run(c);
    expect(res?.verdict).toBe("fail");
    expect(res?.code).toBe("mcp.allowlist-drift");
    expect(res?.detail).toContain("code-review-graph@2.3.6");
  });

  it("fails closed on malformed managed-settings JSON", async () => {
    writeMcp();
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(join(dir, ".claude", "managed-settings.json"), "{ broken");
    const c = rooted();
    const probe = findProbe((await command.plan(c)).actions, "MCP managed allowlist");
    const res = await probe?.run(c);

    expect(res?.verdict).toBe("fail");
    expect(res?.code).toBe("mcp.allowlist-drift");
    expect(res?.detail).toContain("invalid .claude/managed-settings.json");
  });

  it("fails closed on malformed .mcp.json when a managed allowlist is enforced", async () => {
    writeFileSync(join(dir, ".mcp.json"), "{ broken");
    writeAllowlist(["uvx", "code-review-graph@2.3.6", "serve"]);
    const c = rooted();
    const probe = findProbe((await command.plan(c)).actions, "MCP managed allowlist");
    const res = await probe?.run(c);

    expect(res?.verdict).toBe("fail");
    expect(res?.code).toBe("mcp.allowlist-drift");
    expect(res?.detail).toContain("invalid .mcp.json");
  });

  it("passes when the managed allowlist matches org-policy narrowed MCP servers", async () => {
    writeFileSync(
      join(dir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          "code-review-graph": {
            type: "stdio",
            command: "uvx",
            args: ["code-review-graph@2.3.6", "serve"],
          },
          "sequential-thinking": {
            type: "stdio",
            command: "npx",
            args: ["server-sequential-thinking@2025.12.18"],
          },
        },
      }),
    );
    writeFileSync(
      join(dir, "aih-org-policy.json"),
      JSON.stringify({
        schemaVersion: 1,
        minimumPosture: "enterprise",
        references: { repoContract: "ai-coding/project.json" },
        mcp: { allowedServers: ["code-review-graph"], allowManagedOnly: true },
      }),
    );
    writeAllowlist(["uvx", "code-review-graph@2.3.6", "serve"]);
    const c = rooted();
    const probe = findProbe((await command.plan(c)).actions, "MCP managed allowlist");
    const res = await probe?.run(c);

    expect(res?.verdict).toBe("pass");
  });

  it("S1/S2 treats an empty managed allowlist as an empty desired command set", async () => {
    writeMcp();
    writeFileSync(
      join(dir, "aih-org-policy.json"),
      JSON.stringify({
        schemaVersion: 1,
        minimumPosture: "enterprise",
        references: { repoContract: "ai-coding/project.json" },
        mcp: { allowedServers: [], allowManagedOnly: true },
      }),
    );
    writeAllowlist([]);
    const c = rooted();
    const probe = findProbe((await command.plan(c)).actions, "MCP managed allowlist");
    const res = await probe?.run(c);

    expect(res?.verdict).toBe("pass");
  });

  // #501 — after an in-place upgrade the managed allowlist can hold the launch
  // shape an earlier aih generated (bare `uvx <pkg>`), while `.mcp.json` carries
  // the current hardened shape. That is a generation delta, not user drift.
  it("reports a generation delta with the re-projection command for an earlier aih launch shape (#501)", async () => {
    writeMcp("uvx", [
      "--offline",
      "--no-python-downloads",
      "--no-env-file",
      "code-review-graph@2.3.6",
      "serve",
    ]);
    writeFileSync(
      join(dir, "aih-org-policy.json"),
      JSON.stringify({
        schemaVersion: 1,
        minimumPosture: "enterprise",
        references: { repoContract: "ai-coding/project.json" },
        mcp: { allowedServers: ["code-review-graph"], allowManagedOnly: true },
      }),
    );
    writeAllowlist(["uvx", "code-review-graph@2.1.0", "serve"]);
    const c = rooted();
    const probe = findProbe((await command.plan(c)).actions, "MCP managed allowlist");
    const res = await probe?.run(c);

    expect(res?.verdict).toBe("fail");
    expect(res?.code).toBe("mcp.allowlist-generation-delta");
    expect(res?.detail).toContain("generation delta");
    expect(res?.detail).toContain("aih policy project --apply");
    expect(res?.detail).not.toMatch(/drift/i);
  });

  it("keeps drift wording for an earlier launch shape when no committed org policy can be re-projected", async () => {
    writeMcp("uvx", [
      "--offline",
      "--no-python-downloads",
      "--no-env-file",
      "code-review-graph@2.3.6",
      "serve",
    ]);
    writeAllowlist(["uvx", "code-review-graph@2.1.0", "serve"]);
    const c = rooted();
    const probe = findProbe((await command.plan(c)).actions, "MCP managed allowlist");
    const res = await probe?.run(c);

    expect(res?.verdict).toBe("fail");
    expect(res?.code).toBe("mcp.allowlist-drift");
    expect(res?.detail).not.toContain("aih policy project --apply");
  });
});

describe("doctor — org-policy drift", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "aih-doctor-org-policy-drift-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function rooted(): PlanContext {
    const run = fakeRunner(() => ({ code: 1, spawnError: true }));
    return {
      root: dir,
      contextDir: "ai-coding",
      posture: "enterprise",
      apply: false,
      verify: true,
      json: false,
      run,
      host: makeHostAdapter({ platform: "linux", run, env: {} }),
      env: {},
      options: {},
    };
  }

  it("surfaces a coded enterprise failure when managed settings drift from org policy", async () => {
    writeFileSync(
      join(dir, "aih-org-policy.json"),
      JSON.stringify({
        schemaVersion: 1,
        minimumPosture: "enterprise",
        references: { repoContract: "ai-coding/project.json" },
      }),
    );
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(
      join(dir, ".claude", "managed-settings.json"),
      JSON.stringify({ organizationPolicy: { minimumPosture: "enterprise" } }),
    );

    const c = rooted();
    const probe = findProbe((await command.plan(c)).actions, "org-policy drift");
    const res = await probe?.run(c);

    expect(res?.verdict).toBe("fail");
    expect(res?.code).toBe("org-policy.drift");
    expect(res?.detail).toContain(".claude/managed-settings.json");
  });
});

describe("doctor — enterprise baseline attestation", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "aih-doctor-baseline-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function rooted(): PlanContext {
    const run = fakeRunner(() => ({ code: 1, spawnError: true }));
    return {
      root: dir,
      contextDir: "ai-coding",
      posture: "enterprise",
      apply: false,
      verify: true,
      json: false,
      run,
      host: makeHostAdapter({ platform: "linux", run, env: {} }),
      env: {},
      options: {},
    };
  }

  it("wires the baseline residue probe into doctor at enterprise posture", async () => {
    writeFileSync(
      join(dir, "aih-org-policy.json"),
      JSON.stringify({
        schemaVersion: 1,
        minimumPosture: "enterprise",
        references: { repoContract: "ai-coding/project.json" },
        mcp: { allowedServers: [], allowManagedOnly: true },
      }),
    );
    writeFileSync(
      join(dir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          rogue: { type: "http", url: "https://rogue.example/mcp/" },
        },
      }),
    );

    const probe = findProbe((await command.plan(rooted())).actions, "enterprise baseline");
    const res = await probe?.run(rooted());

    expect(probe).toBeDefined();
    expect(res?.verdict).toBe("fail");
    expect(res?.code).toBe("baseline.undeclared-surface");
  });
});

describe("doctor — every probe carries a remediation hint", () => {
  it("git skip names an install + re-run action", async () => {
    const c = ctx(); // fakeRunner reports `git --version` as a spawn error
    const probe = findProbe((await command.plan(c)).actions, "git available");
    const res = await probe?.run(c);
    expect(res?.verdict).toBe("skip");
    expect(res?.detail).toMatch(/install git/);
    expect(res?.detail).toMatch(/re-run/);
  });

  it("platform skip (unverified adapter) carries an actionable hint", async () => {
    const run = fakeRunner(() => ({ code: 1, spawnError: true }));
    const c: PlanContext = {
      ...ctx(),
      run,
      host: makeHostAdapter({ platform: "darwin", run, env: {} }), // darwin = unverified
    };
    const probe = findProbe((await command.plan(c)).actions, "platform adapter");
    const res = await probe?.run(c);
    expect(res?.verdict).toBe("skip");
    expect(res?.detail).toMatch(/file an issue/);
  });
});

describe("doctor — VDI compatibility matrix", () => {
  it("surfaces platform, redirect, and verified-status in a read-only probe", async () => {
    const c = ctx();
    const probe = findProbe((await command.plan(c)).actions, "VDI compatibility matrix");
    const res = await probe?.run(c);

    expect(res?.verdict).toBe("skip");
    expect(res?.detail).toContain("linux");
    expect(res?.detail).toContain("verified");
    expect(res?.detail).toContain("redirect=not-needed");
  });
});

describe("doctor — reads the committed .aih-config.json marker", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "aih-doctor-marker-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** A doctor ctx rooted at the temp dir; `contextDir` simulates the resolved setting. */
  function rooted(contextDir: string): PlanContext {
    const run = fakeRunner(() => ({ code: 1, spawnError: true }));
    return {
      root: dir,
      contextDir,
      apply: false,
      verify: true,
      json: false,
      run,
      host: makeHostAdapter({ platform: "linux", run, env: {} }),
      env: {},
      options: {},
    };
  }

  function writeMarker(contextDir: string, targets: string[] = ["claude"]): void {
    writeFileSync(
      join(dir, AIH_CONFIG_FILE),
      JSON.stringify({ schemaVersion: 1, contextDir, targets }),
    );
  }

  it("checks the context dir from the marker, not the re-derived setting", async () => {
    // Repo bootstrapped with a custom dir; doctor's ctx.contextDir is the default.
    writeMarker("custom-canon");
    mkdirSync(join(dir, "custom-canon"), { recursive: true });
    const c = rooted("ai-coding");
    const probe = findProbe((await command.plan(c)).actions, "canonical context dir");
    const res = await probe?.run(c);
    expect(res?.verdict).toBe("pass");
    expect(res?.detail).toContain("custom-canon");
    expect(res?.detail).not.toContain(dir);
  });

  it("config-marker probe PASSES when the marker matches the checked dir", async () => {
    writeMarker("ai-coding", ["claude", "codex"]);
    const c = rooted("ai-coding");
    const probe = findProbe((await command.plan(c)).actions, "bootstrap config marker");
    const res = await probe?.run(c);
    expect(res?.verdict).toBe("pass");
    expect(res?.detail).toContain("claude, codex");
  });

  it("config-marker probe SKIPS with a hint when an override mismatches the marker", async () => {
    writeMarker("custom-canon");
    const c = rooted("other-dir"); // an explicit --context-dir that disagrees
    const probe = findProbe((await command.plan(c)).actions, "bootstrap config marker");
    const res = await probe?.run(c);
    expect(res?.verdict).toBe("skip");
    expect(res?.detail).toContain("other-dir");
    expect(res?.detail).toContain("custom-canon");
    expect(res?.detail).toContain("omit --context-dir");
  });

  it("config-marker probe SKIPS (no crash) when no marker is present", async () => {
    const c = rooted("ai-coding");
    const probe = findProbe((await command.plan(c)).actions, "bootstrap config marker");
    const res = await probe?.run(c);
    expect(res?.verdict).toBe("skip");
    expect(res?.detail).toContain("no .aih-config.json");
  });

  it.each([
    ["malformed JSON", "{ broken"],
    ["schema-invalid JSON", JSON.stringify({ version: "bad" })],
    [
      "invalid baseline",
      JSON.stringify({
        schemaVersion: 1,
        contextDir: "custom-canon",
        targets: ["claude"],
        baseline: "missing",
      }),
    ],
  ])(
    "config-marker probe warns when the marker is present but invalid (%s)",
    async (_kind, body) => {
      writeFileSync(join(dir, AIH_CONFIG_FILE), body, "utf8");
      const c = rooted("ai-coding");
      const probe = findProbe((await command.plan(c)).actions, "bootstrap config marker");
      const res = await probe?.run(c);

      expect(res?.verdict).toBe("skip");
      expect(res?.code).toBe("config.marker-invalid");
      expect(res?.detail).toContain("invalid .aih-config.json");
      expect(res?.detail).toContain("context dir derived from flags/env/default");
    },
  );
});

describe("doctor — usage-capture hook health probes", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "aih-doctor-hookhealth-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function rooted(): PlanContext {
    const run = fakeRunner(() => ({ code: 1, spawnError: true }));
    return {
      root: dir,
      contextDir: "ai-coding",
      apply: false,
      verify: true,
      json: false,
      run,
      host: makeHostAdapter({ platform: "linux", run, env: {} }),
      env: {},
      options: {},
    };
  }

  it("wires both hook-health probes into the doctor plan", async () => {
    const actions = (await command.plan(rooted())).actions;
    expect(findProbe(actions, "usage recorder present")).toBeDefined();
    expect(findProbe(actions, "metrics hook tool on PATH")).toBeDefined();
  });

  it("both self-skip cleanly on a repo with no usage hooks", async () => {
    const c = rooted();
    const rec = await findProbe((await command.plan(c)).actions, "usage recorder present")?.run(c);
    const tool = await findProbe((await command.plan(c)).actions, "metrics hook tool on PATH")?.run(
      c,
    );
    expect(rec?.verdict).toBe("skip");
    expect(tool?.verdict).toBe("skip");
  });
});

describe("doctor — MCP uvx pin attestation (issue #502)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "aih-doctor-uvx-attest-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function rooted(
    options: Record<string, unknown> = {},
    run: Runner = fakeRunner(() => ({ code: 1, spawnError: true })),
  ): PlanContext {
    return {
      root: dir,
      contextDir: "ai-coding",
      apply: false,
      verify: true,
      json: false,
      run,
      host: makeHostAdapter({ platform: "linux", run, env: {} }),
      env: {},
      options,
    };
  }

  function writeMcp(args: string[], command = "uvx"): void {
    writeFileSync(
      join(dir, ".mcp.json"),
      JSON.stringify({ mcpServers: { "code-review-graph": { type: "stdio", command, args } } }),
    );
  }

  /** A fake pinned uvx server whose MCP initialize response self-reports `version`. */
  function uvxServerRunner(version: string): {
    run: Runner;
    seen: { input?: string; argv?: string[] };
  } {
    const seen: { input?: string; argv?: string[] } = {};
    const run = fakeRunner((argv, opts) => {
      if (argv[0] === "uvx") {
        seen.argv = argv;
        seen.input = opts?.input;
        return {
          code: 0,
          stdout: `${JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: {
              protocolVersion: "2025-06-18",
              capabilities: {},
              serverInfo: { name: "code-review-graph", version },
            },
          })}\n`,
        };
      }
      return { code: 1, spawnError: true };
    });
    return { run, seen };
  }

  it("declares the --attest-mcp-pins opt-in flag", () => {
    expect(command.options?.some((o) => o.flags === "--attest-mcp-pins")).toBe(true);
  });

  it("always renders an attestation row: pinned-but-unattested is visible, never silent", async () => {
    writeMcp(["code-review-graph@2.3.6", "serve"]);
    const c = rooted();
    const probe = findProbe((await command.plan(c)).actions, "MCP uvx pin attestation");
    expect(probe).toBeDefined();
    const res = await probe?.run(c);
    expect(res?.verdict).toBe("skip");
    expect(res?.code).toBe("mcp.pin-unattested");
    expect(res?.detail).toContain("code-review-graph@2.3.6");
    expect(res?.detail).toContain("--attest-mcp-pins");
  });

  it("warns (mcp.version-drift) when the launched server self-reports a version off the pin", async () => {
    writeMcp(["code-review-graph@2.3.6", "serve"]);
    const { run, seen } = uvxServerRunner("2.3.4");
    const c = rooted({ attestMcpPins: true }, run);
    const probe = findProbe((await command.plan(c)).actions, "MCP uvx pin attestation");
    const res = await probe?.run(c);
    expect(res?.verdict).toBe("skip");
    expect(res?.code).toBe("mcp.version-drift");
    expect(res?.detail).toContain("2.3.6");
    expect(res?.detail).toContain("2.3.4");
    // The probe launched the CONFIGURED pinned command with an MCP initialize handshake.
    expect(seen.argv).toEqual(["uvx", "code-review-graph@2.3.6", "serve"]);
    expect(seen.input).toContain('"initialize"');
  });

  it("passes when serverInfo.version matches the honored pin", async () => {
    writeMcp(["code-review-graph@2.3.6", "serve"]);
    const { run } = uvxServerRunner("2.3.6");
    const c = rooted({ attestMcpPins: true }, run);
    const probe = findProbe((await command.plan(c)).actions, "MCP uvx pin attestation");
    const res = await probe?.run(c);
    expect(res?.verdict).toBe("pass");
    expect(res?.detail).toContain("attested");
    expect(res?.detail).toContain("code-review-graph@2.3.6");
  });

  it("reports an honest unattested state when the pinned server never answers initialize", async () => {
    writeMcp(["code-review-graph@2.3.6", "serve"]);
    const run = fakeRunner((argv) =>
      argv[0] === "uvx"
        ? { code: 1, stderr: "boom", spawnError: true }
        : { code: 1, spawnError: true },
    );
    const c = rooted({ attestMcpPins: true }, run);
    const probe = findProbe((await command.plan(c)).actions, "MCP uvx pin attestation");
    const res = await probe?.run(c);
    expect(res?.verdict).toBe("skip");
    expect(res?.code).toBe("mcp.pin-unattested");
    expect(res?.detail).toContain("could not attest");
  });

  it("an unpinned uvx launcher is surfaced as unattestable (never silently green)", async () => {
    writeMcp(["code-review-graph", "serve"]);
    const c = rooted({ attestMcpPins: true });
    const probe = findProbe((await command.plan(c)).actions, "MCP uvx pin attestation");
    const res = await probe?.run(c);
    expect(res?.verdict).toBe("skip");
    expect(res?.code).toBe("mcp.pin-unattested");
    expect(res?.detail).toContain("exact");
    expect(res?.detail).toContain("code-review-graph");
  });

  it("skips quietly (uncoded) when no uvx MCP servers are configured", async () => {
    writeMcp(["server-foo@1.2.3"], "npx");
    const c = rooted();
    const probe = findProbe((await command.plan(c)).actions, "MCP uvx pin attestation");
    const res = await probe?.run(c);
    expect(res?.verdict).toBe("skip");
    expect(res?.code).toBeUndefined();
  });
});

describe("doctor — MCP pin currency (issue #504)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "aih-doctor-pin-currency-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function rooted(
    options: Record<string, unknown> = {},
    run: Runner = fakeRunner(() => ({ code: 1, spawnError: true })),
  ): PlanContext {
    return {
      root: dir,
      contextDir: "ai-coding",
      apply: false,
      verify: true,
      json: false,
      run,
      host: makeHostAdapter({ platform: "linux", run, env: {} }),
      env: {},
      options,
    };
  }

  function writeMcp(servers: Record<string, unknown>): void {
    writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: servers }));
  }

  /** The baked codebase-memory-mcp catalog launch at an arbitrary pinned version. */
  function cmmServer(version: string): Record<string, unknown> {
    return {
      type: "stdio",
      command: "uvx",
      args: [
        "--offline",
        "--no-python-downloads",
        "--no-env-file",
        `codebase-memory-mcp@${version}`,
      ],
    };
  }

  const SEQ_SERVER = {
    type: "stdio",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-sequential-thinking@2026.7.4"],
  };

  /**
   * A fake registry: answers `npm view <name> version` from `npm` and
   * `curl … https://pypi.org/pypi/<name>/json` from `pypi`, recording every
   * network argv so tests can also assert what was NOT queried.
   */
  function registryRunner(latest: {
    npm?: Record<string, string>;
    pypi?: Record<string, string>;
  }): {
    run: Runner;
    seen: string[][];
  } {
    const seen: string[][] = [];
    const run = fakeRunner((argv) => {
      if (argv[0] === "npm" && argv[1] === "view") {
        seen.push([...argv]);
        const version = latest.npm?.[argv[2] ?? ""];
        return version === undefined
          ? { code: 1, stderr: "npm ERR! 404" }
          : { code: 0, stdout: `${version}\n` };
      }
      if (argv[0] === "curl") {
        seen.push([...argv]);
        const url = argv.at(-1) ?? "";
        const name = /pypi\.org\/pypi\/([^/]+)\/json/.exec(url)?.[1];
        const version = name === undefined ? undefined : latest.pypi?.[name];
        return version === undefined
          ? { code: 22, stderr: "curl: (22) The requested URL returned error: 404" }
          : { code: 0, stdout: JSON.stringify({ info: { version } }) };
      }
      return { code: 1, spawnError: true };
    });
    return { run, seen };
  }

  it("declares the --check-pin-currency opt-in flag", () => {
    expect(command.options?.some((o) => o.flags === "--check-pin-currency")).toBe(true);
  });

  it("always renders a currency row; without the flag nothing is queried and the opt-in is named", async () => {
    writeMcp({ "codebase-memory-mcp": cmmServer("0.9.0") });
    const { run, seen } = registryRunner({ pypi: { "codebase-memory-mcp": "0.9.0" } });
    const c = rooted({}, run);
    const probe = findProbe((await command.plan(c)).actions, "MCP pin currency");
    expect(probe).toBeDefined();
    const res = await probe?.run(c);
    expect(res?.verdict).toBe("skip");
    expect(res?.code).toBeUndefined();
    expect(res?.detail).toContain("codebase-memory-mcp@0.9.0");
    expect(res?.detail).toContain("--check-pin-currency");
    expect(seen).toEqual([]); // no registry traffic without the opt-in
  });

  it("reports projection lag offline (mcp.projection-stale) when .mcp.json pins differ from this build's catalog", async () => {
    writeMcp({ "codebase-memory-mcp": cmmServer("0.8.0") });
    const c = rooted();
    const probe = findProbe((await command.plan(c)).actions, "MCP pin currency");
    const res = await probe?.run(c);
    expect(res?.verdict).toBe("skip");
    expect(res?.code).toBe("mcp.projection-stale");
    expect(res?.detail).toContain("codebase-memory-mcp@0.8.0");
    expect(res?.detail).toContain("codebase-memory-mcp@0.9.0");
    expect(res?.detail).toContain("aih mcp --apply");
  });

  it("warns (mcp.pin-stale) when the registry publishes a newer release than a uvx pin", async () => {
    writeMcp({ "codebase-memory-mcp": cmmServer("0.9.0") });
    const { run, seen } = registryRunner({ pypi: { "codebase-memory-mcp": "1.0.0" } });
    const c = rooted({ checkPinCurrency: true }, run);
    const probe = findProbe((await command.plan(c)).actions, "MCP pin currency");
    const res = await probe?.run(c);
    expect(res?.verdict).toBe("skip");
    expect(res?.code).toBe("mcp.pin-stale");
    expect(res?.detail).toContain("0.9.0");
    expect(res?.detail).toContain("1.0.0");
    // The PyPI metadata endpoint was queried read-only for the pinned package.
    expect(
      seen.some(
        (argv) =>
          argv[0] === "curl" && argv.at(-1) === "https://pypi.org/pypi/codebase-memory-mcp/json",
      ),
    ).toBe(true);
  });

  it("checks npm-backed pins through `npm view <name> version`", async () => {
    writeMcp({ "sequential-thinking": SEQ_SERVER });
    const { run, seen } = registryRunner({
      npm: { "@modelcontextprotocol/server-sequential-thinking": "2026.8.0" },
    });
    const c = rooted({ checkPinCurrency: true }, run);
    const probe = findProbe((await command.plan(c)).actions, "MCP pin currency");
    const res = await probe?.run(c);
    expect(res?.verdict).toBe("skip");
    expect(res?.code).toBe("mcp.pin-stale");
    expect(res?.detail).toContain("2026.7.4");
    expect(res?.detail).toContain("2026.8.0");
    expect(seen).toContainEqual([
      "npm",
      "view",
      "@modelcontextprotocol/server-sequential-thinking",
      "version",
    ]);
  });

  it("passes when every pin matches its registry's latest release", async () => {
    writeMcp({ "codebase-memory-mcp": cmmServer("0.9.0"), "sequential-thinking": SEQ_SERVER });
    const { run } = registryRunner({
      npm: { "@modelcontextprotocol/server-sequential-thinking": "2026.7.4" },
      pypi: { "codebase-memory-mcp": "0.9.0" },
    });
    const c = rooted({ checkPinCurrency: true }, run);
    const probe = findProbe((await command.plan(c)).actions, "MCP pin currency");
    const res = await probe?.run(c);
    expect(res?.verdict).toBe("pass");
    expect(res?.detail).toContain("current");
    expect(res?.detail).toContain("codebase-memory-mcp@0.9.0");
  });

  it("degrades honestly (uncoded skip) when the registry cannot be queried", async () => {
    writeMcp({ "codebase-memory-mcp": cmmServer("0.9.0") });
    const c = rooted({ checkPinCurrency: true }); // every spawn fails (curl absent)
    const probe = findProbe((await command.plan(c)).actions, "MCP pin currency");
    const res = await probe?.run(c);
    expect(res?.verdict).toBe("skip");
    expect(res?.code).toBeUndefined();
    expect(res?.detail).toContain("could not resolve");
  });

  it("skips quietly when no .mcp.json exists", async () => {
    const c = rooted();
    const probe = findProbe((await command.plan(c)).actions, "MCP pin currency");
    const res = await probe?.run(c);
    expect(res?.verdict).toBe("skip");
    expect(res?.code).toBeUndefined();
  });
});

/**
 * #554 — doctor must honor the repo's COMMITTED target set, not just a `targets`
 * array an orchestrator injected. `aih doctor` runs standalone, so `ctx.targets` is
 * undefined and the drift/allowlist gates fall open: a Kiro-only repo gets Claude
 * projection findings whose prescribed repair (`aih policy project --apply`) emits
 * zero actions there. The marker is the authority (`resolveTargetSet`).
 */
describe("doctor — Claude probe target scope from the committed marker (#554)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "aih-doctor-target-scope-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function rooted(): PlanContext {
    const run = fakeRunner(() => ({ code: 1, spawnError: true }));
    return {
      root: dir,
      contextDir: "ai-coding",
      apply: false,
      verify: true,
      json: false,
      run,
      host: makeHostAdapter({ platform: "linux", run, env: {} }),
      env: {},
      options: {},
    };
  }

  /** Commit a Kiro-only target set, exactly as `aih init --cli kiro` records it. */
  function kiroOnlyMarker(): void {
    writeFileSync(
      join(dir, AIH_CONFIG_FILE),
      JSON.stringify({ schemaVersion: 1, contextDir: "ai-coding", targets: ["kiro"] }),
    );
  }

  function writeEnterprisePolicy(mcp?: Record<string, unknown>): void {
    writeFileSync(
      join(dir, "aih-org-policy.json"),
      JSON.stringify({
        schemaVersion: 1,
        minimumPosture: "enterprise",
        references: { repoContract: "ai-coding/project.json" },
        command: { deny: { add: [{ pattern: "terraform destroy*" }] } },
        ...(mcp === undefined ? {} : { mcp }),
      }),
    );
  }

  // Reproduction A: no Claude artifacts at all, so there is nothing to reconcile.
  it("does not fail a Kiro-only repo for a missing Claude projection", async () => {
    kiroOnlyMarker();
    writeEnterprisePolicy();
    const c = rooted();
    const probe = findProbe(
      (await command.plan(c)).actions,
      "org-policy drift: .claude/managed-settings.json",
    );
    const res = await probe?.run(c);
    expect(res?.verdict).not.toBe("fail");
  });

  // Reproduction B: stale Claude allowlist residue must route to prune, never to a
  // projection that emits zero actions for this repo's targets.
  it("does not prescribe policy projection for a Kiro-only repo's stale allowlist", async () => {
    kiroOnlyMarker();
    writeEnterprisePolicy({ allowedServers: ["code-review-graph"], allowManagedOnly: true });
    writeFileSync(
      join(dir, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          "code-review-graph": {
            type: "stdio",
            command: "uvx",
            args: [
              "--offline",
              "--no-python-downloads",
              "--no-env-file",
              "code-review-graph@2.2.0",
              "serve",
            ],
          },
        },
      }),
    );
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(
      join(dir, ".claude", "managed-settings.json"),
      JSON.stringify({
        allowManagedMcpServersOnly: true,
        allowedMcpServers: [{ serverCommand: ["uvx", "code-review-graph@2.1.0", "serve"] }],
      }),
    );
    const c = rooted();
    const probe = findProbe((await command.plan(c)).actions, "MCP managed allowlist");
    const res = await probe?.run(c);
    expect(res?.detail ?? "").not.toContain("policy project --apply");
  });

  // Narrowing SUPPRESSES findings, so only the committed marker may do it. Weaker
  // signals must never silence an org-policy finding.
  it.each([
    ["no marker at all", undefined],
    ["an empty target list", [] as string[]],
    ["an unrecognized id beside a valid one", ["kiro", "not-a-real-cli"]],
  ])("does not narrow Claude probes on %s", async (_label, targets) => {
    if (targets !== undefined) {
      writeFileSync(
        join(dir, AIH_CONFIG_FILE),
        JSON.stringify({ schemaVersion: 1, contextDir: "ai-coding", targets }),
      );
    }
    writeEnterprisePolicy();
    const c = rooted();
    const probe = findProbe(
      (await command.plan(c)).actions,
      "org-policy drift: .claude/managed-settings.json",
    );
    expect((await probe?.run(c))?.verdict).toBe("fail");
  });

  // On-disk adapter files are how `resolveTargetSet` infers targets for REPORT
  // grading. That inference must not reach a governance probe: deleting
  // `adapters/claude.md` would otherwise silence org-policy drift.
  it("does not narrow Claude probes on inferred on-disk adapters", async () => {
    mkdirSync(join(dir, "ai-coding", "adapters"), { recursive: true });
    writeFileSync(join(dir, "ai-coding", "adapters", "kiro.md"), "# kiro");
    writeEnterprisePolicy();
    const c = rooted();
    const probe = findProbe(
      (await command.plan(c)).actions,
      "org-policy drift: .claude/managed-settings.json",
    );
    expect((await probe?.run(c))?.verdict).toBe("fail");
  });

  // The control case: a Claude-targeted repo keeps the strict finding and its repair.
  it("still fails a Claude-targeted repo when the projection is missing", async () => {
    writeFileSync(
      join(dir, AIH_CONFIG_FILE),
      JSON.stringify({ schemaVersion: 1, contextDir: "ai-coding", targets: ["claude"] }),
    );
    writeEnterprisePolicy();
    const c = rooted();
    const probe = findProbe(
      (await command.plan(c)).actions,
      "org-policy drift: .claude/managed-settings.json",
    );
    const res = await probe?.run(c);
    expect(res?.verdict).toBe("fail");
  });
});
