import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { adapterNote } from "../../src/bootstrap-ai/canon.js";
import { command } from "../../src/bootstrap-ai/index.js";
import { executePlan, resolveContents } from "../../src/internals/execute.js";
import { LOADABILITY_SENTINEL } from "../../src/internals/loadability-sentinel.js";
import type { Action, PlanContext, ProbeAction, WriteAction } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import { stalePruneSet } from "../../src/prune/detect.js";

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

const PREVIOUS_GEMINI_ADAPTER = `# Gemini CLI adapter

Gemini CLI-specific files are bootloaders and local wiring only — not the
source of repo truth.

## Entry points

- root \`GEMINI.md\`
- \`.ai-context/RULE_ROUTER.md\` — layered model, detected stack, task routing
- \`.ai-context/INDEX.md\` — repo context (run \`aih scaffold\` if absent)

## How it loads rules

- Gemini CLI reads \`GEMINI.md\`; global rules live in \`~/.gemini/GEMINI.md\`.

## Boundaries

Gemini CLI may propose, implement when assigned, and review. It must not push,
merge, bypass CI, or approve a merge without explicit human approval.

## Baseline layer

ECC + Superpowers install the generic baseline at \`~/.gemini/\`; repo canon
under \`.ai-context/\` overrides it on conflict (see \`RULE_ROUTER.md\` § Layered model).
`;

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
  it("keeps the previous full adapter byte-identical in legacy mode", () => {
    expect(adapterNote("gemini", ".ai-context", "legacy")).toBe(PREVIOUS_GEMINI_ADAPTER);
  });

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
    expect(w.get(".ai-context/RULE_ROUTER.md")?.contents).toContain(LOADABILITY_SENTINEL);
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

  it("the shared block carries secrets safety and advisory graph routing", async () => {
    const w = writesByPath((await command.plan(makeCtx({ cli: "codex,gemini,kiro" }))).actions);
    const shared = w.get(".ai-context/adapters/_shared-canonical-block.md")?.contents ?? "";
    expect(shared).toContain("aih secrets --verify");
    expect(shared).toContain("code-review-graph");
    expect(shared).toContain("advisory blast-area context");
    expect(shared).toContain("warn once and continue");
    expect(shared).not.toContain("code-review-graph is a hard prerequisite");
    expect(shared).not.toContain("stop; repair it and verify a populated graph before continuing");
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
    expect(router).toContain("including `code-review-graph` — are advisory");
    expect(router).not.toContain("graph failure is fail-closed");
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
    expect(router).toContain(LOADABILITY_SENTINEL);
    expect(router).toContain("project.md");
    expect(router).toContain("project.json");
    expect(router).not.toContain("INDEX.md");
    const adapter = w.get(".ai-context/adapters/claude.md")?.contents ?? "";
    expect(adapter).toContain("RULE_ROUTER.md");
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

  it("--cli kiro generates current standalone v1 JSON hooks + agent-tools steering", async () => {
    put(
      "package.json",
      JSON.stringify({ name: "svc", scripts: { test: "vitest run", lint: "biome" } }),
    );
    put("tsconfig.json", "{}");
    const w = writesByPath((await command.plan(makeCtx({ cli: "kiro" }))).actions);
    expect(w.has(".kiro/steering/agent-tools.md")).toBe(true);
    const hook = w.get(".kiro/hooks/aih-tests-on-edit.json")?.json as {
      version: string;
      hooks: Array<{ trigger: string; action: { type: string } }>;
    };
    expect(hook.version).toBe("v1");
    expect(hook.hooks[0]?.trigger).toBe("PostFileSave");
    expect(hook.hooks[0]?.action.type).toBe("agent");
    // IDE 1.x removed the Manual hook trigger; AIH never emits an inert v1 hook.
    expect(w.has(".kiro/hooks/aih-quality-gate.json")).toBe(false);
    // Metrics hook fires on the verified agentStop event and records a sample,
    // fail-open: `aih track` runs inside a one-shot `node -e` try/catch so a missing
    // or hung `aih` can never fail the turn, with a seconds-unit timeout cap.
    const metrics = w.get(".kiro/hooks/aih-metrics-on-stop.json")?.json as {
      hooks: Array<{ trigger: string; timeout: number; action: { command: string } }>;
    };
    expect(metrics.hooks[0]?.trigger).toBe("Stop");
    expect(metrics.hooks[0]?.action.command).toContain("['track','--apply']");
    expect(metrics.hooks[0]?.action.command.startsWith("node -e ")).toBe(true);
    expect(metrics.hooks[0]?.action.command).toContain("execFileSync");
    expect(metrics.hooks[0]?.action.command).toContain("shell:false");
    expect(metrics.hooks[0]?.action.command).toContain("catch");
    expect(metrics.hooks[0]?.timeout).toBeGreaterThan(0);
  });

  it("persists the .aih-config.json marker for the resolved targets (standalone)", async () => {
    const w = writesByPath((await command.plan(makeCtx({ cli: "claude,codex" }))).actions);
    const marker = w.get(".aih-config.json");
    expect(marker).toBeDefined();
    expect(marker?.merge).toBe(true);
    expect((marker?.json as { targets?: string[] })?.targets).toEqual(["claude", "codex"]);
  });

  // #506 F3: the marker previously deep-merged, and deepMerge UNIONS arrays — so an
  // explicit `--cli claude,codex` run could never narrow the persisted targets, and
  // the next marker-driven bare run resurrected the gemini adapter + bootloader
  // (on-disk footprint convergence silently beating the CLI scope).
  it("explicit --cli replaces the persisted marker targets instead of unioning into them", async () => {
    put(
      ".aih-config.json",
      `${JSON.stringify(
        { schemaVersion: 1, contextDir: ".ai-context", targets: ["claude", "codex", "gemini"] },
        null,
        2,
      )}\n`,
    );
    const marker = writesByPath((await command.plan(makeCtx({ cli: "claude,codex" }))).actions).get(
      ".aih-config.json",
    );
    expect(marker).toBeDefined();
    expect(marker?.replaceJsonKeys).toContain("targets");
    const merged = JSON.parse(
      resolveContents(marker as WriteAction, join(tmp, ".aih-config.json")),
    ) as { targets?: string[] };
    expect(merged.targets).toEqual(["claude", "codex"]);
  });

  it("a marker-scoped re-run leaves dropped adapters as prune membership evidence", async () => {
    put(
      ".aih-config.json",
      `${JSON.stringify(
        { schemaVersion: 1, contextDir: ".ai-context", targets: ["claude", "codex"] },
        null,
        2,
      )}\n`,
    );
    put("GEMINI.md", "# stale gemini bootloader\n");
    put(".ai-context/adapters/gemini.md", PREVIOUS_GEMINI_ADAPTER);
    const applyCtx = makeCtx({}, { apply: true });
    const result = await executePlan(await command.plan(applyCtx), applyCtx);
    const w = writesByPath((await command.plan(makeCtx())).actions);
    expect(w.has("CLAUDE.md")).toBe(true);
    expect(w.has("AGENTS.md")).toBe(true);
    expect(w.has("GEMINI.md")).toBe(false);
    expect(w.has(".ai-context/adapters/gemini.md")).toBe(false);
    expect(result.removed.map((entry) => entry.path)).not.toContain(
      ".ai-context/adapters/gemini.md",
    );
    expect(readFileSync(join(tmp, "GEMINI.md"), "utf8")).toBe("# stale gemini bootloader\n");
    expect(readFileSync(join(tmp, ".ai-context", "adapters", "gemini.md"), "utf8")).toBe(
      PREVIOUS_GEMINI_ADAPTER,
    );
    const stale = stalePruneSet(applyCtx);
    expect(stale.dropped).toEqual(["gemini"]);
    expect(stale.artifacts.map((artifact) => artifact.path)).toEqual([
      ".ai-context/adapters/gemini.md",
      "GEMINI.md",
    ]);

    const converged = await executePlan(await command.plan(applyCtx), applyCtx);
    expect(converged.removed.map((entry) => entry.path)).not.toContain(
      ".ai-context/adapters/gemini.md",
    );
  });

  it("preserves an operator-authored adapter outside the resolved target set", async () => {
    put(
      ".aih-config.json",
      `${JSON.stringify(
        { schemaVersion: 1, contextDir: ".ai-context", targets: ["claude", "codex"] },
        null,
        2,
      )}\n`,
    );
    const operatorAdapter = "# Gemini adapter\n\nOperator-owned instructions.\n";
    put(".ai-context/adapters/gemini.md", operatorAdapter);

    const applyCtx = makeCtx({}, { apply: true });
    const result = await executePlan(await command.plan(applyCtx), applyCtx);

    expect(result.removed.map((entry) => entry.path)).not.toContain(
      ".ai-context/adapters/gemini.md",
    );
    expect(readFileSync(join(tmp, ".ai-context", "adapters", "gemini.md"), "utf8")).toBe(
      operatorAdapter,
    );
  });

  it("preserves a dropped adapter edited after preview for explicit prune", async () => {
    put(
      ".aih-config.json",
      `${JSON.stringify(
        { schemaVersion: 1, contextDir: ".ai-context", targets: ["claude", "codex"] },
        null,
        2,
      )}\n`,
    );
    put(".ai-context/adapters/gemini.md", adapterNote("gemini", ".ai-context", "legacy"));
    const applyCtx = makeCtx({}, { apply: true });
    const planned = await command.plan(applyCtx);
    const operatorEdit = "# Gemini adapter\n\nEdited after preview.\n";
    put(".ai-context/adapters/gemini.md", operatorEdit);

    await expect(executePlan(planned, applyCtx)).resolves.toBeDefined();
    expect(readFileSync(join(tmp, ".ai-context", "adapters", "gemini.md"), "utf8")).toBe(
      operatorEdit,
    );
  });

  it("does not inspect a dropped adapter through a symlinked parent", async () => {
    put(
      ".aih-config.json",
      `${JSON.stringify(
        { schemaVersion: 1, contextDir: ".ai-context", targets: ["claude", "codex"] },
        null,
        2,
      )}\n`,
    );
    const outside = mkdtempSync(join(tmpdir(), "aih-bootai-outside-"));
    try {
      writeFileSync(
        join(outside, "gemini.md"),
        adapterNote("gemini", ".ai-context", "legacy"),
        "utf8",
      );
      mkdirSync(join(tmp, ".ai-context"), { recursive: true });
      try {
        symlinkSync(outside, join(tmp, ".ai-context", "adapters"), "junction");
      } catch {
        return;
      }

      const actions = (await command.plan(makeCtx())).actions;
      expect(
        actions.some(
          (action) => action.kind === "remove" && action.path === ".ai-context/adapters/gemini.md",
        ),
      ).toBe(false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
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

describe("bootstrap-ai — selectable Layer-1 baseline", () => {
  it("rejects a removed baseline with the migration diagnostic", async () => {
    await expect(command.plan(makeCtx({ canon: "compact", baseline: "gstack" }))).rejects.toThrow(
      'unsupported legacy configuration "gstack"; migrate to a supported framework before continuing',
    );
  });

  it("rejects --baseline gsd (GSD removed from the baseline set by the 2026-07-22 scope decision)", async () => {
    await expect(command.plan(makeCtx({ canon: "compact", baseline: "gsd" }))).rejects.toThrow(
      /unknown --baseline "gsd"/,
    );
  });

  it("default and explicit --baseline ecc render byte-identical canon and marker payloads", async () => {
    const def = writesByPath((await command.plan(makeCtx({ canon: "compact" }))).actions);
    const ecc = writesByPath(
      (await command.plan(makeCtx({ canon: "compact", baseline: "ecc" }))).actions,
    );

    expect(ecc.get(".ai-context/RULE_ROUTER.md")?.contents).toBe(
      def.get(".ai-context/RULE_ROUTER.md")?.contents,
    );
    expect(ecc.get(".ai-context/adapters/claude.md")?.contents).toBe(
      def.get(".ai-context/adapters/claude.md")?.contents,
    );
    expect(ecc.get(".aih-config.json")?.json).toEqual(def.get(".aih-config.json")?.json);
  });

  it("explicit --baseline ecc clears any previously persisted non-default baseline", async () => {
    const marker = writesByPath(
      (await command.plan(makeCtx({ canon: "compact", baseline: "ecc" }))).actions,
    ).get(".aih-config.json");

    expect(marker?.json).not.toHaveProperty("baseline");
    expect(marker?.removeJsonTopLevelKeys).toEqual(["baseline"]);
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

  it("fails on generated-doc drift when a canon file diverges from what the marker regenerates", async () => {
    const applied = makeCtx({ canon: "compact", baseline: "ecc" }, { apply: true });
    await executePlan(await command.plan(applied), applied);
    // Tamper the generated router + adapter so they diverge from a clean
    // regeneration. (The drift used to be induced by switching the marker to a
    // a removed baseline cannot become selectable through configuration drift
    // toward, so the divergence is induced on the generated docs directly — the
    // fail-closed-on-invalid-baseline path is covered by the adopt + marker
    // suites.)
    put(".ai-context/RULE_ROUTER.md", "# hand-edited router — drifted\n");
    put(".ai-context/adapters/claude.md", "# hand-edited adapter — drifted\n");

    const verifyCtx = makeCtx({ canon: "compact" }, { verify: true });
    const res = await executePlan(await command.plan(verifyCtx), verifyCtx);
    const failed = (res.report?.checks ?? []).filter((c) => c.verdict === "fail");

    expect(failed.map((c) => c.name)).toEqual(
      expect.arrayContaining([
        ".ai-context/RULE_ROUTER.md in sync",
        ".ai-context/adapters/claude.md in sync",
      ]),
    );
    expect(failed.map((c) => c.code)).toContain("canon.generated-drift");
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
    try {
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
      expect(hasNotice).toBe(true);
    } finally {
      rmSync(emptyHome, { recursive: true, force: true });
    }
  });

  it("warns when a bare re-run narrows past bootloaders the repo already has", async () => {
    // The drift gate probes only the RESOLVED targets, so a bare run on a repo whose
    // marker lost its targets would verify CLAUDE.md and silently let AGENTS.md rot.
    put("CLAUDE.md", "# claude");
    put("AGENTS.md", "# agents");
    const actions = (await command.plan(makeCtx())).actions;
    const notice = actions.find(
      (a) => a.kind === "doc" && a.describe.includes("targeting narrowed"),
    );
    expect(notice?.kind === "doc" ? notice.text : "").toContain("AGENTS.md");
    expect(notice?.kind === "doc" ? notice.text : "").toContain("--cli");
    // The dry-run notice has a verify-report counterpart: an advisory probe.
    expect(probeNamed(actions, "bootloader AGENTS.md outside target set")).toBeDefined();
  });

  it("stays quiet when the bare default already covers every bootloader present", async () => {
    put("CLAUDE.md", "# claude");
    const actions = (await command.plan(makeCtx())).actions;
    expect(actions.some((a) => a.kind === "doc" && a.describe.includes("targeting narrowed"))).toBe(
      false,
    );
  });

  it("stays quiet when the committed marker already names the extra tools", async () => {
    put("CLAUDE.md", "# claude");
    put("AGENTS.md", "# agents");
    put(
      ".aih-config.json",
      JSON.stringify({ schemaVersion: 1, contextDir: ".ai-context", targets: ["claude", "codex"] }),
    );
    const actions = (await command.plan(makeCtx())).actions;
    expect(actions.some((a) => a.kind === "doc" && a.describe.includes("targeting narrowed"))).toBe(
      false,
    );
    expect(probeNamed(actions, "outside target set")).toBeUndefined();
  });
});

describe("bootstrap-ai — unmanaged-bootloader advisory (verify)", () => {
  it("a verify pinned to --cli claude reports other bootloaders as skips and stays green", async () => {
    // The CI drift gate pins explicit targets; a bootloader outside the pinned set
    // must surface in the report (skip verdict, coded) without flipping the gate.
    put("AGENTS.md", "# agents");
    const applied = makeCtx({ cli: "claude" }, { apply: true });
    await executePlan(await command.plan(applied), applied);

    const verifyCtx = makeCtx({ cli: "claude" }, { verify: true });
    const res = await executePlan(await command.plan(verifyCtx), verifyCtx);
    const advisories = (res.report?.checks ?? []).filter(
      (c) => c.code === "cli.bootloader-unmanaged",
    );
    expect(advisories.map((c) => c.name)).toEqual(["bootloader AGENTS.md outside target set"]);
    expect(advisories[0]?.verdict).toBe("skip");
    expect(advisories[0]?.detail).toContain("--cli");
    expect(res.report?.ok).toBe(true);
  });

  it("emits no advisory when the target set covers every bootloader present", async () => {
    put("CLAUDE.md", "# claude");
    put("AGENTS.md", "# agents");
    const ctx = makeCtx({ cli: "claude,codex" }, { verify: true });
    const res = await executePlan(await command.plan(ctx), ctx);
    expect((res.report?.checks ?? []).some((c) => c.code === "cli.bootloader-unmanaged")).toBe(
      false,
    );
  });
});

describe("bootstrap-ai — stable repo display name (env-insensitive verify)", () => {
  /** A fixture repo whose FOLDER name differs from its git origin repo name. */
  function repoAt(folderName: string, originUrl: string): string {
    const dir = join(tmp, folderName);
    mkdirSync(join(dir, ".git"), { recursive: true });
    writeFileSync(join(dir, ".git", "config"), `[remote "origin"]\n\turl = ${originUrl}\n`, "utf8");
    return dir;
  }

  function ctxAt(root: string, flags: { apply?: boolean; verify?: boolean } = {}): PlanContext {
    const run = fakeRunner(() => undefined);
    return {
      root,
      contextDir: ".ai-context",
      apply: flags.apply ?? false,
      verify: flags.verify ?? false,
      json: false,
      run,
      host: makeHostAdapter({ platform: "linux", run, env: {} }),
      env: { HOME: root },
      options: {},
    };
  }

  it("heads the router and bootloader with the origin repo name, not the checkout folder name", async () => {
    const dir = repoAt("worktree-folder-name", "https://github.com/acme/stable-name.git");
    const w = writesByPath((await command.plan(ctxAt(dir))).actions);
    expect(w.get(".ai-context/RULE_ROUTER.md")?.contents).toContain(
      "# stable-name — AI Rule Router",
    );
    expect(w.get("CLAUDE.md")?.contents).toContain("# stable-name — Claude bootloader");
  });

  it("verify stays green from a differently-named copy of an applied checkout", async () => {
    // The reported defect: canon generated in one checkout, `--verify` run from a
    // renamed clone or worktree → false `canon.generated-drift` because the router
    // heading embedded the checkout folder's name. Pin the fix end-to-end.
    const original = repoAt("original-folder", "https://github.com/acme/moved-repo.git");
    const applied = ctxAt(original, { apply: true });
    await executePlan(await command.plan(applied), applied);

    const renamed = join(tmp, "renamed-copy");
    cpSync(original, renamed, { recursive: true });
    const verifyCtx = ctxAt(renamed, { verify: true });
    const res = await executePlan(await command.plan(verifyCtx), verifyCtx);
    const checks = res.report?.checks ?? [];
    expect(
      checks.filter((c) => c.code === "canon.generated-drift" || c.code === "cli.bootloader-drift"),
    ).toEqual([]);
    expect(checks.find((c) => c.name === ".ai-context/RULE_ROUTER.md in sync")?.verdict).toBe(
      "pass",
    );
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
