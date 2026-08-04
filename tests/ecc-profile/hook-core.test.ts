import { describe, expect, it, vi } from "vitest";
import {
  dispatchHookEvent,
  HOOK_INPUT_LIMITS,
  type HookHandler,
  type NormalizedHookEvent,
  normalizeClaudeHookInput,
  normalizeCodexHookInput,
  serializeHookDispatchResult,
} from "../../src/ecc-profile/hook-core.js";
import vectors from "../fixtures/ecc-profile/hook-vectors.json";

function comparable(event: NormalizedHookEvent) {
  const {
    client: _client,
    customInstructions: _customInstructions,
    compactSummary: _compactSummary,
    durationMs: _durationMs,
    nativeEvent: _nativeEvent,
    model: _model,
    turnId: _turnId,
    ...common
  } = event;
  return common;
}

describe("ECC hook input normalization", () => {
  it("binds shared vectors to the reviewed native references", () => {
    expect(vectors.sources).toEqual({
      claude: "https://code.claude.com/docs/en/hooks",
      codex: "https://learn.chatgpt.com/docs/hooks",
      reviewedOn: "2026-08-03",
    });
  });

  it("normalizes paired Claude and Codex shared vectors", () => {
    for (const vector of vectors.cases) {
      const claude = normalizeClaudeHookInput(vector.claude);
      const codex = normalizeCodexHookInput(vector.codex);
      expect(comparable(claude), vector.id).toEqual(vector.expected);
      expect(comparable(codex), vector.id).toEqual(vector.expected);
    }
  });

  it("preserves client-specific provenance without weakening the common contract", () => {
    const vector = vectors.cases[1];
    if (!vector) throw new Error("missing before-tool vector");
    expect(normalizeClaudeHookInput(vector.claude)).toMatchObject({
      client: "claude",
      nativeEvent: "PreToolUse",
    });
    expect(normalizeCodexHookInput(vector.codex)).toMatchObject({
      client: "codex",
      nativeEvent: "PreToolUse",
      model: "test-model",
      turnId: "turn-1",
    });
  });

  it("accepts current event-optional Codex common fields", () => {
    expect(
      normalizeCodexHookInput({
        session_id: "session-1",
        transcript_path: null,
        cwd: "C:/fixtures/project",
        hook_event_name: "SessionEnd",
        reason: "other",
      }),
    ).toEqual({
      version: 1,
      client: "codex",
      event: "session-end",
      nativeEvent: "SessionEnd",
      sessionId: "session-1",
      transcriptPath: null,
      cwd: "C:/fixtures/project",
      reason: "other",
    });
  });

  it("preserves reviewed Claude metadata used by later handlers", () => {
    expect(
      normalizeClaudeHookInput({
        session_id: "session-1",
        prompt_id: "prompt-1",
        transcript_path: "C:/fixtures/transcript.jsonl",
        cwd: "C:/fixtures/project",
        permission_mode: "default",
        effort: { level: "high" },
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_use_id: "tool-1",
        tool_input: { command: "npm test" },
        tool_response: { stdout: "ok" },
        duration_ms: 12,
      }),
    ).toMatchObject({
      promptId: "prompt-1",
      effortLevel: "high",
      durationMs: 12,
      tool: { response: { stdout: "ok" } },
    });
  });

  it("preserves empty manual compact instructions without coercion", () => {
    expect(
      normalizeClaudeHookInput({
        session_id: "session-1",
        transcript_path: "C:/fixtures/transcript.jsonl",
        cwd: "C:/fixtures/project",
        hook_event_name: "PreCompact",
        trigger: "manual",
        custom_instructions: "",
      }),
    ).toMatchObject({ customInstructions: "" });
  });

  it("normalizes reviewed Claude-only failure and notification events", () => {
    expect(
      normalizeClaudeHookInput({
        session_id: "session-1",
        transcript_path: "C:/fixtures/transcript.jsonl",
        cwd: "C:/fixtures/project",
        permission_mode: "default",
        hook_event_name: "PostToolUseFailure",
        tool_name: "Bash",
        tool_use_id: "tool-1",
        tool_input: { command: "npm test" },
        error: "command failed",
        is_interrupt: false,
        duration_ms: 12,
      }),
    ).toMatchObject({
      event: "tool-failure",
      tool: { name: "Bash", id: "tool-1", error: "command failed" },
      durationMs: 12,
    });
    expect(
      normalizeClaudeHookInput({
        session_id: "session-1",
        transcript_path: "C:/fixtures/transcript.jsonl",
        cwd: "C:/fixtures/project",
        hook_event_name: "Notification",
        message: "Permission needed",
        title: "Claude Code",
        notification_type: "permission_prompt",
      }),
    ).toMatchObject({
      event: "notification",
      notification: {
        message: "Permission needed",
        title: "Claude Code",
        type: "permission_prompt",
      },
    });
  });

  it.each([
    ["unknown event", { ...vectors.cases[0]?.claude, hook_event_name: "FutureEvent" }],
    ["relative cwd", { ...vectors.cases[0]?.claude, cwd: "relative/project" }],
    ["Windows ADS cwd", { ...vectors.cases[0]?.claude, cwd: "C:/fixtures/project:file" }],
    [
      "unknown permission mode",
      { ...vectors.cases[0]?.claude, permission_mode: "future-unreviewed-mode" },
    ],
    [
      "unknown effort level",
      { ...vectors.cases[1]?.claude, effort: { level: "future-unreviewed-level" } },
    ],
    [
      "negative tool duration",
      {
        ...vectors.cases.find((vector) => vector.id === "after-tool")?.claude,
        duration_ms: -1,
      },
    ],
    [
      "unknown session-end reason",
      {
        ...vectors.cases.find((vector) => vector.id === "session-end")?.claude,
        reason: "future-unreviewed-reason",
      },
    ],
    [
      "relative agent transcript",
      {
        ...vectors.cases.find((vector) => vector.id === "agent-stop")?.claude,
        agent_transcript_path: "relative/agent.jsonl",
      },
    ],
    [
      "non-boolean stop state",
      {
        ...vectors.cases.find((vector) => vector.id === "stop")?.claude,
        stop_hook_active: "false",
      },
    ],
    ["unknown top-level field", { ...vectors.cases[0]?.claude, invented: true }],
    [
      "dangerous nested key",
      {
        ...vectors.cases[1]?.claude,
        tool_input: JSON.parse('{"constructor":{"prototype":{"polluted":true}}}'),
      },
    ],
  ])("rejects %s", (_label, input) => {
    expect(() => normalizeClaudeHookInput(input)).toThrow();
  });

  it("rejects an oversized payload before schema derivation", () => {
    const vector = vectors.cases[3];
    if (!vector) throw new Error("missing prompt vector");
    expect(() =>
      normalizeCodexHookInput({
        ...vector.codex,
        prompt: "x".repeat(HOOK_INPUT_LIMITS.maxBytes + 1),
      }),
    ).toThrow(/limit/i);
  });

  it("requires native correlation identifiers for turn and tool events", () => {
    const vector = vectors.cases[1];
    if (!vector) throw new Error("missing before-tool vector");
    const { turn_id: _turnId, ...codexWithoutTurn } = vector.codex;
    const { tool_use_id: _toolUseId, ...claudeWithoutTool } = vector.claude;
    expect(() => normalizeCodexHookInput(codexWithoutTurn)).toThrow(/turn_id/);
    expect(() => normalizeClaudeHookInput(claudeWithoutTool)).toThrow(/tool_use_id/);
  });

  it("requires event-owned agent and compact fields", () => {
    const agentStart = vectors.cases.find((vector) => vector.id === "agent-start");
    const beforeCompact = vectors.cases.find((vector) => vector.id === "before-compact");
    const afterCompact = vectors.cases.find((vector) => vector.id === "after-compact");
    if (!agentStart || !beforeCompact || !afterCompact) throw new Error("missing hook vector");
    const { agent_id: _agentId, ...withoutAgentId } = agentStart.claude;
    const { custom_instructions: _instructions, ...withoutInstructions } = beforeCompact.claude;
    const { compact_summary: _summary, ...withoutSummary } = afterCompact.claude;
    expect(() => normalizeClaudeHookInput(withoutAgentId)).toThrow(/agent_id/);
    expect(() => normalizeClaudeHookInput(withoutInstructions)).toThrow(/custom_instructions/);
    expect(() => normalizeClaudeHookInput(withoutSummary)).toThrow(/compact_summary/);
  });

  it("fails closed on malformed optional fields and bounded JSON structure", () => {
    const beforeTool = vectors.cases.find((vector) => vector.id === "before-tool")?.claude;
    const afterTool = vectors.cases.find((vector) => vector.id === "after-tool")?.claude;
    const toolFailure = {
      session_id: "session-1",
      transcript_path: "C:/fixtures/transcript.jsonl",
      cwd: "C:/fixtures/project",
      hook_event_name: "PostToolUseFailure",
      tool_name: "Bash",
      tool_use_id: "tool-1",
      tool_input: { command: "npm test" },
      error: "failed",
    };
    const agentStop = vectors.cases.find((vector) => vector.id === "agent-stop")?.claude;
    if (!beforeTool || !afterTool || !agentStop) throw new Error("missing hook vector");

    const malformed = [
      { ...beforeTool, prompt_id: null },
      { ...beforeTool, cwd: "C:/fixtures/CON/project" },
      { ...beforeTool, transcript_path: "relative/transcript.jsonl" },
      { ...beforeTool, effort: { level: "high", extra: true } },
      { ...beforeTool, tool_input: undefined },
      { ...afterTool, tool_response: undefined },
      { ...toolFailure, is_interrupt: "false" },
      { ...agentStop, agent_transcript_path: undefined },
      new Date(),
    ];
    for (const input of malformed) expect(() => normalizeClaudeHookInput(input)).toThrow();

    const tooDeep: Record<string, unknown> = {};
    let cursor = tooDeep;
    for (let depth = 0; depth <= HOOK_INPUT_LIMITS.maxDepth; depth += 1) {
      cursor.child = {};
      cursor = cursor.child as Record<string, unknown>;
    }
    expect(() => normalizeClaudeHookInput(tooDeep)).toThrow(/depth limit/i);

    const tooManyNodes = Array.from({ length: HOOK_INPUT_LIMITS.maxNodes }, () => null);
    expect(() => normalizeClaudeHookInput({ nodes: tooManyNodes })).toThrow(/node limit/i);
    expect(() => normalizeClaudeHookInput([])).toThrow(/object/i);
  });
});

