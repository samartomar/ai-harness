import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { executePlan } from "../../src/internals/execute.js";
import type { PlanContext } from "../../src/internals/plan.js";
import { fakeRunner, type Runner } from "../../src/internals/proc.js";
import { makeHostAdapter } from "../../src/platform/detect.js";
import { usagePanel } from "../../src/report/usage.js";
import { aggregateUsage } from "../../src/usage/aggregate.js";
import { gitPostCommitHook, usageRecorderScript } from "../../src/usage/capture.js";
import { readUsage, type UsageEvent } from "../../src/usage/events.js";
import { command } from "../../src/usage/index.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aih-usage-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function makeCtx(
  options: Record<string, unknown> = {},
  run: Runner = fakeRunner(() => undefined),
): PlanContext {
  return {
    root,
    contextDir: "ai-coding",
    apply: false,
    verify: false,
    json: false,
    run,
    host: makeHostAdapter({ platform: "linux", run, env: {} }),
    env: {},
    options,
  };
}

function writeUsage(...lines: string[]): void {
  mkdirSync(join(root, ".aih"), { recursive: true });
  writeFileSync(join(root, ".aih", "usage.jsonl"), `${lines.join("\n")}\n`);
}

interface ZedThreadFixture {
  data: unknown;
  folderPaths?: string | null;
  id?: string;
  updatedAt?: string;
}

