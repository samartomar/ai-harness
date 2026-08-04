import { isAbsolute, win32 } from "node:path";

export const HOOK_INPUT_LIMITS = {
  maxBytes: 1024 * 1024,
  maxDepth: 32,
  maxNodes: 10_000,
  maxHandlers: 64,
  maxHandlerTimeoutMs: 30_000,
  maxAggregateTimeoutMs: 60_000,
  maxDiagnosticBytes: 4_096,
  maxAggregateContextBytes: 8_192,
} as const;

export type HookClient = "claude" | "codex";
export type LogicalHookEvent =
  | "session-start"
  | "session-end"
  | "before-tool"
  | "permission-request"
  | "after-tool"
  | "tool-failure"
  | "before-compact"
  | "after-compact"
  | "user-prompt"
  | "agent-start"
  | "agent-stop"
  | "notification"
  | "stop";

type JsonPrimitive = boolean | number | string | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export interface NormalizedHookEvent {
  version: 1;
  client: HookClient;
  event: LogicalHookEvent;
  nativeEvent: string;
  sessionId: string;
  transcriptPath: string | null;
  cwd: string;
  permissionMode?: string;
  model?: string;
  turnId?: string;
  promptId?: string;
  effortLevel?: "low" | "medium" | "high" | "xhigh" | "max";
  tool?: {
    name: string;
    id?: string;
    input: JsonValue;
    response?: JsonValue;
    error?: string;
    interrupted?: boolean;
  };
  prompt?: string;
  trigger?: "auto" | "manual";
  customInstructions?: string;
  compactSummary?: string;
  source?: "startup" | "resume" | "clear" | "compact";
  reason?: string;
  durationMs?: number;
  stopHookActive?: boolean;
  lastAssistantMessage?: string | null;
  agent?: { id?: string; type?: string; transcriptPath?: string | null };
  notification?: { message: string; title?: string; type?: string };
}

export interface HookHandlerDecision {
  action: "continue" | "block";
  context?: string;
  reason?: string;
}

export interface HookHandler {
  id: string;
  events: readonly LogicalHookEvent[];
  enabled: boolean;
  order: number;
  timeoutMs: number;
  failurePolicy: "open" | "closed";
  redactionPolicy: "none" | "sensitive-values";
  storagePolicy: "none" | "ephemeral" | "aih-state";
  run: (
    event: Readonly<NormalizedHookEvent>,
    signal: AbortSignal,
  ) => HookHandlerDecision | Promise<HookHandlerDecision>;
}

export type HookHandlerStatus =
  | "disabled"
  | "not-matched"
  | "continued"
  | "blocked"
  | "failed-open"
  | "failed-closed"
  | "timed-out-open"
  | "timed-out-closed";

export interface HookHandlerReceipt {
  handlerId: string;
  status: HookHandlerStatus;
  failurePolicy: "open" | "closed";
}

export interface HookDispatchResult {
  action: "continue" | "block";
  reason?: string;
  contexts: string[];
  receipts: HookHandlerReceipt[];
}

const EVENT_MAP: Record<string, LogicalHookEvent> = {
  SessionStart: "session-start",
  SessionEnd: "session-end",
  PreToolUse: "before-tool",
  PermissionRequest: "permission-request",
  PostToolUse: "after-tool",
  PostToolUseFailure: "tool-failure",
  PreCompact: "before-compact",
  PostCompact: "after-compact",
  UserPromptSubmit: "user-prompt",
  SubagentStart: "agent-start",
  SubagentStop: "agent-stop",
  Notification: "notification",
  Stop: "stop",
};

