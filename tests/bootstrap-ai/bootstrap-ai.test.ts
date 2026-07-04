import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { command } from "../../src/bootstrap-ai/index.js";
import { executePlan } from "../../src/internals/execute.js";
import type { Action, PlanContext, ProbeAction, WriteAction } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { makeHostAdapter } from "../../src/platform/detect.js";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "aih-bootai-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function put(relPath: string, contents: string): void {
  const full = join(tmp, relPath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, contents, "utf8");
}

function makeCtx(
  options: Record<string, unknown> = {},
  flags: { apply?: boolean; verify?: boolean } = {},
  presentBinaries: string[] = [],
): PlanContext {
  const run = fakeRunner((argv) => {
    if ((argv[0] === "which" || argv[0] === "where") && presentBinaries.includes(argv[1] ?? "")) {
      return { code: 0, stdout: `/usr/bin/${argv[1]}` };
    }
    return undefined;
  });
  return {
    root: tmp,
    contextDir: ".ai-context",
    apply: flags.apply ?? false,
    verify: flags.verify ?? false,
    json: false,
    run,
    host: makeHostAdapter({ platform: "linux", run, env: {} }),
    // Point HOME at the (empty) temp dir so presence detection is hermetic.
    env: { HOME: tmp },
    // Existing assertions cover the legacy canon (RULE_ROUTER → INDEX, the meta-docs);
    // compact (the default) has its own suite below. Merge so a caller's flags survive.
    options: { canon: "legacy", ...options },
  };
}

function writesByPath(actions: Action[]): Map<string, WriteAction> {
  const m = new Map<string, WriteAction>();
  for (const a of actions) if (a.kind === "write") m.set(a.path.replace(/\\/g, "/"), a);
  return m;
}

function probeNamed(actions: Action[], needle: string): ProbeAction | undefined {
  return actions.find((a): a is ProbeAction => a.kind === "probe" && a.describe.includes(needle));
}

