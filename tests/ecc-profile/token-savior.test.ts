import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NormalizedHookEvent } from "../../src/ecc-profile/hook-core.js";
import {
  buildTokenSaviorAuditProjection,
  createFileTokenSaviorRetentionStore,
  createTokenSaviorCompactionAdapter,
  createTokenSaviorProcessCompactor,
  guardTokenSaviorAuditCall,
  TOKEN_SAVIOR_COMPACTOR_BRIDGE,
  TOKEN_SAVIOR_NATIVE_TRANSPORTS,
  TOKEN_SAVIOR_RUNTIME_PIN,
  TokenSaviorAuditMcpPolicyGuard,
  type TokenSaviorCompactResult,
} from "../../src/ecc-profile/token-savior.js";

const roots: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "aih-token-savior-"));
  roots.push(root);
  const project = join(root, "project");
  const state = join(root, "state");
  const transcripts = join(root, "transcripts");
  mkdirSync(project);
  mkdirSync(state);
  mkdirSync(transcripts);
  return { root, project, state, transcripts };
}

function event(client: "claude" | "codex", cwd: string): NormalizedHookEvent {
  return {
    version: 1,
    client,
    event: "after-tool",
    nativeEvent: "PostToolUse",
    sessionId: "session-1",
    transcriptPath: null,
    cwd,
    tool: {
      name: "Bash",
      id: "tool-1",
      input: { command: "git diff --stat" },
      response:
        client === "codex"
          ? "src/a.ts | 20 ++++++++++++++++++++\n20 insertions(+)"
          : {
              stdout: "src/a.ts | 20 ++++++++++++++++++++\n20 insertions(+)",
              stderr: "",
              interrupted: false,
              isImage: false,
            },
    },
  };
}

const originalText = "src/a.ts | 20 ++++++++++++++++++++\n20 insertions(+)";
const compactedText = "1 file changed; 20 insertions";
const compacted: TokenSaviorCompactResult = {
  text: compactedText,
  originalBytes: Buffer.byteLength(originalText),
  compactBytes: Buffer.byteLength(compactedText),
  savingsPercent: 100 * (1 - Buffer.byteLength(compactedText) / Buffer.byteLength(originalText)),
  originalText,
};

