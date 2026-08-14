import { isAbsolute, normalize, relative } from "node:path";
import { mcpApprovalSubject } from "../mcp/policy.js";
import { mcpEntries, mcpTomlBody } from "../mcp/render.js";
import { coreLocalMcpServers, type McpServer } from "../mcp/servers.js";

const SHA256 = /^[a-f0-9]{64}$/;
const CONTEXT7_ENDPOINT = "https://mcp.context7.com/mcp";

export const ECC_MCP_SELECTED = [
  "code-review-graph",
  "codebase-memory-mcp",
  "context7",
  "serena",
] as const;

export const ECC_MCP_DISABLED = [
  "ecc-memory-mcp",
  "github",
  "sequential-thinking",
  "token-savior",
] as const;

export const SERENA_RUNTIME_PIN = {
  package: "serena-agent==1.7.0",
  sourceCommit: "949a27ef1e5fda1a6e7b561e777bcece345c6ffd",
  wheelSha256: "6dbf1459670d96fb0595f84932adef34260a6fe14ba5135b901fdb3c8c76e891",
  metadataSha256: "124f3562913efb9aa13d06ab92a64eb0a09c976490169e86b39d2c0b09b5643c",
} as const;

const SERENA_1_6_1_RUNTIME_PIN = {
  package: "serena-agent==1.6.1",
  sourceCommit: "bcac0969fb8685783ea6d0f2642468fcc47e6395",
  wheelSha256: "04ddd985bd3feb25598ab8732bf3a998f961d5b46dce271b816126c0a68a91e1",
  metadataSha256: "4c95007465c14bed34e4d0022cc9382e826feafb9212eb6c9a1888ea2548bd7d",
} as const;

interface SerenaRuntimePin {
  package: string;
  sourceCommit: string;
  wheelSha256: string;
  metadataSha256: string;
}

/**
 * The reviewed symbol/refactor surface. A fixed set is deliberate: Serena's
 * client contexts and modes are convenience defaults, not an authorization
 * boundary, and new upstream tools must not become available implicitly.
 */
export const SERENA_ALLOWED_TOOLS = [
  "initial_instructions",
  "get_current_config",
  "restart_language_server",
  "get_symbols_overview",
  "find_symbol",
  "find_referencing_symbols",
  "find_implementations",
  "find_declaration",
  "get_diagnostics_for_file",
  "get_diagnostics_for_symbol",
  "replace_symbol_body",
  "insert_after_symbol",
  "insert_before_symbol",
  "rename_symbol",
  "safe_delete_symbol",
] as const;

/** The semantic floor every native context must expose at setup acceptance. */
export const SERENA_REQUIRED_TOOLS = [
  "get_symbols_overview",
  "find_symbol",
  "find_referencing_symbols",
  "find_implementations",
] as const;

const CONTEXT7_SERVER: McpServer = {
  type: "http",
  url: CONTEXT7_ENDPOINT,
  description:
    "Version-matched external documentation. Queries leave the host; use only after the bound endpoint review is accepted.",
  classification: "third-party-hosted",
  egress: "third-party",
  credentials: "none",
  supplyChain: "hosted-remote",
};

export const CONTEXT7_SUBJECT_SHA256 = mcpApprovalSubject(CONTEXT7_SERVER).replace(
  "mcp-server-sha256:",
  "",
);

export interface EccMcpRemoteAttestation {
  endpoint: string;
  subjectSha256: string;
  reviewedAt: string;
}

export interface EccMcpProjectionInput {
  client: "claude" | "codex";
  canonicalWorktree: string;
  serenaHome: string;
  /** Absolute root containing the authenticated pyproject.toml and uv.lock closure. */
  serenaRuntimeRoot: string;
  /** Absolute path to the later AIH-owned launcher/protocol guard. */
  wrapperCommand: string;
  /** Reviewed argv needed to reach the launcher within wrapperCommand. */
  wrapperArgsPrefix?: readonly string[];
  /** Digest verified by the later acquisition/materialization boundary. */
  wrapperSha256: string;
  /** Authenticated resolver-lock digest produced by the acquisition boundary. */
  serenaDependencyLockSha256: string;
  context7Attestation?: EccMcpRemoteAttestation;
}

