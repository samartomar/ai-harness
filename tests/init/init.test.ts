import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { command as guardrails } from "../../src/guardrails/index.js";
import { command } from "../../src/init/index.js";
import { INIT_PHASES } from "../../src/init/phases.js";
import { executePlan, resolveContents } from "../../src/internals/execute.js";
import type { Action, DocAction, PlanContext, WriteAction } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { makeHostAdapter } from "../../src/platform/detect.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aih-init-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function ctx(over: Partial<PlanContext> = {}): PlanContext {
  const run = over.run ?? fakeRunner(() => undefined);
  return {
    root: dir,
    contextDir: ".ai-context",
    apply: false,
    verify: false,
    json: false,
    run,
    host: makeHostAdapter({ platform: "linux", run, env: {} }),
    env: {},
    options: {},
    ...over,
  };
}

/** Root-relative write paths (normalized to forward slashes). */
function writePaths(actions: Action[]): string[] {
  return actions
    .filter((a): a is WriteAction => a.kind === "write")
    .map((a) => a.path.replace(/\\/g, "/"));
}

/** Doc actions in order. */
function docs(actions: Action[]): DocAction[] {
  return actions.filter((a): a is DocAction => a.kind === "doc");
}

describe("aih init — command surface", () => {
  it("keeps the init name, the --mcp-mode option, and a real plan", async () => {
    expect(command.name).toBe("init");
    expect(command.options?.map((o) => o.flags)).toEqual(["--mcp-mode <mode>"]);
    const p = await command.plan(ctx());
    expect(p.capability).toBe("init");
    expect(p.actions.length).toBeGreaterThan(0);
  });
});

describe("aih init — composes all six repo-scoped capabilities", () => {
  it("includes a signature action from every sub-capability", async () => {
    const paths = writePaths((await command.plan(ctx())).actions);

    // bootstrap-ai: the CLAUDE.md bootloader (sole owner) + the RULE_ROUTER.
    expect(paths).toContain("CLAUDE.md");
    expect(paths).toContain(".ai-context/RULE_ROUTER.md");
    // profile is target-gated: the default set is `claude`, so the Cursor stack rule
    // is NOT written on a bare init (it would be an orphan — bootstrap-ai writes no
    // Cursor canon either). See the "target-gated tool artifacts" suite below.
    expect(paths).not.toContain(".cursor/rules/01-stack.mdc");
    // scaffold: the canonical context INDEX.
    expect(paths).toContain(".ai-context/INDEX.md");
    // secrets: the .claudeignore backstop.
    expect(paths).toContain(".claudeignore");
    // guardrails: the gitleaks policy (mission-named signature).
    expect(paths).toContain(".gitleaks.toml");
    // mcp: the enterprise server config (mission-named signature).
    expect(paths).toContain(".mcp.json");
    // sandbox: the devcontainer.
    expect(paths).toContain(".devcontainer/devcontainer.json");
  });

  it("dedupes the .claude/settings.json contributions into one merge write carrying the deny rules", async () => {
    const writes = (await command.plan(ctx())).actions.filter(
      (a): a is WriteAction =>
        a.kind === "write" && a.path.replace(/\\/g, "/") === ".claude/settings.json",
    );
    // scaffold + secrets both target settings.json with identical deny rules; init
    // dedupes to the FIRST writer (no .aih.bak churn), still a merge write.
    expect(writes).toHaveLength(1);
    expect(writes[0]?.merge).toBe(true);
    const json = JSON.stringify(writes[0]?.json);
    expect(json).toContain("Read(./.env*)");
    expect(json).toContain("Read(./secrets/**)");
  });

  it("forwards the mcp probe and never leaks the remote SSO doc (project scope default)", async () => {
    const p = await command.plan(ctx());
    // mcp/guardrails/sandbox each contribute a probe; they survive composition.
    expect(p.actions.some((a) => a.kind === "probe")).toBe(true);
    // init exposes no --scope, so mcp defaults to project: the agentgateway SSO
    // guidance (remote-only) must not appear in the composed plan.
    const docText = docs(p.actions)
      .map((d) => d.text)
      .join("\n");
    expect(docText).not.toContain("api://agentgateway/mcp_access");
  });
});

