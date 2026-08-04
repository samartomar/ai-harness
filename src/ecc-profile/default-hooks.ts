import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { redactSecrets } from "../guardrails/redact.js";
import { readRegularFile, retryTransient } from "../internals/fsxn.js";
import {
  HOOK_INPUT_LIMITS,
  type HookHandler,
  type HookHandlerDecision,
  type LogicalHookEvent,
  type NormalizedHookEvent,
} from "./hook-core.js";

export const CONTINUITY_LIMITS = {
  maxInjectedCharacters: 8_000,
  retentionMs: 30 * 24 * 60 * 60 * 1_000,
  maxSummaryCharacters: 6_000,
  maxActivityEntries: 100,
  contextWarningActivityCount: 50,
  maxRecords: 128,
} as const;

const SAFE_ID = /^[a-z][a-z0-9-]{0,63}$/;
const SHELL_TOOL_NAMES = new Set([
  "bash",
  "shell",
  "shell_command",
  "exec_command",
  "powershell",
  "pwsh",
  "terminal",
]);
const PROTECTION_EVENTS = ["before-tool", "permission-request"] as const;
const CONTINUITY_EVENTS = [
  "session-start",
  "session-end",
  "before-compact",
  "after-compact",
  "after-tool",
  "tool-failure",
  "user-prompt",
  "stop",
] as const;
const MCP_HEALTH_EVENTS = ["session-start", "before-tool"] as const;
const AUTHENTICATION_HEADER =
  /\b(proxy-authorization|authorization|proxy-authentication-info|authentication-info|www-authenticate|x-api-key|api-key|x-auth-token|x-client-secret|client-secret|private-token|set-cookie|cookie)\s*:\s*[^\r\n]*(?:\r?\n[ \t]+[^\r\n]*)*/gi;

function boundedText(value: string, maxCharacters: number): string {
  const characters = Array.from(value);
  return characters.length <= maxCharacters ? value : characters.slice(0, maxCharacters).join("");
}

function boundedUtf8Text(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) return value;
  const characters: string[] = [];
  let bytes = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes > maxBytes) break;
    characters.push(character);
    bytes += characterBytes;
  }
  return characters.join("");
}

function boundedDiagnosticContext(value: string): string {
  return boundedUtf8Text(
    boundedText(value, CONTINUITY_LIMITS.maxInjectedCharacters),
    HOOK_INPUT_LIMITS.maxDiagnosticBytes,
  );
}

function safeConfiguredText(value: string, name: string, maxCharacters: number): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new Error(`${name} must be a non-empty safe string`);
  }
  if (Array.from(value).length > maxCharacters) throw new Error(`${name} exceeds its limit`);
  return value;
}

function validEpochMs(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} is invalid`);
  return value;
}

interface ShellToken {
  value: string;
  separator: boolean;
}

/** Small, fail-closed shell lexer for command identity and option inspection only. */
function shellTokens(command: string): ShellToken[] {
  if (command.includes("\0") || command.length > 128_000) {
    throw new Error("shell command is malformed or exceeds its limit");
  }
  const tokens: ShellToken[] = [];
  let value = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  const flush = () => {
    if (value.length > 0) tokens.push({ value, separator: false });
    value = "";
  };
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index] ?? "";
    if (escaped) {
      value += char;
      escaped = false;
      continue;
    }
    if ((char === "\\" || char === "`") && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote !== undefined) {
      if (char === quote) quote = undefined;
      else value += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === "\r" || char === "\n") {
      flush();
      if (char === "\r" && command[index + 1] === "\n") index += 1;
      tokens.push({ value: char, separator: true });
      continue;
    }
    if (/\s/.test(char)) {
      flush();
      continue;
    }
    if (";&|".includes(char)) {
      flush();
      while (command[index + 1] === char) index += 1;
      tokens.push({ value: char, separator: true });
      continue;
    }
    value += char;
  }
  if (quote !== undefined || escaped) throw new Error("shell command has unterminated quoting");
  flush();
  return tokens;
}