export interface EccMcpProjection {
  activation: "prepared-not-registered";
  servers: Record<(typeof ECC_MCP_SELECTED)[number], McpServer>;
  disabled: typeof ECC_MCP_DISABLED;
  serenaConfig: string;
  provenance: {
    serena: SerenaRuntimePin & {
      dependencyLockSha256: string;
      wrapperSha256: string;
    };
    context7: EccMcpRemoteAttestation;
  };
  native: { kind: "claude-json"; body: string } | { kind: "codex-toml"; body: string };
}

function requireSha256(value: string, label: string): void {
  if (!SHA256.test(value)) throw new Error(`${label} must be a lowercase SHA-256 digest`);
}

function requireSafeArg(value: string, label: string): string {
  if (value.length === 0 || value.includes("\0") || /[\r\n]/u.test(value)) {
    throw new Error(`${label} must be a non-empty safe argument`);
  }
  return value;
}

function requireAbsoluteSafePath(value: string, label: string): string {
  if (!isAbsolute(value)) throw new Error(`${label} must be absolute`);
  if (value.includes("\0")) throw new Error(`${label} contains a NUL byte`);
  if (
    [...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return (codePoint >= 1 && codePoint <= 31) || codePoint === 127;
    })
  ) {
    throw new Error(`${label} contains a control character`);
  }
  const segments = value.split(/[\\/]/);
  if (segments.includes("..")) throw new Error(`${label} contains traversal`);
  const withoutDrive = value.replace(/^[A-Za-z]:[\\/]/, "");
  if (withoutDrive.includes(":")) throw new Error(`${label} contains a Windows ADS separator`);
  if (
    segments.some((segment) =>
      /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(segment.replace(/[ .]+$/, "")),
    )
  ) {
    throw new Error(`${label} contains a reserved Windows path segment`);
  }
  const normalized = normalize(value);
  return normalized;
}

function requireDistinctPaths(paths: Readonly<Record<string, string>>): void {
  const entries = Object.entries(paths);
  for (let left = 0; left < entries.length; left += 1) {
    for (let right = left + 1; right < entries.length; right += 1) {
      const a = entries[left];
      const b = entries[right];
      if (a === undefined || b === undefined) continue;
      if (a[1].toLowerCase() === b[1].toLowerCase()) {
        throw new Error(`${a[0]} and ${b[0]} must be distinct`);
      }
    }
  }
}

function validateContext7Attestation(
  value: EccMcpRemoteAttestation | undefined,
): EccMcpRemoteAttestation {
  if (value === undefined) throw new Error("Context7 endpoint attestation is required");
  if (value.endpoint !== CONTEXT7_ENDPOINT) {
    throw new Error("Context7 attestation endpoint does not match the reviewed endpoint");
  }
  requireSha256(value.subjectSha256, "Context7 attestation subject");
  if (value.subjectSha256 !== CONTEXT7_SUBJECT_SHA256) {
    throw new Error("Context7 attestation subject does not match the reviewed server contract");
  }
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value.reviewedAt) ||
    !Number.isFinite(Date.parse(value.reviewedAt)) ||
    new Date(value.reviewedAt).toISOString() !== value.reviewedAt
  ) {
    throw new Error("Context7 attestation reviewedAt must be an ISO timestamp");
  }
  return { ...value };
}

export function renderSerenaConfig(): string {
  return [
    "language_backend: LSP",
    "gui_log_window: false",
    "web_dashboard: true",
    "web_dashboard_open_on_launch: false",
    "web_dashboard_interface: browser",
    "web_dashboard_listen_address: 127.0.0.1",
    "web_dashboard_trusted_hosts:",
    "  - 127.0.0.1",
    "  - localhost",
    "fixed_tools:",
    ...SERENA_ALLOWED_TOOLS.map((tool) => `  - ${tool}`),
    "excluded_tools: []",
    "included_optional_tools: []",
    "base_modes:",
    "  - interactive",
    "  - editing",
    "default_modes: []",
    "projects: []",
    "",
  ].join("\n");
}

function localServers(): Pick<
  Record<(typeof ECC_MCP_SELECTED)[number], McpServer>,
  "code-review-graph" | "codebase-memory-mcp"
> {
  const catalog = coreLocalMcpServers();
  const graph = catalog["code-review-graph"];
  const memory = catalog["codebase-memory-mcp"];
  if (graph === undefined || memory === undefined) {
    throw new Error("core local MCP catalog is missing an ECC-selected server");
  }
  return { "code-review-graph": graph, "codebase-memory-mcp": memory };
}

