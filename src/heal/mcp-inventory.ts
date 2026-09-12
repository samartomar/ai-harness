import { lstatSync } from "node:fs";
import { join } from "node:path";
import { NATIVE_MCP_TARGETS, type NativeMcpTarget } from "../config/marker.js";
import { homeDir } from "../internals/cli-detect.js";
import { entry, REGISTRY_IDS } from "../internals/cli-registry.js";
import type { Cli } from "../internals/clis.js";
import { readRegularFile } from "../internals/fsxn.js";
import type { PlanContext } from "../internals/plan.js";
import type { Check } from "../internals/verify.js";
import { nativeConfigEntries, strictJsonObject } from "../mcp/native-projection-format.js";
import { isExternalMcp, mcpConfigAbs } from "../mcp/render.js";
import { resolveTargetSet } from "../report/cli-coverage.js";

export type McpReadinessState = "unverified" | "unavailable" | "disabled";
export type McpRequirement = "required" | "optional" | "unspecified";

export interface McpReadinessServer {
  targetCli: Cli;
  configPath: string;
  name: string;
  selected: boolean;
  required: McpRequirement;
  state: McpReadinessState;
  reason:
    | "native-disabled"
    | "missing-auth-env"
    | "configured-not-exercised"
    | "npx-unavailable"
    | "uvx-unavailable";
  detail: string;
  nextStep: string;
}

export interface McpInventoryIssue {
  targetCli: Cli;
  configPath: string;
  selected: boolean;
  check: Check;
  nextStep: string;
}

export interface McpInventory {
  servers: McpReadinessServer[];
  issues: McpInventoryIssue[];
  launchers: Map<McpReadinessServer, "npx" | "uvx">;
  configurationPresent: boolean;
}

function projectPaths(cli: Cli): string[] {
  const mcp = entry(cli).mcp;
  return [
    ...(mcp.configPath && !isExternalMcp(mcp.configPath) ? [mcp.configPath] : []),
    ...(mcp.governed
      ? [mcp.governed.configPath, ...(mcp.governed.alternateConfigPaths ?? [])]
      : []),
  ];
}

