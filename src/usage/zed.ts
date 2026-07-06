import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import * as zlib from "node:zlib";
import { readIfExists } from "../internals/fsxn.js";
import type { PlanContext } from "../internals/plan.js";
import { USAGE_PATH, type UsageEvent, type UsageTokens } from "./events.js";

interface ZedThreadRow {
  id?: unknown;
  summary?: unknown;
  updated_at?: unknown;
  data_type?: unknown;
  data?: unknown;
  folder_paths?: unknown;
}

type SqliteModule = typeof import("node:sqlite");
type SqliteDatabase = InstanceType<SqliteModule["DatabaseSync"]>;

function recordOf(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function str(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

function counter(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  }
  return undefined;
}

function normalizePath(value: string, caseSensitive: boolean): string {
  const normalized = resolve(value).replace(/\\/g, "/");
  return caseSensitive ? normalized : normalized.toLowerCase();
}

function eventId(row: ZedThreadRow, kind: string, ordinal = 0): string | undefined {
  const threadId = str(row.id);
  if (threadId === undefined) return undefined;
  const hash = createHash("sha256")
    .update(JSON.stringify(["zed", threadId, kind, ordinal]))
    .digest("hex")
    .slice(0, 20);
  return `zed:${hash}`;
}

function timestamp(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) return value.trim();
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  const millis = value > 10_000_000_000 ? value : value * 1000;
  return new Date(millis).toISOString();
}

function zedDbCandidates(ctx: PlanContext): string[] {
  const home = ctx.env.HOME ?? ctx.env.USERPROFILE ?? process.env.HOME ?? process.env.USERPROFILE;
  const appData = ctx.env.APPDATA ?? process.env.APPDATA;
  const localAppData = ctx.env.LOCALAPPDATA ?? process.env.LOCALAPPDATA;
  return [
    appData ? join(appData, "Zed", "threads", "threads.db") : undefined,
    localAppData ? join(localAppData, "Zed", "threads", "threads.db") : undefined,
    home ? join(home, "Library", "Application Support", "Zed", "threads", "threads.db") : undefined,
    home ? join(home, ".local", "share", "zed", "threads", "threads.db") : undefined,
    home ? join(home, ".config", "zed", "threads", "threads.db") : undefined,
  ].filter((candidate): candidate is string => candidate !== undefined);
}

export function zedThreadsDbPath(ctx: PlanContext): string | undefined {
  const option = ctx.options.zedThreadsDb;
  if (typeof option === "string" && option.trim().length > 0) return resolve(ctx.root, option);
  return zedDbCandidates(ctx).find((candidate) => existsSync(candidate));
}

async function loadSqlite(): Promise<SqliteModule | undefined> {
  try {
    return await import("node:sqlite");
  } catch {
    return undefined;
  }
}

function threadMatchesRepo(row: ZedThreadRow, repoRoot: string, caseSensitive: boolean): boolean {
  const folderPaths = str(row.folder_paths);
  if (folderPaths === undefined) return false;
  const repo = normalizePath(repoRoot, caseSensitive);
  try {
    const parsed = JSON.parse(folderPaths);
    if (Array.isArray(parsed)) {
      return parsed.some(
        (path) => typeof path === "string" && normalizePath(path, caseSensitive) === repo,
      );
    }
  } catch {
    // Fall back to exact matching for older/plain string folder path storage.
  }
  return folderPaths
    .split(/\r?\n/)
    .some((path) => path.trim().length > 0 && normalizePath(path.trim(), caseSensitive) === repo);
}

function decodeThreadData(row: ZedThreadRow): string | undefined {
  if (row.data === undefined || row.data === null) return undefined;
  const raw =
    typeof row.data === "string" ? Buffer.from(row.data) : Buffer.from(row.data as Uint8Array);
  if (str(row.data_type)?.toLowerCase() !== "zstd") return raw.toString("utf8");
  const decompress = (zlib as typeof zlib & { zstdDecompressSync?: (input: Buffer) => Buffer })
    .zstdDecompressSync;
  if (decompress === undefined) return undefined;
  try {
    return decompress(raw).toString("utf8");
  } catch {
    return undefined;
  }
}

