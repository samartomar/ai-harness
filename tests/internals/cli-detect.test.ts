import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  detectClis,
  detectFallbackNotice,
  detectOne,
  presentClis,
  resolveTargetClis,
  resolveTargets,
} from "../../src/internals/cli-detect.js";
import { SUPPORTED_CLIS } from "../../src/internals/clis.js";
import type { PlanContext } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { makeHostAdapter } from "../../src/platform/detect.js";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "aih-home-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

/** Create a home-relative config dir to simulate an installed CLI. */
function configDir(rel: string): void {
  mkdirSync(join(home, rel), { recursive: true });
}

/**
 * A ctx whose `which`/`where` probe reports the given binaries as present.
 * `env.HOME` points at the fake home so config-dir detection is hermetic.
 */
function makeCtx(
  options: Record<string, unknown> = {},
  presentBinaries: string[] = [],
): PlanContext {
  const run = fakeRunner((argv) => {
    if ((argv[0] === "which" || argv[0] === "where") && presentBinaries.includes(argv[1] ?? "")) {
      return { code: 0, stdout: `/usr/bin/${argv[1]}` };
    }
    return { code: 1, spawnError: true };
  });
  return {
    root: home,
    contextDir: ".ai-context",
    apply: false,
    verify: false,
    json: false,
    run,
    host: makeHostAdapter({ platform: "linux", run, env: {} }),
    env: { HOME: home },
    options,
  };
}

describe("detectOne", () => {
  it("detects via a config dir (cheap, no PATH probe)", async () => {
    configDir(".claude");
    const p = await detectOne(makeCtx(), "claude");
    expect(p.present).toBe(true);
    expect(p.via).toBe("config");
    expect(p.detail).toBe("~/.claude");
  });

  it("detects via a binary on PATH when no config dir exists", async () => {
    const p = await detectOne(makeCtx({}, ["codex"]), "codex");
    expect(p.present).toBe(true);
    expect(p.via).toBe("binary");
    expect(p.detail).toBe("codex");
  });

  it("reports absent when neither a config dir nor a binary is found", async () => {
    const p = await detectOne(makeCtx(), "zed");
    expect(p.present).toBe(false);
    expect(p.via).toBeUndefined();
  });

  it("matches antigravity's `agy` binary", async () => {
    const p = await detectOne(makeCtx({}, ["agy"]), "antigravity");
    expect(p.present).toBe(true);
    expect(p.detail).toBe("agy");
  });

  it("detects Kiro via its ~/.kiro config dir", async () => {
    configDir(".kiro");
    const p = await detectOne(makeCtx(), "kiro");
    expect(p.present).toBe(true);
    expect(p.detail).toBe("~/.kiro");
  });
});

describe("detectClis / presentClis", () => {
  it("returns presence for every supported CLI and filters the present ones", async () => {
    configDir(".claude");
    configDir(".cursor");
    const all = await detectClis(makeCtx({}, ["codex"]));
    expect(all).toHaveLength(SUPPORTED_CLIS.length);
    expect(presentClis(all)).toEqual(expect.arrayContaining(["claude", "cursor", "codex"]));
    expect(presentClis(all)).not.toContain("zed");
  });
});

describe("resolveTargetClis", () => {
  it("--detect targets only the present CLIs", async () => {
    configDir(".claude");
    const clis = await resolveTargetClis(makeCtx({ detect: true }, ["gemini"]));
    expect(clis).toEqual(expect.arrayContaining(["claude", "gemini"]));
    expect(clis).not.toContain("zed");
  });

  it("--detect with nothing installed falls back to claude", async () => {
    const clis = await resolveTargetClis(makeCtx({ detect: true }, []));
    expect(clis).toEqual(["claude"]);
  });

  it("--all-tools wins over --detect", async () => {
    const clis = await resolveTargetClis(makeCtx({ detect: true, allTools: true }, []));
    expect(clis).toHaveLength(SUPPORTED_CLIS.length);
  });

  it("an explicit --cli list wins over --detect", async () => {
    configDir(".claude");
    const clis = await resolveTargetClis(makeCtx({ detect: true, cli: "codex" }, []));
    expect(clis).toEqual(["codex"]);
  });

  it("defaults to claude with no flags (no detection performed)", async () => {
    expect(await resolveTargetClis(makeCtx())).toEqual(["claude"]);
  });
});

describe("resolveTargets / detectFallbackNotice", () => {
  it("flags detectFellBack when --detect finds nothing", async () => {
    const r = await resolveTargets(makeCtx({ detect: true }, []));
    expect(r.clis).toEqual(["claude"]);
    expect(r.detectFellBack).toBe(true);
  });

  it("does not flag fallback when --detect finds something", async () => {
    configDir(".claude");
    const r = await resolveTargets(makeCtx({ detect: true }, []));
    expect(r.detectFellBack).toBe(false);
    expect(r.clis).toContain("claude");
  });

  it("never flags fallback without --detect", async () => {
    expect((await resolveTargets(makeCtx())).detectFellBack).toBe(false);
  });

  it("the notice names the fix flags", () => {
    const n = detectFallbackNotice();
    expect(n).toContain("--cli");
    expect(n).toContain("--all-tools");
  });
});