function buildEccMcpProfileProjectionForRuntime(
  input: EccMcpProjectionInput,
  runtimePin: SerenaRuntimePin,
): EccMcpProjection {
  const canonicalWorktree = requireAbsoluteSafePath(input.canonicalWorktree, "canonicalWorktree");
  const serenaHome = requireAbsoluteSafePath(input.serenaHome, "serenaHome");
  const serenaRuntimeRoot = requireAbsoluteSafePath(input.serenaRuntimeRoot, "serenaRuntimeRoot");
  const wrapperCommand = requireAbsoluteSafePath(input.wrapperCommand, "wrapperCommand");
  requireDistinctPaths({ canonicalWorktree, serenaHome, serenaRuntimeRoot, wrapperCommand });
  if (isWithinEccMcpRoot(canonicalWorktree, serenaHome)) {
    throw new Error("serenaHome must be outside the canonical worktree");
  }
  if (
    isWithinEccMcpRoot(canonicalWorktree, serenaRuntimeRoot) ||
    isWithinEccMcpRoot(serenaRuntimeRoot, canonicalWorktree) ||
    isWithinEccMcpRoot(serenaHome, serenaRuntimeRoot) ||
    isWithinEccMcpRoot(serenaRuntimeRoot, serenaHome)
  ) {
    throw new Error("serenaRuntimeRoot must be outside and disjoint from worktree and state");
  }
  if (isWithinEccMcpRoot(canonicalWorktree, wrapperCommand)) {
    throw new Error("wrapperCommand must be outside the canonical worktree");
  }
  requireSha256(input.serenaDependencyLockSha256, "Serena dependency lock");
  requireSha256(input.wrapperSha256, "Serena wrapper");
  const wrapperArgsPrefix = (input.wrapperArgsPrefix ?? []).map((value, index) =>
    requireSafeArg(value, `wrapperArgsPrefix[${index}]`),
  );
  if (wrapperArgsPrefix.length > 16) throw new Error("wrapperArgsPrefix exceeds its limit");
  const context7Attestation = validateContext7Attestation(input.context7Attestation);
  const servers: EccMcpProjection["servers"] = {
    ...localServers(),
    context7: { ...CONTEXT7_SERVER },
    serena: {
      type: "stdio",
      command: wrapperCommand,
      args: [
        ...wrapperArgsPrefix,
        "serena",
        "--package",
        runtimePin.package,
        "--dependency-lock-sha256",
        input.serenaDependencyLockSha256,
        "--lock-root",
        serenaRuntimeRoot,
        "--context",
        input.client === "claude" ? "claude-code" : "codex",
        "--mode",
        "no-memories",
        "--project",
        canonicalWorktree,
      ],
      env: { SERENA_HOME: serenaHome, SERENA_USAGE_REPORTING: "false" },
      description:
        "AIH-owned Serena launcher and hard tool guard for the canonical worktree; usage reporting disabled.",
      classification: "local",
      egress: "local-only",
      credentials: "none",
      supplyChain: "pinned",
    },
  };
  const native =
    input.client === "claude"
      ? {
          kind: "claude-json" as const,
          body: `${JSON.stringify({ mcpServers: mcpEntries("claude", servers) }, null, 2)}\n`,
        }
      : { kind: "codex-toml" as const, body: `${mcpTomlBody(servers)}\n` };
  return {
    activation: "prepared-not-registered",
    servers,
    disabled: ECC_MCP_DISABLED,
    serenaConfig: renderSerenaConfig(),
    provenance: {
      serena: {
        ...runtimePin,
        dependencyLockSha256: input.serenaDependencyLockSha256,
        wrapperSha256: input.wrapperSha256,
      },
      context7: context7Attestation,
    },
    native,
  };
}

export function buildEccMcpProfileProjection(input: EccMcpProjectionInput): EccMcpProjection {
  return buildEccMcpProfileProjectionForRuntime(input, SERENA_RUNTIME_PIN);
}

/** Reconstructs only receipt-owned 1.6.1 fragments; new runtime projection always uses 1.7.0. */
export function buildSerena161ReceiptProjection(input: EccMcpProjectionInput): EccMcpProjection {
  return buildEccMcpProfileProjectionForRuntime(input, SERENA_1_6_1_RUNTIME_PIN);
}

