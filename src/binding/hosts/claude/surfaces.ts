import { createHash } from "node:crypto";
import { AihError } from "../../../errors.js";
import { entry } from "../../../internals/cli-registry.js";
import { isPlainObject } from "../../../internals/merge.js";

/**
 * Claude project-scope host surfaces + the small value helpers the managed-write
 * engine and its conservative removal share.
 *
 * D4.3 names the ONLY surfaces AIH may write for the Claude host:
 * `.claude/settings.json`, `.claude/settings.local.json`, `.claude/rules/`,
 * `.claude/skills/`, `.claude/agents/`, `.mcp.json`, and one managed `CLAUDE.md`
 * block. The registry (`entry("claude")`) is the single source for the paths it
 * knows (settings, mcp, bootloader); the project-relative surfaces it does not
 * carry (`settings.local.json`, the rules/skills/agents roots) are module
 * constants here — never hardcoded ad hoc at call sites.
 */

const CLAUDE = entry("claude");

/** `.claude/settings.json` — the tool-native settings file (registry). */
export const CLAUDE_SETTINGS_PATH = CLAUDE.settings?.configPath ?? ".claude/settings.json";
/** `.claude/settings.local.json` — the gitignored local settings sibling (module constant). */
export const CLAUDE_SETTINGS_LOCAL_PATH = ".claude/settings.local.json";
/** `.mcp.json` — the project MCP server map (registry). */
export const CLAUDE_MCP_PATH = CLAUDE.mcp.configPath ?? ".mcp.json";
/** `CLAUDE.md` — the root bootloader hosting the single managed binding block (registry). */
export const CLAUDE_BOOTLOADER_PATH = CLAUDE.bootloaders[0] ?? "CLAUDE.md";

/** The three shared JSON files AIH may own FIELDS in (D18: fields, not files). */
export const CLAUDE_SHARED_JSON_FILES: readonly string[] = [
  CLAUDE_SETTINGS_PATH,
  CLAUDE_SETTINGS_LOCAL_PATH,
  CLAUDE_MCP_PATH,
];

/** The owned-FILE surface roots (D4.3), POSIX with a trailing slash. */
export const CLAUDE_OWNED_FILE_ROOTS: readonly string[] = [
  ".claude/rules/",
  ".claude/skills/",
  ".claude/agents/",
];

/** Top-level key holding the MCP server map inside `.mcp.json` (registry). */
export const CLAUDE_MCP_KEY = CLAUDE.mcp.configKey ?? "mcpServers";

/**
 * The single managed CLAUDE.md block marker id. DISTINCT from the bootstrap-ai
 * shared-canon marker (`ai-canonical:shared`) so a binding block and the canon
 * block coexist in one CLAUDE.md; styled like the canon marker (`domain:scope`).
 */
export const CLAUDE_BINDING_MARKER = "aih-binding:claude";

/** The parenthetical note on the binding block's BEGIN line. */
export const CLAUDE_BINDING_BLOCK_NOTE =
  "aih project-framework binding — managed; do not edit inside this fence";

/** `<file>#block:<marker>` — the ownership target convention for the CLAUDE.md fence. */
export const CLAUDE_BLOCK_TARGET = `${CLAUDE_BOOTLOADER_PATH}#block:${CLAUDE_BINDING_MARKER}`;

/** A binding host-adapter error (invalid target/pointer/surface). Fails closed. */
export class ClaudeHostWriteError extends AihError {
  constructor(message: string) {
    super(message, "AIH_BINDING_CLAUDE_HOST");
  }
}

/** Keys that must never be used as an object key (prototype-pollution guard). */
const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);

/** sha256 hex of a UTF-8 string. */
export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Deterministic JSON with recursively sorted object keys (stable digests + equality). */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key]);
    return out;
  }
  return value;
}