function commandSegments(command: string): string[][] {
  const segments: string[][] = [[]];
  for (const token of shellTokens(command)) {
    if (token.separator) segments.push([]);
    else segments[segments.length - 1]?.push(token.value);
  }
  return segments.filter((segment) => segment.length > 0);
}

function isEnvironmentAssignment(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(value);
}

function hookPathAssignment(value: string): boolean {
  return /^core\.hookspath(?:=|$)/i.test(value);
}

function gitExecutable(value: string): boolean {
  return /(?:^|[\\/])git(?:\.exe|\.cmd)?$/i.test(value);
}

function unwrapCommand(segment: readonly string[]): readonly string[] {
  let index = 0;
  const command = (segment[index] ?? "").toLowerCase();
  if (command === "command" || command === "sudo") {
    index += 1;
    while ((segment[index] ?? "").startsWith("-")) index += 1;
  } else if (command === "env") {
    index += 1;
    while ((segment[index] ?? "").startsWith("-") || isEnvironmentAssignment(segment[index] ?? ""))
      index += 1;
  }
  return segment.slice(index);
}

function nestedShellCommand(segment: readonly string[]): string | undefined {
  const executable = (segment[0] ?? "").toLowerCase().replace(/^.*[\\/]/, "");
  const flag = (segment[1] ?? "").toLowerCase();
  const supported =
    ((executable === "bash" || executable === "sh" || executable === "zsh") && flag === "-c") ||
    ((executable === "pwsh" || executable === "powershell" || executable === "powershell.exe") &&
      (flag === "-command" || flag === "-c")) ||
    ((executable === "cmd" || executable === "cmd.exe") && flag === "/c");
  const candidate = segment[2];
  return supported && candidate?.includes(" ") ? candidate : undefined;
}

function gitSegmentBypassesHooks(segment: readonly string[], depth = 0): boolean {
  if (depth > 2) throw new Error("nested shell command exceeds its review depth");
  segment = unwrapCommand(segment);
  const nested = nestedShellCommand(segment);
  if (nested !== undefined) {
    return commandSegments(nested).some((item) => gitSegmentBypassesHooks(item, depth + 1));
  }
  let gitIndex = 0;
  while (gitIndex < segment.length && isEnvironmentAssignment(segment[gitIndex] ?? ""))
    gitIndex += 1;
  if (!gitExecutable(segment[gitIndex] ?? "")) return false;
  const args = segment.slice(gitIndex + 1);

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    const lower = arg.toLowerCase();
    if (lower === "-c") {
      if (hookPathAssignment(args[index + 1] ?? "")) return true;
      index += 1;
    } else if (/^-c(?:ore\.hookspath)(?:=|$)/i.test(arg)) {
      return true;
    }
  }

  let commandIndex = 0;
  while (commandIndex < args.length) {
    const arg = args[commandIndex] ?? "";
    if (arg === "-c" || arg === "-C" || arg === "--git-dir" || arg === "--work-tree") {
      commandIndex += 2;
      continue;
    }
    if (/^-(?:c|C)/.test(arg) || arg.startsWith("--git-dir=") || arg.startsWith("--work-tree=")) {
      commandIndex += 1;
      continue;
    }
    if (arg.startsWith("-")) {
      commandIndex += 1;
      continue;
    }
    break;
  }
  const subcommand = (args[commandIndex] ?? "").toLowerCase();
  const subcommandArgs = args.slice(commandIndex + 1);
  if (subcommandArgs.some((arg) => arg.toLowerCase() === "--no-verify")) return true;
  if (
    subcommand === "commit" &&
    subcommandArgs.some((arg) => /^-[^-]*n/i.test(arg) && arg !== "--")
  )
    return true;
  if (subcommand !== "config") return false;

  const readOnlyConfig = new Set([
    "--get",
    "--get-all",
    "--get-regexp",
    "--get-urlmatch",
    "--list",
    "-l",
  ]);
  const containsHookPath = subcommandArgs.some(hookPathAssignment);
  if (!containsHookPath) return false;
  return !subcommandArgs.some((arg) => readOnlyConfig.has(arg.toLowerCase()));
}