describe("aih init — composition, not duplication", () => {
  it("emits one doc header per phase and dedupes writes (no path written twice)", async () => {
    const composed = (await command.plan(ctx())).actions;

    // Exactly one "init: <phase>" header per phase.
    const headers = docs(composed).filter((d) => d.describe.startsWith("init: "));
    expect(headers).toHaveLength(INIT_PHASES.length);

    // Writes are deduped by path; CLAUDE.md has a single owner now (bootstrap-ai,
    // the canon), so it appears exactly once — profile/scaffold no longer write it.
    const writePathList = composed
      .filter((a): a is WriteAction => a.kind === "write")
      .map((w) => w.path);
    expect(new Set(writePathList).size).toBe(writePathList.length);
    expect(writePathList.filter((p) => p === "CLAUDE.md")).toHaveLength(1);
  });

  it("emits a doc header per phase in the canonical order, each before its capability's actions", async () => {
    const order = [
      "profile",
      "superpowers",
      "bootstrap-ai",
      "scaffold",
      "secrets",
      "guardrails",
      "mcp",
      "sandbox",
    ];
    // The phase table itself is locked to the mission order.
    expect(INIT_PHASES.map((p) => p.command.name)).toEqual(order);

    const actions = (await command.plan(ctx())).actions;
    const headers = docs(actions).filter((d) => d.describe.startsWith("init: "));
    expect(headers.map((d) => d.describe)).toEqual(order.map((n) => `init: ${n}`));

    // Each header carries the phase headline, and the header index precedes its
    // capability's first signature write.
    const headerIndex = (name: string) =>
      actions.findIndex((a) => a.kind === "doc" && a.describe === `init: ${name}`);
    const writeIndex = (path: string) =>
      actions.findIndex((a) => a.kind === "write" && a.path.replace(/\\/g, "/") === path);

    expect(headerIndex("guardrails")).toBeLessThan(writeIndex(".gitleaks.toml"));
    expect(headerIndex("mcp")).toBeLessThan(writeIndex(".mcp.json"));
    expect(headerIndex("profile")).toBeLessThan(headerIndex("sandbox"));
  });
});

describe("aih init — target-gated tool artifacts (.cursor on cursor, .claude on claude)", () => {
  const paths = async (over: Partial<PlanContext>) =>
    writePaths((await command.plan(ctx(over))).actions);

  it("bare init (default claude): writes .claude/* but NO orphan .cursor/*", async () => {
    const p = await paths({});
    // Claude is the default target → its guard files land.
    expect(p).toContain(".claude/settings.json");
    expect(p).toContain(".claudeignore");
    expect(p).toContain(".claude/managed-settings.json");
    // Cursor is not targeted → neither the stack rule (profile) nor the canon
    // (bootstrap-ai) is written, so there is no orphan 01-stack.mdc.
    expect(p).not.toContain(".cursor/rules/01-stack.mdc");
    expect(p).not.toContain(".cursor/rules/00-canon.mdc");
    // Tool-agnostic guardrails are always present regardless of target.
    expect(p).toContain(".gitleaks.toml");
    expect(p).toContain(".devcontainer/devcontainer.json");
  });

  it("--cli kiro: writes neither .claude/* nor .cursor/*, but lays Kiro canon + agnostic guards", async () => {
    const p = await paths({ options: { cli: "kiro" } });
    expect(p.some((x) => x.startsWith(".claude/"))).toBe(false);
    expect(p).not.toContain(".claudeignore");
    expect(p.some((x) => x.startsWith(".cursor/"))).toBe(false);
    // bootstrap-ai still lays the Kiro bootloader + the tool-agnostic guards.
    expect(p).toContain(".kiro/steering/00-canon.md");
    expect(p).toContain(".gitleaks.toml");
    expect(p).toContain(".devcontainer/devcontainer.json");
  });

  it("--cli cursor: writes the Cursor stack rule AND its canon (no orphan), but no .claude/*", async () => {
    const p = await paths({ options: { cli: "cursor" } });
    expect(p).toContain(".cursor/rules/01-stack.mdc"); // profile
    expect(p).toContain(".cursor/rules/00-canon.mdc"); // bootstrap-ai → companion canon
    expect(p.some((x) => x.startsWith(".claude/"))).toBe(false);
    expect(p).not.toContain(".claudeignore");
  });

  it("--all-tools: writes both .cursor/* and .claude/*", async () => {
    const p = await paths({ options: { allTools: true } });
    expect(p).toContain(".cursor/rules/01-stack.mdc");
    expect(p).toContain(".claude/settings.json");
    expect(p).toContain(".claude/managed-settings.json");
    expect(p).toContain(".claudeignore");
  });

  it("records the resolved targets in the .aih-config.json marker", async () => {
    const marker = (await command.plan(ctx({ options: { cli: "kiro" } }))).actions.find(
      (a): a is WriteAction => a.kind === "write" && a.path === ".aih-config.json",
    );
    expect(marker?.json).toMatchObject({ targets: ["kiro"] });
  });
});

