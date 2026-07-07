import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  Action,
  DocAction,
  ExecAction,
  PlanContext,
  WriteAction,
} from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import { workspaceInitCommand, workspaceReportCommand } from "../../src/workspace/index.js";

let parent: string;

beforeEach(() => {
  parent = mkdtempSync(join(tmpdir(), "aih-ws-recursive-"));
});

afterEach(() => {
  rmSync(parent, { recursive: true, force: true });
});

function ctx(options: Record<string, unknown> = {}): PlanContext {
  const run = fakeRunner(() => undefined);
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

function child(path: string, git = true): void {
  mkdirSync(join(parent, path), { recursive: true });
  if (git) mkdirSync(join(parent, path, ".git"), { recursive: true });
}

function writeManifest(repos: unknown[]): void {
  writeFileSync(
    join(parent, ".aih-workspace.json"),
    JSON.stringify({ contextDir: "ai-coding", repos }, null, 2),
    "utf8",
  );
}

function execs(actions: readonly Action[]): ExecAction[] {
  return actions.filter((action): action is ExecAction => action.kind === "exec");
}

function docs(actions: readonly Action[]): DocAction[] {
  return actions.filter((action): action is DocAction => action.kind === "doc");
}

function writesByPath(actions: readonly Action[]): Map<string, WriteAction> {
  const out = new Map<string, WriteAction>();
  for (const action of actions) {
    if (action.kind === "write") out.set(action.path.replace(/\\/g, "/"), action);
  }
  return out;
}

function expectArgvSuffix(argv: readonly string[], suffix: readonly string[]): void {
  expect(argv.slice(-suffix.length)).toEqual(suffix);
}

describe("workspace recursive child writes", () => {
  it("workspace init defaults to parent-only scaffold and explains the child opt-in", async () => {
    child("ui");

    const actions = (await workspaceInitCommand.plan(ctx({ repos: "ui" }))).actions;

    expect(writesByPath(actions).has(".aih-workspace.json")).toBe(true);
    expect(execs(actions)).toEqual([]);
    expect(
      docs(actions)
        .map((doc) => doc.text)
        .join("\n"),
    ).toContain("aih workspace init --recursive --apply");
  });

  it("workspace init --recursive runs child onboarding only for declared child repos", async () => {
    child("ui");
    child("backend");

    const actions = (
      await workspaceInitCommand.plan(
        ctx({ repos: "ui,backend", recursive: true, cli: "codex", force: true }),
      )
    ).actions;
    const plannedExecs = execs(actions);

    expect(plannedExecs.map((action) => action.cwd)).toEqual([
      join(parent, "ui"),
      join(parent, "backend"),
    ]);
    for (const action of plannedExecs) {
      expectArgvSuffix(action.argv, [
        "init",
        "--apply",
        "--context-dir",
        "ai-coding",
        "--no-log",
        "--cli",
        "codex",
        "--force",
      ]);
    }
  });

  it("skips missing and non-git child repos instead of writing through them", async () => {
    child("ui");
    child("docs", false);
    writeManifest(["ui", "docs", "missing"]);

    const actions = (await workspaceInitCommand.plan(ctx({ recursive: true }))).actions;

    expect(execs(actions).map((action) => action.cwd)).toEqual([join(parent, "ui")]);
    const guidance = docs(actions)
      .map((doc) => doc.text)
      .join("\n");
    expect(guidance).toContain("docs: present but not a git repo");
    expect(guidance).toContain("missing: path missing");
  });

  it("workspace report defaults to the parent artifact and explains child refresh opt-in", async () => {
    child("ui");
    writeManifest(["ui"]);

    const actions = (await workspaceReportCommand.plan(ctx())).actions;
    const plannedExecs = execs(actions);

    expect(plannedExecs).toHaveLength(1);
    expect(plannedExecs[0]?.cwd).toBe(parent);
    expectArgvSuffix(plannedExecs[0]?.argv ?? [], [
      "report",
      "--workspace",
      "--format",
      "html",
      "--apply",
      "--no-log",
    ]);
    expect(
      docs(actions)
        .map((doc) => doc.text)
        .join("\n"),
    ).toContain("aih workspace report --refresh-children --apply");
  });

  it("workspace report --refresh-children refreshes child reports before parent rollup", async () => {
    child("ui");
    child("backend");
    writeManifest(["ui", "backend"]);

    const actions = (await workspaceReportCommand.plan(ctx({ refreshChildren: true }))).actions;
    const plannedExecs = execs(actions);

    expect(plannedExecs.map((action) => action.cwd)).toEqual([
      join(parent, "ui"),
      join(parent, "backend"),
      parent,
    ]);
    expectArgvSuffix(plannedExecs[0]?.argv ?? [], [
      "report",
      "--format",
      "html",
      "--apply",
      "--no-log",
    ]);
    expectArgvSuffix(plannedExecs[2]?.argv ?? [], [
      "report",
      "--workspace",
      "--format",
      "html",
      "--apply",
      "--no-log",
    ]);
  });
});
