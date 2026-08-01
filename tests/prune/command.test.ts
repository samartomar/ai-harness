import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SHARED_MARKER, sharedBlock } from "../../src/bootstrap-ai/canon.js";
import { CODEX_AGENTS_BLOCK_MARKER, CODEX_INSTALL_STATE_FILE } from "../../src/ecc/codex.js";
import { registrationLedgerPath } from "../../src/ecc/registration.js";
import { executePlan } from "../../src/internals/execute.js";
import { mergeManagedBlock } from "../../src/internals/markers.js";
import type { Action, PlanContext } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
import { policyProjectCommand } from "../../src/org-policy/validate.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import { command } from "../../src/prune/index.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aih-prune-cmd-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function ctx(over: Partial<PlanContext> = {}): PlanContext {
  const run = fakeRunner(() => undefined);
  return {
    root: dir,
    contextDir: "ai-coding",
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

function write(rel: string, content = "x"): void {
  const path = join(dir, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

function marker(...targets: string[]): void {
  writeFileSync(
    join(dir, ".aih-config.json"),
    JSON.stringify({ schemaVersion: 1, contextDir: "ai-coding", targets }),
  );
}

const actionsOf = async (over: Partial<PlanContext> = {}): Promise<Action[]> =>
  (await command.plan(ctx(over))).actions;
const digestText = (actions: Action[]): string => {
  const d = actions.find((a): a is Extract<Action, { kind: "digest" }> => a.kind === "digest");
  return d?.text ?? "";
};

describe("aih prune command", () => {
  it("guides the user when there is no committed target set to diff", async () => {
    const text = digestText(await actionsOf());
    expect(text).toContain("No committed target set");
    expect(text).toContain("aih bootstrap-ai");
  });

  it("emits a `remove` action per file artifact and a `write` (block-subtract) per bootloader", async () => {
    marker("claude");
    write("ai-coding/adapters/claude.md");
    write("ai-coding/adapters/codex.md"); // dropped → file remove
    // codex's AGENTS.md bootloader carries a real managed block + a user preamble.
    writeFileSync(
      join(dir, "AGENTS.md"),
      mergeManagedBlock(undefined, sharedBlock("ai-coding"), "# My preamble"),
    );
    const actions = await actionsOf();

    const removes = actions.filter((a) => a.kind === "remove").map((a) => a.path);
    expect(removes).toContain("ai-coding/adapters/codex.md");

    const subtract = actions.find(
      (a): a is Extract<Action, { kind: "write" }> => a.kind === "write" && a.path === "AGENTS.md",
    );
    expect(subtract).toBeDefined();
    // The write lands the file MINUS aih's canon block, preamble preserved.
    expect(subtract?.contents).toBe("# My preamble\n");

    // A .gitignore write is present so `.aih/legacy/` is ignored before the move.
    expect(actions.some((a) => a.kind === "write" && a.path === ".gitignore")).toBe(true);
  });

  it("routes an MCP config to a manual advisory in the digest — never an auto-action", async () => {
    marker("codex"); // keep codex (AGENTS.md stays); drop cursor
    write("ai-coding/adapters/codex.md");
    write("ai-coding/adapters/cursor.md");
    write(".cursor/mcp.json", JSON.stringify({ mcpServers: {} }));
    const actions = await actionsOf();
    // The MCP config is NOT touched by any write/remove action.
    const touched = actions
      .filter((a) => a.kind === "write" || a.kind === "remove")
      .map((a) => (a as { path: string }).path);
    expect(touched).not.toContain(".cursor/mcp.json");
    // It appears as a manual-review line in the digest instead.
    const text = digestText(actions);
    expect(text).toContain("Manual review");
    expect(text).toContain(".cursor/mcp.json");
  });

  it("routes dropped direct ECC installer CLIs through ECC's install-state uninstall", async () => {
    marker("claude");
    write("ai-coding/adapters/claude.md");
    write("ai-coding/adapters/cursor.md");
    const actions = await actionsOf();
    const ecc = actions.find(
      (a): a is Extract<Action, { kind: "exec" }> =>
        a.kind === "exec" && a.describe.includes("ECC-managed cursor footprint"),
    );
    expect(ecc?.argv).toEqual([
      "npx",
      "--yes",
      "--package",
      "ecc-universal",
      "ecc",
      "uninstall",
      "--target",
      "cursor",
    ]);
  });

  describe("dropped-target managed-MCP residue", () => {
    const MANAGED = ".claude/managed-settings.json";
    const managedPath = (): string => join(dir, ".claude", "managed-settings.json");
    const readJson = (path: string): Record<string, unknown> =>
      JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const writeOf = (
      actions: Action[],
      path: string,
    ): Extract<Action, { kind: "write" }> | undefined =>
      actions.find(
        (a): a is Extract<Action, { kind: "write" }> => a.kind === "write" && a.path === path,
      );

    /**
     * Project a real AIH-owned managed-MCP pair for claude, then drop claude from the
     * committed targets — the exact state issue #566 describes. Built with the real
     * projection command so the fixture cannot drift from what production writes.
     */
    async function droppedClaudeProjection(keep = ["kiro"]): Promise<void> {
      write("ai-coding/adapters/claude.md");
      write("ai-coding/adapters/kiro.md");
      write(".claude/managed-settings.json", JSON.stringify({ operatorOnly: true }));
      writeFileSync(
        join(dir, "aih-org-policy.json"),
        JSON.stringify({
          schemaVersion: 1,
          minimumPosture: "enterprise",
          references: { repoContract: "ai-coding/project.json" },
          mcp: { allowedServers: ["code-review-graph"], allowManagedOnly: true },
        }),
      );
      marker("claude", "kiro");
      const projectCtx = ctx({ apply: true });
      await executePlan(await policyProjectCommand.plan(projectCtx), projectCtx);
      const cfg = readJson(join(dir, ".aih-config.json"));
      writeFileSync(join(dir, ".aih-config.json"), JSON.stringify({ ...cfg, targets: keep }));
    }

    it("subtracts exactly the two marker-proven keys, ownership last, never a delete", async () => {
      await droppedClaudeProjection();
      const actions = await actionsOf();

      const subtract = writeOf(actions, MANAGED);
      const ownership = writeOf(actions, ".aih-config.json");
      expect(subtract?.removeJsonTopLevelKeys).toEqual([
        "allowManagedMcpServersOnly",
        "allowedMcpServers",
      ]);
      expect(ownership?.removeJsonTopLevelKeys).toEqual(["managedMcpProjection"]);
      // Owned content first, ownership state second (src/ecc/reconcile-driver.ts:485, :511).
      expect(actions.indexOf(subtract as Action)).toBeLessThan(
        actions.indexOf(ownership as Action),
      );
      // FILE DELETION IS NEVER AUTHORIZED — the marker proves two keys, not the file.
      expect(actions.filter((a) => a.kind === "remove").map((a) => a.path)).not.toContain(MANAGED);
      expect(digestText(actions)).toContain(MANAGED);
    });

    it("leaves every other key's value unchanged under --apply", async () => {
      await droppedClaudeProjection();
      const before = readJson(managedPath());

      const applyCtx = ctx({ apply: true });
      await executePlan(await command.plan(applyCtx), applyCtx);
      const after = readJson(managedPath());

      expect(after).not.toHaveProperty("allowManagedMcpServersOnly");
      expect(after).not.toHaveProperty("allowedMcpServers");
      expect(after.operatorOnly).toBe(true);
      // organizationPolicy / sandbox carry no provenance and are NEVER subtracted.
      expect(after.organizationPolicy).toEqual(before.organizationPolicy);
      expect(after.sandbox).toEqual(before.sandbox);
      expect(readJson(join(dir, ".aih-config.json"))).not.toHaveProperty("managedMcpProjection");
    });

    it("reconciles the residue even after the dropped CLI's adapter is already gone", async () => {
      await droppedClaudeProjection();
      rmSync(join(dir, "ai-coding", "adapters", "claude.md"));

      const applyCtx = ctx({ apply: true });
      await executePlan(await command.plan(applyCtx), applyCtx);

      expect(readJson(managedPath())).not.toHaveProperty("allowManagedMcpServersOnly");
    });

    it("never weakens the projection for a still-committed but unrunnable claude", async () => {
      // --unrunnable prunes per-CLI FILES on a weaker signal (no binary on PATH). A
      // missing binary is not evidence the repo dropped Claude, so it must never
      // subtract an enforcement control.
      await droppedClaudeProjection(["claude", "kiro"]);
      const before = readFileSync(managedPath(), "utf8");

      const applyCtx = ctx({ apply: true, options: { unrunnable: true } });
      await executePlan(await command.plan(applyCtx), applyCtx);

      expect(readFileSync(managedPath(), "utf8")).toBe(before);
      expect(readJson(join(dir, ".aih-config.json"))).toMatchObject({
        managedMcpProjection: { state: "active" },
      });
    });

    it("revokes rather than overwrites a drifted pair", async () => {
      await droppedClaudeProjection();
      const operatorPair = [{ serverCommand: ["operator-mcp", "serve"] }];
      writeFileSync(
        managedPath(),
        JSON.stringify({ ...readJson(managedPath()), allowedMcpServers: operatorPair }),
      );

      const applyCtx = ctx({ apply: true });
      await executePlan(await command.plan(applyCtx), applyCtx);

      expect(readJson(managedPath()).allowedMcpServers).toEqual(operatorPair);
      expect(readJson(join(dir, ".aih-config.json"))).toMatchObject({
        managedMcpProjection: { state: "revoked" },
      });
    });

    it("stays silent and mutates nothing when no ownership marker proves the residue", async () => {
      // Prune must advertise only what prune can act on. With no active claim there is
      // nothing to subtract AND nothing to revoke, so naming the file here would tell an
      // agent to re-run a command designed to refuse — forever. `aih doctor`'s
      // `org-policy.dropped-target-unowned` owns this case and says to escalate.
      write("ai-coding/adapters/claude.md");
      write("ai-coding/adapters/kiro.md");
      const operatorOwned = JSON.stringify({
        allowManagedMcpServersOnly: true,
        allowedMcpServers: [{ serverCommand: ["operator-mcp", "serve"] }],
      });
      write(".claude/managed-settings.json", operatorOwned);
      marker("kiro");

      const applyCtx = ctx({ apply: true });
      const actions = (await command.plan(applyCtx)).actions;
      await executePlan({ capability: "prune", actions }, applyCtx);

      expect(writeOf(actions, MANAGED)).toBeUndefined();
      expect(readFileSync(managedPath(), "utf8")).toBe(operatorOwned);
      expect(digestText(actions)).not.toContain(MANAGED);
    });

    it("converges — a second prune says nothing about an already-reconciled residue", async () => {
      await droppedClaudeProjection();
      const first = ctx({ apply: true });
      await executePlan(await command.plan(first), first);

      const second = ctx({ apply: true });
      const actions = (await command.plan(second)).actions;
      const after = readFileSync(managedPath(), "utf8");
      await executePlan({ capability: "prune", actions }, second);

      expect(writeOf(actions, MANAGED)).toBeUndefined();
      expect(digestText(actions)).not.toContain(MANAGED);
      // organizationPolicy / sandbox legitimately remain and are never touched.
      expect(readFileSync(managedPath(), "utf8")).toBe(after);
      expect(readJson(managedPath())).toHaveProperty("organizationPolicy");
    });
  });

  it("does not call ECC's upstream codex uninstall path when codex is dropped", async () => {
    marker("claude");
    write("ai-coding/adapters/claude.md");
    write("ai-coding/adapters/codex.md");
    const actions = await actionsOf();
    expect(
      actions.some((a) => a.kind === "exec" && a.describe.includes("ECC-managed codex footprint")),
    ).toBe(false);
  });

  it("subtracts the managed ECC Codex AGENTS block when codex is dropped", async () => {
    const home = join(dir, "home");
    marker("claude");
    write("ai-coding/adapters/claude.md");
    write("ai-coding/adapters/codex.md");
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(
      join(home, ".codex", "AGENTS.md"),
      mergeManagedBlock(
        undefined,
        {
          marker: CODEX_AGENTS_BLOCK_MARKER,
          note: "generated from affaan-m/ECC .codex/AGENTS.md",
          body: "# ECC Codex guidance",
        },
        "# My Codex notes",
      ),
    );
    const actions = await actionsOf({ env: { USERPROFILE: home, HOME: home } });
    const subtract = actions.find(
      (a): a is Extract<Action, { kind: "write" }> =>
        a.kind === "write" && a.path.replace(/\\/g, "/").endsWith("/home/.codex/AGENTS.md"),
    );
    expect(subtract?.external).toBe(true);
    expect(subtract?.contents).toBe("# My Codex notes\n");
  });

  it("subtracts the recorded ECC Codex TOML footprint when codex is dropped", async () => {
    const home = join(dir, "home");
    marker("claude");
    write("ai-coding/adapters/claude.md");
    write("ai-coding/adapters/codex.md");
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(
      join(home, ".codex", CODEX_INSTALL_STATE_FILE),
      JSON.stringify(
        {
          schemaVersion: 1,
          managedBy: "aih",
          codexToml: {
            rootKeys: ["approval_policy"],
            tables: ["features"],
            tableKeys: {},
            mcpServers: ["context7"],
          },
          agentsBlock: true,
        },
        null,
        2,
      ),
    );
    writeFileSync(
      join(home, ".codex", "config.toml"),
      [
        'approval_policy = "on-request"',
        'user_key = "keep"',
        "",
        "[features]",
        "multi_agent = true",
        "",
        "[mcp_servers.context7]",
        'command = "npx"',
        'args = ["-y", "@upstash/context7-mcp@latest"]',
        "",
        "[mcp_servers.context7.env]",
        'CONTEXT7_TOKEN = "remove"',
        "",
        "[mcp_servers.user]",
        'url = "https://example.com/mcp"',
        "",
      ].join("\n"),
    );

    const actions = await actionsOf({ env: { USERPROFILE: home, HOME: home } });
    const subtract = actions.find(
      (a): a is Extract<Action, { kind: "write" }> =>
        a.kind === "write" && a.path.replace(/\\/g, "/").endsWith("/home/.codex/config.toml"),
    );
    expect(subtract?.external).toBe(true);
    expect(subtract?.contents).not.toContain("approval_policy");
    expect(subtract?.contents).not.toContain("[features]");
    expect(subtract?.contents).not.toContain("[mcp_servers.context7]");
    expect(subtract?.contents).not.toContain("[mcp_servers.context7.env]");
    expect(subtract?.contents).toContain('user_key = "keep"');
    expect(subtract?.contents).toContain("[mcp_servers.user]");
    expect(
      actions.some(
        (a) => a.kind === "exec" && a.argv.includes(join(home, ".codex", CODEX_INSTALL_STATE_FILE)),
      ),
    ).toBe(true);
  });

  it("subtracts recorded ECC Codex keys from inline TOML tables when codex is dropped", async () => {
    const home = join(dir, "home");
    marker("claude");
    write("ai-coding/adapters/claude.md");
    write("ai-coding/adapters/codex.md");
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(
      join(home, ".codex", CODEX_INSTALL_STATE_FILE),
      JSON.stringify(
        {
          schemaVersion: 1,
          managedBy: "aih",
          codexToml: {
            rootKeys: [],
            tables: [],
            tableKeys: {
              "profiles.strict": ["sandbox_mode", "web_search"],
            },
            mcpServers: [],
          },
          agentsBlock: true,
        },
        null,
        2,
      ),
    );
    writeFileSync(
      join(home, ".codex", "config.toml"),
      [
        "[profiles]",
        '"strict" = { "approval_policy" = "on-request", sandbox_mode = "read-only", web_search = "cached" }',
        'yolo = { approval_policy = "never" }',
        "",
      ].join("\n"),
    );

    const actions = await actionsOf({ env: { USERPROFILE: home, HOME: home } });
    const subtract = actions.find(
      (a): a is Extract<Action, { kind: "write" }> =>
        a.kind === "write" && a.path.replace(/\\/g, "/").endsWith("/home/.codex/config.toml"),
    );
    expect(subtract?.contents).toContain('"strict" = { "approval_policy" = "on-request" }');
    expect(subtract?.contents).toContain('yolo = { approval_policy = "never" }');
    expect(subtract?.contents).not.toContain("sandbox_mode");
    expect(subtract?.contents).not.toContain("web_search");
  });

  it("skips a bootloader that carries no aih block (nothing to subtract)", async () => {
    marker("claude");
    write("ai-coding/adapters/claude.md");
    write("ai-coding/adapters/codex.md");
    writeFileSync(join(dir, "AGENTS.md"), "# just my own notes, no aih block\n");
    const actions = await actionsOf();
    // No write targets AGENTS.md (its block is absent), but the adapter is still removed.
    expect(actions.some((a) => a.kind === "write" && a.path === "AGENTS.md")).toBe(false);
    expect(
      actions.some((a) => a.kind === "remove" && a.path === "ai-coding/adapters/codex.md"),
    ).toBe(true);
  });

  it("never subtracts a block whose body is NOT aih's canonical body (drift/look-alike guard)", async () => {
    marker("claude");
    write("ai-coding/adapters/claude.md");
    write("ai-coding/adapters/codex.md");
    // A block carrying the aih marker but a HAND-EDITED body — not what aih generates.
    writeFileSync(
      join(dir, "AGENTS.md"),
      mergeManagedBlock(
        undefined,
        { marker: SHARED_MARKER, note: "x", body: "hand-edited, not aih canonical" },
        "# preamble",
      ),
    );
    const actions = await actionsOf();
    // The look-alike/drifted block is left untouched (never blindly stripped).
    expect(actions.some((a) => a.kind === "write" && a.path === "AGENTS.md")).toBe(false);
  });
});

describe("aih prune ECC registration reconciliation", () => {
  function writeLedger(home: string, reactRoot: string, cppRoot: string): string {
    const path = registrationLedgerPath(home);
    mkdirSync(dirname(path), { recursive: true });
    const authorization = {
      componentId: "module:framework-language",
      source: "affaan-m/ECC",
      pinnedSha: "a".repeat(40),
      treeSha256: "b".repeat(64),
      tier: "vendor",
      issuer: "@aihq/harness release",
      evidenceSha256: "c".repeat(64),
    };
    writeFileSync(
      path,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          projects: [
            {
              root: reactRoot,
              scope: "scoped",
              components: ["baseline:rules", "framework:react"],
              mcps: ["mcp:sequential-thinking"],
            },
            {
              root: cppRoot,
              scope: "scoped",
              components: ["baseline:rules", "lang:cpp"],
              mcps: ["mcp:sequential-thinking", "mcp:github"],
            },
          ],
          targets: [
            {
              target: "codex",
              components: ["baseline:rules", "framework:react", "lang:cpp"].map((id) => ({
                id,
                authorization,
              })),
              mcps: ["mcp:sequential-thinking", "mcp:github"],
            },
          ],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    return path;
  }

  function writeCodexState(home: string, cppSkill: string, reactSkill: string): string {
    const codexRoot = join(home, ".codex");
    const statePath = join(codexRoot, "ecc-install-state.json");
    mkdirSync(dirname(cppSkill), { recursive: true });
    mkdirSync(dirname(reactSkill), { recursive: true });
    writeFileSync(cppSkill, "cpp\n", "utf8");
    writeFileSync(reactSkill, "react\n", "utf8");
    const operation = (sourceRelativePath: string, destinationPath: string) => ({
      kind: "copy-file",
      moduleId: "framework-language",
      sourceRelativePath,
      destinationPath,
      strategy: "preserve-relative-path",
      ownership: "managed",
      scaffoldOnly: false,
    });
    writeFileSync(
      statePath,
      `${JSON.stringify(
        {
          schemaVersion: "ecc.install.v1",
          installedAt: "2026-07-10T00:00:00.000Z",
          target: {
            id: "codex-home",
            target: "codex",
            kind: "home",
            root: codexRoot,
            installStatePath: statePath,
          },
          request: {
            profile: null,
            modules: ["framework-language"],
            includeComponents: [],
            excludeComponents: [],
            legacyLanguages: [],
            legacyMode: false,
          },
          resolution: { selectedModules: ["framework-language"], skippedModules: [] },
          source: {
            repoVersion: "2.0.0",
            repoCommit: "a".repeat(40),
            manifestVersion: 1,
          },
          operations: [
            operation("skills/react-patterns/SKILL.md", reactSkill),
            operation("skills/cpp-testing/SKILL.md", cppSkill),
          ],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    return statePath;
  }

  function writeCodexMergeState(home: string): void {
    const codexRoot = join(home, ".codex");
    writeFileSync(
      join(codexRoot, CODEX_INSTALL_STATE_FILE),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          managedBy: "aih",
          codexToml: {
            rootKeys: [],
            tables: [],
            tableKeys: {},
            mcpServers: ["sequential-thinking", "github"],
          },
          agentsBlock: true,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    writeFileSync(
      join(codexRoot, "config.toml"),
      [
        "# >>> aih managed (mcp) >>>",
        '[mcp_servers."sequential-thinking"]',
        'command = "npx"',
        "",
        '[mcp_servers."github"]',
        'url = "https://api.githubcopilot.com/mcp/"',
        "# <<< aih managed (mcp) <<<",
        "",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      join(codexRoot, "AGENTS.md"),
      [
        "<!-- BEGIN ecc-codex:agents (generated from affaan-m/ECC .codex/AGENTS.md) -->",
        "Available skills:",
        "- cpp-testing",
        "- react-patterns",
        "",
        "<!-- END ecc-codex:agents -->",
        "",
      ].join("\n"),
      "utf8",
    );
  }

  it("plans and applies a deterministic ledger-last diff even without committed CLI intent", async () => {
    const home = join(dir, "home");
    const reactRoot = join(home, "projects", "react");
    const cppRoot = join(home, "projects", "deleted-cpp");
    mkdirSync(reactRoot, { recursive: true });
    const ledgerPath = writeLedger(home, reactRoot, cppRoot);
    const cppSkill = join(home, ".codex", "skills", "cpp-testing", "SKILL.md");
    const reactSkill = join(home, ".codex", "skills", "react-patterns", "SKILL.md");
    const statePath = writeCodexState(home, cppSkill, reactSkill);
    writeCodexMergeState(home);
    const before = new Map(
      [ledgerPath, statePath, cppSkill, reactSkill].map((path) => [path, readFileSync(path)]),
    );

    const actions = await actionsOf({ env: { HOME: home, USERPROFILE: home } });
    const reconcile = actions.find(
      (action): action is Extract<Action, { kind: "exec" }> =>
        action.kind === "exec" && action.describe.includes("atomic ledger-last transaction"),
    );
    const evidence = actions.find(
      (action): action is Extract<Action, { kind: "digest" }> =>
        action.kind === "digest" && action.describe === "ECC component registration reconciliation",
    );

    expect(reconcile).toBeDefined();
    expect(evidence?.text).toContain(cppRoot);
    expect(evidence?.text).toContain("lang:cpp");
    expect(evidence?.text).toContain(cppSkill);
    if (reconcile === undefined) throw new Error("missing ECC reconciliation action");
    const encoded = reconcile.argv.at(-1);
    if (encoded === undefined) throw new Error("missing ECC reconciliation payload");
    const payload = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as {
      mutations: Array<{ kind: string; path: string }>;
    };
    expect(payload.mutations).toContainEqual(
      expect.objectContaining({
        kind: "remove-file",
        phase: "owned-removal",
        path: cppSkill,
        root: join(home, ".codex"),
      }),
    );
    expect(payload.mutations).toContainEqual(
      expect.objectContaining({ kind: "write-file", path: statePath }),
    );
    for (const [path, contents] of before) expect(readFileSync(path)).toEqual(contents);

    const executable = reconcile.argv[0];
    if (executable === undefined) throw new Error("missing ECC reconciliation executable");
    const result = spawnSync(executable, reconcile.argv.slice(1), {
      cwd: reconcile.cwd ?? dir,
      env: process.env,
      encoding: "utf8",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(() => readFileSync(cppSkill)).toThrow();
    expect(readFileSync(reactSkill, "utf8")).toBe("react\n");
    expect(readFileSync(statePath, "utf8")).not.toContain("cpp-testing");
    const ledger = JSON.parse(readFileSync(ledgerPath, "utf8")) as {
      projects: Array<{ root: string }>;
      targets: Array<{ components: Array<{ id: string }>; mcps: string[] }>;
    };
    expect(ledger.projects.map((project) => project.root)).toEqual([reactRoot]);
    expect(ledger.targets[0]?.components.map((component) => component.id)).toEqual([
      "baseline:rules",
      "framework:react",
    ]);
    expect(ledger.targets[0]?.mcps).toEqual(["mcp:sequential-thinking"]);
    expect(readFileSync(join(home, ".codex", "config.toml"), "utf8")).not.toContain(
      'mcp_servers."github"',
    );
    expect(readFileSync(join(home, ".codex", "AGENTS.md"), "utf8")).not.toContain("cpp-testing");
    const replanned = await actionsOf({ env: { HOME: home, USERPROFILE: home } });
    expect(
      replanned.some(
        (action) =>
          action.kind === "exec" && action.describe.includes("atomic ledger-last transaction"),
      ),
    ).toBe(false);
  });

  it("fails closed on a malformed primary registration ledger", async () => {
    const home = join(dir, "home");
    const path = registrationLedgerPath(home);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "not-json\n", "utf8");

    await expect(actionsOf({ env: { HOME: home, USERPROFILE: home } })).rejects.toThrow(
      /invalid ECC registration ledger/i,
    );
  });

  it("fails closed when a shrinking home target has no authoritative install state", async () => {
    const home = join(dir, "home");
    const reactRoot = join(home, "projects", "react");
    const cppRoot = join(home, "projects", "deleted-cpp");
    mkdirSync(reactRoot, { recursive: true });
    writeLedger(home, reactRoot, cppRoot);

    await expect(actionsOf({ env: { HOME: home, USERPROFILE: home } })).rejects.toThrow(
      /missing ECC install state/i,
    );
  });

  it("coordinates a whole-target uninstall inside the ledger-last transaction", async () => {
    const home = join(dir, "home");
    const reactRoot = join(home, "projects", "react");
    const cppRoot = join(home, "projects", "deleted-cpp");
    mkdirSync(reactRoot, { recursive: true });
    const ledgerPath = writeLedger(home, reactRoot, cppRoot);
    const ledger = JSON.parse(readFileSync(ledgerPath, "utf8")) as {
      targets: Array<{ target: string }>;
    };
    const target = ledger.targets[0];
    if (target === undefined) throw new Error("missing ECC target fixture");
    target.target = "cursor";
    writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
    const before = readFileSync(ledgerPath);
    marker("claude");
    write("ai-coding/adapters/claude.md");
    write("ai-coding/adapters/cursor.md");
    const calls: string[][] = [];
    const run = fakeRunner((argv) => {
      calls.push(argv);
      return argv[0] === "npx" ? { code: 1, stderr: "injected uninstall failure" } : undefined;
    });
    const apply = ctx({ apply: true, env: { HOME: home, USERPROFILE: home }, run });

    const planned = await command.plan(apply);
    const reconcile = planned.actions.find(
      (action): action is Extract<Action, { kind: "exec" }> =>
        action.kind === "exec" && action.describe.includes("atomic ledger-last transaction"),
    );
    if (reconcile === undefined) throw new Error("missing coordinated reconciliation action");
    const encoded = reconcile.argv.at(-1);
    if (encoded === undefined) throw new Error("missing coordinated reconciliation payload");
    const payload = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as {
      uninstalls: Array<{ target: string; argv: string[]; paths: string[] }>;
    };
    expect(payload.uninstalls).toEqual([
      expect.objectContaining({ target: "cursor", argv: expect.arrayContaining(["uninstall"]) }),
    ]);

    const result = await executePlan(planned, apply);

    expect(result.execs).toEqual([
      expect.objectContaining({ argv: expect.arrayContaining([process.execPath]), ok: true }),
    ]);
    expect(calls.some((argv) => argv[0] === "npx")).toBe(false);
    expect(readFileSync(ledgerPath)).toEqual(before);
  });

  it("moves dropped Codex config, block, and state removals into the coordinated payload", async () => {
    const home = join(dir, "home");
    const reactRoot = join(home, "projects", "react");
    const cppRoot = join(home, "projects", "deleted-cpp");
    mkdirSync(reactRoot, { recursive: true });
    writeLedger(home, reactRoot, cppRoot);
    const cppSkill = join(home, ".codex", "skills", "cpp-testing", "SKILL.md");
    const reactSkill = join(home, ".codex", "skills", "react-patterns", "SKILL.md");
    writeCodexState(home, cppSkill, reactSkill);
    writeCodexMergeState(home);
    marker("claude");
    write("ai-coding/adapters/claude.md");
    write("ai-coding/adapters/codex.md");

    const actions = await actionsOf({ env: { HOME: home, USERPROFILE: home } });
    const reconcile = actions.find(
      (action): action is Extract<Action, { kind: "exec" }> =>
        action.kind === "exec" && action.describe.includes("atomic ledger-last transaction"),
    );
    if (reconcile === undefined) throw new Error("missing coordinated reconciliation action");
    const encoded = reconcile.argv.at(-1);
    if (encoded === undefined) throw new Error("missing coordinated reconciliation payload");
    const payload = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as {
      mutations: Array<{ kind: string; phase?: string; path: string }>;
      uninstalls: Array<{ target: string }>;
    };

    expect(payload.uninstalls).toEqual([]);
    expect(payload.mutations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "write-file",
          phase: "owned-removal",
          path: join(home, ".codex", "config.toml"),
        }),
        expect.objectContaining({
          kind: "write-file",
          phase: "owned-removal",
          path: join(home, ".codex", "AGENTS.md"),
        }),
        expect.objectContaining({
          kind: "remove-file",
          phase: "target-state",
          path: join(home, ".codex", CODEX_INSTALL_STATE_FILE),
        }),
      ]),
    );
    expect(
      actions.some(
        (action) =>
          action.kind === "write" &&
          (action.path.endsWith("config.toml") || action.path.endsWith("AGENTS.md")),
      ),
    ).toBe(false);
  });

  it("falls back to standalone Codex cleanup when the ledger has no Codex target record", async () => {
    const home = join(dir, "home");
    const reactRoot = join(home, "projects", "react");
    const cppRoot = join(home, "projects", "deleted-cpp");
    mkdirSync(reactRoot, { recursive: true });
    const ledgerPath = writeLedger(home, reactRoot, cppRoot);
    const ledger = JSON.parse(readFileSync(ledgerPath, "utf8")) as { targets: unknown[] };
    ledger.targets = [];
    writeFileSync(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeCodexMergeState(home);
    marker("claude");
    write("ai-coding/adapters/claude.md");
    write("ai-coding/adapters/codex.md");

    const actions = await actionsOf({ env: { HOME: home, USERPROFILE: home } });
    const config = actions.find(
      (action): action is Extract<Action, { kind: "write" }> =>
        action.kind === "write" && action.path === join(home, ".codex", "config.toml"),
    );
    const agents = actions.find(
      (action): action is Extract<Action, { kind: "write" }> =>
        action.kind === "write" && action.path === join(home, ".codex", "AGENTS.md"),
    );

    expect(config).toBeDefined();
    expect(config?.contents).not.toContain("mcp_servers");
    expect(agents).toBeDefined();
    expect(agents?.contents).not.toContain("BEGIN ecc-codex:agents");
    expect(
      actions.some(
        (action) =>
          action.kind === "exec" && action.describe.includes("remove aih ECC Codex install-state"),
      ),
    ).toBe(true);
  });
});

describe("aih prune --delete / --unrunnable", () => {
  /** A runner where `which <bin>` succeeds only for bins in `onPath`. */
  const pathRunner = (onPath: string[]) =>
    fakeRunner((argv) => {
      if (argv[0] !== "which") return undefined;
      const bin = argv[1] ?? "";
      return onPath.includes(bin)
        ? { code: 0, stdout: `/usr/bin/${bin}` }
        : { code: 1, stdout: "", stderr: "not found" };
    });

  it("--delete marks file removals hardDelete (single-slot .aih.bak, no legacy archive)", async () => {
    marker("claude");
    write("ai-coding/adapters/claude.md");
    write("ai-coding/adapters/codex.md"); // dropped
    const actions = await actionsOf({ options: { delete: true } });
    const rm = actions.find((a): a is Extract<Action, { kind: "remove" }> => a.kind === "remove");
    expect(rm?.hardDelete).toBe(true);
    const text = digestText(actions);
    expect(text).toContain("hard-delete");
    expect(text).not.toContain("move to .aih/legacy/");
  });

  it("default runs never hardDelete", async () => {
    marker("claude");
    write("ai-coding/adapters/claude.md");
    write("ai-coding/adapters/codex.md");
    const actions = await actionsOf();
    const rm = actions.find((a): a is Extract<Action, { kind: "remove" }> => a.kind === "remove");
    expect(rm?.hardDelete).toBeFalsy();
  });

  it("--unrunnable folds no-binary targeted CLIs in, with the loud warning", async () => {
    marker("claude", "cursor"); // both targeted…
    write("ai-coding/adapters/claude.md");
    write("ai-coding/adapters/cursor.md");
    // …but only claude's binary is on PATH.
    const actions = await actionsOf({
      options: { unrunnable: true },
      run: pathRunner(["claude"]),
    });
    expect(
      actions.some((a) => a.kind === "remove" && a.path === "ai-coding/adapters/cursor.md"),
    ).toBe(true);
    const text = digestText(actions);
    expect(text).toContain("--unrunnable");
    expect(text).toContain("PATH problem");
    expect(text).toContain(".aih-config.json are unchanged");
  });

  it("without the flag, an unrunnable-but-targeted CLI is untouched", async () => {
    marker("claude", "cursor");
    write("ai-coding/adapters/claude.md");
    write("ai-coding/adapters/cursor.md");
    const actions = await actionsOf({ run: pathRunner(["claude"]) });
    expect(actions.some((a) => a.kind === "remove")).toBe(false);
    expect(digestText(actions)).toContain("No stale per-CLI artifacts");
  });

  it("treats --cli/--all-tools/--detect as ignored selection flags, not prune intent", async () => {
    marker("claude", "codex", "gemini");
    write("ai-coding/adapters/claude.md");
    write("ai-coding/adapters/codex.md");
    write("ai-coding/adapters/gemini.md");

    const actions = await actionsOf({ options: { allTools: true, cli: "claude", detect: true } });
    expect(actions.some((a) => a.kind === "remove")).toBe(false);

    const text = digestText(actions);
    expect(text).toContain("--cli");
    expect(text).toContain("--all-tools");
    expect(text).toContain("--detect");
    expect(text).toContain("ignored");
    expect(text).toContain("committed intent only");
    expect(text).toContain("Kept (.aih-config.json): claude, codex, gemini");
  });
});
