import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Action, DocAction, ExecAction, PlanContext } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import { command } from "../../src/superpowers/index.js";
import { superpowersActionsForCli } from "../../src/superpowers/install.js";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "aih-sp-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function makeCtx(options: Record<string, unknown> = {}): PlanContext {
  const run = fakeRunner(() => undefined);
  return {
    root: tmp,
    contextDir: ".ai-context",
    apply: false,
    verify: false,
    json: false,
    run,
    host: makeHostAdapter({ platform: "linux", run, env: {} }),
    env: {},
    options,
  };
}

const docs = (actions: Action[]): DocAction[] =>
  actions.filter((a): a is DocAction => a.kind === "doc");
const execs = (actions: Action[]): ExecAction[] =>
  actions.filter((a): a is ExecAction => a.kind === "exec");

describe("superpowersActionsForCli — per-CLI install", () => {
  it("claude: documents the official-marketplace plugin command", () => {
    const text = docs(superpowersActionsForCli("claude"))
      .map((d) => d.text)
      .join("\n");
    expect(text).toContain("/plugin install superpowers@claude-plugins-official");
  });

  it("antigravity: shell-runnable `agy plugin install` exec", () => {
    const argv = execs(superpowersActionsForCli("antigravity"))[0]?.argv;
    expect(argv).toEqual(["agy", "plugin", "install", "https://github.com/obra/superpowers"]);
  });

  it("copilot: marketplace add + install execs", () => {
    const argvs = execs(superpowersActionsForCli("copilot")).map((e) => e.argv);
    expect(argvs).toEqual([
      ["copilot", "plugin", "marketplace", "add", "obra/superpowers-marketplace"],
      ["copilot", "plugin", "install", "superpowers@superpowers-marketplace"],
    ]);
  });

  it("codex: documents the /plugins TUI flow (not shell-runnable)", () => {
    const actions = superpowersActionsForCli("codex");
    expect(execs(actions)).toHaveLength(0);
    expect(docs(actions)[0]?.text).toContain("/plugins");
  });

  it("cursor: points at the INSTALL guide (no first-class path yet)", () => {
    const text = docs(superpowersActionsForCli("cursor"))
      .map((d) => d.text)
      .join("\n");
    expect(text).toContain("github.com/obra/superpowers");
  });
});

describe("superpowers.plan", () => {
  it("defaults to Claude Code (plugin doc, no exec)", async () => {
    const actions = (await command.plan(makeCtx())).actions;
    expect(execs(actions)).toHaveLength(0);
    expect(
      docs(actions)
        .map((d) => d.text)
        .join("\n"),
    ).toContain("superpowers@claude-plugins-official");
  });

  it("--cli antigravity,copilot emits the shell installs", async () => {
    const actions = (await command.plan(makeCtx({ cli: "antigravity,copilot" }))).actions;
    const flat = execs(actions).map((e) => e.argv[0]);
    expect(flat).toContain("agy");
    expect(flat).toContain("copilot");
  });

  it("BOUNDARY: only doc/exec/write actions (write = Kiro methodology steering)", async () => {
    const actions = (await command.plan(makeCtx({ allTools: true }))).actions;
    for (const a of actions) expect(["doc", "exec", "write"]).toContain(a.kind);
  });

  it("--cli kiro writes the Superpowers methodology steering (inclusion: always)", async () => {
    const actions = (await command.plan(makeCtx({ cli: "kiro" }))).actions;
    const write = actions.find(
      (a): a is Extract<typeof a, { kind: "write" }> =>
        a.kind === "write" &&
        a.path.replace(/\\/g, "/") === ".kiro/steering/superpowers-methodology.md",
    );
    expect(write).toBeDefined();
    expect(write?.contents).toContain("inclusion: always");
    expect(write?.contents).toContain("TDD");
  });
});