const CLIENT_EVENTS: Record<HookClient, ReadonlySet<string>> = {
  claude: new Set(Object.keys(EVENT_MAP)),
  codex: new Set([
    "SessionStart",
    "SessionEnd",
    "PreToolUse",
    "PermissionRequest",
    "PostToolUse",
    "PreCompact",
    "PostCompact",
    "UserPromptSubmit",
    "SubagentStart",
    "SubagentStop",
    "Stop",
  ]),
};
const PERMISSION_MODES: Record<HookClient, ReadonlySet<string>> = {
  claude: new Set(["default", "plan", "acceptEdits", "auto", "dontAsk", "bypassPermissions"]),
  codex: new Set(["default", "plan", "acceptEdits", "dontAsk", "bypassPermissions"]),
};
const SESSION_END_REASONS: Record<HookClient, ReadonlySet<string>> = {
  claude: new Set([
    "clear",
    "resume",
    "logout",
    "prompt_input_exit",
    "bypass_permissions_disabled",
    "other",
  ]),
  codex: new Set(["other"]),
};

const COMMON_FIELDS = new Set([
  "session_id",
  "transcript_path",
  "cwd",
  "permission_mode",
  "hook_event_name",
]);
const CLIENT_FIELDS: Record<HookClient, ReadonlySet<string>> = {
  claude: new Set(["prompt_id", "effort", "agent_id", "agent_type"]),
  codex: new Set(["model", "turn_id"]),
};
const EVENT_FIELDS: Record<string, ReadonlySet<string>> = {
  SessionStart: new Set(["source", "model"]),
  SessionEnd: new Set(["reason"]),
  PreToolUse: new Set(["tool_name", "tool_use_id", "tool_input"]),
  PermissionRequest: new Set(["tool_name", "tool_use_id", "tool_input", "permission_suggestions"]),
  PostToolUse: new Set(["tool_name", "tool_use_id", "tool_input", "tool_response", "duration_ms"]),
  PostToolUseFailure: new Set([
    "tool_name",
    "tool_use_id",
    "tool_input",
    "error",
    "is_interrupt",
    "duration_ms",
  ]),
  PreCompact: new Set(["trigger", "custom_instructions"]),
  PostCompact: new Set(["trigger", "compact_summary"]),
  UserPromptSubmit: new Set(["prompt"]),
  SubagentStart: new Set(["agent_id", "agent_type"]),
  SubagentStop: new Set([
    "agent_id",
    "agent_type",
    "agent_transcript_path",
    "stop_hook_active",
    "last_assistant_message",
    "background_tasks",
  ]),
  Notification: new Set(["message", "title", "notification_type"]),
  Stop: new Set([
    "stop_hook_active",
    "last_assistant_message",
    "background_tasks",
    "session_crons",
  ]),
};

const TOOL_EVENTS = new Set([
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PostToolUseFailure",
]);
const BLOCKABLE_EVENTS = new Set<LogicalHookEvent>([
  "before-tool",
  "permission-request",
  "before-compact",
  "user-prompt",
  "agent-stop",
  "stop",
]);
const HANDLER_ID = /^[a-z][a-z0-9-]{0,63}$/;
const DANGEROUS_JSON_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const CODEX_TURN_EVENTS = new Set([
  "SubagentStart",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
  "PreCompact",
  "PostCompact",
  "UserPromptSubmit",
  "SubagentStop",
  "Stop",
]);
const NORMALIZED_FIELDS = new Set([
  "version",
  "client",
  "event",
  "nativeEvent",
  "sessionId",
  "transcriptPath",
  "cwd",
  "permissionMode",
  "model",
  "turnId",
  "promptId",
  "effortLevel",
  "tool",
  "prompt",
  "trigger",
  "customInstructions",
  "compactSummary",
  "source",
  "reason",
  "durationMs",
  "stopHookActive",
  "lastAssistantMessage",
  "agent",
  "notification",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertJsonValue(
  value: unknown,
  state: { nodes: number },
  depth = 0,
): asserts value is JsonValue {
  state.nodes += 1;
  if (state.nodes > HOOK_INPUT_LIMITS.maxNodes) throw new Error("hook input node limit exceeded");
  if (depth > HOOK_INPUT_LIMITS.maxDepth) throw new Error("hook input depth limit exceeded");
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (Array.isArray(value)) {
    for (const item of value) assertJsonValue(item, state, depth + 1);
    return;
  }
  if (!isPlainObject(value)) throw new Error("hook input must contain only JSON values");
  for (const [key, child] of Object.entries(value)) {
    if (DANGEROUS_JSON_KEYS.has(key)) throw new Error("hook input contains a dangerous key");
    assertJsonValue(child, state, depth + 1);
  }
}

function assertBoundedJson(input: unknown): asserts input is Record<string, unknown> {
  assertJsonValue(input, { nodes: 0 });
  if (!isPlainObject(input)) throw new Error("hook input must be an object");
  const bytes = Buffer.byteLength(JSON.stringify(input), "utf8");
  if (bytes > HOOK_INPUT_LIMITS.maxBytes) throw new Error("hook input byte limit exceeded");
}

function requiredString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new Error(`hook input ${key} must be a non-empty safe string`);
  }
  return value;
}

