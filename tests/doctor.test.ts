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