describe("aih init — custom context dir propagation", () => {
  it("threads ctx.contextDir into every sub-capability", async () => {
    const p = await command.plan(ctx({ contextDir: "ai-coding" }));
    const paths = writePaths(p.actions);

    // scaffold context files land under the override, not the default.
    expect(paths).toContain("ai-coding/INDEX.md");
    expect(paths).not.toContain(".ai-context/INDEX.md");

    // guardrails routes its taxonomy doc into the override dir.
    const taxonomy = docs(p.actions).find((d) =>
      (d.path ?? "").replace(/\\/g, "/").startsWith("ai-coding/"),
    );
    expect(taxonomy?.path?.replace(/\\/g, "/")).toBe("ai-coding/guardrails-taxonomy.md");
  });
});

describe("aih init — BOUNDARY (no remote mutation introduced by the orchestrator)", () => {
  it("adds no exec actions and targets only local relative write paths", async () => {
    const p = await command.plan(ctx());
    // Composition never introduces an exec; cloud/setup stays in doc/probe.
    expect(p.actions.some((a) => a.kind === "exec")).toBe(false);

    for (const path of writePaths(p.actions)) {
      expect(path.startsWith("http")).toBe(false);
      expect(path.startsWith("/")).toBe(false);
      expect(path).not.toMatch(/^[A-Za-z]:/); // no absolute Windows drive paths
    }
  });

  it("adds only doc headers; dedupes writes by path and never adds probes/execs beyond the leaves", async () => {
    const shared = ctx();
    // init resolves the default target set (`[claude]`) once and threads it into
    // every phase via ctx.targets; mirror that here so the per-leaf write set
    // matches what composition actually invokes (profile is silent without cursor).
    const leafCtx: PlanContext = { ...shared, targets: ["claude"] };
    let leafProbes = 0;
    let leafExecs = 0;
    let leafDocs = 0;
    const leafWritePaths = new Set<string>();
    for (const phase of INIT_PHASES) {
      const sub = await phase.command.plan(leafCtx);
      for (const a of sub.actions) {
        if (a.kind === "write") leafWritePaths.add(a.path);
        else if (a.kind === "probe") leafProbes += 1;
        else if (a.kind === "exec") leafExecs += 1;
        else if (a.kind === "doc") leafDocs += 1;
      }
    }

    const composed = (await command.plan(shared)).actions;
    const count = (k: Action["kind"]) => composed.filter((a) => a.kind === k).length;
    // Writes equal the UNIQUE leaf write paths (deduped) PLUS the single
    // `.aih-config.json` bootstrap marker init itself appends — never more.
    expect(count("write")).toBe(leafWritePaths.size + 1);
    expect(count("probe")).toBe(leafProbes);
    expect(count("exec")).toBe(leafExecs);
    // init adds one "init: <phase>" header per phase, plus a single ECC pointer doc.
    expect(count("doc")).toBe(leafDocs + INIT_PHASES.length + 1);
  });
});

describe("aih init — persists the .aih-config.json bootstrap marker", () => {
  it("writes the marker at repo ROOT with schemaVersion, contextDir, and resolved targets", async () => {
    const p = await command.plan(ctx({ contextDir: "ai-coding" }));
    const marker = p.actions.find(
      (a): a is WriteAction => a.kind === "write" && a.path === ".aih-config.json",
    );
    expect(marker).toBeDefined();
    expect(marker?.merge).toBe(true); // non-destructive merge write, like .aih-workspace.json
    expect(marker?.json).toEqual({
      schemaVersion: 1,
      contextDir: "ai-coding",
      targets: ["claude"], // default resolution when no --cli/--all-tools
    });
  });

  it("threads a custom context dir + explicit --cli targets into the marker", async () => {
    const p = await command.plan(
      ctx({ contextDir: "custom-canon", options: { cli: "claude,codex" } }),
    );
    const marker = p.actions.find(
      (a): a is WriteAction => a.kind === "write" && a.path === ".aih-config.json",
    );
    expect(marker?.json).toEqual({
      schemaVersion: 1,
      contextDir: "custom-canon",
      targets: ["claude", "codex"],
    });
  });

  it("applies the marker to disk and a second apply is byte-identical (idempotent)", async () => {
    const applied = ctx({ apply: true });
    await executePlan(await command.plan(applied), applied);
    const first = readFileSync(join(dir, ".aih-config.json"), "utf8");
    await executePlan(await command.plan(applied), applied);
    const second = readFileSync(join(dir, ".aih-config.json"), "utf8");
    expect(second).toBe(first);
    expect(JSON.parse(first)).toMatchObject({ schemaVersion: 1, contextDir: ".ai-context" });
  });
});

