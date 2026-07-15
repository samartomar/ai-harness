import { createHash } from "node:crypto";
import { PROVIDER_TOKEN_PATTERNS } from "../guardrails/token-patterns.js";
import { mcpResolverPinState } from "../mcp/pins.js";
import type { McpServer, SkillsProviderEvidence } from "../mcp/servers.js";

const TOKEN_PATTERNS: readonly RegExp[] = [
  /AKIA[0-9A-Z]{16}/,
  ...PROVIDER_TOKEN_PATTERNS.map((pattern) => pattern.re),
];

const SECRET_KEY_RE =
  /token|secret|password|passwd|api[_-]?key|apikey|access[_-]?key|client[_-]?secret|credential|\bpat\b/i;

const FASTMCP_VERSION_RE =
  /\bfastmcp(?:\[[A-Za-z0-9._,-]+\])?(?:==|@)(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/i;
const SHA256_RE = /^(?:sha256:)?([0-9a-f]{64})$/i;
const SKILLS_PROVIDER_RE =
  /\b(ClaudeSkillsProvider|SkillsDirectoryProvider|SkillsProvider|SkillProvider)\b/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function isPlaceholderOrEmpty(value: string): boolean {
  const t = value.trim();
  return (
    t.length === 0 ||
    /^\$\{[^}]+\}$/.test(t) ||
    /^\$[A-Za-z_][A-Za-z0-9_]*$/.test(t) ||
    /^%[A-Za-z0-9_]+%$/.test(t)
  );
}

function isTokenLookingValue(value: string): boolean {
  if (isPlaceholderOrEmpty(value)) return false;
  return TOKEN_PATTERNS.some((pattern) => pattern.test(value));
}

function envEntries(value: unknown): Array<[string, string]> {
  if (!isRecord(value)) return [];
  return Object.entries(value).filter((entry): entry is [string, string] => {
    const [, envValue] = entry;
    return typeof envValue === "string";
  });
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const entries = Object.entries(value).filter((entry): entry is [string, string] => {
    const [, entryValue] = entry;
    return typeof entryValue === "string";
  });
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function hasCredentialHeader(headers: Record<string, string> | undefined): boolean {
  if (headers === undefined) return false;
  return Object.keys(headers).some(
    (key) => SECRET_KEY_RE.test(key) || key.toLowerCase() === "authorization",
  );
}

function hasLiteralCredential(raw: unknown, args: readonly string[]): boolean {
  const env = isRecord(raw) ? envEntries(raw.env) : [];
  for (const [key, value] of env) {
    if (isTokenLookingValue(value)) return true;
    const trimmed = value.trim();
    if (
      SECRET_KEY_RE.test(key) &&
      !isPlaceholderOrEmpty(trimmed) &&
      trimmed.length >= 8 &&
      !/^https?:\/\//i.test(trimmed)
    ) {
      return true;
    }
  }
  return args.some((arg) => {
    if (isTokenLookingValue(arg)) return true;
    if (isPlaceholderOrEmpty(arg)) return false;
    return /(?:token|secret|password|api[_-]?key|apikey|credential|pat)[=:][^\s]{8,}/i.test(arg);
  });
}

function hosted(
  url: string,
  description: string,
  credentials: McpServer["credentials"],
  headers: Record<string, string> | undefined,
): McpServer {
  return {
    type: "http",
    url,
    description,
    ...(headers ? { headers } : {}),
    classification: "third-party-hosted",
    egress: "third-party",
    credentials,
    supplyChain: "hosted-remote",
  };
}

function flagged(description: string, credentials: McpServer["credentials"]): McpServer {
  return {
    type: "stdio",
    command: "unknown",
    args: [],
    description,
    classification: "third-party-hosted",
    egress: "third-party",
    credentials,
    supplyChain: "unpinned",
  };
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, stable(item)]),
  );
}

function collectStrings(value: unknown, depth = 0): string[] {
  if (depth > 5) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => collectStrings(item, depth + 1));
  if (!isRecord(value)) return [];
  return Object.entries(value).flatMap(([key, item]) => [key, ...collectStrings(item, depth + 1)]);
}