function parseThreadJson(row: ZedThreadRow): Record<string, unknown> | undefined {
  const raw = decodeThreadData(row);
  if (raw === undefined) return undefined;
  try {
    return recordOf(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

function tokensFromThread(thread: Record<string, unknown>): UsageTokens | undefined {
  const directRaw =
    recordOf(thread.cumulative_token_usage) ??
    recordOf(thread.cumulativeTokenUsage) ??
    recordOf(thread.token_usage) ??
    recordOf(thread.tokens);
  if (directRaw !== undefined) {
    const direct = tokensFromTokenUsage(directRaw);
    if (direct !== undefined) return direct;
    const summed = summedTokensFromMap(directRaw);
    if (summed !== undefined) return summed;
  }
  const requestRaw = recordOf(thread.request_token_usage) ?? recordOf(thread.requestTokenUsage);
  return requestRaw === undefined ? undefined : summedTokensFromMap(requestRaw);
}

function tokensFromTokenUsage(raw: Record<string, unknown>): UsageTokens | undefined {
  const tokens: UsageTokens = {};
  const input = counter(
    raw.input,
    raw.input_tokens,
    raw.inputTokens,
    raw.prompt_tokens,
    raw.promptTokens,
  );
  const output = counter(
    raw.output,
    raw.output_tokens,
    raw.outputTokens,
    raw.completion_tokens,
    raw.completionTokens,
  );
  const cacheRead = counter(
    raw.cacheRead,
    raw.cache_read_tokens,
    raw.cacheReadTokens,
    raw.cache_read_input_tokens,
    raw.cacheReadInputTokens,
  );
  const cacheCreation = counter(
    raw.cacheCreation,
    raw.cache_creation_tokens,
    raw.cacheCreationTokens,
    raw.cache_creation_input_tokens,
    raw.cacheCreationInputTokens,
  );
  if (input !== undefined) tokens.input = input;
  if (output !== undefined) tokens.output = output;
  if (cacheRead !== undefined) tokens.cacheRead = cacheRead;
  if (cacheCreation !== undefined) tokens.cacheCreation = cacheCreation;
  return Object.keys(tokens).length > 0 ? tokens : undefined;
}

function summedTokensFromMap(raw: Record<string, unknown>): UsageTokens | undefined {
  const totals: Required<UsageTokens> = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
  let found = false;
  for (const value of Object.values(raw)) {
    const tokens = recordOf(value)
      ? tokensFromTokenUsage(value as Record<string, unknown>)
      : undefined;
    if (tokens === undefined) continue;
    found = true;
    totals.input += tokens.input ?? 0;
    totals.output += tokens.output ?? 0;
    totals.cacheRead += tokens.cacheRead ?? 0;
    totals.cacheCreation += tokens.cacheCreation ?? 0;
  }
  if (!found) return undefined;
  const tokens: UsageTokens = {};
  if (totals.input > 0) tokens.input = totals.input;
  if (totals.output > 0) tokens.output = totals.output;
  if (totals.cacheRead > 0) tokens.cacheRead = totals.cacheRead;
  if (totals.cacheCreation > 0) tokens.cacheCreation = totals.cacheCreation;
  return Object.keys(tokens).length > 0 ? tokens : undefined;
}

function collectToolUses(
  value: unknown,
  out: Record<string, unknown>[] = [],
): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    for (const item of value) collectToolUses(item, out);
    return out;
  }
  const record = recordOf(value);
  if (record === undefined) return out;
  const toolUse = recordOf(record.ToolUse) ?? recordOf(record.tool_use) ?? recordOf(record.toolUse);
  if (toolUse !== undefined) out.push(toolUse);
  for (const item of Object.values(record)) collectToolUses(item, out);
  return out;
}

function inputOf(toolUse: Record<string, unknown>): Record<string, unknown> {
  return (
    recordOf(toolUse.input) ??
    recordOf(toolUse.tool_input) ??
    recordOf(toolUse.params) ??
    recordOf(toolUse.arguments) ??
    {}
  );
}

function mcpOf(name: string | undefined, input: Record<string, unknown>) {
  const server = str(input.server, input.server_name, input.serverName, input.mcp_server_name);
  const tool = str(input.mcp_tool, input.mcpTool, input.tool, input.name, input.mcp_tool_name);
  if (server && tool) return { server, name: tool };
  if (name?.startsWith("mcp__")) {
    const parts = name.split("__");
    return { server: parts[1], name: parts.slice(2).join("__") || parts[1] };
  }
  if (name?.startsWith("MCP:")) {
    const match = /^MCP:([^:/.]+)[:/.](.+)$/.exec(name);
    if (match) return { server: match[1], name: match[2] };
  }
  return undefined;
}

function eventFromToolUse(
  toolUse: Record<string, unknown>,
  ts: string | undefined,
  id: string | undefined,
): UsageEvent | undefined {
  const name = str(toolUse.name, toolUse.tool_name, toolUse.toolName);
  if (name === undefined) return undefined;
  const input = inputOf(toolUse);
  const base = {
    ...(id === undefined ? {} : { id }),
    ...(ts === undefined ? {} : { ts }),
    tool: "zed",
  };

  if (name === "Task" || name === "task" || name === "Agent" || name === "agent") {
    const skill = str(
      input.subagent_type,
      input.subagentType,
      input.agent_name,
      input.agentName,
      input.agent,
      input.name,
      "subagent",
    );
    const source = str(input.source, input.provenance);
    const event: UsageEvent = { ...base, kind: "skill", name: skill };
    if (source === "ecc" || source === "canon" || source === "user") event.source = source;
    return event;
  }
  if (name === "Skill" || name === "skill") {
    const skill = str(input.command, input.skill, input.name, input.id, "skill");
    const source = str(input.source, input.provenance);
    const event: UsageEvent = { ...base, kind: "skill", name: skill };
    if (source === "ecc" || source === "canon" || source === "user") event.source = source;
    return event;
  }
  const mcp = mcpOf(name, input);
  if (mcp !== undefined) return { ...base, kind: "mcp", server: mcp.server, name: mcp.name };
  return { ...base, kind: "tool", name };
}

function eventsFromThread(row: ZedThreadRow): UsageEvent[] {
  const thread = parseThreadJson(row);
  if (thread === undefined) return [];
  const ts = timestamp(row.updated_at);
  const sessionId = eventId(row, "session");
  const base = {
    ...(sessionId === undefined ? {} : { id: sessionId }),
    ...(ts === undefined ? {} : { ts }),
    tool: "zed",
  };
  const out: UsageEvent[] = [];
  const tokens = tokensFromThread(thread);
  if (tokens !== undefined) out.push({ ...base, kind: "session", tokens });
  for (const [index, toolUse] of collectToolUses(thread).entries()) {
    const event = eventFromToolUse(toolUse, ts, eventId(row, "tool", index));
    if (event !== undefined) out.push(event);
  }
  return out;
}

export async function readZedUsageEvents(
  dbPath: string,
  repoRoot: string,
  options: { caseSensitivePaths: boolean },
): Promise<UsageEvent[]> {
  const sqlite = await loadSqlite();
  if (sqlite === undefined) return [];
  let db: SqliteDatabase | undefined;
  try {
    db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
    const rows = db
      .prepare(
        "SELECT id, summary, updated_at, data_type, data, folder_paths FROM threads ORDER BY updated_at ASC",
      )
      .all() as ZedThreadRow[];
    return rows
      .filter((row) => threadMatchesRepo(row, repoRoot, options.caseSensitivePaths))
      .flatMap((row) => eventsFromThread(row));
  } catch {
    return [];
  } finally {
    db?.close();
  }
}

function usageLineKey(line: string): string {
  try {
    const raw = recordOf(JSON.parse(line));
    if (raw?.tool === "zed" && typeof raw.id === "string") return `zed:${raw.id}`;
  } catch {
    // Preserve malformed pre-existing rows exactly; they just cannot dedupe by id.
  }
  return `line:${line}`;
}

function usageEventKey(event: UsageEvent, line: string): string {
  return event.tool === "zed" && typeof event.id === "string" ? `zed:${event.id}` : `line:${line}`;
}

export function usageLogWithZedEvents(
  existing: string | undefined,
  events: UsageEvent[],
): string | undefined {
  if (events.length === 0) return existing;
  const lines = (existing ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  const indexes = new Map<string, number>();
  lines.forEach((line, index) => {
    indexes.set(usageLineKey(line), index);
  });
  for (const event of events) {
    const line = JSON.stringify(event);
    const key = usageEventKey(event, line);
    const index = indexes.get(key);
    if (index === undefined) {
      indexes.set(key, lines.length);
      lines.push(line);
    } else {
      lines[index] = line;
    }
  }
  return `${lines.join("\n")}\n`;
}

export function existingUsageLog(ctx: PlanContext): string | undefined {
  return readIfExists(join(ctx.root, USAGE_PATH));
}