function paths(ctx: PlanContext): Array<{ cli: Cli; path: string; selected: boolean }> {
  const selected = new Set(resolveTargetSet(ctx).targeted);
  const seen = new Set<string>();
  const out: Array<{ cli: Cli; path: string; selected: boolean }> = [];
  for (const rawCli of REGISTRY_IDS) {
    const cli = rawCli as Cli;
    const candidates = projectPaths(cli);
    const global = entry(cli).mcp.configPath;
    if (selected.has(cli) && global && isExternalMcp(global)) candidates.push(global);
    for (const path of candidates) {
      const key = `${cli}\0${path}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push({ cli, path, selected: selected.has(cli) });
      }
    }
  }
  return out;
}

function entries(cli: Cli, source: string): Record<string, unknown> {
  if ((NATIVE_MCP_TARGETS as readonly string[]).includes(cli)) {
    return nativeConfigEntries(cli as NativeMcpTarget, source);
  }
  const mcp = entry(cli).mcp;
  const object = strictJsonObject(source);
  const value = object[mcp.configKey ?? ""];
  if (value === undefined) return {};
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("MCP server map is not an object");
  return value as Record<string, unknown>;
}

function commandOf(cli: Cli, value: unknown): string | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const command = (value as Record<string, unknown>).command;
  if (cli === "opencode" && Array.isArray(command)) {
    return typeof command[0] === "string" ? command[0] : undefined;
  }
  return typeof command === "string" ? command : undefined;
}

function disabled(cli: Cli, value: unknown): boolean {
  if ((cli !== "codex" && cli !== "opencode") || value === null || typeof value !== "object")
    return false;
  return (value as Record<string, unknown>).enabled === false;
}

function required(cli: Cli, value: unknown): McpRequirement {
  if (cli !== "codex" || value === null || typeof value !== "object") return "unspecified";
  const valueRequired = (value as Record<string, unknown>).required;
  return valueRequired === true ? "required" : valueRequired === false ? "optional" : "unspecified";
}

function missingCodexAuth(value: unknown, env: NodeJS.ProcessEnv): string[] {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return [];
  const record = value as Record<string, unknown>;
  const names: string[] = [];
  if (record.required !== undefined && typeof record.required !== "boolean")
    throw new Error("invalid required flag");
  if (record.enabled !== undefined && typeof record.enabled !== "boolean")
    throw new Error("invalid enabled flag");
  if (record.bearer_token_env_var !== undefined) {
    if (typeof record.bearer_token_env_var !== "string")
      throw new Error("invalid bearer token env reference");
    names.push(record.bearer_token_env_var);
  }
  if (record.env_http_headers !== undefined) {
    if (
      record.env_http_headers === null ||
      typeof record.env_http_headers !== "object" ||
      Array.isArray(record.env_http_headers)
    )
      throw new Error("invalid HTTP header environment references");
    for (const name of Object.values(record.env_http_headers as Record<string, unknown>)) {
      if (typeof name !== "string") throw new Error("invalid HTTP header environment reference");
      names.push(name);
    }
  }
  // Malformed references must not be echoed as if they were safe variable names.
  if (names.some((name) => !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(name))) {
    throw new Error("invalid authentication environment reference");
  }
  return [...new Set(names)].filter((name) => !env[name]?.trim());
}

export function inventoryMcpReadiness(ctx: PlanContext): McpInventory {
  const servers: McpReadinessServer[] = [];
  const issues: McpInventoryIssue[] = [];
  const launchers = new Map<McpReadinessServer, "npx" | "uvx">();
  let configurationPresent = false;
  for (const candidate of paths(ctx)) {
    const abs = isExternalMcp(candidate.path)
      ? mcpConfigAbs(homeDir(ctx), candidate.path)
      : join(ctx.root, candidate.path);
    let raw: string | undefined;
    try {
      // Only ENOENT establishes absence. Denied access, dangling links and
      // nonregular files must remain visible even when a boolean exists check
      // would collapse them into the missing case.
      lstatSync(abs);
      raw = readRegularFile(abs)?.toString("utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
    }
    if (raw === undefined) {
      issues.push({
        targetCli: candidate.cli,
        configPath: candidate.path,
        selected: candidate.selected,
        check: {
          name: `mcp: ${candidate.cli} configuration`,
          verdict: "fail",
          code: "mcp.config-invalid",
          detail: "registered MCP configuration is not a regular readable file",
        },
        nextStep: "repair the registered MCP configuration before runtime acceptance",
      });
      continue;
    }
    configurationPresent = true;
    try {
      for (const [name, value] of Object.entries(entries(candidate.cli, raw))) {
        if (value === null || typeof value !== "object" || Array.isArray(value))
          throw new Error("MCP server entry is not an object");
        const command = commandOf(candidate.cli, value);
        const isDisabled = disabled(candidate.cli, value);
        const missingAuth = candidate.cli === "codex" ? missingCodexAuth(value, ctx.env) : [];
        const server: McpReadinessServer = {
          targetCli: candidate.cli,
          configPath: candidate.path,
          name,
          selected: candidate.selected,
          required: required(candidate.cli, value),
          state: isDisabled ? "disabled" : missingAuth.length > 0 ? "unavailable" : "unverified",
          reason: isDisabled
            ? "native-disabled"
            : missingAuth.length > 0
              ? "missing-auth-env"
              : "configured-not-exercised",
          detail: isDisabled
            ? "native configuration disables this MCP server"
            : missingAuth.length > 0
              ? `authentication environment reference is absent in the preflight environment: ${missingAuth.join(", ")}`
              : "configured server has not been launched or invoked",
          nextStep: isDisabled
            ? "keep it disabled unless this workflow requires it"
            : missingAuth.length > 0
              ? `set ${missingAuth.join(", ")} in the client environment, then follow docs/governed-mcp.md#bounded-native-acceptance`
              : "follow docs/governed-mcp.md#bounded-native-acceptance",
        };
        servers.push(server);
        if (command === "npx" || command === "uvx") launchers.set(server, command);
      }
    } catch (_error) {
      issues.push({
        targetCli: candidate.cli,
        configPath: candidate.path,
        selected: candidate.selected,
        check: {
          name: `mcp: ${candidate.cli} configuration`,
          verdict: "fail",
          code: "mcp.config-invalid",
          detail: "registered MCP configuration is malformed or unsupported",
        },
        nextStep: "repair the registered MCP configuration before runtime acceptance",
      });
    }
  }
  return { servers, issues, launchers, configurationPresent };
}
