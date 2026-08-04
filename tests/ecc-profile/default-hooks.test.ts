import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  CONTINUITY_LIMITS,
  type ContinuityRecord,
  type ContinuityStore,
  createContinuityHandler,
  createFileContinuityStore,
  createMcpHealthHandler,
  createRepositoryProtectionHandler,
} from "../../src/ecc-profile/default-hooks.js";
import type { NormalizedHookEvent } from "../../src/ecc-profile/hook-core.js";

const WORKTREE = "C:/fixtures/project";

function event(
  kind: NormalizedHookEvent["event"],
  overrides: Partial<NormalizedHookEvent> = {},
): Readonly<NormalizedHookEvent> {
  return {
    version: 1,
    client: "codex",
    event: kind,
    nativeEvent: "TestEvent",
    sessionId: "session-1",
    transcriptPath: null,
    cwd: WORKTREE,
    ...overrides,
  };
}

function shell(command: string, kind: "before-tool" | "permission-request" = "before-tool") {
  return event(kind, { tool: { name: "Bash", id: "tool-1", input: { command } } });
}

class MemoryContinuityStore implements ContinuityStore {
  records: ContinuityRecord[] = [];

  list(): readonly ContinuityRecord[] {
    return structuredClone(this.records);
  }

  save(record: ContinuityRecord): void {
    this.records = this.records.filter((item) => item.sessionId !== record.sessionId);
    this.records.push(structuredClone(record));
  }

  prune(beforeEpochMs: number): void {
    this.records = this.records.filter((item) => item.updatedAtEpochMs >= beforeEpochMs);
  }
}

describe("ECC repository-protection hook", () => {
  const handler = createRepositoryProtectionHandler();
  const signal = new AbortController().signal;

  it.each([
    "git commit --no-verify",
    "git commit -n",
    "git commit -an -m test",
    "git commit `--no-verify",
    "npm test && GIT commit '--NO-VERIFY'",
    "npm test; & 'git' commit -n",
    "env FEATURE=1 /usr/bin/git commit --no-verify",
    "command git -c core.hooksPath=/tmp/empty status",
    "bash -c 'git commit --no-verify'",
    'pwsh -Command "git commit -n"',
    'cmd /c "git commit --no-verify"',
    'git merge "--no-verify"',
    "git -c core.hooksPath=/tmp/empty commit -m test",
    "git -c 'CORE.HOOKSPATH=/tmp/empty' status",
    'git config --local "core.hooksPath" .empty',
    "git config core.hookspath=.empty",
  ])("blocks verification bypass without performing a Git write: %s", async (command) => {
    await expect(Promise.resolve(handler.run(shell(command), signal))).resolves.toMatchObject({
      action: "block",
      reason: expect.stringContaining("repository protection"),
    });
  });

  it.each([
    "git commit -m 'keep --no-verify in prose'",
    "git config --get core.hooksPath",
    "git config --show-origin --get core.hookspath",
    "printf 'git commit --no-verify'",
    "npm test && git status",
  ])("allows non-mutating or literal lookalikes: %s", async (command) => {
    await expect(Promise.resolve(handler.run(shell(command), signal))).resolves.toEqual({
      action: "continue",
    });
  });

  it("ignores non-shell tools and fails closed when shell command input is malformed", async () => {
    await expect(
      Promise.resolve(
        handler.run(
          event("before-tool", { tool: { name: "Read", input: { file_path: "x" } } }),
          signal,
        ),
      ),
    ).resolves.toEqual({ action: "continue" });
    await expect(
      Promise.resolve(
        handler.run(event("before-tool", { tool: { name: "Bash", input: {} } }), signal),
      ),
    ).resolves.toMatchObject({ action: "block" });
  });
});

