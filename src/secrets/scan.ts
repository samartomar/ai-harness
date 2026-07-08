import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { PROVIDER_TOKEN_PATTERNS } from "../guardrails/token-patterns.js";
import { containedPath, inspectContainedPath } from "../internals/contained-path.js";
import { readRegularFile } from "../internals/fsxn.js";
import { parseJsoncText } from "../internals/merge.js";
import type { CheckCode } from "../internals/verify.js";

/** What a repository scan turned up: plaintext secret files + a `secrets/` dir. */
export interface SecretScan {
  /** Relative paths (POSIX separators) of `.env` / `.env.*` files that are not examples. */
  envFiles: string[];
  /** Relative path of a root-level `secrets/` credential directory, if present. */
  secretDirs: string[];
  /** Convenience union of every flagged path, sorted, for warning text. */
  matches: string[];
}

/** `.env.example` / `.env.sample` are templates, not real secrets — never flag them. */
const EXAMPLE_SUFFIXES = [".example", ".sample"] as const;

function isEnvFile(name: string): boolean {
  if (name !== ".env" && !name.startsWith(".env.")) return false;
  return !EXAMPLE_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

/** List directory entries, tolerating an unreadable/missing dir as "empty". */
function safeReadDir(dir: string): string[] {
  try {
    return readdirSync(dir).sort();
  } catch {
    return [];
  }
}

/**
 * Scan `root` for plaintext secret material — `.env` files shallow plus one
 * level deep (excluding `.env.example` / `.env.sample`), and a credential
 * directory named `secrets/` at the repo ROOT only. Nested directories named
 * `secrets` (e.g. `src/secrets`, `tests/secrets`) are code, not secret stores,
 * and are deliberately ignored — matching the root-anchored `Read(./secrets/**)`
 * deny rule. Pure: reads the filesystem, touches no network, mutates nothing;
 * returns repo-relative POSIX paths so results feed deterministically into deny
 * rules and warning docs.
 */
export function scanSecrets(
  root: string,
  opts: { accept?: (rel: string) => boolean } = {},
): SecretScan {
  // A plaintext secret on disk is a finding regardless of git status, so the
  // default keeps everything; callers pass `accept` only to narrow by `--since`
  // for a fast PR scan (never to honor gitignore — a gitignored .env is still a leak).
  const accept = opts.accept ?? (() => true);
  const envFiles = new Set<string>();
  const secretDirs = new Set<string>();
  let rootReal: string;
  try {
    rootReal = realpathSync(root);
  } catch {
    return { envFiles: [], secretDirs: [], matches: [] };
  }

  const visit = (relDir: string, depth: number): void => {
    const absDir = relDir === "" ? rootReal : resolve(rootReal, relDir);
    const dirInfo = inspectContainedPath(rootReal, absDir);
    if (dirInfo.state !== "present" || dirInfo.kind !== "directory") return;
    for (const entry of safeReadDir(absDir)) {
      const rel = relDir === "" ? entry : `${relDir}/${entry}`;
      const abs = join(absDir, entry);
      const info = inspectContainedPath(rootReal, abs);
      if (info.state === "present" && info.kind === "directory") {
        // Only a ROOT-level secrets/ dir is a credential store; nested dirs
        // named "secrets" (src/secrets, tests/secrets, …) are code.
        if (entry === "secrets" && relDir === "" && accept(rel)) secretDirs.add(rel);
        // Recurse exactly one level deep (depth 0 → scan immediate children).
        if (depth > 0) visit(rel, depth - 1);
      } else if (
        info.state === "present" &&
        info.kind === "file" &&
        isEnvFile(entry) &&
        accept(rel)
      ) {
        envFiles.add(rel);
      }
    }
  };

  visit("", 1);

  const envList = [...envFiles].sort();
  const dirList = [...secretDirs].sort();
  return {
    envFiles: envList,
    secretDirs: dirList,
    matches: [...envList, ...dirList].sort(),
  };
}

/** One secret-scan finding inside or at a config file boundary (not a `.env`). */
export interface ConfigSecretHit {
  /** Repo-relative POSIX path of the offending config file. */
  file: string;
  /** Nearest JSON key for the matched value (best-effort; "" for a raw-text match). */
  key: string;
  /** What matched — a known provider token shape, secret-looking key literal, or unsafe path. */
  kind: string;
  /** Stable verification code to emit for this finding. Defaults to `mcp.hardcoded-secret`. */
  code?: Extract<CheckCode, "mcp.config-invalid" | "mcp.hardcoded-secret">;
}

/**
 * Repo-relative MCP config files aih writes or knows about. The sanctioned way to
 * carry a credential here is an env reference (`"${TOKEN}"`), never a literal — so
 * these files need a CONTENT scan. The filename-based {@link scanSecrets} cannot see
 * a token pasted INTO a config file, only a `.env` file sitting beside it; this
 * closes that hole for the MCP surface.
 */
export const MCP_CONFIG_FILES: readonly string[] = [
  ".mcp.json",
  ".cursor/mcp.json",
  ".kiro/settings/mcp.json",
  ".vscode/mcp.json",
  "opencode.json",
];

export interface ExternalMcpConfigFile {
  /** Redacted/display path, usually the registry's `~/...` path. */
  file: string;
  /** Absolute path to inspect. */
  absPath: string;
}

/** High-confidence provider credential shapes — a match is a secret regardless of key. */
const TOKEN_PATTERNS: ReadonlyArray<{ kind: string; re: RegExp }> = [
  { kind: "aws access key id", re: /AKIA[0-9A-Z]{16}/ },
  ...PROVIDER_TOKEN_PATTERNS,
];

/** Keys whose literal (non-placeholder) value is almost certainly a credential. */
const SECRET_KEY_RE =
  /token|secret|password|passwd|api[_-]?key|apikey|access[_-]?key|client[_-]?secret|credential|\bpat\b/i;

/** Minimum length for a secret-key literal to count — skips trivial flags like "1"/"on". */
const MIN_SECRET_VALUE_LEN = 8;

/** An env reference (`${VAR}` / `$VAR` / `%VAR%`) or empty value is the sanctioned form — not a leak. */
function isPlaceholderOrEmpty(value: string): boolean {
  const t = value.trim();
  return (
    t.length === 0 ||
    /^\$\{[^}]+\}$/.test(t) ||
    /^\$[A-Za-z_][A-Za-z0-9_]*$/.test(t) ||
    /^%[A-Za-z0-9_]+%$/.test(t)
  );
}

