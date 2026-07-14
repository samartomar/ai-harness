import { join } from "node:path";
import {
  isActiveManagedMcpProjectionOwnership,
  type ManagedMcpProjectionOwnership,
} from "../config/marker.js";
import { readIfExists } from "../internals/fsxn.js";
import type { PlanContext } from "../internals/plan.js";
import type { Check } from "../internals/verify.js";
import { type OrgPolicy, readOrgPolicy } from "../org-policy/schema.js";
import type { McpServer, StdioServer } from "./servers.js";

export interface ManagedMcpServerCommand {
  serverCommand: string[];
}

export interface ManagedMcpAllowlistSettings {
  allowManagedMcpServersOnly: true;
  allowedMcpServers: ManagedMcpServerCommand[];
}

const MANAGED_MCP_PROJECTION_KEYS = ["allowManagedMcpServersOnly", "allowedMcpServers"] as const;

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

/**
 * Return the Claude managed-MCP fields only when their on-disk pair exactly
 * matches an AIH projection. This excludes same-key operator configuration.
 */
export function matchingGeneratedManagedMcpProjectionKeys(
  value: unknown,
  generated: ManagedMcpAllowlistSettings,
): readonly string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return [];
  const actual = value as Record<string, unknown>;
  if (
    actual.allowManagedMcpServersOnly !== generated.allowManagedMcpServersOnly ||
    JSON.stringify(actual.allowedMcpServers) !== JSON.stringify(generated.allowedMcpServers)
  ) {
    return [];
  }
  return MANAGED_MCP_PROJECTION_KEYS;
}

export function matchesManagedMcpProjectionOwnership(
  value: unknown,
  ownership: ManagedMcpProjectionOwnership | undefined,
): ownership is ManagedMcpProjectionOwnership {
  return (
    isActiveManagedMcpProjectionOwnership(ownership) &&
    matchingGeneratedManagedMcpProjectionKeys(value, ownership.expected).length > 0
  );
}

type JsonRead =
  | { kind: "missing" }
  | { kind: "invalid"; path: string; message: string }
  | { kind: "valid"; value: unknown };

function parseJson(path: string): JsonRead {
  const raw = readIfExists(path);
  if (raw === undefined) return { kind: "missing" };
  try {
    return { kind: "valid", value: JSON.parse(raw) as unknown };
  } catch (err) {
    return { kind: "invalid", path, message: (err as Error).message };
  }
}

type McpCommands =
  | { kind: "missing" | "no-servers" }
  | { kind: "invalid"; path: string; message: string }
  | { kind: "commands"; commands: string[][] };

function policyAllowsManagedServer(name: string, policy: OrgPolicy | undefined): boolean {
  const disabled = new Set(policy?.mcp?.disabledServers ?? []);
  if (disabled.has(name)) return false;
  const allowed = policy?.mcp?.allowedServers ?? [];
  if (policy?.mcp?.allowManagedOnly !== true) return true;
  return allowed.includes(name);
}

function mcpCommands(root: string, policy: OrgPolicy | undefined): McpCommands {
  const parsed = parseJson(join(root, ".mcp.json"));
  if (parsed.kind !== "valid") return parsed;
  const value = parsed.value as { mcpServers?: Record<string, Partial<StdioServer>> };
  if (value.mcpServers === undefined) return { kind: "no-servers" };
  const commands: string[][] = [];
  for (const [name, server] of Object.entries(value.mcpServers)) {
    if (!policyAllowsManagedServer(name, policy)) continue;
    if (
      server.type === "stdio" &&
      typeof server.command === "string" &&
      Array.isArray(server.args) &&
      server.args.every((arg): arg is string => typeof arg === "string")
    ) {
      commands.push([server.command, ...server.args]);
    }
  }
  return { kind: "commands", commands: sortedCommands(commands) };
}

type ManagedCommands =
  | { kind: "missing" | "not-enforced" }
  | { kind: "invalid"; path: string; message: string }
  | { kind: "commands"; commands: string[][] };

function managedCommands(root: string): ManagedCommands {
  const parsed = parseJson(join(root, ".claude", "managed-settings.json"));
  if (parsed.kind !== "valid") return parsed;
  const value = parsed.value as {
    allowManagedMcpServersOnly?: unknown;
    allowedMcpServers?: unknown;
  };
  if (value.allowManagedMcpServersOnly !== true) return { kind: "not-enforced" };
  if (!Array.isArray(value.allowedMcpServers)) return { kind: "commands", commands: [] };
  return {
    kind: "commands",
    commands: sortedCommands(
      value.allowedMcpServers
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
    ),
  };
}

export function mcpManagedAllowlistCheck(ctx: PlanContext): Check {
  const name = "MCP managed allowlist";
  try {
    const actual = managedCommands(ctx.root);
    if (actual.kind === "invalid") {
      return {
        name,
        verdict: "fail",
        detail: `invalid .claude/managed-settings.json: ${actual.message}`,
        code: "mcp.allowlist-drift",
      };
    }
    if (actual.kind !== "commands") {
      return {
        name,
        verdict: "skip",
        detail: "no managed MCP allowlist is enforced in .claude/managed-settings.json",
      };
    }
    const policy = readOrgPolicy(ctx.root, ctx.env);
    const desired = mcpCommands(ctx.root, policy);
    if (desired.kind === "invalid") {
      return {
        name,
        verdict: "fail",
        detail: `invalid .mcp.json: ${desired.message}`,
        code: "mcp.allowlist-drift",
      };
    }
    if (desired.kind !== "commands") {
      return { name, verdict: "skip", detail: "no .mcp.json stdio servers to compare" };
    }
    const desiredKeys = desired.commands.map(commandKey);
    const actualKeys = actual.commands.map(commandKey);
    const missing = desiredKeys.filter((key) => !actualKeys.includes(key));
    const extra = actualKeys.filter((key) => !desiredKeys.includes(key));
    if (missing.length === 0 && extra.length === 0) {
      return {
        name,
        verdict: "pass",
        detail: `${actual.commands.length} managed MCP command${actual.commands.length === 1 ? "" : "s"} match .mcp.json`,
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
