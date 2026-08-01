import { join } from "node:path";
import {
  AIH_CONFIG_FILE,
  isActiveManagedMcpProjectionOwnership,
  type ManagedMcpProjectionOwnership,
} from "../config/marker.js";
import { isTargeted } from "../internals/cli-detect.js";
import { owningCli } from "../internals/cli-registry.js";
import type { Cli } from "../internals/clis.js";
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

/** The managed-settings file this check reads; its owning CLI scopes the whole probe. */
const MANAGED_SETTINGS_PATH = ".claude/managed-settings.json";

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
 * The hardened launch prefix the current generation emits for uvx-run MCP
 * servers (see `src/mcp/servers.ts`). Earlier aih generations emitted the same
 * command without this prefix (and, across releases, with older version pins).
 * The prefix is the positive fingerprint that lets doctor attribute an on-disk
 * delta to aih's own generated output evolving rather than to a local edit.
 */
const GENERATION_HARDENED_LAUNCH_FLAGS = [
  "--offline",
  "--no-python-downloads",
  "--no-env-file",
] as const;

function packageBase(spec: string): string {
  const at = spec.lastIndexOf("@");
  return at > 0 ? spec.slice(0, at) : spec;
}

function hasHardenedPrefix(args: readonly string[]): boolean {
  return (
    args.length > GENERATION_HARDENED_LAUNCH_FLAGS.length &&
    GENERATION_HARDENED_LAUNCH_FLAGS.every((flag, i) => args[i] === flag)
  );
}

/** Human name for a managed server command: the package spec without its version pin. */
export function managedServerDisplayName(command: readonly string[]): string {
  const args = command.slice(1);
  const rest = hasHardenedPrefix(args) ? args.slice(GENERATION_HARDENED_LAUNCH_FLAGS.length) : args;
  return packageBase(rest[0] ?? "") || command[0] || "<empty>";
}

/**
 * True when `actual` is a launch shape an EARLIER aih generation produced for
 * the current `expected` command. Recognition is strict and fail-closed:
 * `expected` must carry the current hardened prefix (only aih's own generated
 * output is a valid attribution anchor), and `actual` may differ from it only
 * in the known generation evolutions — the missing prefix (pre-hardening
 * output) and/or an older/absent version pin of the same package. Anything
 * else stays unattributed so real local edits keep failing as drift.
 */
export function previousGenerationCommandForm(
  actual: readonly string[],
  expected: readonly string[],
): boolean {
  const command = expected[0];
  if (command === undefined || actual[0] !== command) return false;
  if (commandKey(actual) === commandKey(expected)) return false;
  const expectedArgs = expected.slice(1);
  if (!hasHardenedPrefix(expectedArgs)) return false;
  const expectedRest = expectedArgs.slice(GENERATION_HARDENED_LAUNCH_FLAGS.length);
  const actualArgs = actual.slice(1);
  const actualRest = hasHardenedPrefix(actualArgs)
    ? actualArgs.slice(GENERATION_HARDENED_LAUNCH_FLAGS.length)
    : actualArgs;
  if (actualRest.length !== expectedRest.length || expectedRest.length === 0) return false;
  const base = packageBase(expectedRest[0] ?? "");
  if (base.length === 0 || packageBase(actualRest[0] ?? "") !== base) return false;
  return expectedRest.slice(1).every((arg, i) => actualRest[i + 1] === arg);
}

export interface ManagedAllowlistGenerationDelta {
  /** On-disk commands recognized as an earlier generation's launch shape, with their current counterpart. */
  previous: { actual: string[]; expected: string[] }[];
  /** Expected commands with no on-disk counterpart (introduced by a newer generation). */
  added: string[][];
}

/**
 * Attribute the difference between an on-disk managed allowlist and the
 * currently generated one to aih's own generation history — or refuse.
 * Every on-disk command must be either exactly a current command or a
 * recognized previous-generation form of a distinct current command, and at
 * least one previous-generation form must be present (a purely additive delta
 * has no fingerprint and could equally be a local deletion). Returns
 * `undefined` when any command cannot be positively attributed.
 */
export function managedAllowlistGenerationDelta(
  actual: readonly string[][],
  expected: readonly string[][],
): ManagedAllowlistGenerationDelta | undefined {
  const remaining = [...expected];
  const unpaired: string[][] = [];
  for (const command of actual) {
    const exact = remaining.findIndex((candidate) => commandKey(candidate) === commandKey(command));
    if (exact === -1) unpaired.push([...command]);
    else remaining.splice(exact, 1);
  }
  const previous: ManagedAllowlistGenerationDelta["previous"] = [];
  for (const command of unpaired) {
    const match = remaining.findIndex((candidate) =>
      previousGenerationCommandForm(command, candidate),
    );
    if (match === -1) return undefined;
    previous.push({ actual: command, expected: [...(remaining[match] as string[])] });
    remaining.splice(match, 1);
  }
  if (previous.length === 0) return undefined;
  return { previous, added: remaining.map((command) => [...command]) };
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
    // The allowlist lives in ONE tool's config dir, and org-policy projection writes it
    // only when that tool is targeted. With the owner untargeted, every repair below is
    // unsatisfiable by construction, so report the residue and route to prune instead —
    // the same disposition `orgPolicyDriftProbes` gives the file itself (issue #554).
    const owner = owningCli(MANAGED_SETTINGS_PATH);
    if (owner !== undefined && !isTargeted(ctx, owner as Cli)) {
      return {
        name,
        verdict: "fail",
        detail:
          `dropped-target residue: ${MANAGED_SETTINGS_PATH} still enforces a managed MCP allowlist ` +
          `but ${owner} is not a target of this repo, so org-policy projection no longer maintains it — ` +
          `either add ${owner} back to the targets in ${AIH_CONFIG_FILE} to resume maintaining it, or ` +
          `remove the file if ${owner} is genuinely gone; re-projecting cannot fix this while ${owner} ` +
          "is untargeted",
        code: "org-policy.dropped-target-residue",
        location: { uri: MANAGED_SETTINGS_PATH },
        fingerprint: `org-policy-dropped-target:${MANAGED_SETTINGS_PATH}`,
      };
    }
    // #501 — attribute the mismatch to aih's own generation history before
    // calling it drift. Only when the committed org policy still owns the
    // managed allowlist is `aih policy project --apply` a valid prescription.
    if (policy?.mcp?.allowManagedOnly === true) {
      const generation = managedAllowlistGenerationDelta(actual.commands, desired.commands);
      if (generation !== undefined) {
        const names = [
          ...new Set(generation.previous.map((pair) => managedServerDisplayName(pair.expected))),
        ];
        const count = generation.previous.length;
        const addedNote =
          generation.added.length > 0
            ? `; ${generation.added.length} newly generated command${generation.added.length === 1 ? "" : "s"} not yet present`
            : "";
        return {
          name,
          verdict: "fail",
          detail:
            `generation delta: ${count} managed allowlist ${count === 1 ? "entry matches" : "entries match"} ` +
            `an earlier aih-generated launch shape of the current .mcp.json servers (${names.join(", ")})${addedNote}; ` +
            "a newer aih changed its generated output — run `aih policy project --apply` to re-project",
          code: "mcp.allowlist-generation-delta",
        };
      }
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