describe("Token Savior direct compaction adapter", () => {
  it("binds the exact reviewed package and source identity", () => {
    expect(TOKEN_SAVIOR_RUNTIME_PIN).toEqual({
      package: "token-savior-recall[mcp]==4.21.0",
      sourceCommit: "1e5984b452c5b98e6376a7250b3213f5c3500626",
      wheelSha256: "36529b132d658225ad6df7c9ec4ca0cbcf0fb48ebb0054099a0284c793fc9363",
      license: "MIT",
      import: "token_savior.compactors.compact",
    });
    expect(TOKEN_SAVIOR_COMPACTOR_BRIDGE).toContain("from token_savior.compactors import compact");
    expect(TOKEN_SAVIOR_COMPACTOR_BRIDGE).not.toMatch(/token-savior|--help|server|mcp/i);
  });

  it("rejects an unsafe or unbound Python runtime before creating the process compactor", () => {
    const { project, state } = fixture();
    const fakePython = join(state, process.platform === "win32" ? "python.exe" : "python");
    writeFileSync(fakePython, "not a runtime", { encoding: "utf8", mode: 0o700 });
    expect(() =>
      createTokenSaviorProcessCompactor({
        pythonCommand: "python",
        runtimeRoot: state,
        tempRoot: project,
        verifiedWheelSha256: TOKEN_SAVIOR_RUNTIME_PIN.wheelSha256,
      }),
    ).toThrow(/absolute/i);
    expect(() =>
      createTokenSaviorProcessCompactor({
        pythonCommand: join(state, "python.exe"),
        runtimeRoot: state,
        tempRoot: project,
        verifiedWheelSha256: "B".repeat(64),
      }),
    ).toThrow(/wheel/i);

    expect(() =>
      createTokenSaviorProcessCompactor({
        pythonCommand: fakePython,
        runtimeRoot: state,
        tempRoot: state,
        verifiedWheelSha256: TOKEN_SAVIOR_RUNTIME_PIN.wheelSha256,
      }),
    ).toThrow(/separate/i);
    expect(() =>
      createTokenSaviorProcessCompactor({
        pythonCommand: state,
        runtimeRoot: state,
        tempRoot: project,
        verifiedWheelSha256: TOKEN_SAVIOR_RUNTIME_PIN.wheelSha256,
      }),
    ).toThrow(/regular file/i);
    expect(() =>
      createTokenSaviorProcessCompactor({
        pythonCommand: join(state, "missing.exe"),
        runtimeRoot: state,
        tempRoot: project,
        verifiedWheelSha256: TOKEN_SAVIOR_RUNTIME_PIN.wheelSha256,
      }),
    ).toThrow(/exist/i);
    expect(() =>
      createTokenSaviorProcessCompactor({
        pythonCommand: process.execPath,
        runtimeRoot: state,
        tempRoot: project,
        verifiedWheelSha256: TOKEN_SAVIOR_RUNTIME_PIN.wheelSha256,
      }),
    ).toThrow(/runtime root/i);
  });

  it("bounds process input and fails closed when the verified runtime rejects the bridge", async () => {
    const { project, state } = fixture();
    const fakePython = join(state, process.platform === "win32" ? "python.exe" : "python");
    writeFileSync(fakePython, "not a runtime", { encoding: "utf8", mode: 0o700 });
    const compact = createTokenSaviorProcessCompactor({
      pythonCommand: fakePython,
      runtimeRoot: state,
      tempRoot: project,
      verifiedWheelSha256: TOKEN_SAVIOR_RUNTIME_PIN.wheelSha256,
    });
    await expect(
      compact(
        { command: "test", stdout: "x".repeat(1024 * 1024 + 16 * 1024), stderr: "" },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/input exceeds/i);
    await expect(
      compact(
        { command: "test", stdout: "ordinary output", stderr: "" },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/process (?:could not start|failed)/i);
    const asynchronouslyRejected = createTokenSaviorProcessCompactor({
      pythonCommand: process.execPath,
      runtimeRoot: dirname(process.execPath),
      tempRoot: project,
      verifiedWheelSha256: TOKEN_SAVIOR_RUNTIME_PIN.wheelSha256,
    });
    await expect(
      asynchronouslyRejected(
        { command: "test", stdout: "ordinary output", stderr: "" },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/process failed/i);
  });

  it.each(["claude", "codex"] as const)(
    "retains the full original before returning the reviewed %s pre-model transport",
    async (client) => {
      const { project, state } = fixture();
      const store = createFileTokenSaviorRetentionStore({
        stateRoot: state,
        canonicalWorktree: project,
        repositoryId: "github.com/example/project",
      });
      const adapter = createTokenSaviorCompactionAdapter({
        canonicalWorktree: project,
        repositoryId: "github.com/example/project",
        store,
        compact: vi.fn(async () => compacted),
        timeoutMs: 500,
        now: () => Date.UTC(2026, 7, 4, 12),
      });

      const result = await adapter.run(event(client, project));

      expect(result.status).toBe("compacted");
      expect(result.originalRetained).toBe(true);
      expect(result.modelOutput).toBe(compacted.text);
      expect(result.qualification).toEqual(TOKEN_SAVIOR_NATIVE_TRANSPORTS[client]);
      expect(result.nativeOutput).toEqual(
        client === "claude"
          ? {
              hookSpecificOutput: {
                hookEventName: "PostToolUse",
                updatedToolOutput: {
                  stdout: compacted.text,
                  stderr: "",
                  interrupted: false,
                  isImage: false,
                },
              },
            }
          : { decision: "block", reason: compacted.text },
      );
      const records = store.list();
      expect(records).toHaveLength(1);
      expect(records[0]?.originalText).toBe(compacted.originalText);
      expect(records[0]?.client).toBe(client);
      expect(records[0]?.sourcePin).toBe(TOKEN_SAVIOR_RUNTIME_PIN.sourceCommit);
      expect(records[0]?.wheelSha256).toBe(TOKEN_SAVIOR_RUNTIME_PIN.wheelSha256);
      expect(JSON.parse(readFileSync(records[0]?.evidencePath ?? "", "utf8"))).toMatchObject({
        originalText: compacted.originalText,
      });
      const beforeRepeat = readFileSync(records[0]?.evidencePath ?? "", "utf8");
      await expect(adapter.run(event(client, project))).resolves.toMatchObject({
        status: "compacted",
        originalRetained: true,
      });
      expect(store.list()).toHaveLength(1);
      expect(readFileSync(records[0]?.evidencePath ?? "", "utf8")).toBe(beforeRepeat);
    },
  );

  it("accepts the actual Codex string response shape and replaces only model-visible feedback", async () => {
    const { project, state } = fixture();
    const store = createFileTokenSaviorRetentionStore({
      stateRoot: state,
      canonicalWorktree: project,
      repositoryId: "github.com/example/project",
    });
    const native = event("codex", project);
    if (native.tool) {
      native.tool.name = "shell_command";
      native.tool.response = originalText;
    }

    const result = await createTokenSaviorCompactionAdapter({
      canonicalWorktree: project,
      repositoryId: "github.com/example/project",
      store,
      compact: async () => compacted,
      timeoutMs: 25,
    }).run(native);

    expect(result).toMatchObject({
      status: "compacted",
      transport: "codex-post-tool-block-feedback-experimental",
      modelOutput: compactedText,
      nativeOutput: { decision: "block", reason: compactedText },
      qualification: {
        qualifiedAtVersion: "0.145.0",
        status: "experimental-qualified",
        behavior: "blocked-result-feedback-replacement",
      },
    });
    expect(store.list()[0]?.originalText).toBe(originalText);
  });

  it("fails open to the original output on timeout, runner failure, malformed results, or no match", async () => {
    const { project, state } = fixture();
    const store = createFileTokenSaviorRetentionStore({
      stateRoot: state,
      canonicalWorktree: project,
      repositoryId: "github.com/example/project",
    });
    const original = event("claude", project).tool?.response;

    vi.useFakeTimers();
    const timed = createTokenSaviorCompactionAdapter({
      canonicalWorktree: project,
      repositoryId: "github.com/example/project",
      store,
      timeoutMs: 25,
      compact: (_input, signal) =>
        new Promise((resolve) => signal.addEventListener("abort", () => resolve(compacted))),
    }).run(event("claude", project));
    await vi.advanceTimersByTimeAsync(25);
    const timedResult = await timed;
    expect(timedResult).toMatchObject({
      status: "timed-out-open",
      modelOutput: original,
      originalRetained: false,
    });
    expect(timedResult.nativeOutput).toBeUndefined();
    vi.useRealTimers();

    for (const compact of [
      async () => {
        throw new Error("runner secret must not escape");
      },
      async () => ({ ...compacted, originalText: "different" }),
      async () => null,
    ]) {
      const result = await createTokenSaviorCompactionAdapter({
        canonicalWorktree: project,
        repositoryId: "github.com/example/project",
        store,
        timeoutMs: 25,
        compact,
      }).run(event("claude", project));
      expect(result.status).toMatch(/failed-open|no-match/);
      expect(result.modelOutput).toEqual(original);
      expect(JSON.stringify(result)).not.toContain("runner secret");
    }
  });

  it("fails open rather than compacting when full original evidence cannot be bounded", async () => {
    const { project, state } = fixture();
    const store = createFileTokenSaviorRetentionStore({
      stateRoot: state,
      canonicalWorktree: project,
      repositoryId: "github.com/example/project",
      maxOriginalBytes: 16,
    });
    const result = await createTokenSaviorCompactionAdapter({
      canonicalWorktree: project,
      repositoryId: "github.com/example/project",
      store,
      compact: async () => compacted,
      timeoutMs: 25,
    }).run(event("codex", project));
    expect(result).toMatchObject({ status: "retention-failed-open", originalRetained: false });
    expect(result.nativeOutput).toBeUndefined();
  });

  it("rejects foreign worktrees and non-shell or malformed output without invoking the runner", async () => {
    const { project, state, root } = fixture();
    const store = createFileTokenSaviorRetentionStore({
      stateRoot: state,
      canonicalWorktree: project,
      repositoryId: "github.com/example/project",
    });
    const compact = vi.fn(async () => compacted);
    const adapter = createTokenSaviorCompactionAdapter({
      canonicalWorktree: project,
      repositoryId: "github.com/example/project",
      store,
      compact,
      timeoutMs: 25,
    });
    await expect(adapter.run(event("claude", join(root, "other")))).resolves.toMatchObject({
      status: "ineligible",
    });
    const nonShell = event("claude", project);
    if (nonShell.tool) nonShell.tool.name = "Read";
    await expect(adapter.run(nonShell)).resolves.toMatchObject({ status: "ineligible" });
    const malformedClaude = event("claude", project);
    if (malformedClaude.tool) malformedClaude.tool.response = "unexpected-string";
    await expect(adapter.run(malformedClaude)).resolves.toMatchObject({ status: "ineligible" });
    expect(compact).not.toHaveBeenCalled();
  });

  it("fails closed on unsafe retention scope and malformed persisted evidence", async () => {
    const { project, state, root } = fixture();
    const missing = join(root, "missing");
    expect(() =>
      createFileTokenSaviorRetentionStore({
        stateRoot: missing,
        canonicalWorktree: project,
        repositoryId: "github.com/example/project",
      }),
    ).toThrow(/exist/i);
    const regularFile = join(root, "not-a-directory");
    writeFileSync(regularFile, "file", "utf8");
    expect(() =>
      createFileTokenSaviorRetentionStore({
        stateRoot: regularFile,
        canonicalWorktree: project,
        repositoryId: "github.com/example/project",
      }),
    ).toThrow(/real directory/i);
    expect(() =>
      createFileTokenSaviorRetentionStore({
        stateRoot: root,
        canonicalWorktree: project,
        repositoryId: "github.com/example/project",
      }),
    ).toThrow(/outside/i);
    expect(() =>
      createFileTokenSaviorRetentionStore({
        stateRoot: state,
        canonicalWorktree: project,
        repositoryId: "",
      }),
    ).toThrow(/identity/i);
    expect(() =>
      createFileTokenSaviorRetentionStore({
        stateRoot: state,
        canonicalWorktree: project,
        repositoryId: "unsafe\nidentity",
      }),
    ).toThrow(/unsafe/i);
    expect(() =>
      createFileTokenSaviorRetentionStore({
        stateRoot: state,
        canonicalWorktree: project,
        repositoryId: "github.com/example/project",
        maxOriginalBytes: 0,
      }),
    ).toThrow(/invalid/i);

    const store = createFileTokenSaviorRetentionStore({
      stateRoot: state,
      canonicalWorktree: project,
      repositoryId: "github.com/example/project",
    });
    await createTokenSaviorCompactionAdapter({
      canonicalWorktree: project,
      repositoryId: "github.com/example/project",
      store,
      compact: async () => compacted,
      timeoutMs: 25,
    }).run(event("claude", project));
    const retained = store.list()[0];
    const evidence = retained?.evidencePath ?? "";
    const body = readFileSync(evidence, "utf8");
    const copied = join(state, "token-savior", `${"f".repeat(64)}.json`);
    writeFileSync(copied, body, "utf8");
    expect(() => store.list()).toThrow(/content identity/i);
    rmSync(copied);
    if (!retained) throw new Error("retention fixture was not created");
    const { evidencePath: _evidencePath, ...input } = retained;
    expect(() => store.retain({ ...input, repositoryId: "github.com/other/project" })).toThrow(
      /store scope/i,
    );
    expect(() => store.retain({ ...input, originalSha256: "B".repeat(64) })).toThrow(/malformed/i);
    writeFileSync(evidence, "{malformed", "utf8");
    expect(() => store.list()).toThrow(/malformed/i);
    writeFileSync(join(state, "token-savior", "unexpected.txt"), "unexpected", "utf8");
    expect(() => store.list()).toThrow(/unexpected entry/i);
  });

  it("fails open on oversized output or an invalid retention clock", async () => {
    const { project, state } = fixture();
    const store = createFileTokenSaviorRetentionStore({
      stateRoot: state,
      canonicalWorktree: project,
      repositoryId: "github.com/example/project",
    });
    const oversized = event("codex", project);
    if (oversized.tool) oversized.tool.response = "x".repeat(1024 * 1024 + 1);
    await expect(
      createTokenSaviorCompactionAdapter({
        canonicalWorktree: project,
        repositoryId: "github.com/example/project",
        store,
        compact: async () => compacted,
        timeoutMs: 25,
      }).run(oversized),
    ).resolves.toMatchObject({ status: "failed-open" });
    await expect(
      createTokenSaviorCompactionAdapter({
        canonicalWorktree: project,
        repositoryId: "github.com/example/project",
        store,
        compact: async () => compacted,
        timeoutMs: 25,
        now: () => -1,
      }).run(event("claude", project)),
    ).resolves.toMatchObject({ status: "retention-failed-open" });
    expect(() =>
      createTokenSaviorCompactionAdapter({
        canonicalWorktree: project,
        repositoryId: "",
        store,
        compact: async () => compacted,
        timeoutMs: 25,
      }),
    ).toThrow(/identity/i);
  });
});

describe("optional Token Savior audit MCP", () => {
  it("is Claude-only, consent-bound, sanitized, unregistered, and hard-limited to ts_discover", () => {
    const { project, state, transcripts, root } = fixture();
    const wrapper = join(root, process.platform === "win32" ? "wrapper.exe" : "wrapper");
    const projection = buildTokenSaviorAuditProjection({
      client: "claude",
      enabled: true,
      explicitConsent: {
        id: "token-savior-audit-consent-2026-08-04",
        sha256: "a".repeat(64),
      },
      canonicalWorktree: project,
      stateRoot: state,
      transcriptRoot: transcripts,
      wrapperCommand: wrapper,
      wrapperSha256: "b".repeat(64),
    });

    expect(projection.activation).toBe("prepared-not-registered");
    expect(projection.client).toBe("claude");
    expect(projection.allowedTools).toEqual(["ts_discover"]);
    expect(projection.resources).toEqual([]);
    expect(isAbsolute(projection.command)).toBe(true);
    expect(projection.env).toMatchObject({
      TOKEN_SAVIOR_PROFILE: "compact-only",
      TS_MEMORY_DISABLE: "1",
      TS_RESOURCES_DISABLED: "1",
      TS_CAPTURE_DISABLED: "1",
      TOKEN_SAVIOR_DATA_DIR: state,
    });
    expect(JSON.stringify(projection.env)).not.toMatch(/ANTHROPIC|OPENAI|API_KEY|AUTH_TOKEN/);
    expect(() => guardTokenSaviorAuditCall("ts_discover", { since_days: 7 })).not.toThrow();
    expect(() => guardTokenSaviorAuditCall("ts_memory", {})).toThrow(/not allowed/i);
    expect(() => guardTokenSaviorAuditCall("resources/read", {})).toThrow(/not allowed/i);

    const guard = new TokenSaviorAuditMcpPolicyGuard();
    expect(
      guard.inspectClientRequest({ jsonrpc: "2.0", id: 1, method: "resources/list", params: {} }),
    ).toEqual({
      forward: false,
      response: { jsonrpc: "2.0", id: 1, result: { resources: [] } },
    });
    expect(
      guard.inspectClientRequest({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "memory_search", arguments: {} },
      }),
    ).toMatchObject({
      forward: false,
      response: { error: { code: -32601 } },
    });
    expect(
      guard.filterToolsList({ tools: [{ name: "ts_discover" }, { name: "memory_search" }] }),
    ).toEqual({ tools: [{ name: "ts_discover" }] });
    expect(() => guard.filterToolsList({ tools: [{ name: "memory_search" }] })).toThrow(
      /missing reviewed/i,
    );
    expect(() => guard.inspectClientRequest([])).toThrow(/malformed/i);
    expect(() =>
      guard.inspectClientRequest({ jsonrpc: "2.0", id: {}, method: "resources/list" }),
    ).toThrow(/request id/i);
    expect(() =>
      guard.inspectClientRequest({ jsonrpc: "2.0", id: 3, method: "tools/call", params: {} }),
    ).toThrow(/tools\/call/i);
    expect(() => guard.filterToolsList(null)).toThrow(/malformed/i);
    expect(() => guard.filterToolsList({ tools: [null] })).toThrow(/malformed tool/i);
    expect(() => guard.filterToolsList([{ name: "ts_discover" }, { name: "ts_discover" }])).toThrow(
      /malformed/i,
    );
    expect(() =>
      guard.filterToolsList({ tools: [{ name: "ts_discover" }, { name: "ts_discover" }] }),
    ).toThrow(/duplicate/i);
  });

  it("fails closed without consent, for Codex, or for unsafe roots and evidence", () => {
    const { project, state, transcripts, root } = fixture();
    const base = {
      client: "claude" as const,
      enabled: true,
      explicitConsent: { id: "consent", sha256: "a".repeat(64) },
      canonicalWorktree: project,
      stateRoot: state,
      transcriptRoot: transcripts,
      wrapperCommand: join(root, "wrapper.exe"),
      wrapperSha256: "b".repeat(64),
    };
    expect(() => buildTokenSaviorAuditProjection({ ...base, explicitConsent: undefined })).toThrow(
      /consent/i,
    );
    expect(() => buildTokenSaviorAuditProjection({ ...base, client: "codex" })).toThrow(/Claude/i);
    mkdirSync(join(project, ".claude"));
    expect(() =>
      buildTokenSaviorAuditProjection({ ...base, transcriptRoot: join(project, ".claude") }),
    ).toThrow(/outside/i);
    expect(() =>
      buildTokenSaviorAuditProjection({ ...base, wrapperSha256: "B".repeat(64) }),
    ).toThrow(/SHA-256/i);
    expect(() =>
      buildTokenSaviorAuditProjection({ ...base, wrapperCommand: join(project, "wrapper.exe") }),
    ).toThrow(/outside/i);
  });
});
