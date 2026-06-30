import type { McpServer } from "../mcp/servers.js";

const TOKEN_PATTERNS: readonly RegExp[] = [
  /ghp_[A-Za-z0-9]{36}/,
  /github_pat_[A-Za-z0-9_]{40,}/,
  /sk-[A-Za-z0-9_-]{20,}/,
  /AKIA[0-9A-Z]{16}/,
  /xox[abprs]-[A-Za-z0-9-]{10,}/,
  /AIza[0-9A-Za-z_-]{35}/,
];

const SECRET_KEY_RE =
  /token|secret|password|passwd|api[_-]?key|apikey|access[_-]?key|client[_-]?secret|credential|\bpat\b/i;

const EXACT_PACKAGE_RE =
  /^(?:@[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+|[A-Za-z0-9._-]+)@\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

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

function commandName(command: string): string {
  const last = command.split(/[\\/]/).at(-1) ?? command;
  return last.replace(/\.(?:cmd|exe)$/i, "").toLowerCase();
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

function hasExactPackage(args: readonly string[]): boolean {
  return args.some((arg) => EXACT_PACKAGE_RE.test(arg.trim()));
}

function hasFloatingLaunch(command: string | undefined, args: readonly string[]): boolean {
  const cmd = command === undefined ? "" : commandName(command);
  return (
    cmd === "npx" ||
    cmd === "uvx" ||
    args.some((arg) => arg === "-y" || arg === "--yes" || /@latest(?:$|\b)/i.test(arg))
  );
}

function hosted(
  url: string,
  description: string,
  credentials: McpServer["credentials"],
): McpServer {
  return {
    type: "http",
    url,
    description,
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

export function classifyIncomingMcp(rawServer: unknown): McpServer {
  const raw = isRecord(rawServer) ? rawServer : undefined;
  const command = raw ? stringValue(raw.command) : undefined;
  const args = raw ? stringArray(raw.args) : [];
  const url = raw ? stringValue(raw.url) : undefined;
  const description = raw ? (stringValue(raw.description) ?? "") : "";
  const credentials = hasLiteralCredential(rawServer, args) ? "token" : "none";

  if (url !== undefined && /^https?:\/\//i.test(url.trim())) {
    return hosted(url.trim(), description, credentials);
  }
  if (command === undefined || command.trim().length === 0) {
    return flagged(description, credentials);
  }

  return {
    type: "stdio",
    command,
    args,
    description,
    classification: "local",
    egress: "local-only",
    credentials,
    supplyChain: hasFloatingLaunch(command, args)
      ? "unpinned"
      : hasExactPackage(args)
        ? "pinned"
        : "pinned",
  };
}