function isBearerPlaceholder(value: string): boolean {
  const m = /^Bearer\s+(.+)$/i.exec(value.trim());
  return m?.[1] !== undefined && isPlaceholderOrEmpty(m[1]);
}

/** First provider token shape that matches `value`, if any. */
function matchProvider(value: string): string | undefined {
  return TOKEN_PATTERNS.find((p) => p.re.test(value))?.kind;
}

function hasRawBearerLiteral(value: string): boolean {
  const re = /["']?\bauthorization\b["']?\s*[:=]\s*["']?Bearer\s+([^"'\r\n]*)/gi;
  for (const m of value.matchAll(re)) {
    const credential = m[1]?.trim();
    if (credential !== undefined && !isPlaceholderOrEmpty(credential)) return true;
  }
  return false;
}

function rawSecretKeyHits(value: string, file: string): ConfigSecretHit[] {
  const hits: ConfigSecretHit[] = [];
  const re =
    /["']?([A-Za-z0-9_.-]*(?:token|secret|password|passwd|api[_-]?key|apikey|access[_-]?key|client[_-]?secret|credential|pat)[A-Za-z0-9_.-]*)["']?\s*[:=]\s*["']([^"'\r\n]{8,})/gi;
  for (const match of value.matchAll(re)) {
    const key = match[1] ?? "";
    const literal = match[2] ?? "";
    if (isPlaceholderOrEmpty(literal) || /^https?:\/\//i.test(literal.trim())) continue;
    hits.push({ file, key, kind: "secret-looking key with a literal value" });
  }
  return hits;
}

/**
 * Walk parsed JSON collecting hits — `key` is the nearest object key for context.
 * A provider-shape match wins (and returns) so a token under a secret-looking key is
 * reported once, by its precise kind.
 */
function walkJson(node: unknown, key: string, file: string, hits: ConfigSecretHit[]): void {
  if (typeof node === "string") {
    const provider = matchProvider(node);
    if (provider !== undefined) {
      hits.push({ file, key, kind: provider });
      return;
    }
    if (
      key.toLowerCase() === "authorization" &&
      /^Bearer\s+\S+/i.test(node.trim()) &&
      !isBearerPlaceholder(node)
    ) {
      hits.push({ file, key, kind: "authorization bearer literal" });
      return;
    }
    if (
      SECRET_KEY_RE.test(key) &&
      !isPlaceholderOrEmpty(node) &&
      node.trim().length >= MIN_SECRET_VALUE_LEN &&
      !/^https?:\/\//i.test(node.trim())
    ) {
      hits.push({ file, key, kind: "secret-looking key with a literal value" });
    }
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) walkJson(item, key, file, hits);
    return;
  }
  if (node !== null && typeof node === "object") {
    for (const [k, v] of Object.entries(node)) walkJson(v, k, file, hits);
  }
}

/**
 * Scan known MCP config files for hardcoded secrets or unsafe file boundaries — a
 * provider token shape anywhere, a literal (non-`${ENV}`) value under a
 * secret-looking key, or a path that cannot be read as a repo-contained regular
 * file. Pure: reads only contained regular files, returns repo-relative hits, and
 * NEVER includes the secret value itself (only file + key + match kind). Malformed
 * JSON falls back to raw credential-shape scans so a broken file still cannot hide
 * a token.
 */
export function scanConfigSecrets(
  root: string,
  files: readonly string[] = MCP_CONFIG_FILES,
): ConfigSecretHit[] {
  const hits: ConfigSecretHit[] = [];
  for (const rel of files) {
    const read = readMcpConfig(root, rel);
    if (read.state === "absent") continue;
    if (read.state === "unsafe") {
      hits.push({
        file: rel,
        key: "",
        kind: "MCP config path is not a contained regular file",
        code: "mcp.config-invalid",
      });
      continue;
    }
    scanConfigSecretText(read.raw, rel, hits);
  }
  return hits;
}

export function scanExternalConfigSecrets(
  files: readonly ExternalMcpConfigFile[],
): ConfigSecretHit[] {
  const hits: ConfigSecretHit[] = [];
  for (const file of files) {
    const read = readMcpConfigPath(file.absPath);
    if (read.state === "absent") continue;
    if (read.state === "unsafe") {
      hits.push({
        file: file.file,
        key: "",
        kind: "MCP config path is not a regular file",
        code: "mcp.config-invalid",
      });
      continue;
    }
    scanConfigSecretText(read.raw, file.file, hits);
  }
  return hits;
}

function scanConfigSecretText(raw: string, file: string, hits: ConfigSecretHit[]): void {
  try {
    walkJson(parseJsoncText(raw) as unknown, "", file, hits);
  } catch {
    // Malformed JSON/TOML/raw text: a structural walk is impossible, but a provider
    // token in the raw bytes is still a leak — catch that rather than skip the file.
    const provider = matchProvider(raw);
    if (provider !== undefined) hits.push({ file, key: "", kind: provider });
    else if (hasRawBearerLiteral(raw)) {
      hits.push({ file, key: "", kind: "authorization bearer literal" });
    } else {
      hits.push(...rawSecretKeyHits(raw, file));
    }
  }
}

function readMcpConfig(
  root: string,
  rel: string,
): { state: "absent" } | { state: "unsafe" } | { state: "read"; raw: string } {
  const abs = resolve(root, rel);
  let rootReal: string;
  try {
    rootReal = realpathSync(root);
  } catch {
    return { state: "absent" };
  }
  try {
    const st = lstatSync(abs);
    if (st.isSymbolicLink() || !st.isFile()) return { state: "unsafe" };
    if (!containedPath(rootReal, realpathSync(abs))) return { state: "unsafe" };
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT"
      ? { state: "absent" }
      : { state: "unsafe" };
  }
  const contents = readRegularFile(abs);
  return contents === undefined
    ? { state: "unsafe" }
    : { state: "read", raw: contents.toString("utf8") };
}

function readMcpConfigPath(
  abs: string,
): { state: "absent" } | { state: "unsafe" } | { state: "read"; raw: string } {
  try {
    const st = lstatSync(abs);
    if (st.isSymbolicLink() || !st.isFile()) return { state: "unsafe" };
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ENOENT"
      ? { state: "absent" }
      : { state: "unsafe" };
  }
  const contents = readRegularFile(abs);
  return contents === undefined
    ? { state: "unsafe" }
    : { state: "read", raw: contents.toString("utf8") };
}