function optionalString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new Error(`hook input ${key} must be a non-empty safe string when present`);
  }
  return value;
}

function optionalStringAllowEmpty(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.includes("\0")) {
    throw new Error(`hook input ${key} must be a safe string when present`);
  }
  return value;
}

function optionalNullableString(
  input: Record<string, unknown>,
  key: string,
): string | null | undefined {
  if (input[key] === null) return null;
  return optionalStringAllowEmpty(input, key);
}

function portableAbsolutePath(value: string): boolean {
  if (value.includes("\0")) return false;
  if (!isAbsolute(value) && !win32.isAbsolute(value)) return false;
  const windowsStyle = /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith("\\\\");
  const body = windowsStyle && /^[a-zA-Z]:/.test(value) ? value.slice(2) : value;
  if (windowsStyle && body.includes(":")) return false;
  const segments = value.split(/[\\/]/).filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === "..")) return false;
  if (
    windowsStyle &&
    segments.some(
      (segment) => WINDOWS_RESERVED.test(segment) || segment.endsWith(".") || segment.endsWith(" "),
    )
  )
    return false;
  return true;
}

function requiredAbsolutePath(input: Record<string, unknown>, key: string): string {
  const value = requiredString(input, key);
  if (!portableAbsolutePath(value)) throw new Error(`hook input ${key} must be absolute`);
  return value;
}

function transcriptPath(input: Record<string, unknown>): string | null {
  const value = input.transcript_path;
  if (value === null) return null;
  if (typeof value !== "string" || !portableAbsolutePath(value) || value.includes("\0")) {
    throw new Error("hook input transcript_path must be null or an absolute path");
  }
  return value;
}

function assertAllowedFields(
  client: HookClient,
  nativeEvent: string,
  input: Record<string, unknown>,
): void {
  const eventFields = EVENT_FIELDS[nativeEvent];
  if (!eventFields) throw new Error(`unsupported ${client} hook event: ${nativeEvent}`);
  for (const key of Object.keys(input)) {
    if (!COMMON_FIELDS.has(key) && !CLIENT_FIELDS[client].has(key) && !eventFields.has(key)) {
      throw new Error(`unsupported ${client} ${nativeEvent} hook field: ${key}`);
    }
  }
}

function requireEnum<T extends string>(
  input: Record<string, unknown>,
  key: string,
  values: readonly T[],
): T {
  const value = requiredString(input, key);
  if (!values.includes(value as T)) throw new Error(`hook input ${key} is unsupported`);
  return value as T;
}