describe("bootstrap-ai — canon files", () => {
  it("writes the router, shared block, behavior core, adapter note, and REGENERATION", async () => {
    put("package.json", JSON.stringify({ name: "svc" }));
    put("tsconfig.json", "{}");
    const w = writesByPath((await command.plan(makeCtx())).actions);
    expect(w.has(".ai-context/RULE_ROUTER.md")).toBe(true);
    expect(w.has(".ai-context/adapters/_shared-canonical-block.md")).toBe(true);
    expect(w.has(".ai-context/rules/agent-behavior-core.md")).toBe(true);
    expect(w.has(".ai-context/adapters/claude.md")).toBe(true);
    expect(w.has(".ai-context/adapters/other-tools.md")).toBe(true);
    expect(w.has(".ai-context/REGENERATION.md")).toBe(true);
    expect(w.has(".ai-context/harness-update.md")).toBe(true);
  });

  it("the harness-update doc explains managed vs user-owned files + the update path", async () => {
    const w = writesByPath((await command.plan(makeCtx())).actions);
    const upd = w.get(".ai-context/harness-update.md")?.contents ?? "";
    expect(upd).toContain("Harness-managed");
    expect(upd).toContain("write-once");
    expect(upd).toContain("INDEX.md");
    expect(upd).toContain("tasks.md");
    expect(upd).toContain("skills/**");
    expect(upd).toContain("aih init --apply");
  });

  it("the other-tools doc explains wiring an unsupported tool (incl. Kiro)", async () => {
    const w = writesByPath((await command.plan(makeCtx())).actions);
    const doc = w.get(".ai-context/adapters/other-tools.md")?.contents ?? "";
    expect(doc).toContain("Kiro");
    expect(doc).toContain(".kiro/steering/");
    expect(doc).toContain("RULE_ROUTER.md");
  });

  it("the behavior core carries the four-part working discipline + invariants", async () => {
    const w = writesByPath((await command.plan(makeCtx())).actions);
    const core = w.get(".ai-context/rules/agent-behavior-core.md")?.contents ?? "";
    expect(core).toContain("Think before coding");
    expect(core).toContain("Simplicity first");
    expect(core).toContain("Surgical changes");
    expect(core).toContain("Goal-driven execution");
    expect(core).toContain("never coerce");
    expect(core).toContain("Do not open `.env*` or `secrets/**`");
    expect(core).toContain("code-review-graph");
    // The router routes to it as an always-read-first file.
    const router = w.get(".ai-context/RULE_ROUTER.md")?.contents ?? "";
    expect(router).toContain("rules/agent-behavior-core.md");
  });

  it("folds in the anti-attestation + tool-selection rules and drops the immutability style-rule (§6)", async () => {
    const w = writesByPath((await command.plan(makeCtx())).actions);
    const shared = w.get(".ai-context/adapters/_shared-canonical-block.md")?.contents ?? "";
    const core = w.get(".ai-context/rules/agent-behavior-core.md")?.contents ?? "";
    // Anti-attestation: showing the command + output is required; a sanity gate is not done.
    expect(shared).toContain("sanity gate is not a completion gate");
    expect(core).toContain("sanity gate is not a completion gate");
    // Tool-selection discipline.
    expect(shared).toContain("don't load MCP servers just-in-case");
    expect(core).toContain("don't load MCP servers just-in-case");
    // The immutability style-rule is gone from the floor (linter-enforced; false for Go/Rust)...
    expect(shared).not.toContain("Immutable updates over mutation");
    expect(core).not.toContain("Immutable updates over mutation");
    // ...but the real safety invariant stays.
    expect(shared).toContain("no silent failures");
  });

  it("the shared block carries the safety invariants (secrets + large-repo graph)", async () => {
    const w = writesByPath((await command.plan(makeCtx({ cli: "codex,gemini,kiro" }))).actions);
    const shared = w.get(".ai-context/adapters/_shared-canonical-block.md")?.contents ?? "";
    expect(shared).toContain("aih secrets --verify");
    expect(shared).toContain("bounded `rg`/`fd` reads");
  });

  it("the router is stack-aware (names the detected language)", async () => {
    put("package.json", JSON.stringify({ name: "svc", scripts: { start: "node app.js" } }));
    put("tsconfig.json", "{}");
    const w = writesByPath((await command.plan(makeCtx())).actions);
    const router = w.get(".ai-context/RULE_ROUTER.md")?.contents ?? "";
    expect(router).toContain("TypeScript/Node.js");
    expect(router).toContain("start `npm start`");
    expect(router).toContain("Layer 2 wins");
    expect(router).toContain("Do not open `.env*` or `secrets/**`");
    expect(router).toContain("large-repo graph safety");
  });

  it("honors --context-dir for every canon path and reference", async () => {
    const p = await command.plan({ ...makeCtx(), contextDir: "ai-coding" });
    const w = writesByPath(p.actions);
    expect(w.has("ai-coding/RULE_ROUTER.md")).toBe(true);
    expect(w.has(".ai-context/RULE_ROUTER.md")).toBe(false);
    expect(w.get("ai-coding/REGENERATION.md")?.contents).toContain("ai-coding/adapters");
  });
});