function directStringField(
  raw: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = raw[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

function normalizeSha256(value: string): string | undefined {
  const match = SHA256_RE.exec(value.trim());
  return match?.[1] === undefined ? undefined : `sha256:${match[1].toLowerCase()}`;
}

function sha256Bytes(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function manifestSha256(raw: Record<string, unknown>): string | undefined {
  const recorded = directStringField(raw, [
    "manifestSha256",
    "manifest_sha256",
    "_manifestSha256",
    "_manifest_sha256",
  ]);
  if (recorded !== undefined) return normalizeSha256(recorded);

  for (const key of ["_manifest", "manifest"]) {
    if (!Object.hasOwn(raw, key)) continue;
    const value = raw[key];
    return typeof value === "string"
      ? sha256Bytes(value)
      : sha256Bytes(JSON.stringify(stable(value)));
  }
  return undefined;
}

function providerName(strings: readonly string[]): SkillsProviderEvidence["provider"] | undefined {
  for (const value of strings) {
    const match = SKILLS_PROVIDER_RE.exec(value);
    if (match?.[1] === "ClaudeSkillsProvider") return "ClaudeSkillsProvider";
    if (match?.[1] === "SkillsDirectoryProvider") return "SkillsDirectoryProvider";
    if (match?.[1] === "SkillsProvider") return "SkillsProvider";
    if (match?.[1] === "SkillProvider") return "SkillProvider";
  }
  return strings.some((value) => /skill:\/\//i.test(value)) ? "skills" : undefined;
}

function fastMcpVersion(
  raw: Record<string, unknown>,
  strings: readonly string[],
): string | undefined {
  const direct = directStringField(raw, ["fastmcpVersion", "serverVersion", "version"]);
  if (direct !== undefined && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(direct)) return direct;
  for (const value of strings) {
    const match = FASTMCP_VERSION_RE.exec(value);
    if (match?.[1] !== undefined) return match[1];
  }
  return undefined;
}

function hasReloadField(value: unknown, depth = 0): boolean {
  if (depth > 5) return false;
  if (Array.isArray(value)) return value.some((item) => hasReloadField(item, depth + 1));
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, item]) => {
    if (/^(?:hotReload|autoReload|reload)$/i.test(key) && item === true) return true;
    return hasReloadField(item, depth + 1);
  });
}

function hasHotReload(raw: Record<string, unknown>, args: readonly string[]): boolean {
  if (hasReloadField(raw)) return true;
  return args.some((arg) => arg === "--reload" || /^reload\s*=\s*true$/i.test(arg.trim()));
}

function skillsProviderEvidence(
  raw: Record<string, unknown> | undefined,
  args: readonly string[],
): SkillsProviderEvidence | undefined {
  if (raw === undefined) return undefined;
  const strings = collectStrings(raw);
  const provider = providerName(strings);
  if (provider === undefined) return undefined;
  return {
    provider,
    serverVersion: fastMcpVersion(raw, strings),
    manifestSha256: manifestSha256(raw),
    hotReload: hasHotReload(raw, args),
  };
}

export function classifyIncomingMcp(rawServer: unknown): McpServer {
  const raw = isRecord(rawServer) ? rawServer : undefined;
  const command = raw ? stringValue(raw.command) : undefined;
  const args = raw ? stringArray(raw.args) : [];
  const url = raw ? stringValue(raw.url) : undefined;
  const description = raw ? (stringValue(raw.description) ?? "") : "";
  const headers = raw ? stringRecord(raw.headers) : undefined;
  const credentials =
    hasLiteralCredential(rawServer, args) || hasCredentialHeader(headers) ? "token" : "none";
  // Carry env onto the classified server so its content-bound acknowledgement
  // fingerprint (mcpServerConfigFingerprint) invalidates on an env-only rug-pull.
  const env = raw ? Object.fromEntries(envEntries(raw.env)) : {};
  const resolverEnv =
    raw?.env === undefined ? undefined : isRecord(raw.env) ? raw.env : { invalid: raw.env };
  const skillsProvider = skillsProviderEvidence(raw, args);
  const resolverPin =
    command === undefined ? undefined : mcpResolverPinState(command, args, resolverEnv);

  if (url !== undefined && /^https?:\/\//i.test(url.trim())) {
    const server = hosted(url.trim(), description, credentials, headers);
    return skillsProvider === undefined ? server : { ...server, skillsProvider };
  }
  if (command === undefined || command.trim().length === 0) {
    const server = flagged(description, credentials);
    return skillsProvider === undefined ? server : { ...server, skillsProvider };
  }

  return {
    type: "stdio",
    command,
    args,
    description,
    env,
    classification: "local",
    egress: skillsProvider === undefined ? "local-only" : "none",
    credentials,
    supplyChain:
      skillsProvider !== undefined
        ? skillsProvider.hotReload ||
          skillsProvider.serverVersion === undefined ||
          resolverPin !== "pinned"
          ? "unpinned"
          : "pinned"
        : resolverPin === "pinned"
          ? "pinned"
          : "unpinned",
    ...(skillsProvider === undefined ? {} : { skillsProvider }),
  };
}
