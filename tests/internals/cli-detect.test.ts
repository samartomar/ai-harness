import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertGovernedMaterializationTargets } from "../../src/ecc/materialization-target.js";
import {
  bareDefaultNarrowingNotice,
  confirmDetectedClis,
  detectClis,
  detectClisByConfig,
  detectFallbackNotice,
  detectOne,
  presentClis,
  resolveTargetClis,
  resolveTargets,
  unmanagedBootloaders,
} from "../../src/internals/cli-detect.js";
import { type Cli, SUPPORTED_CLIS } from "../../src/internals/clis.js";
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
let kiroHome: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "aih-home-"));
  kiroHome = mkdtempSync(join(tmpdir(), "aih-kiro-home-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  rmSync(kiroHome, { recursive: true, force: true });
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

  it("uses KIRO_HOME as Kiro's config root without changing other CLI home lookup", async () => {
    mkdirSync(kiroHome, { recursive: true });
    configDir(".claude");
    const ctx = { ...makeCtx(), env: { HOME: home, KIRO_HOME: kiroHome } };

    await expect(detectOne(ctx, "kiro")).resolves.toMatchObject({
      present: true,
      via: "config",
      detail: "KIRO_HOME",
    });
    await expect(detectOne(ctx, "claude")).resolves.toMatchObject({
      present: true,
      detail: "~/.claude",
    });
  });

  it("falls back to ~/.kiro when KIRO_HOME is unset", async () => {
    configDir(".kiro");
    await expect(detectOne(makeCtx(), "kiro")).resolves.toMatchObject({
      present: true,
      detail: "~/.kiro",
    });
  });

  it("detects the public Kiro target through the documented kiro-cli executable", async () => {
    const p = await detectOne(makeCtx({}, ["kiro-cli"]), "kiro");
    expect(p.present).toBe(true);
    expect(p.via).toBe("binary");
    expect(p.detail).toBe("kiro-cli");
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

  it("includes a KIRO_HOME config trace in the report-safe config-only inventory", () => {
    mkdirSync(kiroHome, { recursive: true });
    const ctx = { ...makeCtx(), env: { HOME: home, KIRO_HOME: kiroHome } };
    expect(detectClisByConfig(ctx).find((presence) => presence.cli === "kiro")).toMatchObject({
      present: true,
      detail: "KIRO_HOME",
    });
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

  it("with no flags + no marker, defaults to claude even when other CLIs are runnable", async () => {
    // A bare first run is deterministic and matches the documented contract.
    // Discovering installed tools remains an explicit --detect operation.
    const r = await resolveTargetClis(makeCtx({}, ["claude", "kiro", "codex"]));
    expect(r).toEqual(["claude"]);
  });

  it("ignores a config-only/stale tool AND a runnable binary alike", async () => {
    // Neither signal drives a bare run any more: the default is unconditional.
    configDir(".windsurf"); // leftover dir, no binary
    expect(await resolveTargetClis(makeCtx({}, ["windsurf"]))).toEqual(["claude"]);
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

describe("bareDefault — the silent-narrowing signal", () => {
  it("flags bareDefault when nothing selects targets (no flags, no marker)", async () => {
    const r = await resolveTargets(makeCtx({}, ["claude", "codex"]));
    expect(r.clis).toEqual(["claude"]);
    expect(r.bareDefault).toBe(true);
  });

  it("does not flag bareDefault when the committed marker supplies targets", async () => {
    writeFileSync(
      join(home, ".aih-config.json"),
      JSON.stringify({ schemaVersion: 1, contextDir: "ai-coding", targets: ["claude", "codex"] }),
    );
    expect((await resolveTargets(makeCtx())).bareDefault).toBe(false);
  });

  it("does not flag bareDefault for any explicit selection", async () => {
    expect((await resolveTargets(makeCtx({ cli: "codex" }))).bareDefault).toBe(false);
    expect((await resolveTargets(makeCtx({ allTools: true }))).bareDefault).toBe(false);
    expect((await resolveTargets(makeCtx({ detect: true }, ["codex"]))).bareDefault).toBe(false);
  });

  it("does not flag bareDefault when an orchestrator injected the targets", async () => {
    const ctx = { ...makeCtx(), targets: ["claude", "gemini"] as Cli[] };
    expect((await resolveTargets(ctx)).bareDefault).toBe(false);
  });

  it("reports bootloaders present in the repo that the target set will not regenerate", () => {
    writeFileSync(join(home, "CLAUDE.md"), "# claude");
    writeFileSync(join(home, "AGENTS.md"), "# agents");
    writeFileSync(join(home, "GEMINI.md"), "# gemini");
    // Named as FILES, not CLIs: AGENTS.md is shared by codex/antigravity/opencode/
    // zed/kimi, so listing tool names would invent intent the repo never expressed.
    expect(unmanagedBootloaders(home, ["claude"])).toEqual(["AGENTS.md", "GEMINI.md"]);
  });

  it("reports nothing when the target set already regenerates every bootloader present", () => {
    writeFileSync(join(home, "CLAUDE.md"), "# claude");
    expect(unmanagedBootloaders(home, ["claude"])).toEqual([]);
  });

  it("the narrowing notice names the unmanaged files and the fix flags", () => {
    const n = bareDefaultNarrowingNotice(["AGENTS.md", "GEMINI.md"]);
    expect(n).toContain("AGENTS.md");
    expect(n).toContain("GEMINI.md");
    expect(n).toContain("--cli");
    expect(n).toContain("--detect");
  });
});

function writeOrgPolicy({
  minimumPosture = "vibe",
  supportedClis,
}: {
  minimumPosture?: "vibe" | "enterprise";
  supportedClis?: readonly string[];
} = {}): void {
  const governance: Record<string, unknown> = {
    policyVersion: "1",
    catalog: { reviewed: [], custom: [] },
    activations: [],
    authority: { approvals: [] },
    externalCuration: [],
    externalSelections: [],
  };
  if (supportedClis !== undefined) governance.supportedClis = supportedClis;
  writeFileSync(
    join(home, "aih-org-policy.json"),
    JSON.stringify({
      schemaVersion: 2,
      minimumPosture,
      references: { repoContract: "ai-coding/project.json" },
      governance,
    }),
  );
}

describe("resolveTargets — org supported-CLI allow-list", () => {
  it("allows a selected CLI that the org policy sanctions", async () => {
    writeOrgPolicy({ supportedClis: ["claude", "codex"] });
    await expect(resolveTargets(makeCtx({ cli: "codex" }))).resolves.toMatchObject({
      clis: ["codex"],
    });
  });

  it("leaves vibe posture unrestricted when the allow-list is absent", async () => {
    writeOrgPolicy();
    await expect(resolveTargets(makeCtx({ cli: "codex" }))).resolves.toMatchObject({
      clis: ["codex"],
    });
  });

  it.each(["vibe", "enterprise"] as const)(
    "refuses an explicit selected CLI that the present %s allow-list does not sanction",
    async (minimumPosture) => {
      writeOrgPolicy({ minimumPosture, supportedClis: ["claude"] });
      await expect(resolveTargets(makeCtx({ cli: "codex" }))).rejects.toThrow(
        /organization sanction gate.*codex.*allowed: claude/i,
      );
    },
  );

  it("reports materialization capability separately after organization sanction succeeds", async () => {
    writeOrgPolicy({ minimumPosture: "enterprise", supportedClis: ["zed"] });
    const resolved = await resolveTargets(makeCtx({ cli: "zed" }));
    expect(resolved.clis).toEqual(["zed"]);
    expect(() => assertGovernedMaterializationTargets(resolved.clis)).toThrow(
      /materialization capability gate.*zed is not a governed materialization target/i,
    );
  });

  it("refuses --all-tools when any selected CLI is not sanctioned", async () => {
    writeOrgPolicy({ supportedClis: ["claude", "codex"] });
    await expect(resolveTargets(makeCtx({ allTools: true }))).rejects.toThrow(
      /organization sanction gate.*cursor/i,
    );
  });

  it("refuses a detected runnable CLI that is not sanctioned", async () => {
    writeOrgPolicy({ supportedClis: ["claude"] });
    await expect(resolveTargets(makeCtx({ detect: true }, ["codex"]))).rejects.toThrow(
      /organization sanction gate.*codex/i,
    );
  });

  it("refuses a marker-derived CLI that is not sanctioned", async () => {
    writeOrgPolicy({ supportedClis: ["claude"] });
    writeFileSync(
      join(home, ".aih-config.json"),
      JSON.stringify({ schemaVersion: 1, contextDir: "ai-coding", targets: ["claude", "codex"] }),
    );
    await expect(resolveTargets(makeCtx())).rejects.toThrow(/organization sanction gate.*codex/i);
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
