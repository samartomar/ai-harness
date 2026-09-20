/**
 * The DOM-free half of the artifact-intake validators, moved here from
 * `ui/shell/artifact-intake-model.ts` so the engine can reach it (Lane E of
 * the editor port, acceptance rule section 7 row 22). That file re-exports
 * every name below, so the hand-built page's behaviour is unchanged and there
 * is still one source of truth.
 *
 * Pure, like everything under `engine/`: no DOM, no `window`, no Node
 * built-ins, and none of the base64 or Web Crypto globals the engine's host
 * contract (`tools/workbench-engine-platform.d.ts`) does not name. The
 * base64, digest and evidence-draft half stays in the original file.
 */

/**
 * Intake JSON is walked as the runtime walked it: untyped, after an own-object
 * check. Narrowing would change which malformed inputs fail and how.
 */
// biome-ignore lint/suspicious/noExplicitAny: verbatim port of untyped intake JSON walking
type Loose = any;

export const DIGEST = /^sha256:[a-f0-9]{64}$/;
export const MAX_DRAFT_BYTES = 600000;
export const MAX_DRAFT_BASE64 = 800000;
export const MAX_DRAFT_COUNT = 1000;
export const ID = /^[a-z0-9][a-z0-9._-]{0,127}$/;
export const PACKAGE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
export const SEMVER =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*)|(?:\d*[A-Za-z-][0-9A-Za-z-]*))(?:\.(?:(?:0|[1-9]\d*)|(?:\d*[A-Za-z-][0-9A-Za-z-]*)))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
export const COMMIT = /^[a-f0-9]{40}$/;
export const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function own(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function fail(message: string): never {
  throw new Error(message);
}

/** Exact member set: no unknown keys, every required key present. */
export function exact(
  value: Loose,
  allowed: readonly string[],
  required: readonly string[],
  label: string,
): void {
  if (!own(value)) fail(`${label} must be an object`);
  for (const key of Object.keys(value)) {
    if (allowed.indexOf(key) === -1) fail(`${label} has unknown member ${key}`);
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) fail(`${label} is missing ${key}`);
  }
}

/** Every string (and key) must be well-formed UTF-16 and already NFC. */
export function unicode(value: Loose, label: string): void {
  if (typeof value === "string") {
    for (let i = 0; i < value.length; i++) {
      const code = value.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = value.charCodeAt(i + 1);
        if (!(next >= 0xdc00 && next <= 0xdfff)) fail(`${label} contains malformed Unicode`);
        i++;
      } else if (code >= 0xdc00 && code <= 0xdfff) {
        fail(`${label} contains malformed Unicode`);
      }
    }
    if (value.normalize("NFC") !== value) fail(`${label} must already be NFC`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      unicode(item, `${label}[${index}]`);
    });
    return;
  }
  if (own(value)) {
    for (const key of Object.keys(value)) {
      unicode(key, `${label} key`);
      unicode(value[key], `${label}.${key}`);
    }
  }
}

/** Strict JSON: no duplicate keys, no trailing content, object root, NFC strings. */
export function strictJson(text: string, label: string): Loose {
  let at = 0;
  const length = text.length;
  const ws = (): void => {
    while (at < length && /[\t\n\r ]/.test(text.charAt(at))) at++;
  };
  const stringToken = (): string => {
    const start = at;
    if (text.charAt(at) !== '"') fail(`${label} contains invalid JSON string`);
    at++;
    while (at < length) {
      const ch = text.charAt(at);
      if (ch === '"') {
        at++;
        return JSON.parse(text.slice(start, at));
      }
      if (ch === "\\") at += 2;
      else at++;
    }
    return fail(`${label} contains unterminated JSON string`);
  };
  const valueToken = (): void => {
    ws();
    const ch = text.charAt(at);
    if (ch === "{") {
      at++;
      ws();
      const seen: Record<string, boolean> = {};
      if (text.charAt(at) === "}") {
        at++;
        return;
      }
      while (at < length) {
        ws();
        const key = stringToken();
        if (Object.hasOwn(seen, key)) fail(`duplicate JSON object key: ${key}`);
        seen[key] = true;
        ws();
        if (text.charAt(at) !== ":") fail(`${label} contains invalid JSON object`);
        at++;
        valueToken();
        ws();
        if (text.charAt(at) === "}") {
          at++;
          return;
        }
        if (text.charAt(at) !== ",") fail(`${label} contains invalid JSON object`);
        at++;
      }
    } else if (ch === "[") {
      at++;
      ws();
      if (text.charAt(at) === "]") {
        at++;
        return;
      }
      while (at < length) {
        valueToken();
        ws();
        if (text.charAt(at) === "]") {
          at++;
          return;
        }
        if (text.charAt(at) !== ",") fail(`${label} contains invalid JSON array`);
        at++;
      }
    } else if (ch === '"') {
      stringToken();
    } else {
      const match = text
        .slice(at)
        .match(/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/);
      if (!match) fail(`${label} contains invalid JSON value`);
      at += match[0].length;
    }
  };
  valueToken();
  ws();
  if (at !== length) fail(`${label} contains trailing JSON content`);
  const parsed = JSON.parse(text);
  if (!own(parsed)) fail(`${label} root must be an object`);
  unicode(parsed, label);
  return parsed;
}

