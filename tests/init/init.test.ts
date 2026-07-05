import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SHARED_MARKER, sharedCanonicalBlockBody } from "../../src/bootstrap-ai/canon.js";
import { claudeBashPermissions } from "../../src/guardrails/command-policy.js";
import { command as guardrails } from "../../src/guardrails/index.js";
import { command } from "../../src/init/index.js";
import { INIT_PHASES } from "../../src/init/phases.js";
import { executePlan, resolveContents } from "../../src/internals/execute.js";
import { readIfExists } from "../../src/internals/fsxn.js";
import { beginLine, endLine } from "../../src/internals/markers.js";
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
    expect(command.options?.map((o) => o.flags)).toEqual([
      "--mcp-mode <mode>",
      "--mcp-compliant",
      "--canon <mode>",
      "--baseline <id>",
    ]);
    const p = await command.plan(ctx());
    expect(p.capability).toBe("init");
    expect(p.actions.length).toBeGreaterThan(0);
  });

  it("threads --mcp-compliant into the composed MCP phase", async () => {
    const p = await command.plan(ctx({ options: { posture: "enterprise", mcpCompliant: true } }));
    const dotMcp = p.actions.find(
      (a): a is WriteAction => a.kind === "write" && a.path === ".mcp.json",
    );
    const servers = (dotMcp?.json as { mcpServers?: Record<string, unknown> } | undefined)
      ?.mcpServers;
    const quarantine = p.actions.find(
      (a) => a.kind === "doc" && a.describe === "Quarantined MCP servers",
    );

    expect(Object.keys(servers ?? {})).toContain("code-review-graph");
    expect(Object.keys(servers ?? {})).not.toContain("context7");
    expect(quarantine?.kind === "doc" ? quarantine.text : "").toContain("context7");
  });

  it("preserves folded JSON merge controls for managed MCP replacement", async () => {
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(
      join(dir, ".claude", "managed-settings.json"),
      JSON.stringify(
        {
          sandbox: { keep: true },
          allowManagedMcpServersOnly: true,
          allowedMcpServers: [{ serverCommand: ["stale-denied-mcp"] }],
        },
        null,
        2,
      ),
    );

    const p = await command.plan(ctx({ options: { posture: "enterprise", mcpCompliant: true } }));
    const managed = p.actions.find(
      (a): a is WriteAction => a.kind === "write" && a.path === ".claude/managed-settings.json",
    );
    if (managed === undefined) throw new Error("expected managed-settings write");
    const merged = JSON.parse(
      resolveContents(managed, join(dir, ".claude", "managed-settings.json")),
    ) as { sandbox?: unknown; allowedMcpServers?: unknown[] };
    const allowlist = JSON.stringify(merged.allowedMcpServers);

    expect(merged.sandbox).toMatchObject({ keep: true });
    expect(allowlist).toContain("code-review-graph@2.3.6");
    expect(allowlist).not.toContain("stale-denied-mcp");
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
    // contract: the machine-readable repo contract (compact default replaces INDEX).
    expect(paths).toContain(".ai-context/project.json");
    // secrets: the .claudeignore backstop.
    expect(paths).toContain(".claudeignore");
    // guardrails: the gitleaks policy (mission-named signature).
    expect(paths).toContain(".gitleaks.toml");
    // mcp: the enterprise server config (mission-named signature).
    expect(paths).toContain(".mcp.json");
    // sandbox: the devcontainer.
    expect(paths).toContain(".devcontainer/devcontainer.json");
    // usage: the recorder + universal git hook are folded in last.
    expect(paths).toContain(".aih/usage-record.mjs");
    expect(paths).toContain(".git/hooks/post-commit");
  });

  it("folds the .claude/settings.json contributions into one merge write carrying deny rules, command policy, and usage hooks", async () => {
    const writes = (
      await command.plan(ctx({ posture: "team", postureSource: "flag" }))
    ).actions.filter(
      (a): a is WriteAction =>
        a.kind === "write" && a.path.replace(/\\/g, "/") === ".claude/settings.json",
    );
    // Multiple phases merge-write settings.json: scaffold + secrets seed identical
    // Read(...) deny rules; guardrails projects the command-policy Bash lexicon
    // (different content); usage adds PostToolUse capture. init FOLDS them via
    // deepMerge into ONE merge write so none are silently dropped on the init path.
    expect(writes).toHaveLength(1);
    expect(writes[0]?.merge).toBe(true);
    const settings = writes[0]?.json as {
      permissions?: Record<string, string[]>;
      hooks?: { PostToolUse?: Array<{ hooks?: Array<{ command?: string }> }> };
    };
    const perms = settings.permissions ?? {};
    // secrets/scaffold deny rules survive...
    expect(perms.deny).toContain("Read(./.env*)");
    expect(perms.deny).toContain("Read(./secrets/**)");
    // ...AND guardrails' command-policy projection (PR #20) is composed in, intact.
    const policy = claudeBashPermissions();
    expect(perms.deny).toEqual(expect.arrayContaining(policy.deny));
    expect(perms.ask).toEqual(expect.arrayContaining(policy.ask));
    expect(perms.allow).toEqual(expect.arrayContaining(policy.allow));
    const usageCommands = (settings.hooks?.PostToolUse ?? []).flatMap((group) =>
      (group.hooks ?? []).map((hook) => hook.command ?? ""),
    );
    expect(usageCommands.some((cmd) => cmd.includes(".aih/usage-record.mjs --from claude"))).toBe(
      true,
    );
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
      "contract",
      "secrets",
      "guardrails",
      "mcp",
      "sandbox",
      "usage",
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
    expect(headerIndex("usage")).toBeGreaterThan(headerIndex("sandbox"));
    expect(headerIndex("usage")).toBeLessThan(writeIndex(".aih/usage-record.mjs"));
  });
});