describe("ECC composite hook dispatcher", () => {
  const event = normalizeCodexHookInput(vectors.cases[1]?.codex);
  const noDataPolicy = {
    redactionPolicy: "none",
    storagePolicy: "none",
  } as const;

  it("runs matching handlers in explicit order and returns byte-stable receipts", async () => {
    const calls: string[] = [];
    const handlers: HookHandler[] = [
      {
        id: "second",
        events: ["before-tool"],
        enabled: true,
        order: 20,
        timeoutMs: 1_000,
        failurePolicy: "open",
        ...noDataPolicy,
        run: () => {
          calls.push("second");
          return { action: "continue", context: "second context" };
        },
      },
      {
        id: "first",
        events: ["before-tool"],
        enabled: true,
        order: 10,
        timeoutMs: 1_000,
        failurePolicy: "closed",
        ...noDataPolicy,
        run: () => {
          calls.push("first");
          return { action: "continue", context: "first context" };
        },
      },
    ];

    const first = await dispatchHookEvent(event, handlers);
    const second = await dispatchHookEvent(event, handlers);
    expect(calls).toEqual(["first", "second", "first", "second"]);
    expect(first).toEqual({
      action: "continue",
      contexts: ["first context", "second context"],
      receipts: [
        { handlerId: "first", status: "continued", failurePolicy: "closed" },
        { handlerId: "second", status: "continued", failurePolicy: "open" },
      ],
    });
    expect(serializeHookDispatchResult(first)).toBe(serializeHookDispatchResult(second));
    expect(JSON.parse(serializeHookDispatchResult(first))).toEqual(first);
    expect(serializeHookDispatchResult(first)).toMatch(/\n$/);
  });

  it("keeps disabled and non-matching handlers explicit without running them", async () => {
    const run = vi.fn();
    const result = await dispatchHookEvent(event, [
      {
        id: "disabled",
        events: ["before-tool"],
        enabled: false,
        order: 10,
        timeoutMs: 100,
        failurePolicy: "open",
        ...noDataPolicy,
        run,
      },
      {
        id: "different-event",
        events: ["session-start"],
        enabled: true,
        order: 20,
        timeoutMs: 100,
        failurePolicy: "open",
        ...noDataPolicy,
        run,
      },
    ]);
    expect(run).not.toHaveBeenCalled();
    expect(result.receipts).toEqual([
      { handlerId: "disabled", status: "disabled", failurePolicy: "open" },
      { handlerId: "different-event", status: "not-matched", failurePolicy: "open" },
    ]);
  });

  it("rejects a fabricated normalized event whose native identity conflicts", async () => {
    await expect(dispatchHookEvent({ ...event, event: "session-start" }, [])).rejects.toThrow(
      /identity/i,
    );
  });

  it("rejects a fabricated normalized event missing event-specific content", async () => {
    const { tool: _tool, ...missingTool } = event;
    await expect(dispatchHookEvent(missingTool as NormalizedHookEvent, [])).rejects.toThrow(
      /tool/i,
    );
  });

  it("rejects contradictory normalized fields before handler execution", async () => {
    const afterTool = normalizeClaudeHookInput(
      vectors.cases.find((vector) => vector.id === "after-tool")?.claude,
    );
    const toolFailure = normalizeClaudeHookInput({
      session_id: "session-1",
      transcript_path: "C:/fixtures/transcript.jsonl",
      cwd: "C:/fixtures/project",
      hook_event_name: "PostToolUseFailure",
      tool_name: "Bash",
      tool_use_id: "tool-1",
      tool_input: { command: "npm test" },
      error: "failed",
    });
    const malformed = [
      { ...event, invented: true },
      { ...event, version: 2 },
      { ...event, cwd: "relative/project" },
      { ...event, transcriptPath: "relative/transcript.jsonl" },
      { ...event, permissionMode: "future-mode" },
      { ...event, turnId: undefined },
      { ...event, tool: { ...event.tool, invented: true } },
      { ...event, tool: { name: "Shell", id: "tool-1" } },
      { ...afterTool, tool: { ...afterTool.tool, response: undefined } },
      { ...toolFailure, tool: { ...toolFailure.tool, error: undefined } },
    ];
    for (const input of malformed) {
      await expect(dispatchHookEvent(input as NormalizedHookEvent, [])).rejects.toThrow();
    }
  });

  it("fails open or closed according to each handler's reviewed policy", async () => {
    const result = await dispatchHookEvent(event, [
      {
        id: "advisory",
        events: ["before-tool"],
        enabled: true,
        order: 10,
        timeoutMs: 100,
        failurePolicy: "open",
        ...noDataPolicy,
        run: () => {
          throw new Error("secret detail");
        },
      },
      {
        id: "guardrail",
        events: ["before-tool"],
        enabled: true,
        order: 20,
        timeoutMs: 100,
        failurePolicy: "closed",
        ...noDataPolicy,
        run: () => {
          throw new Error("another secret detail");
        },
      },
    ]);
    expect(result).toEqual({
      action: "block",
      reason: "Hook handler guardrail failed closed.",
      contexts: [],
      receipts: [
        { handlerId: "advisory", status: "failed-open", failurePolicy: "open" },
        { handlerId: "guardrail", status: "failed-closed", failurePolicy: "closed" },
      ],
    });
    expect(JSON.stringify(result)).not.toContain("secret detail");
  });

  it("applies failure policy to malformed handler decisions", async () => {
    const result = await dispatchHookEvent(event, [
      {
        id: "malformed-advisory",
        events: ["before-tool"],
        enabled: true,
        order: 10,
        timeoutMs: 100,
        failurePolicy: "open",
        ...noDataPolicy,
        run: () => ({ action: "invented" }) as unknown as { action: "continue" },
      },
      {
        id: "malformed-guardrail",
        events: ["before-tool"],
        enabled: true,
        order: 20,
        timeoutMs: 100,
        failurePolicy: "closed",
        ...noDataPolicy,
        run: () => ({ action: "invented" }) as unknown as { action: "continue" },
      },
    ]);
    expect(result).toMatchObject({
      action: "block",
      reason: "Hook handler malformed-guardrail failed closed.",
      receipts: [
        { handlerId: "malformed-advisory", status: "failed-open" },
        { handlerId: "malformed-guardrail", status: "failed-closed" },
      ],
    });
  });

  it("isolates later handlers from mutation attempts", async () => {
    let observedCommand: unknown;
    const result = await dispatchHookEvent(event, [
      {
        id: "mutation-attempt",
        events: ["before-tool"],
        enabled: true,
        order: 10,
        timeoutMs: 100,
        failurePolicy: "open",
        ...noDataPolicy,
        run: (received) => {
          const input = received.tool?.input as { command?: string };
          input.command = "invented command";
          return { action: "continue" };
        },
      },
      {
        id: "observer",
        events: ["before-tool"],
        enabled: true,
        order: 20,
        timeoutMs: 100,
        failurePolicy: "open",
        ...noDataPolicy,
        run: (received) => {
          if (!received.tool) throw new Error("expected tool event");
          observedCommand = (received.tool.input as { command?: string }).command;
          return { action: "continue" };
        },
      },
    ]);
    expect(observedCommand).toBe("npm test");
    expect(result.receipts[0]).toMatchObject({ status: "failed-open" });
  });

  it("snapshots handler configuration before execution", async () => {
    const second = {
      id: "stable-second",
      events: ["before-tool"] as const,
      enabled: true,
      order: 20,
      timeoutMs: 100,
      failurePolicy: "open" as const,
      ...noDataPolicy,
      run: vi.fn(() => ({ action: "continue" as const })),
    };
    const first: HookHandler = {
      id: "mutating-first",
      events: ["before-tool"],
      enabled: true,
      order: 10,
      timeoutMs: 100,
      failurePolicy: "open",
      ...noDataPolicy,
      run: () => {
        second.enabled = false;
        return { action: "continue" };
      },
    };
    const result = await dispatchHookEvent(event, [first, second]);
    expect(second.run).toHaveBeenCalledOnce();
    expect(result.receipts.map((receipt) => receipt.status)).toEqual(["continued", "continued"]);
  });

  it("bounds a handler timeout and aborts its signal", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const pending = dispatchHookEvent(event, [
      {
        id: "bounded",
        events: ["before-tool"],
        enabled: true,
        order: 10,
        timeoutMs: 25,
        failurePolicy: "open",
        ...noDataPolicy,
        run: (_event, receivedSignal) => {
          signal = receivedSignal;
          return new Promise(() => undefined);
        },
      },
    ]);
    await vi.advanceTimersByTimeAsync(25);
    await expect(pending).resolves.toMatchObject({
      action: "continue",
      receipts: [{ handlerId: "bounded", status: "timed-out-open", failurePolicy: "open" }],
    });
    expect(signal?.aborted).toBe(true);
    vi.useRealTimers();
  });

  it("rejects excessive handler counts and cumulative timeout budgets", async () => {
    const handler = (index: number, timeoutMs = 1): HookHandler => ({
      id: `bounded-${index}`,
      events: ["before-tool"],
      enabled: true,
      order: index,
      timeoutMs,
      failurePolicy: "open",
      ...noDataPolicy,
      run: () => ({ action: "continue" }),
    });
    const tooMany = Array.from({ length: HOOK_INPUT_LIMITS.maxHandlers + 1 }, (_, index) =>
      handler(index),
    );
    await expect(dispatchHookEvent(event, tooMany)).rejects.toThrow(/handler count/i);
    await expect(
      dispatchHookEvent(event, [handler(1, 30_000), handler(2, 30_000), handler(3, 1)]),
    ).rejects.toThrow(/timeout budget/i);
  });

  it("applies failure policy when aggregate context exceeds its bound", async () => {
    const result = await dispatchHookEvent(
      event,
      [10, 20, 30].map((order) => ({
        id: `context-${order}`,
        events: ["before-tool"] as const,
        enabled: true,
        order,
        timeoutMs: 100,
        failurePolicy: "open" as const,
        ...noDataPolicy,
        run: () => ({ action: "continue" as const, context: "x".repeat(4_096) }),
      })),
    );
    expect(result.contexts).toHaveLength(2);
    expect(result.receipts.map((receipt) => receipt.status)).toEqual([
      "continued",
      "continued",
      "failed-open",
    ]);
  });

  it.each([
    [
      "duplicate handler id",
      [
        { id: "same", order: 10 },
        { id: "same", order: 20 },
      ],
    ],
    [
      "duplicate order",
      [
        { id: "one", order: 10 },
        { id: "two", order: 10 },
      ],
    ],
    ["unsafe handler id", [{ id: "../escape", order: 10 }]],
    ["unbounded timeout", [{ id: "slow", order: 10, timeoutMs: 60_000 }]],
  ])("rejects ambiguous handler configuration: %s", async (_label, variants) => {
    const handlers: HookHandler[] = variants.map((variant) => ({
      events: ["before-tool"],
      enabled: true,
      timeoutMs: 100,
      failurePolicy: "open",
      ...noDataPolicy,
      run: () => ({ action: "continue" }),
      ...variant,
    }));
    await expect(dispatchHookEvent(event, handlers)).rejects.toThrow();
  });

  it("rejects incomplete or ambiguous handler contracts", async () => {
    const base: HookHandler = {
      id: "reviewed",
      events: ["before-tool"],
      enabled: true,
      order: 10,
      timeoutMs: 100,
      failurePolicy: "open",
      ...noDataPolicy,
      run: () => ({ action: "continue" }),
    };
    const malformed = [
      { ...base, events: [] },
      { ...base, events: ["before-tool", "before-tool"] },
      { ...base, events: ["future-event"] },
      { ...base, enabled: "yes" },
      { ...base, run: null },
    ];
    for (const handler of malformed) {
      await expect(dispatchHookEvent(event, [handler as unknown as HookHandler])).rejects.toThrow();
    }
  });

  it("rejects a handler block on an informational event", async () => {
    const sessionEvent = normalizeClaudeHookInput(vectors.cases[0]?.claude);
    await expect(
      dispatchHookEvent(sessionEvent, [
        {
          id: "invalid-block",
          events: ["session-start"],
          enabled: true,
          order: 10,
          timeoutMs: 100,
          failurePolicy: "open",
          ...noDataPolicy,
          run: () => ({ action: "block", reason: "not allowed" }),
        },
      ]),
    ).rejects.toThrow(/cannot block/i);
  });

  it("permits a reviewed block on common compact and agent-stop boundaries", async () => {
    const blockableEvents = [
      normalizeCodexHookInput({
        session_id: "session-1",
        transcript_path: "C:/fixtures/transcript.jsonl",
        cwd: "C:/fixtures/project",
        hook_event_name: "PreCompact",
        model: "test-model",
        turn_id: "turn-1",
        trigger: "auto",
      }),
      normalizeCodexHookInput({
        session_id: "session-1",
        transcript_path: "C:/fixtures/transcript.jsonl",
        cwd: "C:/fixtures/project",
        permission_mode: "default",
        hook_event_name: "SubagentStop",
        model: "test-model",
        turn_id: "turn-1",
        agent_id: "agent-1",
        agent_type: "reviewer",
        agent_transcript_path: null,
        stop_hook_active: false,
        last_assistant_message: null,
      }),
    ];
    for (const blockableEvent of blockableEvents) {
      const result = await dispatchHookEvent(blockableEvent, [
        {
          id: `block-${blockableEvent.event}`,
          events: [blockableEvent.event],
          enabled: true,
          order: 10,
          timeoutMs: 100,
          failurePolicy: "closed",
          ...noDataPolicy,
          run: () => ({ action: "block", reason: "Finish the required state write." }),
        },
      ]);
      expect(result.action).toBe("block");
    }
  });

  it("rejects fail-closed policy on a native informational event", async () => {
    await expect(
      dispatchHookEvent(event, [
        {
          id: "false-enforcement",
          events: ["session-end"],
          enabled: true,
          order: 10,
          timeoutMs: 100,
          failurePolicy: "closed",
          ...noDataPolicy,
          run: () => ({ action: "continue" }),
        },
      ]),
    ).rejects.toThrow(/fail closed/i);
  });

  it("requires explicit redaction and storage policy for every handler", async () => {
    const missingDataPolicy = {
      id: "missing-data-policy",
      events: ["before-tool"],
      enabled: true,
      order: 10,
      timeoutMs: 100,
      failurePolicy: "open",
      run: () => ({ action: "continue" as const }),
    } as unknown as HookHandler;
    await expect(dispatchHookEvent(event, [missingDataPolicy])).rejects.toThrow(/data policy/i);
  });

  it("rejects persisted handler data without reviewed redaction", async () => {
    const unsafePersistence = {
      id: "unsafe-persistence",
      events: ["before-tool"],
      enabled: true,
      order: 10,
      timeoutMs: 100,
      failurePolicy: "open",
      redactionPolicy: "none",
      storagePolicy: "aih-state",
      run: () => ({ action: "continue" as const }),
    } as HookHandler;
    await expect(dispatchHookEvent(event, [unsafePersistence])).rejects.toThrow(/redaction/i);
  });
});