export function https(value: Loose, label: string): void {
  if (typeof value !== "string") fail(`${label} must be an HTTPS URL`);
  let parsed: URL | undefined;
  try {
    parsed = new URL(value);
  } catch (_error) {
    fail(`${label} must be an HTTPS URL`);
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password)
    fail(`${label} must be an HTTPS URL without credentials`);
}

export function directorySource(value: Loose, label: string): void {
  exact(value, ["type", "provider", "url"], ["type", "provider", "url"], label);
  if (value.type !== "directory" || ["pulsemcp", "mcpmarket"].indexOf(value.provider) === -1)
    fail(`${label} directory provider is unsupported`);
  https(value.url, `${label} URL`);
  const parsed = new URL(value.url);
  const pulse = value.provider === "pulsemcp";
  const host = pulse ? "www.pulsemcp.com" : "mcpmarket.com";
  const prefix = pulse ? "/servers/" : "/server/";
  const slug = parsed.pathname.slice(prefix.length);
  if (
    parsed.hostname.toLowerCase() !== host ||
    parsed.port ||
    parsed.search ||
    parsed.hash ||
    parsed.pathname !== prefix + slug ||
    !/^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/.test(slug) ||
    parsed.toString() !== value.url
  )
    fail(`${label} must be one canonical ${pulse ? "PulseMCP" : "MCP Market"} server URL`);
}

export function npmRegistry(value: Loose, label: string): void {
  https(value, label);
  const parsed = new URL(value);
  if (
    parsed.search ||
    parsed.hash ||
    parsed.pathname !== "/" ||
    (value !== parsed.origin && value !== `${parsed.origin}/`)
  )
    fail(`${label} must be a canonical HTTPS origin`);
}

/**
 * Canonical SHA-512 SRI. The original decoded the payload with `atob` and
 * re-encoded it to prove both the 64-byte length and the canonical padding.
 * The engine has no base64 globals, so the same two facts are decided by the
 * shape the encoder can produce for exactly 64 bytes: 21 whole three-byte
 * groups (84 characters) plus one leftover byte, which emits one free
 * character and one that carries only two significant bits — so its alphabet
 * index is a multiple of 16 (`A`, `Q`, `g` or `w`) — then `==`.
 */
export function sri(value: unknown): boolean {
  return typeof value === "string" && /^sha512-[A-Za-z0-9+/]{85}[AQgw]==$/.test(value);
}

export function safePath(value: Loose, label: string): void {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 1024 ||
    value.charAt(0) === "/" ||
    /^[A-Za-z]:/.test(value) ||
    /[\\%?#:]/.test(value) ||
    value.charAt(value.length - 1) === "/" ||
    value.split("/").some((part: string) => !part || part === "." || part === "..")
  )
    fail(`${label} must be a safe relative POSIX path no longer than 1024 characters`);
}

