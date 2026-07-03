import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PlanContext } from "../../src/internals/plan.js";
import type { Runner } from "../../src/internals/proc.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import type { WorkspaceManifest, WorkspaceRepo } from "../../src/workspace/manifest.js";
import { collectWorkspaceSnapshot, readWorkspaceRepoState } from "../../src/workspace/state.js";

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

function ctx(run: Runner): PlanContext {
  return {
    root: parent,
    contextDir: "ai-coding",
    apply: false,
    verify: false,
    json: false,
    run,
    host: makeHostAdapter({ platform: "linux", run, env: {} }),
    env: {},
    options: {},
  };
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
});
