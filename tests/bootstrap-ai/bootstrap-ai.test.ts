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
): PlanContext {
  const run = fakeRunner(() => undefined);
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
    options,
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
    expect(w.has(".ai-context/REGENERATION.md")).toBe(true);
  });

  it("the behavior core carries the four-part working discipline + invariants", async () => {
    const w = writesByPath((await command.plan(makeCtx())).actions);
    const core = w.get(".ai-context/rules/agent-behavior-core.md")?.contents ?? "";
    expect(core).toContain("Think before coding");
    expect(core).toContain("Simplicity first");
    expect(core).toContain("Surgical changes");
    expect(core).toContain("Goal-driven execution");
    expect(core).toContain("never coerce");
    // The router routes to it as an always-read-first file.
    const router = w.get(".ai-context/RULE_ROUTER.md")?.contents ?? "";
    expect(router).toContain("rules/agent-behavior-core.md");
  });

  it("the router is stack-aware (names the detected language)", async () => {
    put("package.json", JSON.stringify({ name: "svc" }));
    put("tsconfig.json", "{}");
    const w = writesByPath((await command.plan(makeCtx())).actions);
    const router = w.get(".ai-context/RULE_ROUTER.md")?.contents ?? "";
    expect(router).toContain("TypeScript/Node.js");
    expect(router).toContain("Layer 2 wins");
  });

  it("honors --context-dir for every canon path and reference", async () => {
    const p = await command.plan({ ...makeCtx(), contextDir: "ai-coding" });
    const w = writesByPath(p.actions);
    expect(w.has("ai-coding/RULE_ROUTER.md")).toBe(true);
    expect(w.has(".ai-context/RULE_ROUTER.md")).toBe(false);
    expect(w.get("ai-coding/REGENERATION.md")?.contents).toContain("ai-coding/adapters");
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

  it("passes the presence probe when a config dir is present", async () => {
    mkdirSync(join(tmp, ".claude"), { recursive: true });
    const probe = probeNamed((await command.plan(makeCtx())).actions, "claude installed");
    const res = await probe?.run(makeCtx());
    expect(res?.verdict).toBe("pass");
    expect(res?.detail).toContain("config");
  });

  it("--detect targets only the CLIs with a config dir present", async () => {
    mkdirSync(join(tmp, ".claude"), { recursive: true });
    mkdirSync(join(tmp, ".cursor"), { recursive: true });
    const w = writesByPath((await command.plan(makeCtx({ detect: true }))).actions);
    expect(w.has("CLAUDE.md")).toBe(true);
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