export function source(value: Loose, label: string, allowDirectory: boolean): void {
  if (
    !own(value) ||
    (value.type !== "npm" &&
      value.type !== "github" &&
      (!allowDirectory || value.type !== "directory"))
  )
    fail(
      `${label} must be an npm or GitHub source${allowDirectory ? " or a supported directory claim" : ""}`,
    );
  if (value.type === "directory") {
    directorySource(value, label);
    return;
  }
  if (value.type === "npm") {
    exact(
      value,
      ["type", "registry", "package", "version", "integrity", "path"],
      ["type", "registry", "package", "version"],
      label,
    );
    npmRegistry(value.registry, `${label} registry`);
    if (typeof value.package !== "string" || !PACKAGE.test(value.package))
      fail(`${label} package must be unscoped-package or @scope/package`);
    if (typeof value.version !== "string" || !SEMVER.test(value.version))
      fail(`${label} version must be exact semantic version`);
    if (value.integrity !== undefined && !sri(value.integrity))
      fail(`${label} integrity must be canonical SHA-512 SRI`);
    if (value.path !== undefined) safePath(value.path, `${label} path`);
  } else {
    exact(
      value,
      ["type", "repository", "commit", "path"],
      ["type", "repository", "commit", "path"],
      label,
    );
    if (
      typeof value.repository !== "string" ||
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value.repository)
    )
      fail(`${label} repository must be owner/repository`);
    if (typeof value.commit !== "string" || !COMMIT.test(value.commit))
      fail(`${label} commit must be a lowercase 40-character commit`);
    safePath(value.path, `${label} path`);
  }
}

/** Validate one `aih-artifact-intake` document; returns the same value. */
export function validateIntake(value: Loose): Loose {
  exact(
    value,
    ["format", "version", "authority", "defaults", "items"],
    ["format", "version", "authority", "items"],
    "artifact intake",
  );
  if (value.format !== "aih-artifact-intake" || (value.version !== 1 && value.version !== 2))
    fail("artifact intake format/version is unsupported");
  exact(value.authority, ["state"], ["state"], "artifact intake authority");
  if (value.authority.state !== "not-authority")
    fail("artifact intake must declare itself non-authoritative");
  if (value.defaults !== undefined) {
    exact(value.defaults, ["accountableOwner"], [], "artifact intake defaults");
    if (
      value.defaults.accountableOwner !== undefined &&
      (typeof value.defaults.accountableOwner !== "string" ||
        value.defaults.accountableOwner.length > 320 ||
        !EMAIL.test(value.defaults.accountableOwner))
    )
      fail("default accountable owner must be an email no longer than 320 characters");
  }
  if (!Array.isArray(value.items) || value.items.length < 1 || value.items.length > 100)
    fail("artifact intake must contain 1-100 items");
  const ids = new Set<unknown>();
  value.items.forEach((item: Loose, index: number) => {
    const label = `artifact intake item ${index}`;
    exact(
      item,
      ["id", "kind", "discoveryUrl", "accountableOwner", "source", "clarification"],
      ["id", "kind", "source"],
      label,
    );
    if (typeof item.id !== "string" || !ID.test(item.id) || ids.has(item.id))
      fail(`${label} identifier is invalid or duplicated`);
    ids.add(item.id);
    if (["mcp", "skill", "agent"].indexOf(item.kind) === -1)
      fail(`${label} kind must be mcp, skill, or agent`);
    if (item.discoveryUrl !== undefined) https(item.discoveryUrl, `${label} discovery URL`);
    if (
      item.accountableOwner !== undefined &&
      (typeof item.accountableOwner !== "string" ||
        item.accountableOwner.length > 320 ||
        !EMAIL.test(item.accountableOwner))
    )
      fail(`${label} accountable owner must be an email no longer than 320 characters`);
    if (
      item.accountableOwner === undefined &&
      (!value.defaults || value.defaults.accountableOwner === undefined)
    )
      fail(`${label} needs an accountable owner or default`);
    source(item.source, `${label} source`, value.version === 2);
    if (item.source.type === "directory" && (value.version !== 2 || item.kind !== "mcp"))
      fail(`${label} directory claims require intake version 2 and MCP kind`);
    if (
      item.clarification !== undefined &&
      (typeof item.clarification !== "string" ||
        !item.clarification ||
        item.clarification.length > 1000)
    )
      fail(`${label} clarification is invalid`);
  });
  return value;
}

export function utf8Bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}
