import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  confirmDetectedClis,
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
import type { Prompter } from "../../src/internals/prompt.js";
import { makeHostAdapter } from "../../src/platform/detect.js";

/** A fake prompter that records the questions asked and returns a canned answer. */
function fakePrompter(answer: string): { prompter: Prompter; asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    prompter: {
      ask: async (q: string) => {
        asked.push(q);
        return answer;
      },
    },
  };
}

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
  prompter?: Prompter,
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
    prompter,
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
  it("--detect targets only runnable CLIs", async () => {
    configDir(".claude"); // config-only trace, no binary
    const clis = await resolveTargetClis(makeCtx({ detect: true }, ["gemini"]));
    expect(clis).toEqual(["gemini"]);
    expect(clis).not.toContain("claude");
    expect(clis).not.toContain("zed");
  });

  it("--detect ignores config-only traces and falls back when nothing is runnable", async () => {
    configDir(".windsurf");
    const clis = await resolveTargetClis(makeCtx({ detect: true }, []));
    expect(clis).toEqual(["claude"]);
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

  it("falls back to claude with no flags when nothing runnable is detected", async () => {
    // No binaries on PATH, no marker → claude (CI / fresh box).
    expect(await resolveTargetClis(makeCtx())).toEqual(["claude"]);
  });

  it("with no flags + no marker, defaults to the RUNNABLE installed CLIs (binary on PATH)", async () => {
    // The first-run fix: wire every tool you actually have, not just claude — so a
    // kiro user doesn't have to discover kiro was left unwired.
    const r = await resolveTargetClis(makeCtx({}, ["claude", "kiro", "codex"]));
    expect(r).toEqual(expect.arrayContaining(["claude", "kiro", "codex"]));
    expect(r).not.toContain("cursor"); // not installed → not wired
  });

  it("excludes a config-only/stale tool (config dir, no binary) from the default", async () => {
    configDir(".windsurf"); // leftover dir with no binary on PATH
    const r = await resolveTargetClis(makeCtx()); // nothing runnable
    expect(r).toEqual(["claude"]); // windsurf is NOT wired from a stale dir
  });
});

describe("resolveTargets / detectFallbackNotice", () => {
  it("flags detectFellBack when --detect finds nothing", async () => {
    const r = await resolveTargets(makeCtx({ detect: true }, []));
    expect(r.clis).toEqual(["claude"]);
    expect(r.detectFellBack).toBe(true);
  });

  it("does not flag fallback when --detect finds something", async () => {
    configDir(".claude"); // config-only, ignored for targeting
    const r = await resolveTargets(makeCtx({ detect: true }, ["claude"]));
    expect(r.detectFellBack).toBe(false);
    expect(r.clis).toContain("claude");
  });

  it("never flags fallback without --detect", async () => {
    expect((await resolveTargets(makeCtx())).detectFellBack).toBe(false);
  });

  it("honors the committed marker's targets over the claude default (multi-tool re-run)", async () => {
    // A repo adopted for claude+codex+gemini must regenerate for all three on a bare
    // re-run — not narrow to the claude default (which would drop the codex/gemini canon).
    writeFileSync(
      join(home, ".aih-config.json"),
      JSON.stringify({
        schemaVersion: 1,
        contextDir: "ai-coding",
        targets: ["claude", "codex", "gemini"],
      }),
    );
    const r = await resolveTargets(makeCtx());
    expect(r.clis).toEqual(["claude", "codex", "gemini"]);
  });

  it("an explicit --cli still overrides the marker", async () => {
    writeFileSync(
      join(home, ".aih-config.json"),
      JSON.stringify({ schemaVersion: 1, contextDir: "ai-coding", targets: ["claude", "codex"] }),
    );
    expect((await resolveTargets(makeCtx({ cli: "gemini" }))).clis).toEqual(["gemini"]);
  });

  it("the notice names the fix flags", () => {
    const n = detectFallbackNotice();
    expect(n).toContain("--cli");
    expect(n).toContain("--all-tools");
  });
});

describe("confirmDetectedClis — review the detected list", () => {
  it("bare Enter keeps the detected list as-is", async () => {
    const { prompter } = fakePrompter("");
    expect(await confirmDetectedClis(prompter, ["claude", "codex"])).toEqual(["claude", "codex"]);
  });

  it("a typed list overrides it, parsed + validated (unknowns dropped, deduped)", async () => {
    const { prompter } = fakePrompter("kiro, bogus ,CURSOR, kiro");
    expect(await confirmDetectedClis(prompter, ["claude"])).toEqual(["kiro", "cursor"]);
  });

  it("shows the detected names in the prompt when something was found", async () => {
    const { prompter, asked } = fakePrompter("");
    await confirmDetectedClis(prompter, ["claude", "gemini"]);
    expect(asked[0]).toContain("claude, gemini");
    expect(asked[0]).toContain("Runnable AI CLIs");
    expect(asked[0]).toContain("Press Enter to accept");
  });

  it("asks what to install when nothing was detected", async () => {
    const { prompter, asked } = fakePrompter("");
    await confirmDetectedClis(prompter, []);
    expect(asked[0]).toContain("No runnable AI CLIs were detected");
  });

  it("surfaces config-only traces as manual choices, not default targets", async () => {
    const { prompter, asked } = fakePrompter("");
    expect(await confirmDetectedClis(prompter, ["codex"], ["windsurf"])).toEqual(["codex"]);
    expect(asked[0]).toContain("Config-only traces found");
    expect(asked[0]).toContain("windsurf");
  });
});

describe("resolveTargets — interactive --detect confirm", () => {
  it("bare Enter accepts the detected set", async () => {
    const { prompter, asked } = fakePrompter("");
    const r = await resolveTargets(makeCtx({ detect: true }, ["codex"], prompter));
    expect(r.clis).toEqual(["codex"]);
    expect(r.detectFellBack).toBe(false);
    expect(asked).toHaveLength(1); // the user was asked exactly once
  });

  it("a typed list lets the user add/remove tools before install", async () => {
    configDir(".claude"); // only claude detected…
    const { prompter } = fakePrompter("kiro, codex"); // …but the user wants these
    const r = await resolveTargets(makeCtx({ detect: true }, [], prompter));
    expect(r.clis).toEqual(["kiro", "codex"]);
  });

  it("nothing detected + Enter falls back to claude (and flags it)", async () => {
    const { prompter } = fakePrompter("");
    const r = await resolveTargets(makeCtx({ detect: true }, [], prompter));
    expect(r.clis).toEqual(["claude"]);
    expect(r.detectFellBack).toBe(true);
  });

  it("without a prompter, --detect stays non-interactive (unchanged)", async () => {
    configDir(".claude"); // config-only trace, ignored
    const r = await resolveTargets(makeCtx({ detect: true }, ["codex"])); // no prompter
    expect(r.clis).toEqual(["codex"]);
  });

  it("an explicit --cli list skips the prompt entirely", async () => {
    const { prompter, asked } = fakePrompter("zed");
    const r = await resolveTargets(makeCtx({ detect: true, cli: "codex" }, [], prompter));
    expect(r.clis).toEqual(["codex"]);
    expect(asked).toHaveLength(0); // never prompted — explicit list wins
  });
});