interface SerenaToolDescription {
  name: string;
  [key: string]: unknown;
}

export function filterSerenaToolsList(value: unknown): { tools: SerenaToolDescription[] } {
  if (
    value === null ||
    typeof value !== "object" ||
    !Array.isArray((value as { tools?: unknown }).tools)
  ) {
    throw new Error("Serena tools/list response is malformed");
  }
  const tools = (value as { tools: unknown[] }).tools;
  const byName = new Map<string, SerenaToolDescription>();
  for (const tool of tools) {
    if (
      tool === null ||
      typeof tool !== "object" ||
      typeof (tool as { name?: unknown }).name !== "string"
    ) {
      throw new Error("Serena tools/list contains a malformed tool");
    }
    const typed = tool as SerenaToolDescription;
    if (byName.has(typed.name))
      throw new Error(`Serena tools/list contains duplicate '${typed.name}'`);
    byName.set(typed.name, typed);
  }
  const missing = SERENA_REQUIRED_TOOLS.filter((name) => !byName.has(name));
  if (missing.length > 0)
    throw new Error(`Serena tools/list is missing reviewed tools: ${missing.join(", ")}`);
  return {
    tools: SERENA_ALLOWED_TOOLS.flatMap((name) => {
      const tool = byName.get(name);
      return tool === undefined ? [] : [tool];
    }),
  };
}

export function guardSerenaToolCall(
  name: string,
): { allowed: true } | { allowed: false; code: -32601; message: string } {
  if ((SERENA_ALLOWED_TOOLS as readonly string[]).includes(name)) return { allowed: true };
  return {
    allowed: false,
    code: -32601,
    message: `Serena tool '${name}' is disabled by the AIH ECC profile`,
  };
}

export type SerenaMcpRequestDecision =
  | { forward: true }
  | {
      forward: false;
      response: {
        jsonrpc: "2.0";
        id: string | number | null;
        error: { code: -32601; message: string };
      };
    };

/**
 * Protocol-level guard used by the later managed launcher. Client-native tool
 * filters remain defense in depth; this decision is the hard boundary.
 */
export class SerenaMcpPolicyGuard {
  inspectClientRequest(value: unknown): SerenaMcpRequestDecision {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("malformed Serena JSON-RPC request");
    }
    const request = value as Record<string, unknown>;
    if (request.method !== "tools/call") return { forward: true };
    const params = request.params;
    if (
      params === null ||
      typeof params !== "object" ||
      Array.isArray(params) ||
      typeof (params as { name?: unknown }).name !== "string"
    ) {
      throw new Error("malformed Serena tools/call request");
    }
    const id = request.id;
    if (!(typeof id === "string" || typeof id === "number" || id === null)) {
      throw new Error("malformed Serena tools/call request id");
    }
    const policy = guardSerenaToolCall((params as { name: string }).name);
    return policy.allowed
      ? { forward: true }
      : {
          forward: false,
          response: {
            jsonrpc: "2.0",
            id,
            error: { code: policy.code, message: policy.message },
          },
        };
  }

  filterToolsList(value: unknown): { tools: SerenaToolDescription[] } {
    return filterSerenaToolsList(value);
  }
}

export function mergeEccMcpServers(
  operator: Readonly<Record<string, McpServer>>,
  managed: Readonly<Record<string, McpServer>>,
): Record<string, McpServer> {
  const conflicts = Object.keys(managed).filter((name) => Object.hasOwn(operator, name));
  if (conflicts.length > 0) throw new Error(`MCP ownership conflict: ${conflicts.join(", ")}`);
  return { ...operator, ...managed };
}

export type EccMcpHealth =
  | { mode: "ordinary"; status: "advisory"; failedServers: string[] }
  | { mode: "setup-acceptance"; status: "ready" | "blocked"; failedServers: string[] };

export function evaluateEccMcpHealth(
  mode: EccMcpHealth["mode"],
  initialized: Readonly<Record<string, boolean>>,
): EccMcpHealth {
  const failedServers = ECC_MCP_SELECTED.filter((name) => initialized[name] !== true);
  return mode === "ordinary"
    ? { mode, status: "advisory", failedServers }
    : { mode, status: failedServers.length === 0 ? "ready" : "blocked", failedServers };
}

/** Path is within root without treating prefix siblings as descendants. */
export function isWithinEccMcpRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