function normalizeHookInput(client: HookClient, raw: unknown): NormalizedHookEvent {
  assertBoundedJson(raw);
  const nativeEvent = requiredString(raw, "hook_event_name");
  if (!CLIENT_EVENTS[client].has(nativeEvent)) {
    throw new Error(`unsupported ${client} hook event: ${nativeEvent}`);
  }
  assertAllowedFields(client, nativeEvent, raw);
  const event = EVENT_MAP[nativeEvent];
  if (!event) throw new Error(`unsupported ${client} hook event: ${nativeEvent}`);

  const normalized: NormalizedHookEvent = {
    version: 1,
    client,
    event,
    nativeEvent,
    sessionId: requiredString(raw, "session_id"),
    transcriptPath: transcriptPath(raw),
    cwd: requiredAbsolutePath(raw, "cwd"),
  };

  const permissionMode = optionalString(raw, "permission_mode");
  const model = optionalString(raw, "model");
  const turnId = optionalString(raw, "turn_id");
  const promptId = optionalString(raw, "prompt_id");
  if (permissionMode !== undefined && !PERMISSION_MODES[client].has(permissionMode)) {
    throw new Error(`hook input permission_mode is unsupported for ${client}`);
  }
  if (permissionMode !== undefined) normalized.permissionMode = permissionMode;
  if (model !== undefined) normalized.model = model;
  if (turnId !== undefined) normalized.turnId = turnId;
  if (promptId !== undefined) normalized.promptId = promptId;
  if (client === "codex" && CODEX_TURN_EVENTS.has(nativeEvent) && turnId === undefined) {
    throw new Error(`hook input turn_id is required for ${nativeEvent}`);
  }

  if (raw.effort !== undefined) {
    if (
      !isPlainObject(raw.effort) ||
      Object.keys(raw.effort).length !== 1 ||
      !("level" in raw.effort)
    ) {
      throw new Error("hook input effort must contain only a reviewed level");
    }
    normalized.effortLevel = requireEnum(raw.effort, "level", [
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ] as const);
  }

  const commonAgentId = optionalString(raw, "agent_id");
  const commonAgentType = optionalString(raw, "agent_type");
  if (commonAgentId !== undefined || commonAgentType !== undefined) {
    normalized.agent = {};
    if (commonAgentId !== undefined) normalized.agent.id = commonAgentId;
    if (commonAgentType !== undefined) normalized.agent.type = commonAgentType;
  }

  if (TOOL_EVENTS.has(nativeEvent)) {
    const id =
      nativeEvent === "PermissionRequest"
        ? optionalString(raw, "tool_use_id")
        : requiredString(raw, "tool_use_id");
    const input = raw.tool_input;
    if (input === undefined) throw new Error("hook input tool_input is required");
    assertJsonValue(input, { nodes: 0 });
    normalized.tool = { name: requiredString(raw, "tool_name"), input };
    if (id !== undefined) normalized.tool.id = id;
    if (nativeEvent === "PostToolUse") {
      const response = raw.tool_response;
      if (response === undefined) throw new Error("hook input tool_response is required");
      assertJsonValue(response, { nodes: 0 });
      normalized.tool.response = response;
    }
    if (nativeEvent === "PostToolUseFailure") {
      normalized.tool.error = requiredString(raw, "error");
      if (raw.is_interrupt !== undefined) {
        if (typeof raw.is_interrupt !== "boolean") {
          throw new Error("hook input is_interrupt must be boolean when present");
        }
        normalized.tool.interrupted = raw.is_interrupt;
      }
    }
    if (raw.duration_ms !== undefined) {
      if (!Number.isSafeInteger(raw.duration_ms) || (raw.duration_ms as number) < 0) {
        throw new Error("hook input duration_ms must be a non-negative safe integer");
      }
      normalized.durationMs = raw.duration_ms as number;
    }
  }

  if (nativeEvent === "SessionStart") {
    normalized.source = requireEnum(raw, "source", [
      "startup",
      "resume",
      "clear",
      "compact",
    ] as const);
  } else if (nativeEvent === "SessionEnd") {
    normalized.reason = requiredString(raw, "reason");
    if (!SESSION_END_REASONS[client].has(normalized.reason)) {
      throw new Error(`hook input reason is unsupported for ${client} SessionEnd`);
    }
  } else if (nativeEvent === "PreCompact" || nativeEvent === "PostCompact") {
    normalized.trigger = requireEnum(raw, "trigger", ["auto", "manual"] as const);
    if (nativeEvent === "PreCompact") {
      const instructions = optionalStringAllowEmpty(raw, "custom_instructions");
      if (client === "claude" && instructions === undefined) {
        throw new Error("hook input custom_instructions is required for Claude PreCompact");
      }
      if (instructions !== undefined) normalized.customInstructions = instructions;
    } else {
      const summary = optionalStringAllowEmpty(raw, "compact_summary");
      if (client === "claude" && summary === undefined) {
        throw new Error("hook input compact_summary is required for Claude PostCompact");
      }
      if (summary !== undefined) normalized.compactSummary = summary;
    }
  } else if (nativeEvent === "UserPromptSubmit") {
    normalized.prompt = requiredString(raw, "prompt");
  } else if (nativeEvent === "SubagentStart" || nativeEvent === "SubagentStop") {
    const id = requiredString(raw, "agent_id");
    const type = requiredString(raw, "agent_type");
    const agentTranscript = optionalNullableString(raw, "agent_transcript_path");
    normalized.agent ??= {};
    normalized.agent.id = id;
    normalized.agent.type = type;
    if (nativeEvent === "SubagentStop" && agentTranscript === undefined) {
      throw new Error("hook input agent_transcript_path is required for SubagentStop");
    }
    if (agentTranscript !== undefined) {
      if (agentTranscript !== null && !portableAbsolutePath(agentTranscript)) {
        throw new Error("hook input agent_transcript_path must be absolute");
      }
      normalized.agent.transcriptPath = agentTranscript;
    }
  } else if (nativeEvent === "Notification") {
    normalized.notification = { message: requiredString(raw, "message") };
    const title = optionalString(raw, "title");
    const type = optionalString(raw, "notification_type");
    if (title !== undefined) normalized.notification.title = title;
    if (type !== undefined) normalized.notification.type = type;
  }

  if (nativeEvent === "SubagentStop" || nativeEvent === "Stop") {
    if (typeof raw.stop_hook_active !== "boolean") {
      throw new Error("hook input stop_hook_active must be boolean");
    }
    normalized.stopHookActive = raw.stop_hook_active;
    const lastMessage = optionalNullableString(raw, "last_assistant_message");
    if (lastMessage !== undefined) normalized.lastAssistantMessage = lastMessage;
  }

  return deepFreeze(structuredClone(normalized)) as NormalizedHookEvent;
}

