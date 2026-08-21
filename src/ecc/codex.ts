import { homedir } from "node:os";
import { join } from "node:path";
import { readIfExists } from "../internals/fsxn.js";
import { stripManagedBlock } from "../internals/markers.js";
import { type Action, doc, exec, type PlanContext, probe, writeText } from "../internals/plan.js";
import { lines } from "../internals/render.js";
export type CodexMcpTransport = "stdio" | "http" | "mixed" | "unknown";
type CodexMcpScope = "project" | "global" | "planned ECC";

/** Codex's scoped TOML writer accepts this local projection only. */
export type CodexScopedMcpServer =
  | { type: "stdio"; command: string; args: string[]; startupTimeoutSec?: number }
  | { type: "http"; url: string; startupTimeoutSec?: number };
export type CodexScopedMcpServers = Record<string, CodexScopedMcpServer>;

export interface CodexMcpCollision {
  name: string;
  existingScope: CodexMcpScope;
  existingTransport: CodexMcpTransport;
  conflictingScope: CodexMcpScope;
  conflictingTransport: CodexMcpTransport;
}

/**
 * Core owns this one ECC default because the vendor helper currently launches it
 * through a floating npm tag. Its exact package identity is bound to the active
 * external-pin ledger; optional ECC MCPs remain on their scoped policy path.
 */
export function coreOwnedEccCodexMcpServers(): CodexScopedMcpServers {
  return {
    "chrome-devtools": {
      type: "stdio",
      command: "npx",
      args: ["-y", "chrome-devtools-mcp@1.7.0"],
      startupTimeoutSec: 30,
    },
  };
}

// The collision preflight mirrors the Core-owned default above. Optional MCPs
// are registered through AIH's scoped writer, not this vendor-specific path.
const ECC_CODEX_MCP_TRANSPORTS = new Map<string, CodexMcpTransport>([["chrome-devtools", "stdio"]]);

