import { join } from "node:path";
import { readIfExists } from "../internals/fsxn.js";
import type { PlanContext } from "../internals/plan.js";
import type { Check } from "../internals/verify.js";
import type { McpServer, StdioServer } from "./servers.js";

export interface ManagedMcpServerCommand {
  serverCommand: string[];
}

export interface ManagedMcpAllowlistSettings {
  allowManagedMcpServersOnly: true;
  allowedMcpServers: ManagedMcpServerCommand[];
}

function stdioCommand(server: StdioServer): string[] {
  return [server.command, ...server.args];
}

function commandKey(command: readonly string[]): string {
  return JSON.stringify([...command]);
}

function sortedCommands(commands: readonly string[][]): string[][] {
  return [...commands].sort((a, b) => commandKey(a).localeCompare(commandKey(b)));
}

export function managedMcpAllowlistSettings(
  servers: Record<string, McpServer>,
): ManagedMcpAllowlistSettings {
  const commands = Object.values(servers)
    .filter((server): server is StdioServer => server.type === "stdio")
    .map(stdioCommand);
  return {
    allowManagedMcpServersOnly: true,
    allowedMcpServers: sortedCommands(commands).map((serverCommand) => ({ serverCommand })),
  };
}

function parseJson(path: string): unknown | undefined {
  const raw = readIfExists(path);
  if (raw === undefined) return undefined;
  return JSON.parse(raw) as unknown;
}

function mcpCommands(root: string): string[][] | undefined {
  const parsed = parseJson(join(root, ".mcp.json")) as
    | { mcpServers?: Record<string, Partial<StdioServer>> }
    | undefined;
  if (parsed?.mcpServers === undefined) return undefined;
  const commands: string[][] = [];
  for (const server of Object.values(parsed.mcpServers)) {
    if (
      server.type === "stdio" &&
      typeof server.command === "string" &&
      Array.isArray(server.args) &&
      server.args.every((arg): arg is string => typeof arg === "string")
    ) {
      commands.push([server.command, ...server.args]);
    }
  }
  return sortedCommands(commands);
}

function managedCommands(root: string): string[][] | undefined {
  const parsed = parseJson(join(root, ".claude", "managed-settings.json")) as
    | { allowManagedMcpServersOnly?: unknown; allowedMcpServers?: unknown }
    | undefined;
  if (parsed?.allowManagedMcpServersOnly !== true) return undefined;
  if (!Array.isArray(parsed.allowedMcpServers)) return [];
  return sortedCommands(
    parsed.allowedMcpServers
      .map((entry) =>
        entry &&
        typeof entry === "object" &&
        Array.isArray((entry as { serverCommand?: unknown }).serverCommand)
          ? (entry as { serverCommand: unknown[] }).serverCommand.filter(
              (arg): arg is string => typeof arg === "string",
            )
          : [],
      )
      .filter((command) => command.length > 0),
  );
}

export function mcpManagedAllowlistCheck(ctx: PlanContext): Check {
  const name = "MCP managed allowlist";
  try {
    const desired = mcpCommands(ctx.root);
    const actual = managedCommands(ctx.root);
    if (actual === undefined) {
      return {
        name,
        verdict: "skip",
        detail: "no managed MCP allowlist is enforced in .claude/managed-settings.json",
      };
    }
    if (desired === undefined) {
      return { name, verdict: "skip", detail: "no .mcp.json stdio servers to compare" };
    }
    const desiredKeys = desired.map(commandKey);
    const actualKeys = actual.map(commandKey);
    const missing = desiredKeys.filter((key) => !actualKeys.includes(key));
    const extra = actualKeys.filter((key) => !desiredKeys.includes(key));
    if (missing.length === 0 && extra.length === 0) {
      return {
        name,
        verdict: "pass",
        detail: `${actual.length} managed MCP command${actual.length === 1 ? "" : "s"} match .mcp.json`,
      };
    }
    return {
      name,
      verdict: "fail",
      detail: `allowlist drift: missing ${missing.join(", ") || "(none)"}; extra ${extra.join(", ") || "(none)"}`,
      code: "mcp.allowlist-drift",
    };
  } catch (err) {
    return {
      name,
      verdict: "fail",
      detail: `could not compare MCP allowlist: ${(err as Error).message}`,
      code: "mcp.allowlist-drift",
    };
  }
}