export function normalizeClaudeHookInput(input: unknown): NormalizedHookEvent {
  return normalizeHookInput("claude", input);
}

export function normalizeCodexHookInput(input: unknown): NormalizedHookEvent {
  return normalizeHookInput("codex", input);
}

function assertNormalizedEvent(input: unknown): asserts input is NormalizedHookEvent {
  assertBoundedJson(input);
  if (Object.keys(input).some((key) => !NORMALIZED_FIELDS.has(key))) {
    throw new Error("normalized hook event contains an unknown field");
  }
  if (input.version !== 1 || (input.client !== "claude" && input.client !== "codex")) {
    throw new Error("normalized hook event has an invalid version or client");
  }
  const nativeEvent = requiredString(input, "nativeEvent");
  const expectedEvent = EVENT_MAP[nativeEvent];
  if (
    !expectedEvent ||
    !CLIENT_EVENTS[input.client].has(nativeEvent) ||
    input.event !== expectedEvent
  ) {
    throw new Error("normalized hook event identity conflicts with its native event");
  }
  requiredString(input, "sessionId");
  const cwd = requiredString(input, "cwd");
  if (!portableAbsolutePath(cwd)) throw new Error("normalized hook event cwd must be absolute");
  const transcript = input.transcriptPath;
  if (
    transcript !== null &&
    (typeof transcript !== "string" || !portableAbsolutePath(transcript))
  ) {
    throw new Error("normalized hook event transcriptPath must be null or absolute");
  }
  const permissionMode = optionalString(input, "permissionMode");
  if (permissionMode !== undefined && !PERMISSION_MODES[input.client].has(permissionMode)) {
    throw new Error(`normalized hook permissionMode is unsupported for ${input.client}`);
  }
  optionalString(input, "model");
  const turnId = optionalString(input, "turnId");
  optionalString(input, "promptId");
  if (input.client === "codex" && CODEX_TURN_EVENTS.has(nativeEvent) && turnId === undefined) {
    throw new Error(`normalized hook event turnId is required for ${nativeEvent}`);
  }

  if (
    input.event === "before-tool" ||
    input.event === "permission-request" ||
    input.event === "after-tool" ||
    input.event === "tool-failure"
  ) {
    if (!isPlainObject(input.tool)) throw new Error("normalized hook tool content is required");
    if (
      Object.keys(input.tool).some(
        (key) => !new Set(["name", "id", "input", "response", "error", "interrupted"]).has(key),
      )
    ) {
      throw new Error("normalized hook tool contains an unknown field");
    }
    requiredString(input.tool, "name");
    if (!("input" in input.tool)) throw new Error("normalized hook tool input is required");
    assertJsonValue(input.tool.input, { nodes: 0 });
    if (input.event !== "permission-request") requiredString(input.tool, "id");
    if (input.event === "after-tool" && !("response" in input.tool)) {
      throw new Error("normalized hook tool response is required");
    }
    if (input.event === "tool-failure") requiredString(input.tool, "error");
  }

  if (input.event === "session-start") {
    requireEnum(input, "source", ["startup", "resume", "clear", "compact"] as const);
  } else if (input.event === "session-end") {
    const reason = requiredString(input, "reason");
    if (!SESSION_END_REASONS[input.client].has(reason)) {
      throw new Error(`normalized hook reason is unsupported for ${input.client}`);
    }
  } else if (input.event === "before-compact" || input.event === "after-compact") {
    requireEnum(input, "trigger", ["auto", "manual"] as const);
    if (input.client === "claude" && input.event === "before-compact") {
      if (optionalStringAllowEmpty(input, "customInstructions") === undefined) {
        throw new Error("normalized Claude before-compact instructions are required");
      }
    }
    if (input.client === "claude" && input.event === "after-compact") {
      if (optionalStringAllowEmpty(input, "compactSummary") === undefined) {
        throw new Error("normalized Claude after-compact summary is required");
      }
    }
  } else if (input.event === "user-prompt") {
    requiredString(input, "prompt");
  } else if (input.event === "agent-start" || input.event === "agent-stop") {
    if (!isPlainObject(input.agent)) throw new Error("normalized hook agent content is required");
    requiredString(input.agent, "id");
    requiredString(input.agent, "type");
    if (input.event === "agent-stop") {
      if (!("transcriptPath" in input.agent)) {
        throw new Error("normalized hook agent transcript path is required");
      }
      const agentTranscript = input.agent.transcriptPath;
      if (
        agentTranscript !== null &&
        (typeof agentTranscript !== "string" || !portableAbsolutePath(agentTranscript))
      ) {
        throw new Error("normalized hook agent transcript path must be null or absolute");
      }
    }
  } else if (input.event === "notification") {
    if (!isPlainObject(input.notification)) {
      throw new Error("normalized hook notification content is required");
    }
    requiredString(input.notification, "message");
  }
  if (input.event === "agent-stop" || input.event === "stop") {
    if (typeof input.stopHookActive !== "boolean") {
      throw new Error("normalized hook stop state is required");
    }
  }
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function assertDiagnostic(value: unknown, field: string): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > HOOK_INPUT_LIMITS.maxDiagnosticBytes ||
    containsUnsafeDiagnosticCharacter(value)
  ) {
    throw new Error(`hook handler ${field} must be a bounded non-empty string`);
  }
}

function containsUnsafeDiagnosticCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (
      codePoint <= 0x08 ||
      codePoint === 0x0b ||
      codePoint === 0x0c ||
      (codePoint >= 0x0e && codePoint <= 0x1f) ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      (codePoint >= 0x202a && codePoint <= 0x202e) ||
      (codePoint >= 0x2066 && codePoint <= 0x2069)
    ) {
      return true;
    }
  }
  return false;
}

function validateDecision(
  event: LogicalHookEvent,
  decision: HookHandlerDecision,
): HookHandlerDecision {
  if (!isPlainObject(decision)) throw new Error("hook handler returned an invalid decision");
  const keys = Object.keys(decision);
  if (keys.some((key) => !new Set(["action", "context", "reason"]).has(key))) {
    throw new Error("hook handler returned an unknown decision field");
  }
  if (decision.action === "continue") {
    if (decision.reason !== undefined)
      throw new Error("continuing hook decision cannot have a reason");
    if (decision.context !== undefined) assertDiagnostic(decision.context, "context");
    return decision;
  }
  if (decision.action === "block") {
    if (!BLOCKABLE_EVENTS.has(event)) throw new Error(`${event} hook handlers cannot block`);
    assertDiagnostic(decision.reason, "reason");
    if (decision.context !== undefined)
      throw new Error("blocking hook decision cannot have context");
    return decision;
  }
  throw new Error("hook handler returned an unsupported action");
}