describe("ECC continuity hook", () => {
  const signal = new AbortController().signal;

  function setup(now = Date.UTC(2026, 7, 3, 12)) {
    const store = new MemoryContinuityStore();
    const handler = createContinuityHandler({
      repositoryId: "github.com/example/project",
      canonicalWorktree: WORKTREE,
      harness: "codex",
      store,
      now: () => now,
    });
    return { handler, store };
  }

  it("writes a redacted durable pre-compaction checkpoint and resumes the exact worktree", async () => {
    const { handler, store } = setup();
    await handler.run(
      event("after-compact", {
        compactSummary: "Keep plan. API_TOKEN=super-secret-value and continue tests.",
      }),
      signal,
    );
    expect(store.records).toHaveLength(1);
    expect(JSON.stringify(store.records)).not.toContain("super-secret-value");
    expect(JSON.stringify(store.records)).not.toContain("session-1");

    const resumed = await handler.run(
      event("session-start", { sessionId: "session-2", source: "resume" }),
      signal,
    );
    expect(resumed).toMatchObject({
      action: "continue",
      context: expect.stringContaining("Keep plan"),
    });
    expect(resumed.context?.length).toBeLessThanOrEqual(CONTINUITY_LIMITS.maxInjectedCharacters);
  });

  it("checkpoints the latest response before compaction and resumes it after compaction", async () => {
    const { handler, store } = setup();
    await handler.run(
      event("stop", {
        stopHookActive: false,
        lastAssistantMessage: "Decision: retain the safe path. API_TOKEN=super-secret-value",
      }),
      signal,
    );
    const compact = await handler.run(event("before-compact", { trigger: "auto" }), signal);
    expect(compact.context).toMatch(/preserve decisions/i);
    expect(JSON.stringify(store.records)).toContain("retain the safe path");
    expect(JSON.stringify(store.records)).not.toContain("super-secret-value");
    const resumed = await handler.run(
      event("session-start", { sessionId: "session-after-compact", source: "compact" }),
      signal,
    );
    expect(resumed.context).toContain("retain the safe path");
  });

  it("records activity metadata without raw prompt, tool input, output, or auth headers", async () => {
    const { handler, store } = setup();
    await handler.run(
      event("after-tool", {
        prompt: "do not store me",
        tool: {
          name: "Bash",
          input: { command: "curl -H 'Authorization: bearer secret'" },
          response: { stdout: "complete tool output" },
        },
        durationMs: 19,
      }),
      signal,
    );
    expect(store.records[0]?.activity).toEqual([
      {
        atEpochMs: Date.UTC(2026, 7, 3, 12),
        event: "after-tool",
        tool: "Bash",
        outcome: "ok",
        durationMs: 19,
      },
    ]);
    expect(JSON.stringify(store.records)).not.toMatch(
      /do not store|Authorization|complete tool output|curl/,
    );
  });

  it("rejects foreign worktrees and cannot resume another harness or repository", async () => {
    const { handler, store } = setup();
    await expect(
      Promise.resolve().then(() =>
        handler.run(event("session-start", { cwd: "C:/fixtures/other" }), signal),
      ),
    ).rejects.toThrow(/foreign worktree/);
    store.records.push({
      version: 1,
      repositoryId: "github.com/other/project",
      canonicalWorktree: WORKTREE,
      harness: "claude",
      sessionId: "foreign",
      updatedAtEpochMs: Date.UTC(2026, 7, 3, 11),
      summary: "foreign summary",
      activity: [],
    });
    const result = await handler.run(event("session-start", { sessionId: "new" }), signal);
    expect(result.context ?? "").not.toContain("foreign summary");
  });

  it("prunes records older than 30 days and emits strategic compaction guidance", async () => {
    const now = Date.UTC(2026, 7, 3, 12);
    const { handler, store } = setup(now);
    store.records.push({
      version: 1,
      repositoryId: "github.com/example/project",
      canonicalWorktree: WORKTREE,
      harness: "codex",
      sessionId: "old",
      updatedAtEpochMs: now - CONTINUITY_LIMITS.retentionMs - 1,
      summary: "expired",
      activity: [],
    });
    const decision = await handler.run(event("before-compact"), signal);
    expect(store.records).toHaveLength(1);
    expect(store.records[0]?.sessionId).not.toBe("old");
    expect(decision.context).toMatch(/decisions|next action|worktree/i);
  });

  it("emits a bounded context-critical warning after the reviewed activity threshold", async () => {
    const { handler } = setup();
    for (let index = 0; index < CONTINUITY_LIMITS.contextWarningActivityCount; index += 1) {
      await handler.run(event("after-tool", { tool: { name: "Read", input: {} } }), signal);
    }
    const result = await handler.run(event("user-prompt", { prompt: "continue" }), signal);
    expect(result.context).toMatch(/context-critical/i);
  });

  it("persists deterministic scoped records outside the worktree", () => {
    const root = mkdtempSync(join(tmpdir(), "aih-continuity-"));
    const stateRoot = join(root, "state");
    const worktree = join(root, "project");
    mkdirSync(stateRoot);
    mkdirSync(worktree);
    try {
      const options = {
        stateRoot,
        canonicalWorktree: worktree,
        repositoryId: "github.com/example/project",
        harness: "codex",
      };
      const store = createFileContinuityStore(options);
      store.save({
        version: 1,
        repositoryId: options.repositoryId,
        canonicalWorktree: worktree,
        harness: options.harness,
        sessionId: "session-1",
        updatedAtEpochMs: 10,
        summary: "durable checkpoint",
        activity: [],
      });
      expect(createFileContinuityStore(options).list()).toEqual(store.list());
      expect(store.list()[0]?.summary).toBe("durable checkpoint");
      expect(() =>
        store.save({
          version: 1,
          repositoryId: "github.com/other/project",
          canonicalWorktree: worktree,
          harness: options.harness,
          sessionId: "foreign",
          updatedAtEpochMs: 11,
          summary: "wrong scope",
          activity: [],
        }),
      ).toThrow(/store scope/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects in-worktree state, linked state files, malformed state, and byte overflow", () => {
    const root = mkdtempSync(join(tmpdir(), "aih-continuity-boundary-"));
    const stateRoot = join(root, "state");
    const worktree = join(root, "project");
    mkdirSync(stateRoot);
    mkdirSync(worktree);
    try {
      expect(() =>
        createFileContinuityStore({
          stateRoot: worktree,
          canonicalWorktree: worktree,
          repositoryId: "repo",
          harness: "codex",
        }),
      ).toThrow(/outside/);
      const store = createFileContinuityStore({
        stateRoot,
        canonicalWorktree: worktree,
        repositoryId: "repo",
        harness: "codex",
        maxFileBytes: 1_024,
      });
      store.save({
        version: 1,
        repositoryId: "repo",
        canonicalWorktree: worktree,
        harness: "codex",
        sessionId: "one",
        updatedAtEpochMs: 1,
        summary: "ok",
        activity: [],
      });
      const directory = join(stateRoot, "continuity");
      // The test controls this disposable directory; production discovery stays inside the store.
      const [file] = readdirSync(directory);
      if (!file) throw new Error("missing continuity fixture state");
      const path = join(directory, file);
      writeFileSync(path, "not-json", "utf8");
      expect(() => store.list()).toThrow(/malformed/);
      rmSync(path);
      let linkCreated = false;
      try {
        symlinkSync(join(root, "outside.json"), path, "file");
        linkCreated = true;
      } catch (error) {
        if (process.platform !== "win32") throw error;
      }
      if (linkCreated) expect(() => store.list()).toThrow(/regular file/);
      rmSync(path, { force: true });
      expect(() =>
        store.save({
          version: 1,
          repositoryId: "repo",
          canonicalWorktree: worktree,
          harness: "codex",
          sessionId: "two",
          updatedAtEpochMs: 2,
          summary: "x".repeat(900),
          activity: [],
        }),
      ).toThrow(/file limit/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("ECC MCP-health hook", () => {
  const signal = new AbortController().signal;

  it("probes only selected servers, caches health, and returns deterministic fallbacks", async () => {
    const probe = vi.fn(async (id: string) => ({ ok: id !== "serena", detail: "raw detail" }));
    const handler = createMcpHealthHandler({
      selectedServers: [
        { id: "serena", fallback: "Use repository search until Serena recovers." },
        { id: "context7", fallback: "Use pinned official documentation." },
      ],
      probe,
      now: () => 1_000,
    });
    const first = await handler.run(event("session-start"), signal);
    const second = await handler.run(event("session-start"), signal);
    expect(probe.mock.calls.map(([id]) => id)).toEqual(["context7", "serena"]);
    expect(second).toEqual(first);
    expect(first.context).toBe(
      "MCP serena unavailable. Use repository search until Serena recovers.",
    );
    expect(first.context).not.toContain("raw detail");
  });

  it("backs off failures and reconnects only when explicitly configured", async () => {
    let now = 1_000;
    const probe = vi.fn(async () => ({ ok: false }));
    const reconnect = vi.fn(async () => true);
    const handler = createMcpHealthHandler({
      selectedServers: [{ id: "serena", fallback: "Use repository search.", reconnect: true }],
      probe,
      reconnect,
      now: () => now,
    });
    await handler.run(event("session-start"), signal);
    now += 500;
    await handler.run(
      event("before-tool", { tool: { name: "mcp__serena__find", input: {} } }),
      signal,
    );
    expect(probe).toHaveBeenCalledTimes(1);
    expect(reconnect).toHaveBeenCalledTimes(1);
  });

  it("fails closed on ambiguous selected identities and never probes unselected tool names", async () => {
    expect(() =>
      createMcpHealthHandler({
        selectedServers: [
          { id: "serena", fallback: "one" },
          { id: "SERENA", fallback: "two" },
        ],
        probe: vi.fn(),
      }),
    ).toThrow(/duplicate/i);
    const probe = vi.fn(async () => ({ ok: true }));
    const handler = createMcpHealthHandler({
      selectedServers: [{ id: "serena", fallback: "Use repository search." }],
      probe,
    });
    await handler.run(
      event("before-tool", { tool: { name: "mcp__not-selected__read", input: {} } }),
      signal,
    );
    expect(probe).not.toHaveBeenCalled();
  });
});