describe("bootstrap-ai — compact canon (default)", () => {
  it("routes the RULE_ROUTER + adapter at the contract and drops the meta-docs", async () => {
    const w = writesByPath((await command.plan(makeCtx({ canon: "compact" }))).actions);
    // Meta-docs are legacy-only now.
    expect(w.has(".ai-context/REGENERATION.md")).toBe(false);
    expect(w.has(".ai-context/harness-update.md")).toBe(false);
    expect(w.has(".ai-context/adapters/other-tools.md")).toBe(false);
    // The router + adapter route at the contract, not INDEX/architecture.
    const router = w.get(".ai-context/RULE_ROUTER.md")?.contents ?? "";
    expect(router).toContain("project.md");
    expect(router).toContain("project.json");
    expect(router).not.toContain("INDEX.md");
    const adapter = w.get(".ai-context/adapters/claude.md")?.contents ?? "";
    expect(adapter).toContain("project.md");
    expect(adapter).not.toContain("INDEX.md");
    // Core canon still ships.
    expect(w.has(".ai-context/adapters/_shared-canonical-block.md")).toBe(true);
    expect(w.has(".ai-context/rules/agent-behavior-core.md")).toBe(true);
  });

  it("the compact bootloader preamble no longer points at REGENERATION.md", async () => {
    const w = writesByPath((await command.plan(makeCtx({ canon: "compact" }))).actions);
    const claude = w.get("CLAUDE.md")?.contents ?? "";
    expect(claude).not.toContain("REGENERATION.md");
    expect(claude).toContain("RULE_ROUTER.md"); // still routes to the canon
  });

  it("the compact canon lints clean (contract refs resolve via the sibling allowlist)", async () => {
    // Under --verify the lint probes run; project.md/project.json resolve even though
    // bootstrap-ai itself doesn't write them (the contract phase does).
    const verifyCtx = makeCtx({ canon: "compact" }, { verify: true });
    const res = await executePlan(await command.plan(verifyCtx), verifyCtx);
    const lintFails = (res.report?.checks ?? []).filter(
      (c) => c.verdict === "fail" && c.name.startsWith("lint "),
    );
    expect(lintFails).toEqual([]);
  });
});

