import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SHARED_MARKER, sharedBlock } from "../../src/bootstrap-ai/canon.js";
import { CODEX_AGENTS_BLOCK_MARKER, CODEX_INSTALL_STATE_FILE } from "../../src/ecc/codex.js";
import { registrationLedgerPath } from "../../src/ecc/registration.js";
import { mergeManagedBlock } from "../../src/internals/markers.js";
import type { Action, PlanContext } from "../../src/internals/plan.js";
import { fakeRunner } from "../../src/internals/proc.js";
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

  it("plans a deterministic ledger-last component diff even without committed CLI intent", async () => {
    const home = join(dir, "home");
    const reactRoot = join(home, "projects", "react");
    const cppRoot = join(home, "projects", "deleted-cpp");
    mkdirSync(reactRoot, { recursive: true });
    const ledgerPath = writeLedger(home, reactRoot, cppRoot);
    const cppSkill = join(home, ".codex", "skills", "cpp-testing", "SKILL.md");
    const reactSkill = join(home, ".codex", "skills", "react-patterns", "SKILL.md");
    const statePath = writeCodexState(home, cppSkill, reactSkill);
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
    const encoded = reconcile?.argv.at(-1);
    if (encoded === undefined) throw new Error("missing ECC reconciliation payload");
    const payload = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as {
      mutations: Array<{ kind: string; path: string }>;
    };
    expect(payload.mutations).toContainEqual({
      kind: "remove-file",
      path: cppSkill,
      root: join(home, ".codex"),
    });
    expect(payload.mutations).toContainEqual(
      expect.objectContaining({ kind: "write-file", path: statePath }),
    );
    for (const [path, contents] of before) expect(readFileSync(path)).toEqual(contents);
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
