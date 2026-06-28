import { isAbsolute, join } from "node:path";
import type { Cli } from "../internals/clis.js";
import { removeManagedBlock } from "../internals/envfile.js";
import type { McpServer } from "./servers.js";

/**
 * Per-CLI MCP config RENDERING — turns aih's canonical {@link McpServer} blueprint
 * into the exact on-disk shape each tool reads. This is what lets `aih mcp --apply`
 * WRITE a correct config for tools that used to be guidance-only ("fallback"): the
 * server map is the same, but the per-tool field names / nesting differ, and writing
 * the wrong shape would be worse than emitting guidance. Shapes verified against each
 * tool's current docs:
 *  - claude / cursor / kiro / kimi → the canonical `mcpServers` JSON aih already
 *    emits (identity — byte-preserves the existing `.mcp.json` golden output);
 *  - gemini  → `mcpServers` `{command, args}` / `{httpUrl}` (~/.gemini/settings.json);
 *  - windsurf→ `mcpServers` `{command, args}` / `{serverUrl}`;
 *  - antigravity → `mcpServers` `{command, args}` / `{url}`;
 *  - copilot → `servers` `{type, command, args}` / `{type:"http", url}` (.vscode/mcp.json);
 *  - opencode→ `mcp` `{type:"local", command:[cmd, ...args], enabled}` / `{type:"remote", url, enabled}`;
 *  - zed     → `context_servers` `{command, args}` / `{url}`;
 *  - codex   → TOML `[mcp_servers."name"]` tables (see {@link mcpTomlBody}).
 * A stdio server's optional `env` rides along under each tool's env key (`env`, or
 * `environment` for OpenCode, or a `[mcp_servers.NAME.env]` sub-table for Codex);
 * http servers never carry env. Pure data transforms — no IO, no network.
 */

/** One tool-shaped MCP server entry (the value under the tool's server-map key). */
export type McpEntry = Record<string, unknown>;

/** Render one canonical server into `cli`'s entry shape. */
export function mcpEntryFor(cli: Cli, s: McpServer): McpEntry {
  switch (cli) {
    case "opencode":
      // command + args collapse into ONE array; `type` is local|remote; `enabled` required.
      // OpenCode's env key is `environment` (merged over process.env), not `env`.
      return s.type === "stdio"
        ? {
            type: "local",
            command: [s.command, ...s.args],
            enabled: true,
            ...(s.env ? { environment: s.env } : {}),
          }
        : { type: "remote", url: s.url, enabled: true };
    case "copilot":
      // VS Code `.vscode/mcp.json` keeps the `type` discriminator.
      return s.type === "stdio"
        ? { type: "stdio", command: s.command, args: s.args, ...(s.env ? { env: s.env } : {}) }
        : { type: "http", url: s.url };
    case "gemini":
      return s.type === "stdio"
        ? { command: s.command, args: s.args, ...(s.env ? { env: s.env } : {}) }
        : { httpUrl: s.url };
    case "windsurf":
      return s.type === "stdio"
        ? { command: s.command, args: s.args, ...(s.env ? { env: s.env } : {}) }
        : { serverUrl: s.url };
    case "zed":
    case "antigravity":
      return s.type === "stdio"
        ? { command: s.command, args: s.args, ...(s.env ? { env: s.env } : {}) }
        : { url: s.url };
    default:
      // claude, cursor, kiro, kimi — the canonical aih shape, unchanged so the
      // existing `.mcp.json` / `.cursor/mcp.json` golden output stays byte-identical.
      return s as unknown as McpEntry;
  }
}

/** Render the whole server map into `cli`'s server-map object (for JSON configs). */
export function mcpEntries(cli: Cli, servers: Record<string, McpServer>): Record<string, McpEntry> {
  const out: Record<string, McpEntry> = {};
  for (const [name, s] of Object.entries(servers)) out[name] = mcpEntryFor(cli, s);
  return out;
}

/**
 * A TOML basic string: quote and escape `\` and `"`. aih's server values are its
 * own hardcoded command names / package args / URLs (see `mcp/servers.ts`) — never
 * user input and never control chars — so escaping the two structural characters is
 * sufficient and correct for every value this emits.
 */
function tomlStr(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** A TOML array of strings: `["a", "b"]`. */
function tomlArray(items: string[]): string {
  return `[${items.map(tomlStr).join(", ")}]`;
}

/**
 * Render the server map as Codex `config.toml` `[mcp_servers."name"]` tables (no
 * markers — {@link upsertTextBlock} wraps these in the aih-managed region). The
 * server NAME is always a quoted key so a dotted name (`awslabs.core-mcp-server`)
 * stays one table instead of splitting into nested tables. stdio → `command`/`args`;
 * http → `url` (Codex's streamable_http transport).
 */
export function mcpTomlBody(servers: Record<string, McpServer>): string {
  return Object.entries(servers)
    .map(([name, s]) => {
      const head = `[mcp_servers.${tomlStr(name)}]`;
      if (s.type === "stdio") {
        const out = [head, `command = ${tomlStr(s.command)}`];
        if (s.args.length > 0) out.push(`args = ${tomlArray(s.args)}`);
        if (s.env) {
          // A nested `[mcp_servers.NAME.env]` table (blank line before it keeps TOML valid).
          out.push(`\n[mcp_servers.${tomlStr(name)}.env]`);
          for (const [k, v] of Object.entries(s.env)) {
            const key = /^[A-Za-z0-9_-]+$/.test(k) ? k : tomlStr(k);
            out.push(`${key} = ${tomlStr(v)}`);
          }
        }
        return out.join("\n");
      }
      return `${head}\nurl = ${tomlStr(s.url)}`;
    })
    .join("\n\n");
}

/** A tool whose MCP config lives outside the repo (a `~/home` or absolute path). */
export function isExternalMcp(configPath: string): boolean {
  return configPath.startsWith("~") || isAbsolute(configPath);
}

/** Resolve a registry config path to an absolute one, expanding a leading `~`. */
export function mcpConfigAbs(home: string, configPath: string): string {
  if (configPath === "~") return home;
  if (configPath.startsWith("~/") || configPath.startsWith("~\\")) {
    return join(home, configPath.slice(2));
  }
  return configPath; // already absolute
}

/**
 * Matches a top-level Codex `[mcp_servers.NAME]` table header — a quoted key OR a
 * bare dotted-key segment — but NOT a sub-table like `[mcp_servers.x.env]` (the name
 * must be the last segment before `]`). Capture group 1 = quoted name, 2 = bare name.
 */
const TOML_SERVER_HEADER = /^[ \t]*\[mcp_servers\.(?:"([^"]+)"|([^.\]"]+))\][ \t]*$/gm;

/** Count direct `[mcp_servers.NAME]` server tables (ignores `.env`/sub-tables). */
export function tomlServerCount(raw: string): number {
  return Array.from(raw.matchAll(TOML_SERVER_HEADER)).length;
}

/**
 * The server names already defined as top-level `[mcp_servers.NAME]` tables in a
 * Codex config, IGNORING aih's own managed `scope` region (those are ours, replaced
 * each run). aih filters its blueprint against this set before writing: a second
 * `[mcp_servers.playwright]` when the user already has one is a TOML duplicate-table
 * PARSE ERROR — so the user's own servers always win and aih only adds what's absent.
 */
export function existingMcpTomlNames(existing: string, scope: string): Set<string> {
  const outside = removeManagedBlock(existing, scope);
  const names = new Set<string>();
  for (const m of outside.matchAll(TOML_SERVER_HEADER)) names.add(m[1] ?? m[2] ?? "");
  return names;
}