function commandFromEvent(event: Readonly<NormalizedHookEvent>): string | undefined {
  const tool = event.tool;
  if (!tool || !SHELL_TOOL_NAMES.has(tool.name.toLowerCase())) return undefined;
  if (tool.input === null || Array.isArray(tool.input) || typeof tool.input !== "object") {
    throw new Error("shell tool input must be an object");
  }
  const command = tool.input.command;
  if (typeof command !== "string" || command.length === 0) {
    throw new Error("shell tool command must be a non-empty string");
  }
  return command;
}

export function createRepositoryProtectionHandler(): HookHandler {
  return {
    id: "repository-protection",
    events: PROTECTION_EVENTS,
    enabled: true,
    order: 10,
    timeoutMs: 1_000,
    failurePolicy: "closed",
    redactionPolicy: "none",
    storagePolicy: "none",
    run(event) {
      let command: string | undefined;
      try {
        command = commandFromEvent(event);
        if (command === undefined) return { action: "continue" };
        if (commandSegments(command).some(gitSegmentBypassesHooks)) {
          return {
            action: "block",
            reason: "repository protection blocks Git verification bypass and hooksPath overrides",
          };
        }
        return { action: "continue" };
      } catch {
        return {
          action: "block",
          reason: "repository protection could not safely classify the shell command",
        };
      }
    },
  };
}

export interface ContinuityActivity {
  atEpochMs: number;
  event: "after-tool" | "tool-failure";
  tool: string;
  outcome: "ok" | "failed";
  durationMs?: number;
}

export interface ContinuityRecord {
  version: 1;
  repositoryId: string;
  canonicalWorktree: string;
  harness: string;
  sessionId: string;
  updatedAtEpochMs: number;
  summary: string;
  activity: ContinuityActivity[];
}

export interface ContinuityStore {
  list(): readonly ContinuityRecord[];
  save(record: ContinuityRecord): void;
  prune(beforeEpochMs: number): void;
}

export interface FileContinuityStoreOptions {
  stateRoot: string;
  canonicalWorktree: string;
  repositoryId: string;
  harness: string;
  maxFileBytes?: number;
}

const DEFAULT_CONTINUITY_FILE_BYTES = 1024 * 1024;

function existingDirectory(path: string, name: string): string {
  const stats = lstatSync(path);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`${name} must be a real directory`);
  }
  return realpathSync(path);
}

function containsPath(parent: string, child: string): boolean {
  const relation = relative(parent, child);
  return relation === "" || (!relation.startsWith("..") && !isAbsolute(relation));
}

function parseContinuityFile(raw: Buffer, file: string): ContinuityRecord[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new Error(`continuity state is malformed: ${file}`);
  }
  if (!Array.isArray(parsed)) throw new Error(`continuity state is malformed: ${file}`);
  if (parsed.length > CONTINUITY_LIMITS.maxRecords) {
    throw new Error(`continuity state has too many records: ${file}`);
  }
  for (const record of parsed) validateRecord(record as ContinuityRecord);
  return parsed as ContinuityRecord[];
}

/**
 * Durable JSON state scoped by repository, canonical worktree, and harness. The
 * caller supplies an existing AIH-owned state root outside the worktree; the
 * store never discovers or writes project paths.
 */