function validateHandlers(handlers: readonly HookHandler[]): HookHandler[] {
  if (handlers.length > HOOK_INPUT_LIMITS.maxHandlers) {
    throw new Error("hook handler count limit exceeded");
  }
  const ids = new Set<string>();
  const orders = new Set<number>();
  for (const handler of handlers) {
    if (!isPlainObject(handler)) throw new Error("hook handler configuration must be an object");
    if (!HANDLER_ID.test(handler.id)) throw new Error(`unsafe hook handler id: ${handler.id}`);
    if (ids.has(handler.id)) throw new Error(`duplicate hook handler id: ${handler.id}`);
    ids.add(handler.id);
    if (!Number.isSafeInteger(handler.order) || handler.order < 0) {
      throw new Error(`invalid hook handler order: ${handler.id}`);
    }
    if (orders.has(handler.order))
      throw new Error(`duplicate hook handler order: ${handler.order}`);
    orders.add(handler.order);
    if (
      !Number.isSafeInteger(handler.timeoutMs) ||
      handler.timeoutMs < 1 ||
      handler.timeoutMs > HOOK_INPUT_LIMITS.maxHandlerTimeoutMs
    ) {
      throw new Error(`invalid hook handler timeout: ${handler.id}`);
    }
    if (handler.failurePolicy !== "open" && handler.failurePolicy !== "closed") {
      throw new Error(`invalid hook handler failure policy: ${handler.id}`);
    }
    if (
      (handler.redactionPolicy !== "none" && handler.redactionPolicy !== "sensitive-values") ||
      !["none", "ephemeral", "aih-state"].includes(handler.storagePolicy)
    ) {
      throw new Error(`invalid hook handler data policy: ${handler.id}`);
    }
    if (handler.storagePolicy !== "none" && handler.redactionPolicy !== "sensitive-values") {
      throw new Error(`hook handler ${handler.id} storage requires reviewed redaction`);
    }
    if (!Array.isArray(handler.events) || handler.events.length === 0) {
      throw new Error(`ambiguous hook handler event list: ${handler.id}`);
    }
    if (new Set(handler.events).size !== handler.events.length) {
      throw new Error(`ambiguous hook handler event list: ${handler.id}`);
    }
    for (const event of handler.events) {
      if (!Object.values(EVENT_MAP).includes(event)) {
        throw new Error(`unsupported logical hook event for ${handler.id}: ${event}`);
      }
    }
    if (
      handler.failurePolicy === "closed" &&
      handler.events.some((event) => !BLOCKABLE_EVENTS.has(event))
    ) {
      throw new Error(`hook handler ${handler.id} cannot fail closed on an informational event`);
    }
    if (typeof handler.enabled !== "boolean" || typeof handler.run !== "function") {
      throw new Error(`invalid hook handler contract: ${handler.id}`);
    }
  }
  for (const event of new Set(Object.values(EVENT_MAP))) {
    const timeoutBudget = handlers
      .filter((handler) => handler.enabled && handler.events.includes(event))
      .reduce((total, handler) => total + handler.timeoutMs, 0);
    if (timeoutBudget > HOOK_INPUT_LIMITS.maxAggregateTimeoutMs) {
      throw new Error(`hook handler timeout budget exceeded for ${event}`);
    }
  }
  return handlers
    .map((handler) => ({ ...handler, events: [...handler.events] }))
    .sort((left, right) => left.order - right.order);
}