async function writeZedThreadsDb(dbPath: string, fixture: ZedThreadFixture): Promise<void> {
  const sqlite = await import("node:sqlite");
  const db = new sqlite.DatabaseSync(dbPath);
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY,
        summary TEXT,
        updated_at TEXT,
        data_type TEXT,
        data BLOB,
        folder_paths TEXT
      )
    `);
    db.prepare(
      "INSERT OR REPLACE INTO threads (id, summary, updated_at, data_type, data, folder_paths) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      fixture.id ?? "thread-1",
      "Implement usage metering",
      fixture.updatedAt ?? "2026-07-06T10:00:00.000Z",
      "json",
      Buffer.from(JSON.stringify(fixture.data)),
      fixture.folderPaths === undefined ? JSON.stringify([root]) : fixture.folderPaths,
    );
  } finally {
    db.close();
  }
}

const zedSqliteDescribe = builtinModules.includes("node:sqlite") ? describe : describe.skip;

const EVENTS: UsageEvent[] = [
  { tool: "git", kind: "commit", added: 10, removed: 3, files: 2 },
  { tool: "git", kind: "commit", added: 5, removed: 0, files: 1 },
  { tool: "claude", kind: "skill", name: "tdd", source: "ecc" },
  { tool: "claude", kind: "skill", name: "tdd", source: "ecc" },
  { tool: "claude", kind: "skill", name: "crispy", source: "canon" },
  { tool: "cursor", kind: "mcp", name: "search", server: "context7" },
];

describe("readUsage", () => {
  it("parses valid events, skips malformed lines and unknown kinds", () => {
    writeUsage(
      JSON.stringify({ tool: "git", kind: "commit", added: 1 }),
      "{ not json",
      JSON.stringify({ tool: "x", kind: "bogus" }), // invalid kind → dropped
      JSON.stringify({ kind: "skill" }), // missing tool → dropped
      JSON.stringify({ tool: "claude", kind: "skill", name: "tdd" }),
      JSON.stringify({
        tool: "claude",
        kind: "session",
        tokens: { input: 100, output: 20, cacheRead: 300, cacheCreation: 40 },
      }),
    );
    const ev = readUsage(makeCtx());
    expect(ev).toHaveLength(3);
    expect(ev.map((e) => e.kind)).toEqual(["commit", "skill", "session"]);
    expect(ev[2]?.tokens).toEqual({ input: 100, output: 20, cacheRead: 300, cacheCreation: 40 });
  });

  it("rejects malformed schema rows and strips unknown fields", () => {
    writeUsage(
      JSON.stringify({ tool: "claude", kind: "skill", name: "bad", source: "external" }),
      JSON.stringify({ tool: "claude", kind: "session", tokens: { input: -1 } }),
      JSON.stringify({ tool: "git", kind: "commit", added: "1" }),
      JSON.stringify({
        tool: "claude",
        kind: "skill",
        name: "safe",
        source: "ecc",
        prompt: "do not retain",
      }),
    );

    const ev = readUsage(makeCtx());

    expect(ev).toEqual([{ tool: "claude", kind: "skill", name: "safe", source: "ecc" }]);
    expect((ev[0] as unknown as Record<string, unknown>).prompt).toBeUndefined();
  });

  it("returns [] when there is no log", () => {
    expect(readUsage(makeCtx())).toEqual([]);
  });
});

describe("aggregateUsage", () => {
  it("folds events into tool / commit / skills-by-source / mcp summaries", () => {
    const s = aggregateUsage([
      ...EVENTS,
      {
        tool: "claude",
        kind: "session",
        tokens: { input: 100, output: 20, cacheRead: 300, cacheCreation: 40 },
      },
      {
        tool: "codex",
        kind: "tool",
        name: "shell_command",
        tokens: { input: 20, cacheRead: 80 },
      },
    ]);
    expect(s.total).toBe(8);
    expect(s.tools).toEqual([
      { name: "claude", count: 4 },
      { name: "git", count: 2 },
      { name: "codex", count: 1 },
      { name: "cursor", count: 1 },
    ]);
    expect(s.commits).toEqual({ count: 2, added: 15, removed: 3, files: 3 });
    expect(s.tokens).toEqual({
      input: 120,
      output: 20,
      cacheRead: 380,
      cacheCreation: 40,
      total: 560,
      cacheEfficiencyPct: 76,
    });
    expect(s.skills.top).toEqual([
      { name: "tdd", count: 2 },
      { name: "crispy", count: 1 },
    ]);
    expect(s.skills.bySource.ecc).toEqual([{ name: "tdd", count: 2 }]);
    expect(s.skills.bySource.canon).toEqual([{ name: "crispy", count: 1 }]);
    expect(s.mcp.servers).toEqual([{ name: "context7", count: 1 }]);
    expect(s.mcp.tools).toEqual([{ name: "search", count: 1 }]);
  });
});

describe("capture artifacts", () => {
  it("the recorder appends to .aih/usage.jsonl and derives commit LOC", () => {
    const src = usageRecorderScript();
    expect(src).toContain(".aih/usage.jsonl");
    expect(src).toContain("appendFileSync");
    expect(src).toContain("--numstat"); // derives LOC for commit events
    expect(src).toContain("--abbrev-ref"); // captures the commit branch (AI events table)
    expect(src).toContain("ev.branch");
    expect(src).not.toMatch(/sk-ant-/); // no secrets
  });

  it("maps representative stdin hook payloads for codex/gemini/opencode", () => {
    const recorder = join(root, "usage-record.mjs");
    writeFileSync(recorder, usageRecorderScript());
    const cases = [
      ["codex", { tool_name: "mcp__context7__resolve-library-id", tool_input: {} }],
      ["gemini", { tool_name: "mcp_context7_resolve_library_id", tool_input: {} }],
      ["opencode", { tool: "skill", args: { name: "tdd-workflow" } }],
    ] as const;
    for (const [cli, payload] of cases) {
      execFileSync(process.execPath, [recorder, "--from", cli], {
        cwd: root,
        input: JSON.stringify(payload),
      });
    }
    const rows = readFileSync(join(root, ".aih", "usage.jsonl"), "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as UsageEvent);
    expect(rows).toMatchObject([
      { tool: "codex", kind: "mcp", server: "context7", name: "resolve-library-id" },
      { tool: "gemini", kind: "mcp", server: "context7", name: "resolve_library_id" },
      { tool: "opencode", kind: "skill", name: "tdd-workflow" },
    ]);
  }, 15000);

  it("maps real stdin hook payloads for the remaining hook-capable CLIs", () => {
    const recorder = join(root, "usage-record.mjs");
    writeFileSync(recorder, usageRecorderScript());
    const cases = [
      [
        "cursor",
        {
          hook_event_name: "afterMCPExecution",
          tool_name: "MCP:context7:resolve-library-id",
          tool_input: '{"libraryName":"Vitest"}',
          result_json: "{}",
          duration: 123,
        },
      ],
      [
        "windsurf",
        {
          agent_action_name: "post_mcp_tool_use",
          tool_info: {
            mcp_server_name: "github",
            mcp_tool_name: "list_commits",
            mcp_tool_arguments: { owner: "samartomar", repo: "ai-harness" },
            mcp_result: "{}",
          },
        },
      ],
      [
        "copilot",
        {
          sessionId: "s1",
          cwd: root,
          toolName: "Agent",
          toolArgs: { subagentType: "security-reviewer" },
        },
      ],
      [
        "kimi",
        {
          hook_event_name: "PostToolUse",
          tool_name: "Shell",
          tool_input: { command: "npm test" },
        },
      ],
      [
        "antigravity",
        {
          hook_event_name: "PostToolUse",
          toolCall: {
            name: "Task",
            input: { subagent_type: "planner" },
          },
        },
      ],
    ] as const;
    for (const [cli, payload] of cases) {
      execFileSync(process.execPath, [recorder, "--from", cli], {
        cwd: root,
        input: JSON.stringify(payload),
      });
    }
    const rows = readFileSync(join(root, ".aih", "usage.jsonl"), "utf8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line) as UsageEvent);
    expect(rows).toMatchObject([
      { tool: "cursor", kind: "mcp", server: "context7", name: "resolve-library-id" },
      { tool: "windsurf", kind: "mcp", server: "github", name: "list_commits" },
      { tool: "copilot", kind: "skill", name: "security-reviewer" },
      { tool: "kimi", kind: "tool", name: "Shell" },
      { tool: "antigravity", kind: "skill", name: "planner" },
    ]);
  }, 15000);

  it("the git hook is best-effort and can never block a commit", () => {
    const hook = gitPostCommitHook();
    expect(hook).toContain("#!/bin/sh");
    expect(hook).toContain("usage-record.mjs"); // invokes the recorder
    expect(hook).toContain("exit 0"); // never blocks the commit
    expect(hook).toContain("|| true"); // best-effort
  });
});

describe("aih usage command", () => {
  it("installs the recorder + universal git hook + gitignore + coverage doc", async () => {
    const actions = (await command.plan(makeCtx({ cli: "claude,cursor" }))).actions;
    const writes = actions.filter((a) => a.kind === "write");
    const rec = writes.find((w) => w.path.replace(/\\/g, "/") === ".aih/usage-record.mjs");
    expect(rec?.kind === "write" && rec.mode).toBe(0o755);
    const hook = writes.find((w) => w.path.replace(/\\/g, "/") === ".git/hooks/post-commit");
    expect(hook?.kind === "write" && hook.once).toBe(true); // never clobber an existing hook
    expect(hook?.kind === "write" && hook.mode).toBe(0o755);
    expect(writes.some((w) => w.path === ".gitignore")).toBe(true);
    const docText = actions
      .filter((a) => a.kind === "doc")
      .map((a) => (a.kind === "doc" ? a.text : ""))
      .join("\n");
    expect(docText).toContain("usage-record.mjs"); // shows the recorder one-liner
    expect(docText).toContain("cursor"); // tailored to the selected CLIs
    expect(docText).toContain("token/cache counters");
    expect(docText).not.toContain("never prompt content, args, secrets, tokens, or cost");
  });

  zedSqliteDescribe("Zed threads.db usage import", () => {
    it("captures Zed threads.db usage samples additively and idempotently", async () => {
      const dbPath = join(root, "threads.db");
      await writeZedThreadsDb(dbPath, {
        data: {
          cumulative_token_usage: {
            input_tokens: 120,
            output_tokens: 30,
            cache_read_input_tokens: 90,
            cache_creation_input_tokens: 10,
          },
          messages: [
            {
              Agent: {
                content: [
                  {
                    ToolUse: {
                      name: "mcp__context7__resolve-library-id",
                      input: { libraryName: "Vitest" },
                    },
                  },
                  {
                    ToolUse: {
                      name: "Task",
                      input: { subagent_type: "planner", source: "ecc" },
                    },
                  },
                  {
                    ToolUse: {
                      name: "terminal",
                      input: { command: "npm test" },
                    },
                  },
                ],
              },
            },
          ],
        },
      });

      const ctx = { ...makeCtx({ cli: "zed", zedThreadsDb: dbPath }), apply: true };
      await executePlan(await command.plan(ctx), ctx);
      await executePlan(await command.plan(ctx), ctx);

      const rows = readFileSync(join(root, ".aih", "usage.jsonl"), "utf8")
        .trim()
        .split(/\r?\n/)
        .map((line) => JSON.parse(line) as UsageEvent);
      expect(rows).toMatchObject([
        { ts: "2026-07-06T10:00:00.000Z", tool: "zed", kind: "session" },
        {
          ts: "2026-07-06T10:00:00.000Z",
          tool: "zed",
          kind: "mcp",
          server: "context7",
          name: "resolve-library-id",
        },
        {
          ts: "2026-07-06T10:00:00.000Z",
          tool: "zed",
          kind: "skill",
          name: "planner",
          source: "ecc",
        },
        { ts: "2026-07-06T10:00:00.000Z", tool: "zed", kind: "tool", name: "terminal" },
      ]);
      expect(rows.every((row) => typeof row.id === "string" && row.id.startsWith("zed:"))).toBe(
        true,
      );
      expect(rows[0]?.tokens).toEqual({
        input: 120,
        output: 30,
        cacheRead: 90,
        cacheCreation: 10,
      });
      expect(rows.filter((row) => row.tool === "zed")).toHaveLength(4);
    });

    it("sums Zed request token usage maps when cumulative counters are absent", async () => {
      const dbPath = join(root, "threads.db");
      await writeZedThreadsDb(dbPath, {
        data: {
          request_token_usage: {
            user_1: {
              input_tokens: 100,
              output_tokens: 25,
              cache_read_input_tokens: 70,
            },
            user_2: {
              input_tokens: 20,
              output_tokens: 5,
              cache_creation_input_tokens: 10,
            },
          },
        },
      });

      const ctx = { ...makeCtx({ cli: "zed", zedThreadsDb: dbPath }), apply: true };
      await executePlan(await command.plan(ctx), ctx);

      const [row] = readFileSync(join(root, ".aih", "usage.jsonl"), "utf8")
        .trim()
        .split(/\r?\n/)
        .map((line) => JSON.parse(line) as UsageEvent);
      expect(row?.tokens).toEqual({ input: 120, output: 30, cacheRead: 70, cacheCreation: 10 });
    });

    it("updates imported Zed thread rows without duplicating old tool calls", async () => {
      const dbPath = join(root, "threads.db");
      await writeZedThreadsDb(dbPath, {
        data: {
          cumulative_token_usage: {
            input_tokens: 120,
            output_tokens: 30,
          },
          messages: [
            {
              Agent: {
                content: [
                  {
                    ToolUse: {
                      name: "terminal",
                      input: { command: "npm test" },
                    },
                  },
                ],
              },
            },
          ],
        },
      });
      const ctx = { ...makeCtx({ cli: "zed", zedThreadsDb: dbPath }), apply: true };
      await executePlan(await command.plan(ctx), ctx);

      await writeZedThreadsDb(dbPath, {
        updatedAt: "2026-07-06T10:05:00.000Z",
        data: {
          cumulative_token_usage: {
            input_tokens: 150,
            output_tokens: 40,
          },
          messages: [
            {
              Agent: {
                content: [
                  {
                    ToolUse: {
                      name: "terminal",
                      input: { command: "npm test" },
                    },
                  },
                  {
                    ToolUse: {
                      name: "mcp__github__get_issue",
                      input: { issue: 251 },
                    },
                  },
                ],
              },
            },
          ],
        },
      });
      await executePlan(await command.plan(ctx), ctx);

      const rows = readFileSync(join(root, ".aih", "usage.jsonl"), "utf8")
        .trim()
        .split(/\r?\n/)
        .map((line) => JSON.parse(line) as UsageEvent);
      expect(rows).toMatchObject([
        {
          ts: "2026-07-06T10:05:00.000Z",
          tool: "zed",
          kind: "session",
          tokens: { input: 150, output: 40 },
        },
        { ts: "2026-07-06T10:05:00.000Z", tool: "zed", kind: "tool", name: "terminal" },
        {
          ts: "2026-07-06T10:05:00.000Z",
          tool: "zed",
          kind: "mcp",
          server: "github",
          name: "get_issue",
        },
      ]);
      expect(rows.filter((row) => row.tool === "zed")).toHaveLength(3);
    });

    it("captures newline-delimited Zed folder metadata when one path matches the repo", async () => {
      const dbPath = join(root, "threads.db");
      await writeZedThreadsDb(dbPath, {
        folderPaths: `${join(root, "other-repo")}\n${root}`,
        data: {
          cumulative_token_usage: {
            input_tokens: 120,
            output_tokens: 30,
          },
        },
      });

      const ctx = { ...makeCtx({ cli: "zed", zedThreadsDb: dbPath }), apply: true };
      await executePlan(await command.plan(ctx), ctx);

      const [row] = readFileSync(join(root, ".aih", "usage.jsonl"), "utf8")
        .trim()
        .split(/\r?\n/)
        .map((line) => JSON.parse(line) as UsageEvent);
      expect(row).toMatchObject({ tool: "zed", kind: "session" });
    });

    it("skips Zed rows without matching repo metadata", async () => {
      const dbPath = join(root, "threads.db");
      await writeZedThreadsDb(dbPath, {
        folderPaths: null,
        data: {
          cumulative_token_usage: {
            input_tokens: 120,
            output_tokens: 30,
          },
        },
      });

      const ctx = { ...makeCtx({ cli: "zed", zedThreadsDb: dbPath }), apply: true };
      await executePlan(await command.plan(ctx), ctx);

      expect(existsSync(join(root, ".aih", "usage.jsonl"))).toBe(false);
    });

    it("skips unreadable Zed threads.db paths without failing the usage plan", async () => {
      const ctx = {
        ...makeCtx({ cli: "zed", zedThreadsDb: join(root, "missing.db") }),
        apply: true,
      };
      await executePlan(await command.plan(ctx), ctx);

      expect(existsSync(join(root, ".aih", "usage.jsonl"))).toBe(false);
    });

    it("skips non-matching Zed repo folder metadata", async () => {
      const dbPath = join(root, "threads.db");
      await writeZedThreadsDb(dbPath, {
        folderPaths: JSON.stringify([join(root, "other-repo")]),
        data: {
          cumulative_token_usage: {
            input_tokens: 120,
            output_tokens: 30,
          },
        },
      });

      const ctx = { ...makeCtx({ cli: "zed", zedThreadsDb: dbPath }), apply: true };
      await executePlan(await command.plan(ctx), ctx);

      expect(existsSync(join(root, ".aih", "usage.jsonl"))).toBe(false);
    });

    it("skips case-only Zed repo mismatches on Linux", async () => {
      const dbPath = join(root, "threads.db");
      await writeZedThreadsDb(dbPath, {
        folderPaths: root.toUpperCase(),
        data: {
          cumulative_token_usage: {
            input_tokens: 120,
            output_tokens: 30,
          },
        },
      });

      const ctx = { ...makeCtx({ cli: "zed", zedThreadsDb: dbPath }), apply: true };
      await executePlan(await command.plan(ctx), ctx);

      expect(existsSync(join(root, ".aih", "usage.jsonl"))).toBe(false);
    });

    it("captures legacy-style Zed token counters", async () => {
      const dbPath = join(root, "threads.db");
      await writeZedThreadsDb(dbPath, {
        data: {
          token_usage: {
            input_tokens: 120,
            output_tokens: 30,
            cache_read_tokens: 90,
            cache_creation_tokens: 10,
          },
        },
      });

      const ctx = { ...makeCtx({ cli: "zed", zedThreadsDb: dbPath }), apply: true };
      await executePlan(await command.plan(ctx), ctx);

      const [row] = readFileSync(join(root, ".aih", "usage.jsonl"), "utf8")
        .trim()
        .split(/\r?\n/)
        .map((line) => JSON.parse(line) as UsageEvent);
      expect(row?.tokens).toEqual({
        input: 120,
        output: 30,
        cacheRead: 90,
        cacheCreation: 10,
      });
    });
  });

  it("generates per-tool usage hooks for every targeted hook-capable CLI", async () => {
    const actions = (
      await command.plan(
        makeCtx({
          cli: "claude,codex,cursor,antigravity,gemini,copilot,windsurf,opencode,kimi,kiro,zed",
        }),
      )
    ).actions;
    const writes = actions
      .filter((a) => a.kind === "write")
      .map((a) => [a.path.replace(/\\/g, "/"), JSON.stringify(a)] as const);
    const expected = new Map([
      [".claude/settings.json", "--from claude"],
      [".codex/hooks.json", "--from codex"],
      [".cursor/hooks.json", "--from cursor"],
      [".agents/hooks.json", "--from antigravity"],
      [".gemini/settings.json", "--from gemini"],
      [".github/hooks/aih-usage-metering.json", "--from copilot"],
      [".windsurf/hooks.json", "--from windsurf"],
      [".opencode/plugins/aih-usage-metering.js", "--from opencode"],
      [".kimi/config.toml", "--from kimi"],
      [".kiro/hooks/aih-usage-metering.kiro.hook", "--from kiro"],
    ]);
    for (const [path, commandText] of expected) {
      const write = writes.find(([p]) => p === path);
      expect(write, path).toBeDefined();
      expect(write?.[1]).toContain(commandText);
    }
    const codex = writes.find(([p]) => p === ".codex/hooks.json");
    expect(codex?.[1]).toContain("git rev-parse --show-toplevel");
    expect(codex?.[1]).toContain("commandWindows");
    expect(writes.some(([p]) => p === ".codex/hooks/hooks.json")).toBe(false);
    expect(writes.some(([p]) => p === ".copilot/hooks/aih-usage-metering.json")).toBe(false);
    expect(writes.some(([p]) => p === ".antigravity/hooks.json")).toBe(false);
    const copilot = writes.find(([p]) => p === ".github/hooks/aih-usage-metering.json");
    expect(copilot?.[1]).toContain('"version":1');
    expect(copilot?.[1]).toContain('"postToolUse"');
    const antigravity = writes.find(([p]) => p === ".agents/hooks.json");
    expect(antigravity?.[1]).toContain('"aih-usage-metering"');
    expect(antigravity?.[1]).toContain('"PostToolUse"');
    const gemini = writes.find(([p]) => p === ".gemini/settings.json");
    expect(gemini?.[1]).toContain('"AfterTool"');
    expect(gemini?.[1]).toContain('"sequential":false');
    expect(writes.some(([p]) => p.includes("zed"))).toBe(false);
    const docs = actions
      .filter((a) => a.kind === "doc")
      .map((a) => (a.kind === "doc" ? a.text : ""))
      .join("\n");
    expect(docs).toContain(".codex/hooks.json");
    expect(docs).toContain("trusted");
    expect(docs).toContain("zed");
    expect(docs).toContain("no hooks");
  });

  it("makes the Claude PostToolUse command fail-open (`; exit 0`, no PowerShell-hostile guards)", async () => {
    const actions = (await command.plan(makeCtx({ cli: "claude" }))).actions;
    const settings = actions.find(
      (a) => a.kind === "write" && a.path.replace(/\\/g, "/") === ".claude/settings.json",
    );
    const serialized = settings?.kind === "write" ? JSON.stringify(settings.json) : "";
    // Recorder still invoked, then the shell always exits 0 so a tool call can't fail.
    expect(serialized).toContain("node .aih/usage-record.mjs --from claude; exit 0");
    // Claude runs hooks via sh/Git Bash/PowerShell — POSIX-only guards break PowerShell.
    expect(serialized).not.toContain("[ -f");
    expect(serialized).not.toContain("2>/dev/null");
  });

  it("confines the `; exit 0` fail-open masker to the Claude-derived hosts (Claude + Antigravity)", async () => {
    // Regression guard: only the Claude-Code-derived CLIs run hooks under
    // sh/Git Bash/PowerShell where `; exit 0` is portable. On a cmd.exe host (codex
    // windows, possibly others) `; exit 0` would misbehave, so flipping the
    // `commandHook` ternary or adding `failOpen` to a cmd-hosted CLI must fail here,
    // not ship silently.
    const noMaskerHosts = "codex,cursor,gemini,copilot,windsurf,opencode,kimi,kiro";
    const nonClaudeWrites = (await command.plan(makeCtx({ cli: noMaskerHosts }))).actions
      .filter((a) => a.kind === "write")
      .map((a) => JSON.stringify(a));
    for (const serialized of nonClaudeWrites) {
      expect(serialized).not.toContain("; exit 0");
    }
    // And BOTH Claude-derived hosts DO carry it (the positive half of the invariant):
    // Antigravity is a Claude-Code fork on the identical hook schema + shell hosts.
    const claudeDerived = (
      await command.plan(makeCtx({ cli: "claude,antigravity" }))
    ).actions.filter(
      (a) =>
        a.kind === "write" &&
        [".claude/settings.json", ".agents/hooks.json"].includes(a.path.replace(/\\/g, "/")),
    );
    expect(claudeDerived).toHaveLength(2);
    for (const write of claudeDerived) {
      expect(write.kind === "write" ? JSON.stringify(write.json) : "").toContain("; exit 0");
    }
  });

  it("gives the Kiro usage hook a seconds-unit timeout (agentStop is non-blocking)", async () => {
    const actions = (await command.plan(makeCtx({ cli: "kiro" }))).actions;
    const hook = actions.find(
      (a) =>
        a.kind === "write" &&
        a.path.replace(/\\/g, "/") === ".kiro/hooks/aih-usage-metering.kiro.hook",
    );
    const json = hook?.kind === "write" ? (hook.json as { timeout?: number; when?: unknown }) : {};
    expect(json.timeout).toBeGreaterThan(0);
    expect(json.when).toMatchObject({ type: "agentStop" });
  });

  it("merges the Claude usage hook additively and idempotently", async () => {
    mkdirSync(join(root, ".claude"), { recursive: true });
    writeFileSync(
      join(root, ".claude", "settings.json"),
      JSON.stringify({
        hooks: {
          PostToolUse: [
            {
              matcher: "Bash",
              hooks: [{ type: "command", command: "node team-hook.mjs" }],
            },
          ],
        },
      }),
    );
    const ctx = { ...makeCtx({ cli: "claude" }), apply: true };
    await executePlan(await command.plan(ctx), ctx);
    await executePlan(await command.plan(ctx), ctx);
    const parsed = JSON.parse(readFileSync(join(root, ".claude", "settings.json"), "utf8")) as {
      hooks: { PostToolUse: Array<{ hooks?: Array<{ command?: string }> }> };
    };
    const commands = parsed.hooks.PostToolUse.flatMap((group) =>
      (group.hooks ?? []).map((hook) => hook.command),
    );
    expect(commands).toContain("node team-hook.mjs");
    expect(commands.filter((cmd) => cmd?.includes("usage-record.mjs --from claude"))).toHaveLength(
      1,
    );
  });

  it("merges remaining repo hook configs additively and idempotently", async () => {
    mkdirSync(join(root, ".cursor"), { recursive: true });
    writeFileSync(
      join(root, ".cursor", "hooks.json"),
      JSON.stringify({
        version: 1,
        hooks: {
          afterMCPExecution: [
            { command: "node team.mjs" },
            {
              type: "command",
              command: "node .aih/usage-record.mjs --from cursor",
              name: "aih-usage-metering",
              description: "Record local AI tool usage to .aih/usage.jsonl.",
              timeout: 5000,
            },
          ],
        },
      }),
    );
    mkdirSync(join(root, ".windsurf"), { recursive: true });
    writeFileSync(
      join(root, ".windsurf", "hooks.json"),
      JSON.stringify({
        hooks: {
          post_mcp_tool_use: [
            { command: "python team.py" },
            {
              type: "command",
              command: "node .aih/usage-record.mjs --from windsurf",
              name: "aih-usage-metering",
              description: "Record local AI tool usage to .aih/usage.jsonl.",
              timeout: 5000,
            },
          ],
        },
      }),
    );
    mkdirSync(join(root, ".agents"), { recursive: true });
    writeFileSync(
      join(root, ".agents", "hooks.json"),
      JSON.stringify({ "team-policy": { Stop: [{ command: "python done.py" }] } }),
    );
    mkdirSync(join(root, ".kimi"), { recursive: true });
    writeFileSync(join(root, ".kimi", "config.toml"), 'theme = "dark"\n');

    const ctx = { ...makeCtx({ cli: "cursor,windsurf,antigravity,kimi" }), apply: true };
    await executePlan(await command.plan(ctx), ctx);
    await executePlan(await command.plan(ctx), ctx);

    const cursor = JSON.parse(readFileSync(join(root, ".cursor", "hooks.json"), "utf8")) as {
      hooks: { afterMCPExecution: Array<{ command?: string }> };
    };
    const cursorCommands = cursor.hooks.afterMCPExecution.map((hook) => hook.command);
    expect(cursorCommands).toContain("node team.mjs");
    expect(
      cursorCommands.filter((cmd) => cmd?.includes("usage-record.mjs --from cursor")),
    ).toHaveLength(1);

    const windsurf = JSON.parse(readFileSync(join(root, ".windsurf", "hooks.json"), "utf8")) as {
      hooks: { post_mcp_tool_use: Array<{ command?: string }> };
    };
    const windsurfCommands = windsurf.hooks.post_mcp_tool_use.map((hook) => hook.command);
    expect(windsurfCommands).toContain("python team.py");
    expect(
      windsurfCommands.filter((cmd) => cmd?.includes("usage-record.mjs --from windsurf")),
    ).toHaveLength(1);

    const antigravity = JSON.parse(readFileSync(join(root, ".agents", "hooks.json"), "utf8")) as {
      "team-policy"?: unknown;
      "aih-usage-metering"?: { PostToolUse?: Array<{ hooks?: Array<{ command?: string }> }> };
    };
    expect(antigravity["team-policy"]).toBeDefined();
    const agyCommands = (antigravity["aih-usage-metering"]?.PostToolUse ?? []).flatMap((group) =>
      (group.hooks ?? []).map((hook) => hook.command),
    );
    expect(
      agyCommands.filter((cmd) => cmd?.includes("usage-record.mjs --from antigravity")),
    ).toHaveLength(1);

    const kimi = readFileSync(join(root, ".kimi", "config.toml"), "utf8");
    expect(kimi).toContain('theme = "dark"');
    expect(kimi.match(/aih managed \(usage-metering\)/g)).toHaveLength(2);
    expect(kimi.match(/usage-record\.mjs --from kimi/g)).toHaveLength(1);
  });

  it("is read-only/local — only write/doc/probe actions, never exec or call out", async () => {
    const actions = (await command.plan(makeCtx())).actions;
    for (const a of actions) expect(["write", "doc", "probe"]).toContain(a.kind);
  });

  it("chains capture into a PRE-EXISTING post-commit hook instead of skipping it (AIH-USAGE-001)", async () => {
    mkdirSync(join(root, ".git", "hooks"), { recursive: true });
    writeFileSync(join(root, ".git", "hooks", "post-commit"), "#!/bin/sh\n./team-hook.sh\n");
    const actions = (await command.plan(makeCtx())).actions;
    // The user's hook is preserved (write-once), and a chain snippet is offered.
    const hook = actions.find(
      (a) => a.kind === "write" && a.path.replace(/\\/g, "/") === ".git/hooks/post-commit",
    );
    expect(hook?.kind === "write" && hook.once).toBe(true);
    const chainDoc = actions.find(
      (a) => a.kind === "doc" && a.describe.includes("existing post-commit"),
    );
    expect(chainDoc?.kind === "doc" && chainDoc.text).toContain("usage-record.mjs");
  });

  it("emits a read-only cross-project rollup digest from passed repo roots", async () => {
    const other = mkdtempSync(join(tmpdir(), "aih-usage-other-"));
    try {
      mkdirSync(join(other, ".aih"), { recursive: true });
      writeFileSync(
        join(other, ".aih", "usage.jsonl"),
        `${JSON.stringify({ tool: "codex", kind: "skill", name: "planner", source: "ecc" })}\n`,
      );
      writeUsage(
        JSON.stringify({ tool: "claude", kind: "mcp", name: "search", server: "context7" }),
      );
      const actions = (await command.plan(makeCtx({ rollup: `${root},${other}` }))).actions;
      expect(actions.every((a) => a.kind === "digest")).toBe(true);
      const rollup = actions.find(
        (a) => a.kind === "digest" && a.describe.startsWith("Usage rollup"),
      );
      expect(rollup?.kind === "digest" && rollup.text).toContain("claude");
      expect(rollup?.kind === "digest" && rollup.text).toContain("codex");
      expect(rollup?.kind === "digest" && rollup.data).toMatchObject({
        repos: expect.arrayContaining([expect.objectContaining({ events: 1 })]),
        summary: { total: 2 },
      });
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});

describe("usagePanel", () => {
  it("shows a stub pointing at `aih usage` when nothing is captured", () => {
    const d = usagePanel(makeCtx());
    expect(d.describe).toContain("no events captured");
    expect(d.text).toContain("aih usage --apply");
  });

  it("renders activity, skills-by-source, and MCP once events exist", () => {
    writeUsage(...EVENTS.map((e) => JSON.stringify(e)));
    const d = usagePanel(makeCtx());
    expect(d.describe).toContain("6 events");
    expect(d.text).toContain("claude (3)");
    expect(d.text).toContain("ECC:");
    expect(d.text).toContain("tdd");
    expect(d.text).toContain("context7");
    expect(d.data).toMatchObject({ total: 6 });
  });
});