describe("bootstrap-ai — CLI-aware bootloaders", () => {
  it("default (claude) writes CLAUDE.md carrying the shared block + router ref", async () => {
    const w = writesByPath((await command.plan(makeCtx())).actions);
    const claude = w.get("CLAUDE.md")?.contents ?? "";
    expect(claude).toContain("<!-- BEGIN ai-canonical:shared");
    expect(claude).toContain("RULE_ROUTER.md");
    expect(w.has("AGENTS.md")).toBe(false);
  });

  it("--cli codex,gemini,cursor writes AGENTS.md, GEMINI.md and the Cursor MDC", async () => {
    const w = writesByPath((await command.plan(makeCtx({ cli: "codex,gemini,cursor" }))).actions);
    expect(w.has("AGENTS.md")).toBe(true);
    expect(w.has("GEMINI.md")).toBe(true);
    const mdc = w.get(".cursor/rules/00-canon.mdc")?.contents ?? "";
    expect(mdc.startsWith("---\n")).toBe(true);
    expect(mdc).toContain("alwaysApply: true");
    expect(mdc).toContain("<!-- BEGIN ai-canonical:shared");
  });

  it("--cli kiro writes a Kiro steering file (inclusion: always + router live-ref)", async () => {
    const w = writesByPath((await command.plan(makeCtx({ cli: "kiro" }))).actions);
    const steering = w.get(".kiro/steering/00-canon.md")?.contents ?? "";
    expect(steering.startsWith("---\n")).toBe(true);
    expect(steering).toContain("inclusion: always");
    expect(steering).toContain("#[[file:.ai-context/RULE_ROUTER.md]]");
    expect(steering).toContain("<!-- BEGIN ai-canonical:shared");
    expect(w.has("CLAUDE.md")).toBe(false);
  });

  it("--cli kiro generates real .kiro.hook files + agent-tools steering", async () => {
    put(
      "package.json",
      JSON.stringify({ name: "svc", scripts: { test: "vitest run", lint: "biome" } }),
    );
    put("tsconfig.json", "{}");
    const w = writesByPath((await command.plan(makeCtx({ cli: "kiro" }))).actions);
    expect(w.has(".kiro/steering/agent-tools.md")).toBe(true);
    // Hook uses Kiro's verified real schema (when/then types).
    const hook = w.get(".kiro/hooks/aih-tests-on-edit.kiro.hook")?.json as {
      when: { type: string };
      then: { type: string };
    };
    expect(hook.when.type).toBe("fileEdited");
    expect(hook.then.type).toBe("askAgent");
    // Quality gate runs the repo's real (detected) test + lint commands.
    const gate = w.get(".kiro/hooks/aih-quality-gate.kiro.hook")?.json as {
      when: { type: string };
      then: { command: string };
    };
    expect(gate.when.type).toBe("userTriggered");
    expect(gate.then.command).toContain("npm test");
    // Metrics hook fires on the verified agentStop event and records a sample,
    // fail-open: `aih track` runs inside a one-shot `node -e` try/catch so a missing
    // or hung `aih` can never fail the turn, with a seconds-unit timeout cap.
    const metrics = w.get(".kiro/hooks/aih-metrics-on-stop.kiro.hook")?.json as {
      when: { type: string };
      timeout: number;
      then: { command: string };
    };
    expect(metrics.when.type).toBe("agentStop");
    expect(metrics.then.command).toContain("aih track --apply");
    expect(metrics.then.command.startsWith("node -e ")).toBe(true); // dependency-free wrapper
    expect(metrics.then.command).toContain("catch"); // swallows missing/failing aih
    expect(metrics.timeout).toBeGreaterThan(0); // caps a stuck aih (Kiro timeout is seconds)
  });

  it("persists the .aih-config.json marker for the resolved targets (standalone)", async () => {
    const w = writesByPath((await command.plan(makeCtx({ cli: "claude,codex" }))).actions);
    const marker = w.get(".aih-config.json");
    expect(marker).toBeDefined();
    expect(marker?.merge).toBe(true);
    expect((marker?.json as { targets?: string[] })?.targets).toEqual(["claude", "codex"]);
  });

  it("--all-tools dedupes AGENTS.md to a single write", async () => {
    const actions = (await command.plan(makeCtx({ allTools: true }))).actions;
    const agents = actions.filter(
      (a) => a.kind === "write" && a.path.replace(/\\/g, "/") === "AGENTS.md",
    );
    expect(agents).toHaveLength(1);
  });

  it("merges into an existing bootloader, preserving hand-written content", async () => {
    put("CLAUDE.md", "# My hand-written header\n\nProject-specific note.\n");
    const w = writesByPath((await command.plan(makeCtx())).actions);
    const claude = w.get("CLAUDE.md")?.contents ?? "";
    expect(claude).toContain("My hand-written header");
    expect(claude).toContain("Project-specific note.");
    expect(claude).toContain("<!-- BEGIN ai-canonical:shared");
  });

  it("reports existing bootloader writes as merge effects, not overwrites", async () => {
    put("CLAUDE.md", "# My hand-written header\n\nProject-specific note.\n");
    const ctx = makeCtx();
    const res = await executePlan(await command.plan(ctx), ctx);
    const claude = res.writes.find((w) => w.path === "CLAUDE.md");
    expect(claude?.effect).toBe("merge");
    expect(claude?.effect).not.toBe("overwrite");
  });
});

describe("bootstrap-ai — doctor probes (drift gate)", () => {
  it("fails when the bootloader is missing, passes after --apply", async () => {
    const probe = probeNamed((await command.plan(makeCtx())).actions, "CLAUDE.md in sync");
    expect(probe).toBeDefined();
    // Before apply: missing.
    const before = await probe?.run(makeCtx());
    expect(before?.verdict).toBe("fail");

    // Apply, then the same probe passes.
    const applied = makeCtx({}, { apply: true });
    await executePlan(await command.plan(applied), applied);
    const after = await probe?.run(applied);
    expect(after?.verdict).toBe("pass");
  });

  it("fails on drift: a hand-edited canonical block is detected", async () => {
    const applied = makeCtx({}, { apply: true });
    await executePlan(await command.plan(applied), applied);

    // Corrupt the managed block body on disk.
    const drifted = join(tmp, "CLAUDE.md");
    const original = readFileSync(drifted, "utf8");
    writeFileSync(drifted, original.replace("## Start here", "## Tampered"), "utf8");

    const probe = probeNamed((await command.plan(applied)).actions, "CLAUDE.md in sync");
    const res = await probe?.run(applied);
    expect(res?.verdict).toBe("fail");
    expect(res?.detail).toContain("drift");
  });
});