export function createFileContinuityStore(options: FileContinuityStoreOptions): ContinuityStore {
  if (!isAbsolute(options.stateRoot) || !isAbsolute(options.canonicalWorktree)) {
    throw new Error("continuity roots must be absolute");
  }
  const stateRoot = existingDirectory(resolve(options.stateRoot), "continuity state root");
  const worktree = existingDirectory(resolve(options.canonicalWorktree), "canonical worktree");
  if (containsPath(worktree, stateRoot) || containsPath(stateRoot, worktree)) {
    throw new Error("continuity state root must be outside the canonical worktree");
  }
  const repositoryId = safeConfiguredText(options.repositoryId, "continuity repositoryId", 512);
  const harness = safeConfiguredText(options.harness, "continuity harness", 64);
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_CONTINUITY_FILE_BYTES;
  if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes < 1 || maxFileBytes > 16 * 1024 * 1024) {
    throw new Error("continuity maxFileBytes is invalid");
  }
  const directory = join(stateRoot, "continuity");
  try {
    mkdirSync(directory, { recursive: false });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const canonicalDirectory = existingDirectory(directory, "continuity directory");
  if (!containsPath(stateRoot, canonicalDirectory)) {
    throw new Error("continuity directory escapes its state root");
  }
  const key = createHash("sha256")
    .update(`${repositoryId}\0${worktree}\0${harness}`, "utf8")
    .digest("hex");
  const file = join(canonicalDirectory, `${key}.json`);
  const resolvesToWorktree = (candidate: string): boolean => {
    if (!isAbsolute(candidate)) return false;
    try {
      return (
        comparablePath(existingDirectory(resolve(candidate), "continuity record worktree")) ===
        comparablePath(worktree)
      );
    } catch {
      return false;
    }
  };
  const assertScope = (record: ContinuityRecord) => {
    if (
      record.repositoryId !== repositoryId ||
      !resolvesToWorktree(record.canonicalWorktree) ||
      record.harness !== harness
    ) {
      throw new Error("continuity record conflicts with its store scope");
    }
  };

  const read = (): ContinuityRecord[] => {
    let stats: ReturnType<typeof lstatSync>;
    try {
      stats = lstatSync(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error(`continuity state must be a regular file: ${file}`);
    }
    const raw = readRegularFile(file, { maxBytes: maxFileBytes });
    if (raw === undefined) throw new Error(`continuity state could not be read safely: ${file}`);
    const records = parseContinuityFile(raw, file);
    for (const record of records) assertScope(record);
    return records;
  };

  const write = (records: readonly ContinuityRecord[]) => {
    const sorted = [...records]
      .sort(
        (a, b) => a.updatedAtEpochMs - b.updatedAtEpochMs || a.sessionId.localeCompare(b.sessionId),
      )
      .slice(-CONTINUITY_LIMITS.maxRecords);
    const contents = `${JSON.stringify(sorted, null, 2)}\n`;
    if (Buffer.byteLength(contents, "utf8") > maxFileBytes) {
      throw new Error("continuity state exceeds its file limit");
    }
    const temp = join(dirname(file), `.${key}.${process.pid}.tmp`);
    try {
      const tempStats = lstatSync(temp);
      if (tempStats.isSymbolicLink() || !tempStats.isFile()) {
        throw new Error(`continuity temporary path is unsafe: ${temp}`);
      }
      rmSync(temp);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    retryTransient(() =>
      writeFileSync(temp, contents, { encoding: "utf8", flag: "wx", mode: 0o600 }),
    );
    try {
      retryTransient(() => renameSync(temp, file));
    } finally {
      try {
        rmSync(temp);
      } catch {
        // Best-effort cleanup must not mask a successful atomic replacement.
      }
    }
  };

  return {
    list: read,
    save(record) {
      validateRecord(record);
      assertScope(record);
      const records = read().filter((item) => item.sessionId !== record.sessionId);
      write([...records, structuredClone(record)]);
    },
    prune(beforeEpochMs) {
      if (!Number.isSafeInteger(beforeEpochMs)) throw new Error("continuity prune time is invalid");
      const current = read();
      const retained = current.filter((record) => record.updatedAtEpochMs >= beforeEpochMs);
      if (retained.length !== current.length) write(retained);
    },
  };
}

export interface ContinuityHandlerOptions {
  repositoryId: string;
  canonicalWorktree: string;
  harness: string;
  store: ContinuityStore;
  now?: () => number;
}

function comparablePath(value: string): string {
  const normalized = value.replace(/\\/g, "/").replace(/\/$/, "");
  return /^[A-Za-z]:\//.test(normalized) ? normalized.toLowerCase() : normalized;
}

function validateRecord(record: ContinuityRecord): void {
  const object = record as unknown as Record<string, unknown>;
  const recordFields = [
    "version",
    "repositoryId",
    "canonicalWorktree",
    "harness",
    "sessionId",
    "updatedAtEpochMs",
    "summary",
    "activity",
  ];
  if (
    record === null ||
    typeof record !== "object" ||
    Array.isArray(record) ||
    Object.keys(object).some((key) => !recordFields.includes(key)) ||
    Object.keys(object).length !== recordFields.length ||
    record.version !== 1 ||
    !Number.isSafeInteger(record.updatedAtEpochMs) ||
    record.updatedAtEpochMs < 0 ||
    !Array.isArray(record.activity) ||
    record.activity.length > CONTINUITY_LIMITS.maxActivityEntries
  ) {
    throw new Error("continuity store returned a malformed record");
  }
  safeConfiguredText(record.repositoryId, "continuity repositoryId", 512);
  safeConfiguredText(record.canonicalWorktree, "continuity canonicalWorktree", 4_096);
  safeConfiguredText(record.harness, "continuity harness", 64);
  safeConfiguredText(record.sessionId, "continuity sessionId", 256);
  if (
    typeof record.summary !== "string" ||
    record.summary.includes("\0") ||
    Array.from(record.summary).length > CONTINUITY_LIMITS.maxSummaryCharacters
  ) {
    throw new Error("continuity store returned an oversized summary");
  }
  for (const activity of record.activity) {
    const fields = ["atEpochMs", "event", "tool", "outcome", "durationMs"];
    if (
      activity === null ||
      typeof activity !== "object" ||
      Array.isArray(activity) ||
      Object.keys(activity).some((key) => !fields.includes(key)) ||
      !Number.isSafeInteger(activity.atEpochMs) ||
      activity.atEpochMs < 0 ||
      (activity.event !== "after-tool" && activity.event !== "tool-failure") ||
      (activity.outcome !== "ok" && activity.outcome !== "failed") ||
      typeof activity.tool !== "string" ||
      activity.tool.length === 0 ||
      activity.tool.includes("\0") ||
      Array.from(activity.tool).length > 128 ||
      (activity.durationMs !== undefined &&
        (!Number.isSafeInteger(activity.durationMs) || activity.durationMs < 0))
    ) {
      throw new Error("continuity store returned a malformed activity entry");
    }
  }
}

function redactedSummary(value: string): string {
  const withoutAuthenticationHeaders = value.replace(AUTHENTICATION_HEADER, "$1: [REDACTED]");
  return boundedText(
    redactSecrets(withoutAuthenticationHeaders),
    CONTINUITY_LIMITS.maxSummaryCharacters,
  );
}

export function createContinuityHandler(options: ContinuityHandlerOptions): HookHandler {
  const repositoryId = safeConfiguredText(options.repositoryId, "continuity repositoryId", 512);
  const canonicalWorktree = safeConfiguredText(
    options.canonicalWorktree,
    "continuity canonicalWorktree",
    4_096,
  );
  const harness = safeConfiguredText(options.harness, "continuity harness", 64);
  const now = options.now ?? Date.now;
  const sameScope = (record: ContinuityRecord) =>
    record.repositoryId === repositoryId &&
    comparablePath(record.canonicalWorktree) === comparablePath(canonicalWorktree) &&
    record.harness === harness;
  const sessionKey = (sessionId: string) =>
    createHash("sha256").update(sessionId, "utf8").digest("hex");

  const records = () => {
    const found = [...options.store.list()];
    if (found.length > CONTINUITY_LIMITS.maxRecords) {
      throw new Error("continuity store returned too many records");
    }
    for (const record of found) validateRecord(record);
    return found.filter(sameScope);
  };

  const save = (event: Readonly<NormalizedHookEvent>, update: Partial<ContinuityRecord>) => {
    const keyedSession = sessionKey(event.sessionId);
    const existing = records().find((record) => record.sessionId === keyedSession);
    const record: ContinuityRecord = {
      version: 1,
      repositoryId,
      canonicalWorktree,
      harness,
      sessionId: keyedSession,
      updatedAtEpochMs: validEpochMs(now(), "continuity clock"),
      summary: existing?.summary ?? "",
      activity: existing?.activity ?? [],
      ...update,
    };
    validateRecord(record);
    options.store.save(record);
    return record;
  };

  return {
    id: "continuity",
    events: CONTINUITY_EVENTS,
    enabled: true,
    order: 30,
    timeoutMs: 2_000,
    failurePolicy: "open",
    redactionPolicy: "sensitive-values",
    storagePolicy: "aih-state",
    run(event): HookHandlerDecision {
      if (comparablePath(event.cwd) !== comparablePath(canonicalWorktree)) {
        throw new Error("continuity event belongs to a foreign worktree");
      }
      const timestamp = validEpochMs(now(), "continuity clock");
      options.store.prune(timestamp - CONTINUITY_LIMITS.retentionMs);

      if (event.event === "session-start") {
        const keyedSession = sessionKey(event.sessionId);
        const previous = records()
          .filter((record) => record.sessionId !== keyedSession && record.summary.length > 0)
          .sort(
            (a, b) =>
              b.updatedAtEpochMs - a.updatedAtEpochMs || a.sessionId.localeCompare(b.sessionId),
          )[0];
        if (!previous) return { action: "continue" };
        const context = boundedDiagnosticContext(
          `Resume the previous exact-worktree checkpoint:\n${previous.summary}`,
        );
        return { action: "continue", context };
      }

      if (event.event === "after-tool" || event.event === "tool-failure") {
        const keyedSession = sessionKey(event.sessionId);
        const existing = records().find((record) => record.sessionId === keyedSession);
        const activity: ContinuityActivity = {
          atEpochMs: timestamp,
          event: event.event,
          tool: boundedText(redactSecrets(event.tool?.name ?? "unknown"), 128),
          outcome: event.event === "after-tool" ? "ok" : "failed",
        };
        if (event.durationMs !== undefined) activity.durationMs = event.durationMs;
        save(event, {
          activity: [...(existing?.activity ?? []), activity].slice(
            -CONTINUITY_LIMITS.maxActivityEntries,
          ),
        });
        return { action: "continue" };
      }

      if (event.event === "after-compact" && event.compactSummary !== undefined) {
        save(event, { summary: redactedSummary(event.compactSummary) });
        return { action: "continue" };
      }

      if (event.event === "session-end" || event.event === "stop") {
        const summary = event.lastAssistantMessage
          ? redactedSummary(event.lastAssistantMessage)
          : (records().find((record) => record.sessionId === sessionKey(event.sessionId))
              ?.summary ?? "");
        save(event, { summary });
        return { action: "continue" };
      }

      if (event.event === "before-compact") {
        const current = records().find(
          (record) => record.sessionId === sessionKey(event.sessionId),
        );
        save(event, {
          summary:
            current?.summary ||
            "Compaction checkpoint created; preserve decisions, unresolved risks, verification evidence, and the next action.",
        });
        return {
          action: "continue",
          context: boundedDiagnosticContext(
            "Before compaction, preserve decisions, unresolved risks, exact verification evidence, the next action, and this exact worktree identity. Do not include secrets or complete tool output.",
          ),
        };
      }

      if (event.event === "user-prompt") {
        const current = records().find(
          (record) => record.sessionId === sessionKey(event.sessionId),
        );
        if ((current?.activity.length ?? 0) >= CONTINUITY_LIMITS.contextWarningActivityCount) {
          return {
            action: "continue",
            context:
              "Context-critical warning: create a durable checkpoint before more tool-heavy work or compaction.",
          };
        }
      }
      return { action: "continue" };
    },
  };
}

export interface McpHealthServer {
  id: string;
  fallback: string;
  reconnect?: boolean;
}

export interface McpHealthProbeResult {
  ok: boolean;
  detail?: string;
}

export interface McpHealthHandlerOptions {
  selectedServers: readonly McpHealthServer[];
  probe: (id: string, signal: AbortSignal) => Promise<McpHealthProbeResult>;
  reconnect?: (id: string, signal: AbortSignal) => Promise<boolean>;
  now?: () => number;
  successCacheMs?: number;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
}

interface McpHealthCacheEntry {
  ok: boolean;
  checkedAt: number;
  nextProbeAt: number;
  failures: number;
}

export function createMcpHealthHandler(options: McpHealthHandlerOptions): HookHandler {
  if (options.selectedServers.length > 64) throw new Error("too many selected MCP servers");
  const selected = [...options.selectedServers]
    .map((server) => ({
      ...server,
      id: safeConfiguredText(server.id.toLowerCase(), "MCP server id", 64),
      fallback: safeConfiguredText(server.fallback, "MCP fallback", 1_000),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  if (selected.some((server) => !SAFE_ID.test(server.id))) {
    throw new Error("MCP server id is malformed");
  }
  if (new Set(selected.map((server) => server.id)).size !== selected.length) {
    throw new Error("duplicate MCP server identity");
  }
  if (selected.some((server) => redactSecrets(server.fallback) !== server.fallback)) {
    throw new Error("MCP fallback must not contain sensitive values");
  }
  const byId = new Map(selected.map((server) => [server.id, server]));
  const cache = new Map<string, McpHealthCacheEntry>();
  const now = options.now ?? Date.now;
  const successCacheMs = options.successCacheMs ?? 60_000;
  const initialBackoffMs = options.initialBackoffMs ?? 1_000;
  const maxBackoffMs = options.maxBackoffMs ?? 60_000;
  for (const [name, value] of Object.entries({ successCacheMs, initialBackoffMs, maxBackoffMs })) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be positive`);
  }
  if (initialBackoffMs > maxBackoffMs) throw new Error("MCP backoff range is invalid");

  const targetIds = (event: Readonly<NormalizedHookEvent>): string[] => {
    if (event.event === "session-start") return selected.map((server) => server.id);
    const match = /^mcp__([a-z0-9-]+)__/i.exec(event.tool?.name ?? "");
    if (!match) return [];
    const id = (match[1] ?? "").toLowerCase();
    return byId.has(id) ? [id] : [];
  };

  return {
    id: "mcp-health",
    events: MCP_HEALTH_EVENTS,
    enabled: true,
    order: 20,
    timeoutMs: 5_000,
    failurePolicy: "open",
    redactionPolicy: "sensitive-values",
    storagePolicy: "ephemeral",
    async run(event, signal): Promise<HookHandlerDecision> {
      const timestamp = validEpochMs(now(), "MCP health clock");
      const targets = targetIds(event);
      if (targets.length === 0) return { action: "continue" };
      for (const id of targets) {
        const server = byId.get(id);
        if (!server) continue;
        const current = cache.get(id);
        if (current && timestamp < current.nextProbeAt) continue;
        const result = await options.probe(id, signal);
        if (
          result === null ||
          typeof result !== "object" ||
          typeof result.ok !== "boolean" ||
          (result.detail !== undefined && typeof result.detail !== "string")
        ) {
          throw new Error(`MCP health probe returned an invalid result for ${id}`);
        }
        let ok = result.ok;
        if (!ok && server.reconnect === true && options.reconnect !== undefined) {
          const reconnected = await options.reconnect(id, signal);
          if (typeof reconnected !== "boolean") {
            throw new Error(`MCP reconnect returned an invalid result for ${id}`);
          }
          ok = reconnected;
        }
        const failures = ok ? 0 : (current?.failures ?? 0) + 1;
        const delay = ok
          ? successCacheMs
          : Math.min(initialBackoffMs * 2 ** Math.min(failures - 1, 20), maxBackoffMs);
        cache.set(id, { ok, checkedAt: timestamp, nextProbeAt: timestamp + delay, failures });
      }
      const targetSet = new Set(targets);
      const unavailable = selected.filter(
        (server) => targetSet.has(server.id) && cache.get(server.id)?.ok === false,
      );
      if (unavailable.length === 0) return { action: "continue" };
      return {
        action: "continue",
        context: boundedDiagnosticContext(
          unavailable
            .map((server) => `MCP ${server.id} unavailable. ${server.fallback}`)
            .join("\n"),
        ),
      };
    },
  };
}

export const DEFAULT_ECC_HOOK_IDS = ["repository-protection", "mcp-health", "continuity"] as const;

export type DefaultEccHookId = (typeof DEFAULT_ECC_HOOK_IDS)[number];

export function defaultEccHookEvents(): Readonly<
  Record<DefaultEccHookId, readonly LogicalHookEvent[]>
> {
  return {
    "repository-protection": PROTECTION_EVENTS,
    "mcp-health": MCP_HEALTH_EVENTS,
    continuity: CONTINUITY_EVENTS,
  };
}
