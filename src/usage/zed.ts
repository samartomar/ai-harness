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

function normalizePath(value: string): string {
  return resolve(value).replace(/\\/g, "/").toLowerCase();
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

function threadMatchesRepo(row: ZedThreadRow, repoRoot: string): boolean {
  const folderPaths = str(row.folder_paths);
  if (folderPaths === undefined) return true;
  const repo = normalizePath(repoRoot);
  try {
    const parsed = JSON.parse(folderPaths);
    if (Array.isArray(parsed)) {
      return parsed.some((path) => typeof path === "string" && normalizePath(path) === repo);
    }
  } catch {
    // Fall back to a substring match for older/plain string folder path storage.
  }
  return folderPaths.replace(/\\\\/g, "\\").replace(/\\/g, "/").toLowerCase().includes(repo);
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
  const raw =
    recordOf(thread.request_token_usage) ??
    recordOf(thread.requestTokenUsage) ??
    recordOf(thread.token_usage) ??
    recordOf(thread.tokens);
  if (raw === undefined) return undefined;
  const tokens: UsageTokens = {};
  const input = counter(raw.input, raw.input_tokens, raw.prompt_tokens);
  const output = counter(raw.output, raw.output_tokens, raw.completion_tokens);
  const cacheRead = counter(raw.cacheRead, raw.cache_read_tokens, raw.cache_read_input_tokens);
  const cacheCreation = counter(
    raw.cacheCreation,
    raw.cache_creation_tokens,
    raw.cache_creation_input_tokens,
  );
  if (input !== undefined) tokens.input = input;
  if (output !== undefined) tokens.output = output;
  if (cacheRead !== undefined) tokens.cacheRead = cacheRead;
  if (cacheCreation !== undefined) tokens.cacheCreation = cacheCreation;
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
): UsageEvent | undefined {
  const name = str(toolUse.name, toolUse.tool_name, toolUse.toolName);
  if (name === undefined) return undefined;
  const input = inputOf(toolUse);
  const base = ts === undefined ? { tool: "zed" } : { ts, tool: "zed" };

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
  const base = ts === undefined ? { tool: "zed" } : { ts, tool: "zed" };
  const out: UsageEvent[] = [];
  const tokens = tokensFromThread(thread);
  if (tokens !== undefined) out.push({ ...base, kind: "session", tokens });
  for (const toolUse of collectToolUses(thread)) {
    const event = eventFromToolUse(toolUse, ts);
    if (event !== undefined) out.push(event);
  }
  return out;
}

export async function readZedUsageEvents(dbPath: string, repoRoot: string): Promise<UsageEvent[]> {
  const sqlite = await loadSqlite();
  if (sqlite === undefined) return [];
  const db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db
      .prepare(
        "SELECT id, summary, updated_at, data_type, data, folder_paths FROM threads ORDER BY updated_at ASC",
      )
      .all() as ZedThreadRow[];
    return rows
      .filter((row) => threadMatchesRepo(row, repoRoot))
      .flatMap((row) => eventsFromThread(row));
  } catch {
    return [];
  } finally {
    db.close();
  }
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
  const seen = new Set(lines);
  for (const event of events) {
    const line = JSON.stringify(event);
    if (!seen.has(line)) {
      seen.add(line);
      lines.push(line);
    }
  }
  return `${lines.join("\n")}\n`;
}

export function existingUsageLog(ctx: PlanContext): string | undefined {
  return readIfExists(join(ctx.root, USAGE_PATH));
}