describe("bootstrap-ai — CLI presence confirm step", () => {
  it("skips the presence probe when the targeted CLI is not installed", async () => {
    const probe = probeNamed((await command.plan(makeCtx())).actions, "claude installed");
    expect(probe).toBeDefined();
    const res = await probe?.run(makeCtx());
    expect(res?.verdict).toBe("skip"); // empty $HOME, no binary → not detected
  });

  it("skips the presence probe when only a config dir is present", async () => {
    mkdirSync(join(tmp, ".claude"), { recursive: true });
    const probe = probeNamed((await command.plan(makeCtx())).actions, "claude installed");
    const res = await probe?.run(makeCtx());
    expect(res?.verdict).toBe("skip");
    expect(res?.detail).toContain("config-only");
  });

  it("passes the presence probe when a CLI binary is on PATH", async () => {
    const ctx = makeCtx({}, {}, ["claude"]);
    const probe = probeNamed((await command.plan(ctx)).actions, "claude installed");
    const res = await probe?.run(ctx);
    expect(res?.verdict).toBe("pass");
    expect(res?.detail).toContain("runnable on PATH");
  });

  it("--detect targets only runnable CLIs", async () => {
    mkdirSync(join(tmp, ".claude"), { recursive: true });
    const w = writesByPath((await command.plan(makeCtx({ detect: true }, {}, ["cursor"]))).actions);
    expect(w.has("CLAUDE.md")).toBe(false);
    expect(w.has(".cursor/rules/00-canon.mdc")).toBe(true);
    expect(w.has("AGENTS.md")).toBe(false); // codex/etc not installed in the fake home
  });
});

describe("bootstrap-ai — hygiene & detect notice", () => {
  it("writes .gitignore ignoring the harness's backup/temp files", async () => {
    const w = writesByPath((await command.plan(makeCtx())).actions);
    expect(w.has(".gitignore")).toBe(true);
    expect(w.get(".gitignore")?.contents).toContain("*.aih.bak");
    expect(w.get(".gitignore")?.contents).toContain("*.aih.tmp");
  });

  it("--detect with no CLIs present emits the fallback notice", async () => {
    const emptyHome = mkdtempSync(join(tmpdir(), "aih-eh-"));
    const run = fakeRunner((argv) =>
      argv[0] === "which" || argv[0] === "where" ? { code: 1, spawnError: true } : undefined,
    );
    const ctx: PlanContext = {
      ...makeCtx({ detect: true }),
      env: { HOME: emptyHome, USERPROFILE: emptyHome },
      run,
      host: makeHostAdapter({ platform: "linux", run, env: {} }),
    };
    const hasNotice = (await command.plan(ctx)).actions.some(
      (a) => a.kind === "doc" && a.describe.includes("no AI CLIs detected"),
    );
    rmSync(emptyHome, { recursive: true, force: true });
    expect(hasNotice).toBe(true);
  });
});

describe("bootstrap-ai — boundary", () => {
  it("plans only write/probe/doc actions — no exec, no remote write target", async () => {
    const actions = (await command.plan(makeCtx({ allTools: true }))).actions;
    for (const a of actions) {
      expect(["write", "probe", "doc"]).toContain(a.kind);
      if (a.kind === "write") {
        expect(a.path.startsWith("http")).toBe(false);
        expect(a.path.startsWith("/")).toBe(false);
      }
    }
  });
});
