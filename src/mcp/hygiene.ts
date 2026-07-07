import type { Cli } from "../internals/clis.js";
import type { PlanContext } from "../internals/plan.js";
import type { Check } from "../internals/verify.js";
import type { McpEntry } from "./render.js";
import type { McpServer } from "./servers.js";

export type McpHygieneKind = "missing-env" | "placeholder-url";

export interface McpHygieneIssue {
  server: string;
  kind: McpHygieneKind;
  detail: string;
}

interface NpmPackagePin {
  server: string;
  packageName: string;
  version: string;
  spec: string;
}

const ENV_REF = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const NPM_SCOPED_SPEC = /^(@[^@\s/]+\/[^@\s]+)@([^@\s]+)$/;
const NPM_UNSCOPED_SPEC = /^([^@\s/][^@\s]*)@([^@\s]+)$/;

function envRefs(value: string): string[] {
  return [...value.matchAll(ENV_REF)].flatMap((match) => (match[1] ? [match[1]] : []));
}

function requiredEnvVars(server: McpServer): string[] {
  const vars = new Set<string>();
  if (server.type === "stdio" && server.env) {
    for (const value of Object.values(server.env)) for (const ref of envRefs(value)) vars.add(ref);
  }
  if (server.type === "http" && server.headers) {
    for (const value of Object.values(server.headers))
      for (const ref of envRefs(value)) vars.add(ref);
  }
  return [...vars].sort();
}

function isMissingEnv(env: NodeJS.ProcessEnv, name: string): boolean {
  const value = env[name];
  return value === undefined || value.trim().length === 0;
}

function placeholderUrlDetail(server: McpServer): string | undefined {
  if (server.type !== "http") return undefined;
  let host: string;
  try {
    host = new URL(server.url).hostname.toLowerCase();
  } catch {
    return `invalid URL ${server.url}`;
  }
  const placeholder =
    host === "example" ||
    host.endsWith(".example") ||
    host === "example.com" ||
    host.endsWith(".example.com") ||
    host.endsWith(".invalid") ||
    host.endsWith(".test");
  return placeholder ? `placeholder URL host ${host}` : undefined;
}

export function mcpHygieneIssues(
  servers: Record<string, McpServer>,
  env: NodeJS.ProcessEnv,
): McpHygieneIssue[] {
  const issues: McpHygieneIssue[] = [];
  for (const [server, config] of Object.entries(servers)) {
    const missing = requiredEnvVars(config).filter((name) => isMissingEnv(env, name));
    if (missing.length > 0) {
      issues.push({
        server,
        kind: "missing-env",
        detail: `missing required env var${missing.length === 1 ? "" : "s"} ${missing.join(", ")}`,
      });
    }
    const placeholder = placeholderUrlDetail(config);
    if (placeholder !== undefined) {
      issues.push({ server, kind: "placeholder-url", detail: placeholder });
    }
  }
  return issues;
}

export function mcpHygieneDigest(issues: readonly McpHygieneIssue[], clis: readonly Cli[]): string {
  const disabled = [...new Set(issues.map((issue) => issue.server))].sort();
  const lines = [
    "aih found MCP entries that may retry-fail if written as enabled:",
    ...issues.map((issue) => `- ${issue.server}: ${issue.detail}`),
  ];
  if (clis.includes("opencode")) {
    lines.push("", `OpenCode enabled:false: ${disabled.join(", ")}`);
  }
  lines.push(
    "",
    "Other CLI config shapes keep the generated entry and surface this warning before apply; fix the env or URL before relying on that server.",
  );
  return lines.join("\n");
}

export function applyMcpHygieneToEntries(
  cli: Cli,
  entries: Record<string, McpEntry>,
  issues: readonly McpHygieneIssue[],
): Record<string, McpEntry> {
  if (cli !== "opencode" || issues.length === 0) return entries;
  const disabled = new Set(issues.map((issue) => issue.server));
  const next: Record<string, McpEntry> = { ...entries };
  for (const name of disabled) {
    const entry = next[name];
    if (entry !== undefined) next[name] = { ...entry, enabled: false };
  }
  return next;
}

function parseNpmSpec(value: string): { packageName: string; version: string } | undefined {
  const scoped = NPM_SCOPED_SPEC.exec(value);
  if (scoped?.[1] && scoped[2]) return { packageName: scoped[1], version: scoped[2] };
  const unscoped = NPM_UNSCOPED_SPEC.exec(value);
  if (unscoped?.[1] && unscoped[2]) return { packageName: unscoped[1], version: unscoped[2] };
  return undefined;
}

function npmPackagePins(servers: Record<string, McpServer>): NpmPackagePin[] {
  const pins: NpmPackagePin[] = [];
  for (const [server, config] of Object.entries(servers)) {
    if (config.type !== "stdio" || config.command !== "npx") continue;
    for (const arg of config.args) {
      const parsed = parseNpmSpec(arg);
      if (parsed === undefined) continue;
      pins.push({ server, spec: arg, ...parsed });
    }
  }
  return pins;
}

function resolvedVersion(stdout: string): string | undefined {
  const first = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return first;
}

export async function mcpPackagePinDriftProbe(
  servers: Record<string, McpServer>,
  ctx: PlanContext,
): Promise<Check> {
  const name = "MCP package pins match resolved versions";
  const pins = npmPackagePins(servers);
  if (pins.length === 0) {
    return { name, verdict: "skip", detail: "no npm-backed MCP package pins to resolve" };
  }
  const drift: string[] = [];
  const unresolved: string[] = [];
  for (const pin of pins) {
    const res = await ctx.run(["npm", "view", pin.spec, "version"], { timeoutMs: 15_000 });
    if (res.spawnError) {
      return { name, verdict: "skip", detail: "npm not found on PATH" };
    }
    if (res.code !== 0) {
      unresolved.push(`${pin.spec} (${res.stderr.trim() || `exit ${res.code}`})`);
      continue;
    }
    const resolved = resolvedVersion(res.stdout);
    if (resolved === undefined) {
      unresolved.push(`${pin.spec} (registry returned no version)`);
      continue;
    }
    if (resolved !== pin.version) {
      drift.push(
        `${pin.packageName} pinned ${pin.version} but registry resolved ${resolved} for ${pin.spec} (${pin.server})`,
      );
    }
  }
  if (drift.length > 0) {
    return {
      name,
      verdict: "fail",
      detail: drift.join("; "),
      code: "mcp.version-drift",
    };
  }
  if (unresolved.length > 0) {
    return {
      name,
      verdict: "skip",
      detail: `could not resolve ${unresolved.join("; ")}`,
    };
  }
  return {
    name,
    verdict: "pass",
    detail: `${pins.length} npm MCP package pin(s) resolved cleanly`,
  };
}