/** Order-insensitive JSON value equality (the D18 "still equals the applied value" test). */
export function jsonEqual(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

/**
 * Parse an RFC6901-style JSON pointer ("/a/b") into unescaped segments. Fails
 * closed on a pointer that does not start with "/", has an empty segment, or names
 * a prototype-pollution key. Depth is validated by the caller (the write engine
 * supports depth 1 and 2 — the shape every Claude settings/MCP owned field takes).
 */
export function parseJsonPointer(pointer: string): string[] {
  if (typeof pointer !== "string" || !pointer.startsWith("/")) {
    throw new ClaudeHostWriteError(
      `invalid JSON pointer ${JSON.stringify(pointer)} — must start with "/"`,
    );
  }
  const segments = pointer
    .slice(1)
    .split("/")
    .map((seg) => seg.replace(/~1/g, "/").replace(/~0/g, "~"));
  for (const seg of segments) {
    if (seg.length === 0) {
      throw new ClaudeHostWriteError(
        `invalid JSON pointer ${JSON.stringify(pointer)} — empty segment`,
      );
    }
    assertSafeKey(seg);
  }
  return segments;
}

/** Reject a dangerous or control-bearing object key. */
export function assertSafeKey(key: string): void {
  if (key.length === 0 || DANGEROUS_KEYS.has(key)) {
    throw new ClaudeHostWriteError(`refusing unsafe object key ${JSON.stringify(key)}`);
  }
  for (const char of key) {
    if (char.charCodeAt(0) <= 31 || char.charCodeAt(0) === 127) {
      throw new ClaudeHostWriteError(
        `refusing control character in object key ${JSON.stringify(key)}`,
      );
    }
  }
}

/** Walk `value` by `segments`, reading only own plain-object keys. */
export function valueAtPointer(
  value: unknown,
  segments: readonly string[],
): { present: true; value: unknown } | { present: false } {
  let current: unknown = value;
  for (const seg of segments) {
    if (!isPlainObject(current) || !Object.hasOwn(current, seg)) return { present: false };
    current = current[seg];
  }
  return { present: true, value: current };
}

/**
 * A safe repo-relative POSIX path — the SAME rule the binding lock's
 * {@link BindingWriteSchema} SafeRelPath enforces (no backslash, drive, absolute,
 * `..`, trailing/double slash, or control chars). Validated HERE at the write
 * boundary so a bad path is refused before it reaches the fs.
 */
export function isSafeRelPosixPath(value: string): boolean {
  if (value.length === 0 || value.startsWith("/") || value.includes("\\")) return false;
  if (/^[A-Za-z]:/.test(value)) return false;
  if (value.endsWith("/") || value.includes("//")) return false;
  if (value.split("/").some((part) => part.length === 0 || part === "." || part === "..")) {
    return false;
  }
  for (const char of value) {
    if (char.charCodeAt(0) <= 31 || char.charCodeAt(0) === 127) return false;
  }
  return true;
}

/** Fail closed unless `file` is one of the D18 shared JSON surfaces. */
export function assertSharedJsonFile(file: string): void {
  if (!CLAUDE_SHARED_JSON_FILES.includes(file)) {
    throw new ClaudeHostWriteError(
      `refusing to own a field in ${JSON.stringify(file)} — not a Claude shared JSON surface ` +
        `(${CLAUDE_SHARED_JSON_FILES.join(", ")})`,
    );
  }
}

/** Fail closed unless `rel` is a safe path under a D4.3 owned-file root. */
export function assertOwnedFilePath(rel: string): void {
  if (!isSafeRelPosixPath(rel)) {
    throw new ClaudeHostWriteError(
      `refusing owned-file path ${JSON.stringify(rel)} — must be a safe repo-relative POSIX path`,
    );
  }
  if (!CLAUDE_OWNED_FILE_ROOTS.some((rootDir) => rel.startsWith(rootDir))) {
    throw new ClaudeHostWriteError(
      `refusing owned-file path ${JSON.stringify(rel)} — outside the Claude owned-file surfaces ` +
        `(${CLAUDE_OWNED_FILE_ROOTS.join(", ")})`,
    );
  }
}
