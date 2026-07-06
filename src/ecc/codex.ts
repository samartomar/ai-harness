import { homedir } from "node:os";
import { join } from "node:path";
import { readIfExists } from "../internals/fsxn.js";
import { stripManagedBlock } from "../internals/markers.js";
import { type Action, doc, exec, type PlanContext, probe, writeText } from "../internals/plan.js";
import { lines } from "../internals/render.js";

type CodexMcpTransport = "stdio" | "http" | "mixed" | "unknown";
type CodexMcpScope = "project" | "global" | "planned ECC";

export interface CodexMcpCollision {
  name: string;
  existingScope: CodexMcpScope;
  existingTransport: CodexMcpTransport;
  conflictingScope: CodexMcpScope;
  conflictingTransport: CodexMcpTransport;
}

const ECC_CODEX_MCP_TRANSPORTS = new Map<string, CodexMcpTransport>([
  ["supabase", "stdio"],
  ["playwright", "stdio"],
  ["context7", "stdio"],
  ["exa", "http"],
  ["github", "stdio"],
  ["memory", "stdio"],
  ["sequential-thinking", "stdio"],
]);

const TOML_SERVER_HEADER =
  /^[ \t]*\[mcp_servers\.(?:"([^"]+)"|'([^']+)'|([^.\]'"]+))\][ \t]*(?:#.*)?$/;
const TOML_TABLE_HEADER = /^[ \t]*\[/;
export const CODEX_AGENTS_BLOCK_MARKER = "ecc-codex:agents";
export const CODEX_INSTALL_STATE_FILE = "ecc-aih-install-state.json";

interface CodexTomlFootprint {
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

function tableHeaderPattern(tablePath: string): RegExp {
  const escaped = escapeRegExp(tablePath);
  return new RegExp(`^[ \\t]*\\[${escaped}\\][ \\t]*(?:#.*)?$`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
  const inlinePattern = new RegExp(`^[ \\t]*${escapeRegExp(parts.key)}\\s*=\\s*\\{`);
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
  return entry.match(/^\s*([A-Za-z0-9_-]+)\s*=/)?.[1];
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
  const pattern = new RegExp(`^[ \\t]*${escapeRegExp(key)}\\s*=`);
  for (const line of raw.replace(/\r\n/g, "\n").split("\n")) {
    if (/^[ \t]*\[/.test(line)) return false;
    if (pattern.test(line)) return true;
  }
  return false;
}

function tableKeyExists(raw: string, tablePath: string, key: string): boolean {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const header = tableHeaderPattern(tablePath);
  const tableKeyPattern = new RegExp(`^[ \\t]*${escapeRegExp(key)}\\s*=`);
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

function plannedCodexFootprint(raw: string): CodexTomlFootprint {
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
  footprint.mcpServers = [...ECC_CODEX_MCP_TRANSPORTS.keys()].filter(
    (name) => !mcpServerExists(raw, name),
  );
  return footprint;
}

export function codexInstallStateContents(ctx: PlanContext): string {
  const configRaw = readIfExists(join(codexHomeDir(ctx), "config.toml")) ?? "";
  const existing = readCodexInstallState(ctx);
  const codexToml = unionFootprint(
    existing?.codexToml ?? emptyFootprint(),
    plannedCodexFootprint(configRaw),
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
  const remove = new Set(tablePaths);
  const out: string[] = [];
  let skipping = false;
  for (const line of raw.replace(/\r\n/g, "\n").split("\n")) {
    const header = line.match(/^[ \t]*\[([^\]]+)\][ \t]*(?:#.*)?$/);
    if (header) {
      const table = header[1] ?? "";
      skipping =
        remove.has(table) ||
        (options.includeDescendants === true &&
          [...remove].some((parent) => table.startsWith(`${parent}.`)));
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

function stripCodexTomlFootprint(raw: string, footprint: CodexTomlFootprint): string {
  const usesCrlf = /\r\n/.test(raw);
  const mcpTables = footprint.mcpServers.map((name) => `mcp_servers.${name}`);
  let lines = removeTables(raw, footprint.tables);
  lines = removeTables(lines.join("\n"), mcpTables, { includeDescendants: true });
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

export function codexMcpTransportCollisions(ctx: PlanContext): CodexMcpCollision[] {
  const project = codexMcpTransports(readIfExists(join(ctx.root, ".codex", "config.toml")) ?? "");
  const global = codexMcpTransports(readIfExists(join(codexHomeDir(ctx), "config.toml")) ?? "");
  const collisions: CodexMcpCollision[] = [];
  const pushCollision = (
    name: string,
    existingScope: CodexMcpScope,
    existingTransport: CodexMcpTransport,
    conflictingScope: CodexMcpScope,
    conflictingTransport: CodexMcpTransport,
  ): void => {
    if (
      existingTransport === "unknown" ||
      conflictingTransport === "unknown" ||
      existingTransport === conflictingTransport
    ) {
      return;
    }
    collisions.push({
      name,
      existingScope,
      existingTransport,
      conflictingScope,
      conflictingTransport,
    });
  };

  for (const [name, projectTransport] of project) {
    const globalTransport = global.get(name);
    if (globalTransport !== undefined) {
      pushCollision(name, "project", projectTransport, "global", globalTransport);
    } else {
      const plannedTransport = ECC_CODEX_MCP_TRANSPORTS.get(name);
      if (plannedTransport !== undefined) {
        pushCollision(name, "project", projectTransport, "planned ECC", plannedTransport);
      }
    }
  }
  for (const [name, globalTransport] of global) {
    const plannedTransport = ECC_CODEX_MCP_TRANSPORTS.get(name);
    if (plannedTransport !== undefined) {
      pushCollision(name, "global", globalTransport, "planned ECC", plannedTransport);
    }
  }
  return collisions.sort((a, b) =>
    a.name === b.name
      ? a.existingScope.localeCompare(b.existingScope) ||
        a.conflictingScope.localeCompare(b.conflictingScope)
      : a.name.localeCompare(b.name),
  );
}

export function codexMcpCollisionActions(ctx: PlanContext): Action[] {
  const collisions = codexMcpTransportCollisions(ctx);
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
