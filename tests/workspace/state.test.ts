import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Action, PlanContext, WriteAction } from "../../src/internals/plan.js";
import { defaultRunner, type Runner } from "../../src/internals/proc.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import { snapshotCommand } from "../../src/workspace/index.js";
import type { WorkspaceManifest, WorkspaceRepo } from "../../src/workspace/manifest.js";
import {
  collectWorkspaceSnapshot,
  mapWorkspaceRepos,
  readWorkspaceRepoState,
} from "../../src/workspace/state.js";

let parent: string;

beforeEach(() => {
  parent = mkdtempSync(join(tmpdir(), "aih-ws-state-"));
});

afterEach(() => {
  rmSync(parent, { recursive: true, force: true });
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ctx(run: Runner, options: Record<string, unknown> = {}): PlanContext {
  return {
    root: parent,
    contextDir: "ai-coding",
    apply: false,
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
  for (const action of actions) if (action.kind === "write") m.set(action.path, action);
  return m;
}

function repo(id: string): WorkspaceRepo {
  return { id, path: id, router: "ai-coding/RULE_ROUTER.md" };
}

function childRepo(id: string): WorkspaceRepo {
  mkdirSync(join(parent, id, ".git"), { recursive: true });
  return repo(id);
}

function manifest(repos: WorkspaceRepo[]): WorkspaceManifest {
  return {
    status: "OK",
    errors: [],
    raw: {},
    contextDir: "ai-coding",
    repos,
    edges: [],
    git: false,
  };
}

describe("workspace state collection", () => {
  it("reads independent git facts for one repo concurrently after the git check", async () => {
    let active = 0;
    let maxActive = 0;
    const run: Runner = async (argv) => {
      const tail = argv.slice(3).join(" ");
      active++;
      maxActive = Math.max(maxActive, active);
      await delay(5);
      active--;
      if (tail === "rev-parse --is-inside-work-tree")
        return { code: 0, stdout: "true\n", stderr: "" };
      if (tail === "rev-parse --abbrev-ref HEAD") return { code: 0, stdout: "main\n", stderr: "" };
      if (tail === "rev-parse --short HEAD") return { code: 0, stdout: "abc123\n", stderr: "" };
      if (tail === "status --porcelain") return { code: 0, stdout: "", stderr: "" };
      if (tail === "rev-list --left-right --count HEAD...@{upstream}") {
        return { code: 0, stdout: "1\t2\n", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };

    const state = await readWorkspaceRepoState(ctx(run), childRepo("ui"));

    expect(maxActive).toBeGreaterThan(1);
    expect(state).toMatchObject({ ahead: 2, behind: 1 });
  });

  it("captures the child fetch remote from local git config", async () => {
    const run: Runner = async (argv) => {
      const tail = argv.slice(3).join(" ");
      if (tail === "rev-parse --is-inside-work-tree")
        return { code: 0, stdout: "true\n", stderr: "" };
      if (tail === "rev-parse --abbrev-ref HEAD") return { code: 0, stdout: "main\n", stderr: "" };
      if (tail === "rev-parse --short HEAD") return { code: 0, stdout: "abc123\n", stderr: "" };
      if (tail === "status --porcelain") return { code: 0, stdout: "", stderr: "" };
      if (tail === "config --local --get remote.origin.url") {
        return { code: 0, stdout: "https://github.com/acme/ui.git\n", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "" };
    };

    await expect(readWorkspaceRepoState(ctx(run), childRepo("ui"))).resolves.toMatchObject({
      id: "ui",
      path: "ui",
      branch: "main",
      sha: "abc123",
      remote: "https://github.com/acme/ui.git",
      dirty: false,
      git: true,
    });
  });

  it("omits the child fetch remote when git cannot report one", async () => {
    const run: Runner = async (argv) => {
      const tail = argv.slice(3).join(" ");
      if (tail === "rev-parse --is-inside-work-tree")
        return { code: 0, stdout: "true\n", stderr: "" };
      if (tail === "rev-parse --abbrev-ref HEAD") return { code: 0, stdout: "main\n", stderr: "" };
      if (tail === "rev-parse --short HEAD") return { code: 0, stdout: "abc123\n", stderr: "" };
      if (tail === "status --porcelain") return { code: 0, stdout: "", stderr: "" };
      if (tail === "config --local --get remote.origin.url") {
        return { code: 1, stdout: "", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "" };
    };

    const state = await readWorkspaceRepoState(ctx(run), childRepo("ui"));

    expect(state).not.toHaveProperty("remote");
  });

  it("omits unsafe observed child origin values", async () => {
    const run: Runner = async (argv) => {
      const tail = argv.slice(3).join(" ");
      if (tail === "rev-parse --is-inside-work-tree")
        return { code: 0, stdout: "true\n", stderr: "" };
      if (tail === "rev-parse --abbrev-ref HEAD") return { code: 0, stdout: "main\n", stderr: "" };
      if (tail === "rev-parse --short HEAD") return { code: 0, stdout: "abc123\n", stderr: "" };
      if (tail === "status --porcelain") return { code: 0, stdout: "", stderr: "" };
      if (tail === "config --local --get remote.origin.url") {
        return { code: 0, stdout: "https://token@github.com/acme/ui.git\n", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "" };
    };

    const state = await readWorkspaceRepoState(ctx(run), childRepo("ui"));

    expect(state).not.toHaveProperty("remote");
  });

  it("accepts scp-like child origin values from local config", async () => {
    const run: Runner = async (argv) => {
      const tail = argv.slice(3).join(" ");
      if (tail === "rev-parse --is-inside-work-tree")
        return { code: 0, stdout: "true\n", stderr: "" };
      if (tail === "rev-parse --abbrev-ref HEAD") return { code: 0, stdout: "main\n", stderr: "" };
      if (tail === "rev-parse --short HEAD") return { code: 0, stdout: "abc123\n", stderr: "" };
      if (tail === "status --porcelain") return { code: 0, stdout: "", stderr: "" };
      if (tail === "config --local --get remote.origin.url") {
        return { code: 0, stdout: "git@github.com:acme/ui.git\n", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "" };
    };

    await expect(readWorkspaceRepoState(ctx(run), childRepo("ui"))).resolves.toMatchObject({
      remote: "git@github.com:acme/ui.git",
    });
  });

  it("does not read ambient git config when the child local origin is absent", async () => {
    const calls: string[] = [];
    const run: Runner = async (argv) => {
      const tail = argv.slice(3).join(" ");
      calls.push(tail);
      if (tail === "rev-parse --is-inside-work-tree")
        return { code: 0, stdout: "true\n", stderr: "" };
      if (tail === "rev-parse --abbrev-ref HEAD") return { code: 0, stdout: "main\n", stderr: "" };
      if (tail === "rev-parse --short HEAD") return { code: 0, stdout: "abc123\n", stderr: "" };
      if (tail === "status --porcelain") return { code: 0, stdout: "", stderr: "" };
      if (tail === "config --local --get remote.origin.url") {
        return { code: 1, stdout: "", stderr: "" };
      }
      if (tail === "config --get remote.origin.url") {
        return { code: 0, stdout: "https://github.com/acme/global.git\n", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "" };
    };

    const state = await readWorkspaceRepoState(ctx(run), childRepo("ui"));

    expect(state).not.toHaveProperty("remote");
    expect(calls).toContain("config --local --get remote.origin.url");
    expect(calls).not.toContain("remote get-url origin");
    expect(calls).not.toContain("config --get remote.origin.url");
  });

  it("omits a real child remote when only global git config declares origin", async () => {
    const home = join(parent, "home");
    const child = join(parent, "ui");
    const globalConfig = join(home, ".gitconfig");
    mkdirSync(home, { recursive: true });
    mkdirSync(child, { recursive: true });
    writeFileSync(
      globalConfig,
      '[remote "origin"]\n\turl = https://github.com/acme/global.git\n',
      "utf8",
    );
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_CONFIG_GLOBAL: globalConfig,
      HOME: home,
      USERPROFILE: home,
    };
    const run: Runner = (argv, opts) => defaultRunner(argv, { ...opts, env });
    const init = await run(["git", "-C", child, "init"]);
    if (init.spawnError) return;
    expect(init.code).toBe(0);

    const state = await readWorkspaceRepoState(ctx(run), repo("ui"));

    expect(state.git).toBe(true);
    expect(state).not.toHaveProperty("remote");
  });

  it("prefers manifest-declared child remote over the observed git remote", async () => {
    const calls: string[] = [];
    const run: Runner = async (argv) => {
      const tail = argv.slice(3).join(" ");
      calls.push(tail);
      if (tail === "rev-parse --is-inside-work-tree")
        return { code: 0, stdout: "true\n", stderr: "" };
      if (tail === "rev-parse --abbrev-ref HEAD") return { code: 0, stdout: "main\n", stderr: "" };
      if (tail === "rev-parse --short HEAD") return { code: 0, stdout: "abc123\n", stderr: "" };
      if (tail === "status --porcelain") return { code: 0, stdout: "", stderr: "" };
      if (tail === "config --local --get remote.origin.url") {
        return { code: 0, stdout: "https://github.com/acme/observed.git\n", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "" };
    };
    const child = {
      ...childRepo("ui"),
      remote: "https://github.com/acme/manifest.git",
    };

    await expect(readWorkspaceRepoState(ctx(run), child)).resolves.toMatchObject({
      remote: "https://github.com/acme/manifest.git",
    });
    expect(calls).not.toContain("remote get-url origin");
    expect(calls).not.toContain("config --local --get remote.origin.url");
  });

  it("collects repo snapshots concurrently across workspace children", async () => {
    let activeInsideChecks = 0;
    let maxInsideChecks = 0;
    const run: Runner = async (argv) => {
      const tail = argv.slice(3).join(" ");
      if (tail === "rev-parse --is-inside-work-tree") {
        activeInsideChecks++;
        maxInsideChecks = Math.max(maxInsideChecks, activeInsideChecks);
        await delay(5);
        activeInsideChecks--;
        return { code: 0, stdout: "true\n", stderr: "" };
      }
      if (tail === "rev-parse --abbrev-ref HEAD") return { code: 0, stdout: "main\n", stderr: "" };
      if (tail === "rev-parse --short HEAD") return { code: 0, stdout: "abc123\n", stderr: "" };
      if (tail === "status --porcelain") return { code: 0, stdout: "", stderr: "" };
      return { code: 1, stdout: "", stderr: "" };
    };

    await collectWorkspaceSnapshot(ctx(run), manifest([childRepo("ui"), childRepo("backend")]));

    expect(maxInsideChecks).toBeGreaterThan(1);
  });

  it("caps concurrent repo git probes while collecting larger workspace snapshots", async () => {
    let activeInsideChecks = 0;
    let maxInsideChecks = 0;
    const run: Runner = async (argv) => {
      const tail = argv.slice(3).join(" ");
      if (tail === "rev-parse --is-inside-work-tree") {
        activeInsideChecks++;
        maxInsideChecks = Math.max(maxInsideChecks, activeInsideChecks);
        await delay(5);
        activeInsideChecks--;
        return { code: 0, stdout: "true\n", stderr: "" };
      }
      if (tail === "rev-parse --abbrev-ref HEAD") return { code: 0, stdout: "main\n", stderr: "" };
      if (tail === "rev-parse --short HEAD") return { code: 0, stdout: "abc123\n", stderr: "" };
      if (tail === "status --porcelain") return { code: 0, stdout: "", stderr: "" };
      return { code: 1, stdout: "", stderr: "" };
    };

    await collectWorkspaceSnapshot(
      ctx(run),
      manifest(["api", "docs", "infra", "shared", "ui", "web", "worker", "jobs"].map(childRepo)),
    );

    expect(maxInsideChecks).toBeGreaterThan(1);
    expect(maxInsideChecks).toBeLessThanOrEqual(4);
  });

  it("serializes the child remote into the shared workspace lock", async () => {
    mkdirSync(join(parent, "ai-coding"), { recursive: true });
    childRepo("ui");
    writeFileSync(
      join(parent, ".aih-workspace.json"),
      JSON.stringify({ repos: ["ui"], contextDir: "ai-coding" }),
    );
    const run: Runner = async (argv) => {
      const tail = argv.slice(3).join(" ");
      if (tail === "rev-parse --is-inside-work-tree")
        return { code: 0, stdout: "true\n", stderr: "" };
      if (tail === "rev-parse --abbrev-ref HEAD") return { code: 0, stdout: "main\n", stderr: "" };
      if (tail === "rev-parse --short HEAD") return { code: 0, stdout: "abc123\n", stderr: "" };
      if (tail === "status --porcelain") return { code: 0, stdout: "", stderr: "" };
      if (tail === "config --local --get remote.origin.url") {
        return { code: 0, stdout: "https://github.com/acme/ui.git\n", stderr: "" };
      }
      return { code: 1, stdout: "", stderr: "" };
    };

    const actions = (await snapshotCommand.plan(ctx(run, { lock: true }))).actions;
    const lock = writesByPath(actions).get("ai-coding/workspace-lock.json")?.json as
      | { repos?: unknown[] }
      | undefined;

    expect(lock?.repos).toEqual([
      {
        id: "ui",
        path: "ui",
        branch: "main",
        sha: "abc123",
        remote: "https://github.com/acme/ui.git",
        dirty: false,
        git: true,
      },
    ]);
  });

  it("rejects sparse repo arrays instead of returning holes", async () => {
    const repos = new Array<WorkspaceRepo>(2);
    repos[1] = childRepo("ui");

    await expect(mapWorkspaceRepos(repos, async (item) => item.id)).rejects.toThrow(/dense/);
  });
});