describe("aih init — compact default vs --canon legacy", () => {
  it("compact (default): emits the contract files and drops the meta-doc family", async () => {
    const paths = writePaths((await command.plan(ctx())).actions);
    expect(paths).toContain(".ai-context/project.json");
    expect(paths).toContain(".ai-context/project.md");
    expect(paths).toContain(".ai-context/setup.md");
    for (const meta of [
      ".ai-context/INDEX.md",
      ".ai-context/architecture.md",
      ".ai-context/conventions.md",
      ".ai-context/tasks.md",
      ".ai-context/SETUP-TASKS.md",
      ".ai-context/VALIDATION.md",
      ".ai-context/project-guardrails.md",
      ".ai-context/REGENERATION.md",
      ".ai-context/harness-update.md",
      ".ai-context/adapters/other-tools.md",
    ]) {
      expect(paths).not.toContain(meta);
    }
    // One writer per contract file + the router (the one-writer-per-file invariant).
    for (const p of [
      ".ai-context/RULE_ROUTER.md",
      ".ai-context/project.json",
      ".ai-context/project.md",
      ".ai-context/setup.md",
    ]) {
      expect(paths.filter((x) => x === p)).toHaveLength(1);
    }
  });

  it("--canon legacy reproduces the full doc family (and still lands the contract)", async () => {
    const paths = writePaths((await command.plan(ctx({ options: { canon: "legacy" } }))).actions);
    for (const meta of [
      ".ai-context/INDEX.md",
      ".ai-context/architecture.md",
      ".ai-context/REGENERATION.md",
      ".ai-context/adapters/other-tools.md",
    ]) {
      expect(paths).toContain(meta);
    }
    expect(paths).toContain(".ai-context/project.json"); // the contract phase always runs
  });

  it("the compact RULE_ROUTER routes at the contract, not the legacy docs", async () => {
    const w = (await command.plan(ctx())).actions.find(
      (a): a is WriteAction =>
        a.kind === "write" && a.path.replace(/\\/g, "/") === ".ai-context/RULE_ROUTER.md",
    );
    const router = w?.contents ?? "";
    expect(router).toContain("project.md");
    expect(router).not.toContain("INDEX.md");
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

  it("--baseline gstack skips the Superpowers phase and records the selected baseline", async () => {
    const p = await command.plan(ctx({ options: { cli: "kiro", baseline: "gstack" } }));
    const paths = writePaths(p.actions);
    const docText = docs(p.actions)
      .map((d) => `${d.describe}\n${d.text}`)
      .join("\n");
    const marker = p.actions.find(
      (a): a is WriteAction => a.kind === "write" && a.path === ".aih-config.json",
    );

    expect(docs(p.actions).map((d) => d.describe)).not.toContain("init: superpowers");
    expect(paths).not.toContain(".kiro/steering/superpowers-methodology.md");
    expect(docText).toContain("garrytan/gstack");
    expect(docText).not.toContain("Superpowers install summary");
    expect(marker?.json).toMatchObject({ baseline: "gstack", targets: ["kiro"] });
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
    // legacy so the guardrails taxonomy doc (a doc-with-path under the dir) is present.
    const p = await command.plan(ctx({ contextDir: "ai-coding", options: { canon: "legacy" } }));
    const paths = writePaths(p.actions);

    // contract files land under the override, not the default.
    expect(paths).toContain("ai-coding/project.json");
    expect(paths).not.toContain(".ai-context/project.json");

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
    const first = readIfExists(join(dir, ".aih-config.json"));

    // Second apply over the now-populated repo: it re-reads + re-renders the marker.
    const second = await executePlan(await command.plan(applied), applied);
    const onDisk = readIfExists(join(dir, ".aih-config.json"));

    // Idempotency is the EXECUTOR recognizing identical rendered content and NOT
    // rewriting — assert that mechanism directly (independent of FS read timing on a
    // slow CI filesystem), rather than byte-diffing two racing on-disk reads.
    const marker = second.writes.find((w) => w.path === ".aih-config.json");
    expect(marker?.effect).toBe("unchanged"); // re-apply re-stages nothing for the marker
    // ...so the second pass churns NO backup for it (the *.aih.bak risk surface).
    expect(existsSync(join(dir, ".aih-config.json.aih.bak"))).toBe(false);

    // The on-disk content is stable across applies. EOL-normalize before comparing so
    // a stray CRLF (git autocrlf, an editor) can never fail an otherwise-identical
    // marker, and assert the parsed shape rather than leaning on raw bytes alone.
    const lf = (s: string | undefined) => (s ?? "").replace(/\r\n/g, "\n");
    expect(lf(onDisk)).toBe(lf(first));
    expect(JSON.parse(onDisk ?? "{}")).toMatchObject({
      schemaVersion: 1,
      contextDir: ".ai-context",
    });
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
        .map((w) => `${w.path}\\u0000${resolveContents(w, w.path)}`);
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
    expect(written).toContain("CLAUDE.md"); // bootstrap-ai
    expect(written).toContain(".ai-context/project.json"); // contract
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

  it("composes the deny rules AND the command policy into .claude/settings.json on disk (guardrails not dropped)", async () => {
    // ctx() defaults to no --cli → resolves to [claude], so .claude/settings.json IS
    // a targeted write. This is the regression guard for the init-dedup fold: under
    // the old first-writer-wins drop, guardrails' command-policy projection never
    // reached the composed init plan (it landed only via standalone `aih guardrails`).
    const applied = ctx({ apply: true, posture: "team", postureSource: "flag" });
    await executePlan(await command.plan(applied), applied);

    const settings = JSON.parse(readFileSync(join(dir, ".claude/settings.json"), "utf8"));
    const deny: string[] = settings.permissions?.deny ?? [];
    const ask: string[] = settings.permissions?.ask ?? [];
    const allow: string[] = settings.permissions?.allow ?? [];

    // secrets/scaffold deny rules...
    expect(deny).toContain("Read(./.env*)");
    expect(deny).toContain("Read(./secrets/**)");
    // ...AND the full command-policy projection from guardrails (PR #20) on disk.
    const policy = claudeBashPermissions();
    expect(deny).toEqual(expect.arrayContaining(policy.deny));
    expect(ask).toEqual(expect.arrayContaining(policy.ask));
    expect(allow).toEqual(expect.arrayContaining(policy.allow));
  });

  it("is idempotent — applying the full bootstrap twice leaves byte-identical files", async () => {
    const applied = ctx({ apply: true });

    // First apply lays everything down.
    await executePlan(await command.plan(applied), applied);
    // Read via the same hardened reader the executor uses (bounded retry over the
    // transient Windows post-write lock) and EOL-normalize, so the cross-apply
    // comparison tests CONTENT stability, not byte-for-byte raw reads.
    const snapshot = (paths: string[]) =>
      Object.fromEntries(
        paths.map((p) => [p, (readIfExists(join(dir, p)) ?? "").replace(/\r\n/g, "\n")]),
      );

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

describe("aih init — brownfield guard (redirect to adopt)", () => {
  it("redirects to `aih adopt` on an existing canon and writes NOTHING", async () => {
    // A divergent bootloader = adoptable brownfield canon.
    const body = `${sharedCanonicalBlockBody(".ai-context").trim()}\n\n## Project extension\n\n- keep me`;
    writeFileSync(
      join(dir, "CLAUDE.md"),
      `# Pre\n\n${beginLine(SHARED_MARKER, "s")}\n\n${body}\n\n${endLine(SHARED_MARKER)}\n`,
    );
    const p = await command.plan(ctx({ apply: true }));
    expect(writePaths(p.actions)).toHaveLength(0);
    expect(docs(p.actions).some((d) => d.describe.includes("use `aih adopt`"))).toBe(true);
  });

  it("greenfield still composes the full bootstrap (no redirect)", async () => {
    const p = await command.plan(ctx());
    expect(writePaths(p.actions).length).toBeGreaterThan(0);
    expect(docs(p.actions).some((d) => d.describe.includes("use `aih adopt`"))).toBe(false);
  });
});