type RunOutcome =
  | { kind: "decision"; decision: HookHandlerDecision }
  | { kind: "failed" }
  | { kind: "timed-out" };

async function runBoundedHandler(
  handler: HookHandler,
  event: NormalizedHookEvent,
): Promise<RunOutcome> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const work: Promise<RunOutcome> = Promise.resolve()
    .then(() => handler.run(event, controller.signal))
    .then(
      (decision) => ({ kind: "decision", decision }) as const,
      () => ({ kind: "failed" }) as const,
    );
  const timeout = new Promise<RunOutcome>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ kind: "timed-out" });
    }, handler.timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function failureReceipt(handler: HookHandler, kind: "failed" | "timed-out"): HookHandlerReceipt {
  const suffix = handler.failurePolicy === "open" ? "open" : "closed";
  return {
    handlerId: handler.id,
    status: `${kind}-${suffix}` as HookHandlerStatus,
    failurePolicy: handler.failurePolicy,
  };
}

export async function dispatchHookEvent(
  event: NormalizedHookEvent,
  handlers: readonly HookHandler[],
): Promise<HookDispatchResult> {
  assertNormalizedEvent(event);
  const snapshot = deepFreeze(structuredClone(event)) as NormalizedHookEvent;
  const ordered = validateHandlers(handlers);
  const contexts: string[] = [];
  let contextBytes = 0;
  const receipts: HookHandlerReceipt[] = [];
  let blockReason: string | undefined;

  for (const handler of ordered) {
    if (!handler.enabled) {
      receipts.push({
        handlerId: handler.id,
        status: "disabled",
        failurePolicy: handler.failurePolicy,
      });
      continue;
    }
    if (!handler.events.includes(snapshot.event)) {
      receipts.push({
        handlerId: handler.id,
        status: "not-matched",
        failurePolicy: handler.failurePolicy,
      });
      continue;
    }

    const outcome = await runBoundedHandler(handler, snapshot);
    if (outcome.kind !== "decision") {
      receipts.push(failureReceipt(handler, outcome.kind));
      if (handler.failurePolicy === "closed" && blockReason === undefined) {
        blockReason = `Hook handler ${handler.id} failed closed.`;
      }
      continue;
    }

    let decision: HookHandlerDecision;
    try {
      decision = validateDecision(snapshot.event, outcome.decision);
    } catch (error) {
      if (
        isPlainObject(outcome.decision) &&
        outcome.decision.action === "block" &&
        !BLOCKABLE_EVENTS.has(snapshot.event)
      ) {
        throw error;
      }
      receipts.push(failureReceipt(handler, "failed"));
      if (handler.failurePolicy === "closed" && blockReason === undefined) {
        blockReason = `Hook handler ${handler.id} failed closed.`;
      }
      continue;
    }
    if (decision.action === "block") {
      receipts.push({
        handlerId: handler.id,
        status: "blocked",
        failurePolicy: handler.failurePolicy,
      });
      blockReason ??= decision.reason;
    } else {
      const nextContextBytes =
        decision.context === undefined ? 0 : Buffer.byteLength(decision.context, "utf8");
      if (contextBytes + nextContextBytes > HOOK_INPUT_LIMITS.maxAggregateContextBytes) {
        receipts.push(failureReceipt(handler, "failed"));
        if (handler.failurePolicy === "closed" && blockReason === undefined) {
          blockReason = `Hook handler ${handler.id} failed closed.`;
        }
        continue;
      }
      receipts.push({
        handlerId: handler.id,
        status: "continued",
        failurePolicy: handler.failurePolicy,
      });
      if (decision.context !== undefined) {
        contexts.push(decision.context);
        contextBytes += nextContextBytes;
      }
    }
  }

  if (blockReason !== undefined)
    return { action: "block", reason: blockReason, contexts, receipts };
  return { action: "continue", contexts, receipts };
}

function stableJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJson);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, child]) => [key, stableJson(child)]),
  );
}

export function serializeHookDispatchResult(result: HookDispatchResult): string {
  return `${JSON.stringify(stableJson(result), null, 2)}\n`;
}