const TOML_SERVER_HEADER =
  /^[ \t]*\[mcp_servers\.(?:"([^"]+)"|'([^']+)'|([^.\]'"]+))\][ \t]*(?:#.*)?$/;
const TOML_TABLE_HEADER = /^[ \t]*\[/;
const CODEX_MCP_BLOCK_BEGIN = "# >>> aih managed (mcp) >>>";
const CODEX_MCP_BLOCK_END = "# <<< aih managed (mcp) <<<";
export const CODEX_AGENTS_BLOCK_MARKER = "ecc-codex:agents";
export const CODEX_INSTALL_STATE_FILE = "ecc-aih-install-state.json";

export interface CodexTomlFootprint {
  rootKeys: string[];
  tables: string[];
  tableKeys: Record<string, string[]>;
  mcpServers: string[];
}

interface CodexInstallState {
  schemaVersion: 1;
  managedBy: "aih";
  codexToml: CodexTomlFootprint;
  agentsBlock: boolean;
}

const CODEX_BASELINE_ROOT_KEYS = [
  "approval_policy",
  "sandbox_mode",
  "web_search",
  "notify",
  "persistent_instructions",
];

const CODEX_BASELINE_TABLE_KEYS: Record<string, string[]> = {
  features: ["multi_agent"],
  "profiles.strict": ["approval_policy", "sandbox_mode", "web_search"],
  "profiles.yolo": ["approval_policy", "sandbox_mode", "web_search"],
  agents: ["max_threads", "max_depth"],
  "agents.explorer": ["description", "config_file"],
  "agents.reviewer": ["description", "config_file"],
  "agents.docs_researcher": ["description", "config_file"],
};

const CODEX_MCP_ALIASES: Record<string, string[]> = {
  context7: ["context7-mcp"],
};

export function codexHomeDir(ctx: PlanContext): string {
  return join(ctx.env.USERPROFILE || ctx.env.HOME || homedir(), ".codex");
}

export function codexInstallStatePath(ctx: PlanContext): string {
  return join(codexHomeDir(ctx), CODEX_INSTALL_STATE_FILE);
}

function tomlHeaderName(match: RegExpMatchArray): string {
  return match[1] ?? match[2] ?? match[3] ?? "";
}

function mergeTransport(
  current: CodexMcpTransport,
  next: Exclude<CodexMcpTransport, "mixed" | "unknown">,
): CodexMcpTransport {
  if (current === "unknown") return next;
  return current === next ? current : "mixed";
}

function codexMcpTransports(raw: string): Map<string, CodexMcpTransport> {
  const transports = new Map<string, CodexMcpTransport>();
  let current: string | undefined;
  for (const line of raw.replace(/\r\n/g, "\n").split("\n")) {
    const table = line.match(TOML_SERVER_HEADER);
    if (table) {
      current = tomlHeaderName(table);
      transports.set(current, transports.get(current) ?? "unknown");
      continue;
    }
    if (TOML_TABLE_HEADER.test(line)) {
      current = undefined;
      continue;
    }
    if (current === undefined) continue;
    const trimmed = line.trim();
    if (/^command\s*=/.test(trimmed)) {
      transports.set(current, mergeTransport(transports.get(current) ?? "unknown", "stdio"));
    } else if (/^url\s*=/.test(trimmed)) {
      transports.set(current, mergeTransport(transports.get(current) ?? "unknown", "http"));
    }
  }
  return transports;
}

function tomlTablePathPattern(tablePath: string): string {
  return tablePath
    .split(".")
    .map((segment) => tomlKeyPattern(segment))
    .join("\\s*\\.\\s*");
}

function tableHeaderPattern(tablePath: string, includeDescendants = false): RegExp {
  const suffix = includeDescendants ? "(?:\\s*\\..+)?" : "";
  return new RegExp(`^[ \\t]*\\[${tomlTablePathPattern(tablePath)}${suffix}\\][ \\t]*(?:#.*)?$`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function tomlKeyPattern(key: string): string {
  const escaped = escapeRegExp(key);
  return `(?:${escaped}|"${escaped}"|'${escaped}')`;
}

function tableRange(
  lines: readonly string[],
  tablePath: string,
): { start: number; end: number } | undefined {
  const header = tableHeaderPattern(tablePath);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (!header.test(line)) continue;
    let end = lines.length;
    for (let next = index + 1; next < lines.length; next += 1) {
      if (TOML_TABLE_HEADER.test(lines[next] ?? "")) {
        end = next;
        break;
      }
    }
    return { start: index + 1, end };
  }
  return undefined;
}

function tableExists(raw: string, tablePath: string): boolean {
  return raw
    .replace(/\r\n/g, "\n")
    .split("\n")
    .some((line) => tableHeaderPattern(tablePath).test(line));
}

function inlineTableParts(tablePath: string): { parentPath: string; key: string } | undefined {
  const lastDot = tablePath.lastIndexOf(".");
  if (lastDot <= 0 || lastDot === tablePath.length - 1) return undefined;
  return { parentPath: tablePath.slice(0, lastDot), key: tablePath.slice(lastDot + 1) };
}

function inlineTableLineIndex(lines: readonly string[], tablePath: string): number | undefined {
  const parts = inlineTableParts(tablePath);
  if (!parts) return undefined;
  const range = tableRange(lines, parts.parentPath);
  if (!range) return undefined;
  const inlinePattern = new RegExp(`^[ \\t]*${tomlKeyPattern(parts.key)}\\s*=\\s*\\{`);
  for (let index = range.start; index < range.end; index += 1) {
    if (inlinePattern.test(lines[index] ?? "")) return index;
  }
  return undefined;
}

function inlineTableExists(raw: string, tablePath: string): boolean {
  return inlineTableLineIndex(raw.replace(/\r\n/g, "\n").split("\n"), tablePath) !== undefined;
}

function inlineTableBody(line: string): string | undefined {
  const start = line.indexOf("{");
  const end = line.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  return line.slice(start + 1, end);
}

function inlineEntryKey(entry: string): string | undefined {
  const match = entry.match(/^\s*(?:([A-Za-z0-9_-]+)|"([^"\\]*(?:\\.[^"\\]*)*)"|'([^']*)')\s*=/);
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

function splitInlineTableEntries(body: string): string[] {
  const entries: string[] = [];
  let start = 0;
  let quote: string | undefined;
  let escaped = false;
  let depth = 0;
  for (let index = 0; index < body.length; index += 1) {
    const ch = body[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === quote) {
        quote = undefined;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "[" || ch === "{") {
      depth += 1;
    } else if ((ch === "]" || ch === "}") && depth > 0) {
      depth -= 1;
    } else if (ch === "," && depth === 0) {
      entries.push(body.slice(start, index));
      start = index + 1;
    }
  }
  entries.push(body.slice(start));
  return entries;
}

function inlineTableKeyExists(raw: string, tablePath: string, key: string): boolean {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const index = inlineTableLineIndex(lines, tablePath);
  if (index === undefined) return false;
  const body = inlineTableBody(lines[index] ?? "");
  if (body === undefined) return false;
  return splitInlineTableEntries(body).some((entry) => inlineEntryKey(entry) === key);
}

function rootKeyExists(raw: string, key: string): boolean {
  const pattern = new RegExp(`^[ \\t]*${tomlKeyPattern(key)}\\s*=`);
  for (const line of raw.replace(/\r\n/g, "\n").split("\n")) {
    if (/^[ \t]*\[/.test(line)) return false;
    if (pattern.test(line)) return true;
  }
  return false;
}

function tableKeyExists(raw: string, tablePath: string, key: string): boolean {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const header = tableHeaderPattern(tablePath);
  const tableKeyPattern = new RegExp(`^[ \\t]*${tomlKeyPattern(key)}\\s*=`);
  let inTable = false;
  for (const line of lines) {
    if (header.test(line)) {
      inTable = true;
      continue;
    }
    if (inTable && /^[ \t]*\[/.test(line)) return false;
    if (inTable && tableKeyPattern.test(line)) return true;
  }
  return inlineTableKeyExists(raw, tablePath, key);
}

function mcpServerExists(raw: string, name: string): boolean {
  return [name, ...(CODEX_MCP_ALIASES[name] ?? [])].some((server) =>
    tableExists(raw, `mcp_servers.${server}`),
  );
}

function emptyFootprint(): CodexTomlFootprint {
  return { rootKeys: [], tables: [], tableKeys: {}, mcpServers: [] };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function readCodexInstallState(ctx: PlanContext): CodexInstallState | undefined {
  const raw = readIfExists(codexInstallStatePath(ctx));
  if (raw === undefined) return undefined;
  try {
    const parsed = JSON.parse(raw) as {
      schemaVersion?: unknown;
      managedBy?: unknown;
      codexToml?: {
        rootKeys?: unknown;
        tables?: unknown;
        tableKeys?: unknown;
        mcpServers?: unknown;
      };
      agentsBlock?: unknown;
    };
    const tableKeys =
      parsed.codexToml?.tableKeys && typeof parsed.codexToml.tableKeys === "object"
        ? Object.fromEntries(
            Object.entries(parsed.codexToml.tableKeys).filter(
              (entry): entry is [string, string[]] => isStringArray(entry[1]),
            ),
          )
        : {};
    if (parsed.schemaVersion !== 1 || parsed.managedBy !== "aih") return undefined;
    return {
      schemaVersion: 1,
      managedBy: "aih",
      codexToml: {
        rootKeys: isStringArray(parsed.codexToml?.rootKeys) ? parsed.codexToml.rootKeys : [],
        tables: isStringArray(parsed.codexToml?.tables) ? parsed.codexToml.tables : [],
        tableKeys,
        mcpServers: isStringArray(parsed.codexToml?.mcpServers) ? parsed.codexToml.mcpServers : [],
      },
      agentsBlock: parsed.agentsBlock === true,
    };
  } catch {
    return undefined;
  }
}

function unionSorted(a: readonly string[], b: readonly string[]): string[] {
  return [...new Set([...a, ...b])].sort();
}

function unionFootprint(
  existing: CodexTomlFootprint,
  next: CodexTomlFootprint,
): CodexTomlFootprint {
  const tableNames = unionSorted(Object.keys(existing.tableKeys), Object.keys(next.tableKeys));
  const tableKeys = Object.fromEntries(
    tableNames.map((name) => [
      name,
      unionSorted(existing.tableKeys[name] ?? [], next.tableKeys[name] ?? []),
    ]),
  );
  return {
    rootKeys: unionSorted(existing.rootKeys, next.rootKeys),
    tables: unionSorted(existing.tables, next.tables),
    tableKeys,
    mcpServers: unionSorted(existing.mcpServers, next.mcpServers),
  };
}

function plannedCodexFootprint(
  raw: string,
  plannedMcpServers: readonly string[] = [...ECC_CODEX_MCP_TRANSPORTS.keys()],
): CodexTomlFootprint {
  const footprint = emptyFootprint();
  footprint.rootKeys = CODEX_BASELINE_ROOT_KEYS.filter((key) => !rootKeyExists(raw, key));
  for (const [table, keys] of Object.entries(CODEX_BASELINE_TABLE_KEYS)) {
    if (!tableExists(raw, table) && !inlineTableExists(raw, table)) {
      footprint.tables.push(table);
      continue;
    }
    const missingKeys = keys.filter((key) => !tableKeyExists(raw, table, key));
    if (missingKeys.length > 0) footprint.tableKeys[table] = missingKeys;
  }
  footprint.mcpServers = plannedMcpServers.filter((name) => !mcpServerExists(raw, name));
  return footprint;
}

export function codexInstallStateContents(
  ctx: PlanContext,
  plannedMcpServers?: readonly string[],
  suppressRuntimeConfig = false,
): string {
  const configRaw = readIfExists(join(codexHomeDir(ctx), "config.toml")) ?? "";
  const existing = readCodexInstallState(ctx);
  const codexToml = unionFootprint(
    existing?.codexToml ?? emptyFootprint(),
    suppressRuntimeConfig ? emptyFootprint() : plannedCodexFootprint(configRaw, plannedMcpServers),
  );
  const state: CodexInstallState = {
    schemaVersion: 1,
    managedBy: "aih",
    codexToml,
    agentsBlock: true,
  };
  return `${JSON.stringify(state, null, 2)}\n`;
}

function keyPattern(key: string): RegExp {
  return new RegExp(`^[ \\t]*${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=`);
}

function bracketDelta(line: string): number {
  let delta = 0;
  for (const ch of line) {
    if (ch === "[") delta += 1;
    else if (ch === "]") delta -= 1;
  }
  return delta;
}

function removeKeysFromScope(
  lines: string[],
  tablePath: string | undefined,
  keys: Set<string>,
): string[] {
  if (keys.size === 0) return lines;
  const out: string[] = [];
  const tableHeader = tablePath ? tableHeaderPattern(tablePath) : undefined;
  let inScope = tablePath === undefined;
  let skippingKey = false;
  let bracketDepth = 0;

  for (const line of lines) {
    if (skippingKey) {
      bracketDepth += bracketDelta(line);
      if (bracketDepth <= 0) skippingKey = false;
      continue;
    }

    if (tableHeader?.test(line)) {
      inScope = true;
      out.push(line);
      continue;
    }
    if (/^[ \t]*\[/.test(line)) {
      if (tablePath === undefined) inScope = false;
      else if (inScope) inScope = false;
    }

    const matchedKey = inScope ? [...keys].find((key) => keyPattern(key).test(line)) : undefined;
    if (matchedKey) {
      bracketDepth = bracketDelta(line);
      skippingKey = bracketDepth > 0;
      continue;
    }
    out.push(line);
  }
  return out;
}

function removeTables(
  raw: string,
  tablePaths: readonly string[],
  options: { includeDescendants?: boolean } = {},
): string[] {
  const patterns = tablePaths.map((tablePath) =>
    tableHeaderPattern(tablePath, options.includeDescendants === true),
  );
  const out: string[] = [];
  let skipping = false;
  for (const line of raw.replace(/\r\n/g, "\n").split("\n")) {
    if (/^[ \t]*\[[^\]]+\][ \t]*(?:#.*)?$/.test(line)) {
      skipping = patterns.some((pattern) => pattern.test(line));
      if (skipping) continue;
    }
    if (!skipping) out.push(line);
  }
  return out;
}

function removeInlineTableKeys(lines: string[], tablePath: string, keys: Set<string>): string[] {
  if (keys.size === 0) return lines;
  const index = inlineTableLineIndex(lines, tablePath);
  if (index === undefined) return lines;
  const line = lines[index];
  if (line === undefined) return lines;
  const start = line.indexOf("{");
  const end = line.lastIndexOf("}");
  if (start < 0 || end <= start) return lines;
  const entries = splitInlineTableEntries(line.slice(start + 1, end));
  const kept = entries
    .map((entry) => entry.trim())
    .filter((entry) => {
      if (entry.length === 0) return false;
      const key = inlineEntryKey(entry);
      return key === undefined || !keys.has(key);
    });
  const nextLine = `${line.slice(0, start + 1)}${kept.length > 0 ? ` ${kept.join(", ")} ` : ""}${line.slice(end)}`;
  return lines.map((entry, entryIndex) => (entryIndex === index ? nextLine : entry));
}

function stripManagedMcpTables(raw: string, claimedNames: readonly string[]): string {
  if (claimedNames.length === 0) return raw;
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const begins = lines
    .map((line, index) => (line === CODEX_MCP_BLOCK_BEGIN ? index : -1))
    .filter((index) => index >= 0);
  const ends = lines
    .map((line, index) => (line === CODEX_MCP_BLOCK_END ? index : -1))
    .filter((index) => index >= 0);
  if (begins.length !== 1 || ends.length !== 1) return raw;
  const begin = begins[0];
  const end = ends[0];
  if (begin === undefined || end === undefined || begin >= end) return raw;

  const sections: Array<{ name: string; lines: string[] }> = [];
  let current: { name: string; lines: string[] } | undefined;
  const names = new Set<string>();
  for (const line of lines.slice(begin + 1, end)) {
    const header = line.match(TOML_SERVER_HEADER);
    if (header) {
      if (current !== undefined) sections.push(current);
      const name = tomlHeaderName(header);
      if (names.has(name)) return raw;
      names.add(name);
      current = { name, lines: [line] };
    } else if (TOML_TABLE_HEADER.test(line)) {
      if (
        current === undefined ||
        !tableHeaderPattern(`mcp_servers.${current.name}`, true).test(line)
      ) {
        return raw;
      }
      current.lines.push(line);
    } else if (current !== undefined) {
      current.lines.push(line);
    } else if (line.trim().length > 0) {
      return raw;
    }
  }
  if (current !== undefined) sections.push(current);
  const claimed = new Set(claimedNames);
  const retained = sections.filter((section) => !claimed.has(section.name));
  if (retained.length === sections.length) return raw;
  const body = retained.map((section) => section.lines.join("\n").replace(/\n+$/, "")).join("\n\n");
  const replacement = body.length > 0 ? [CODEX_MCP_BLOCK_BEGIN, body, CODEX_MCP_BLOCK_END] : [];
  return [...lines.slice(0, begin), ...replacement, ...lines.slice(end + 1)].join("\n");
}

export function stripCodexTomlFootprint(raw: string, footprint: CodexTomlFootprint): string {
  const usesCrlf = /\r\n/.test(raw);
  const mcpStripped = stripManagedMcpTables(raw, footprint.mcpServers);
  let lines = removeTables(mcpStripped, footprint.tables);
  lines = removeKeysFromScope(lines, undefined, new Set(footprint.rootKeys));
  for (const [table, keys] of Object.entries(footprint.tableKeys)) {
    const keySet = new Set(keys);
    lines = removeKeysFromScope(lines, table, keySet);
    lines = removeInlineTableKeys(lines, table, keySet);
  }
  let next = lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+/, "")
    .replace(/\n+$/, "");
  if (next.length > 0) next += "\n";
  return usesCrlf ? next.replace(/\n/g, "\r\n") : next;
}

export function codexMcpTransportCollisions(
  ctx: PlanContext,
  scopedPlannedTransports?: ReadonlyMap<string, CodexMcpTransport>,
): CodexMcpCollision[] {
  const project = codexMcpTransports(readIfExists(join(ctx.root, ".codex", "config.toml")) ?? "");
  const global = codexMcpTransports(readIfExists(join(codexHomeDir(ctx), "config.toml")) ?? "");
  const plannedTransports = scopedPlannedTransports ?? ECC_CODEX_MCP_TRANSPORTS;
  const collisions: CodexMcpCollision[] = [];
  const pushCollision = (
    name: string,
    existingScope: CodexMcpScope,
    existingTransport: CodexMcpTransport,
    conflictingScope: CodexMcpScope,
    conflictingTransport: CodexMcpTransport,
    strictUnknown = false,
  ): void => {
    const unknown = existingTransport === "unknown" || conflictingTransport === "unknown";
    if (unknown && !strictUnknown) return;
    if (!unknown && existingTransport === conflictingTransport && existingTransport !== "mixed")
      return;
    collisions.push({
      name,
      existingScope,
      existingTransport,
      conflictingScope,
      conflictingTransport,
    });
  };

  for (const [name, projectTransport] of project) {
    const plannedTransport = plannedTransports.get(name);
    const globalTransport = global.get(name);
    if (plannedTransport !== undefined) {
      pushCollision(name, "project", projectTransport, "planned ECC", plannedTransport, true);
    } else if (globalTransport !== undefined) {
      pushCollision(name, "project", projectTransport, "global", globalTransport);
    }
  }
  for (const [name, globalTransport] of global) {
    const plannedTransport = plannedTransports.get(name);
    if (plannedTransport !== undefined) {
      pushCollision(name, "global", globalTransport, "planned ECC", plannedTransport, true);
    }
  }
  return collisions.sort((a, b) =>
    a.name === b.name
      ? a.existingScope.localeCompare(b.existingScope) ||
        a.conflictingScope.localeCompare(b.conflictingScope)
      : a.name.localeCompare(b.name),
  );
}

export function codexMcpCollisionActions(
  ctx: PlanContext,
  scopedPlannedTransports?: ReadonlyMap<string, CodexMcpTransport>,
): Action[] {
  const collisions = codexMcpTransportCollisions(ctx, scopedPlannedTransports);
  if (collisions.length === 0) return [];
  const summary = collisions
    .map(
      (c) =>
        `${c.name} (${c.existingScope} ${c.existingTransport}, ` +
        `${c.conflictingScope} ${c.conflictingTransport})`,
    )
    .join(", ");
  return [
    doc(
      "Codex MCP server name collision — fix before running ECC",
      lines(
        "The Codex project-local config and either the global config or ECC's planned",
        "global MCP additions define the same server name with different transports.",
        "Running ECC now could leave Codex with a combined config that has both stdio",
        "and remote fields for one server name.",
        "",
        `Collision(s): ${summary}.`,
        "",
        "Resolve each collision, then rerun `aih ecc --cli codex --apply`.",
      ),
    ),
    probe("Codex MCP server name collision", () => ({
      name: "Codex MCP server name collision",
      verdict: "fail",
      code: "mcp.config-invalid",
      detail: summary,
    })),
  ];
}

export function codexAgentsBlockRemovalAction(ctx: PlanContext): Action | undefined {
  const agentsPath = join(codexHomeDir(ctx), "AGENTS.md");
  const existing = readIfExists(agentsPath);
  if (existing === undefined) return undefined;
  const stripped = stripManagedBlock(existing, CODEX_AGENTS_BLOCK_MARKER);
  if (stripped === existing) return undefined;
  return writeText(
    agentsPath,
    stripped,
    "subtract ECC Codex AGENTS block from ~/.codex/AGENTS.md (codex dropped)",
    { external: true },
  );
}

export function codexConfigRemovalAction(ctx: PlanContext): Action | undefined {
  const state = readCodexInstallState(ctx);
  if (!state) return undefined;
  const configPath = join(codexHomeDir(ctx), "config.toml");
  const existing = readIfExists(configPath);
  if (existing === undefined) return undefined;
  const stripped = stripCodexTomlFootprint(existing, state.codexToml);
  if (stripped === existing) return undefined;
  return writeText(
    configPath,
    stripped,
    "subtract ECC Codex TOML footprint from ~/.codex/config.toml (codex dropped)",
    { external: true },
  );
}

export function codexInstallStateCleanupAction(ctx: PlanContext): Action | undefined {
  const statePath = codexInstallStatePath(ctx);
  if (readIfExists(statePath) === undefined) return undefined;
  return exec("remove aih ECC Codex install-state after prune cleanup (under --apply)", [
    "node",
    "-e",
    "const fs=require('fs'); fs.rmSync(process.argv[1], { force: true });",
    statePath,
  ]);
}
