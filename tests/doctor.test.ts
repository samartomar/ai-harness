import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AIH_CONFIG_FILE } from "../src/config/marker.js";
import { command } from "../src/doctor.js";
import type { Action, PlanContext, ProbeAction } from "../src/internals/plan.js";
import { fakeRunner } from "../src/internals/proc.js";
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
    expect(res?.detail).toContain("bounded rg/fd reads only");
  });

  it("passes large repos when the repo MCP graph is configured and uv is available", async () => {
    writeFileSync(
      join(dir, ".mcp.json"),
      JSON.stringify({ mcpServers: { "code-review-graph": { command: "uvx" } } }),
    );
    const c = scaleCtx(1000, ["uv"]);
    const probe = findProbe((await command.plan(c)).actions, "large-repo graph safety");
    const res = await probe?.run(c);
    expect(res?.verdict).toBe("pass");
    expect(res?.detail).toContain("repo MCP code-review-graph configured");
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
    writeFileSync(join(dir, ".gitignore"), "service-api/\n", "utf8");
    const c = rooted(true);
    const probe = findProbe((await command.plan(c)).actions, "workspace child repos gitignored");
    const res = await probe?.run(c);

    expect(res?.verdict).toBe("skip");
    expect(res?.detail).toContain("web-client/");
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

  it("passes CLI loadability for workspace bootloaders without repo-level RULE_ROUTER", async () => {
    writeWorkspaceMarker();
    writeWorkspaceCanon();
    const c = rooted(true);
    const probe = findProbe((await command.plan(c)).actions, "CLI context loadability");
    const res = await probe?.run(c);

    expect(res?.verdict).toBe("pass");
    expect(res?.detail).toContain("claude");
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

  it("skips malformed managed-settings JSON as no enforceable allowlist", async () => {
    writeMcp();
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(join(dir, ".claude", "managed-settings.json"), "{ broken");
    const c = rooted();
    const probe = findProbe((await command.plan(c)).actions, "MCP managed allowlist");
    const res = await probe?.run(c);

    expect(res?.verdict).toBe("skip");
    expect(res?.detail).toContain("no managed MCP allowlist");
  });

  it("skips malformed .mcp.json as no comparable stdio servers", async () => {
    writeFileSync(join(dir, ".mcp.json"), "{ broken");
    writeAllowlist(["uvx", "code-review-graph@2.3.6", "serve"]);
    const c = rooted();
    const probe = findProbe((await command.plan(c)).actions, "MCP managed allowlist");
    const res = await probe?.run(c);

    expect(res?.verdict).toBe("skip");
    expect(res?.detail).toContain("no .mcp.json stdio servers");
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
});
