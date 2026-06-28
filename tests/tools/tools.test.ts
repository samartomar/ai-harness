import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Action, ExecAction, PlanContext, ProbeAction } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import type { Platform } from "../../src/platform/base.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import { command } from "../../src/tools/index.js";
import { chooseOption, execArgv, TOOLS } from "../../src/tools/install.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aih-tools-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A runner where only `present` binaries resolve on PATH (which/where). */
function pathRunner(present: string[], platform: Platform = "linux") {
  const set = new Set(present);
  const run = fakeRunner((argv) => {
    const name = argv[0] === "which" || argv[0] === "where" ? argv[1] : undefined;
    if (name === undefined) return undefined;
    return set.has(name) ? { code: 0, stdout: `/usr/bin/${name}` } : { code: 1, stdout: "" };
  });
  return { run, platform };
}
function ctx(present: string[], platform: Platform = "linux"): PlanContext {
  const { run } = pathRunner(present, platform);
  return {
    root: dir,
    contextDir: "ai-coding",
    apply: false,
    verify: true,
    json: false,
    run,
    host: makeHostAdapter({ platform, run, env: {} }),
    env: {},
    options: {},
  };
}
const execs = (a: Action[]): ExecAction[] => a.filter((x): x is ExecAction => x.kind === "exec");
const probe = (a: Action[], needle: string): ProbeAction | undefined =>
  a.find((x): x is ProbeAction => x.kind === "probe" && x.describe.includes(needle));

describe("install.ts pure helpers", () => {
  it("chooseOption picks the first option whose PM is available", () => {
    const rg = TOOLS.find((t) => t.bin === "rg");
    if (!rg) throw new Error("rg spec missing");
    expect(chooseOption(rg, new Set(["cargo"]))?.pm).toBe("cargo");
    expect(chooseOption(rg, new Set(["brew", "cargo"]))?.pm).toBe("brew"); // brew is earlier
    expect(chooseOption(rg, new Set(["pip"]))).toBeUndefined();
  });

  it("execArgv routes .cmd shims through `cmd /c` on Windows only", () => {
    expect(execArgv("windows", ["npm", "install", "-g", "x"])).toEqual([
      "cmd",
      "/c",
      "npm",
      "install",
      "-g",
      "x",
    ]);
    expect(execArgv("windows", ["winget", "install", "x"])).toEqual(["winget", "install", "x"]);
    expect(execArgv("linux", ["npm", "install", "-g", "x"])).toEqual(["npm", "install", "-g", "x"]);
  });
});

describe("aih tools — plan", () => {
  it("all tools present → nothing to install, no execs", async () => {
    const allBins = TOOLS.map((t) => t.bin);
    const actions = (await command.plan(ctx(allBins))).actions;
    expect(execs(actions)).toHaveLength(0);
    expect(actions.some((a) => a.kind === "doc" && a.describe.includes("all present"))).toBe(true);
  });

  it("missing tool + available PM → a LOCAL exec with the right command", async () => {
    // brew available (PM), no tools present → rg installs via brew.
    const actions = (await command.plan(ctx(["brew"]))).actions;
    const rgExec = execs(actions).find((e) => e.describe.startsWith("install ripgrep"));
    expect(rgExec?.argv).toEqual(["brew", "install", "ripgrep"]);
    expect(rgExec?.allowFailure).toBe(true);
  });

  it("missing tool with NO supported PM → a manual doc, not an exec", async () => {
    // No PM at all → code-review-graph (uv/pip only) gets a manual doc.
    const actions = (await command.plan(ctx([]))).actions;
    expect(
      actions.some((a) => a.kind === "doc" && a.describe.includes("code-review-graph manually")),
    ).toBe(true);
  });

  it("verify probe: a still-missing CORE tool fails with env.tool-install-blocked", async () => {
    const c = ctx(["brew"]); // brew present but rg never resolves → blocked
    const p = probe((await command.plan(c)).actions, "ripgrep");
    const check = await p?.run(c);
    expect(check?.verdict).toBe("fail");
    expect(check?.code).toBe("env.tool-install-blocked");
    expect(check?.detail).toContain("brew install ripgrep");
  });

  it("verify probe: a still-missing OPTIONAL tool only skips (advisory)", async () => {
    const c = ctx(["brew"]);
    const p = probe((await command.plan(c)).actions, "comby");
    const check = await p?.run(c);
    expect(check?.verdict).toBe("skip");
    expect(check?.code).toBe("env.tool-install-blocked");
  });

  it("verify probe passes (uncoded) once the tool lands on PATH after install", async () => {
    // jq missing at plan time → a jq probe is created; the probe then runs against a
    // ctx where jq IS on PATH (post-install) → pass.
    const p = probe((await command.plan(ctx(["brew"]))).actions, "jq");
    const check = await p?.run(ctx(["brew", "jq"]));
    expect(check?.verdict).toBe("pass");
    expect(check?.code).toBeUndefined();
  });
});