describe("aih init — deterministic plan", () => {
  it("produces the same action shape across runs (no dates/random ordering)", async () => {
    const a = (await command.plan(ctx())).actions.map((x) => `${x.kind}:${describeOf(x)}`);
    const b = (await command.plan(ctx())).actions.map((x) => `${x.kind}:${describeOf(x)}`);
    expect(a).toEqual(b);
  });

  it("renders byte-identical write contents across runs (no timestamps in file bodies)", async () => {
    // describeOf only compares paths/describe; this guards the *contents* a leaf
    // would materialize — a date/nonce baked into any generated file fails here.
    const bodies = (actions: Action[]) =>
      actions
        .filter((a): a is WriteAction => a.kind === "write")
        .map((w) => `${w.path} ${resolveContents(w, w.path)}`);
    const a = bodies((await command.plan(ctx())).actions);
    const b = bodies((await command.plan(ctx())).actions);
    expect(a).toEqual(b);
  });
});

describe("aih init — apply lays the whole bootstrap down in one pass", () => {
  it("materializes signature files from multiple capabilities on disk", async () => {
    const applied = ctx({ apply: true });
    const built = await command.plan(applied);
    const res = await executePlan(built, applied);

    const written = res.writes.map((w) => w.path.replace(/\\/g, "/"));
    expect(written).toContain("CLAUDE.md"); // profile/scaffold
    expect(written).toContain(".ai-context/INDEX.md"); // scaffold
    expect(written).toContain(".gitleaks.toml"); // guardrails
    expect(written).toContain(".mcp.json"); // mcp
    expect(written).toContain(".devcontainer/devcontainer.json"); // sandbox

    // The on-disk gitleaks policy is byte-identical to what guardrails alone writes.
    const standalone = await guardrails.plan(applied);
    const gl = standalone.actions.find(
      (a): a is WriteAction => a.kind === "write" && a.path === ".gitleaks.toml",
    );
    const onDisk = readFileSync(join(dir, ".gitleaks.toml"), "utf8");
    expect(onDisk).toBe(`${(gl?.contents ?? "").replace(/\n+$/, "")}\n`);
  });

  it("is idempotent — applying the full bootstrap twice leaves byte-identical files", async () => {
    const applied = ctx({ apply: true });

    // First apply lays everything down.
    await executePlan(await command.plan(applied), applied);
    const snapshot = (paths: string[]) =>
      Object.fromEntries(paths.map((p) => [p, readFileSync(join(dir, p), "utf8")]));

    // Sample one plain write and every merge write (the re-merge risk surface):
    // a stable bootstrap must not drift or duplicate array entries on re-run.
    const sampled = [
      ".mcp.json",
      ".claude/settings.json",
      ".claude/managed-settings.json",
      ".gitleaks.toml",
    ];
    const first = snapshot(sampled);

    // Second apply over the now-populated repo (re-reads + deep-merges existing files).
    await executePlan(await command.plan(applied), applied);
    const second = snapshot(sampled);

    expect(second).toEqual(first);
    // The merged deny-list must not have grown duplicate entries on the second pass.
    const settings = JSON.parse(second[".claude/settings.json"] ?? "{}");
    const deny: string[] = settings.permissions?.deny ?? [];
    expect(deny).toEqual([...new Set(deny)]);
  });
});

describe("aih init — sub-capability options default gracefully", () => {
  it("uses each leaf's own defaults (mcp project scope) without init flags", async () => {
    // init declares no options; the leaves must fall back to their defaults.
    const p = await command.plan(ctx({ options: {} }));
    const paths = writePaths(p.actions);
    // profile is gated on the (default `claude`) target set — no orphan Cursor rule.
    expect(paths).not.toContain(".cursor/rules/01-stack.mdc");
    // mcp writes .mcp.json with the project-scope describe.
    const mcpWrite = p.actions.find(
      (a): a is WriteAction => a.kind === "write" && a.path === ".mcp.json",
    );
    expect(mcpWrite?.describe).toContain("project scope");
  });

  it("--mcp-mode none threads to the mcp phase only (no .mcp.json; CLI fallback)", async () => {
    const paths = writePaths((await command.plan(ctx({ options: { mcpMode: "none" } }))).actions);
    expect(paths).not.toContain(".mcp.json");
    expect(paths).toContain(".ai-context/mcp-fallback.md");
    // Other phases are unaffected — the canon still lands.
    expect(paths).toContain("CLAUDE.md");
  });
});

/** Stable description of any action, for determinism comparisons. */
function describeOf(a: Action): string {
  if (a.kind === "write") return `${a.path}|${a.describe}`;
  if (a.kind === "doc") return `${a.describe}|${a.path ?? ""}`;
  return a.describe;
}
