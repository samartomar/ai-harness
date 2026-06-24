/**
 * Minimal, idempotent INI / TOML key upserts for package-manager config files.
 *
 * These managers each own a small, hand-edited config file (`.npmrc`,
 * `pip.conf`/`pip.ini`, `.cargo/config.toml`). The harness must set exactly one
 * or two keys without clobbering the developer's other settings, so we parse the
 * file line-by-line and replace just the target line — re-running yields
 * byte-identical output (the second pass sees the key already present and
 * rewrites it in place).
 *
 * `.npmrc` is a flat `key=value` file (no sections); pip and cargo are sectioned
 * (`[global]`, `[http]`, `[net]`). One helper covers both: pass `section: null`
 * for the flat case. The caller supplies the exact value text and separator so
 * cargo's quoted TOML (`cainfo = "..."`) and pip's bare `cert=...` both render
 * faithfully.
 */

export interface UpsertIniOptions {
  /** Section header to scope the key under (e.g. `global`, `http`); null for a flat file. */
  section?: string | null;
  /** Separator between key and value. Default `=` (npm/pip); TOML uses ` = `. */
  separator?: string;
}

/**
 * Insert or update `key = value` in `existing`, preserving every other line.
 * When a `section` is given, the key is placed inside that section (created at
 * the end of the file if absent). Existing EOL style (CRLF vs LF) is preserved.
 */
export function upsertIniKey(
  existing: string,
  key: string,
  value: string,
  opts: UpsertIniOptions = {},
): string {
  const section = opts.section ?? null;
  const sep = opts.separator ?? "=";
  const line = `${key}${sep}${value}`;

  const usesCrlf = /\r\n/.test(existing);
  const normalized = existing.replace(/\r\n/g, "\n");
  const next =
    section === null
      ? upsertFlat(normalized, key, line)
      : upsertSectioned(normalized, section, key, line);
  const withEol = next.endsWith("\n") || next.length === 0 ? next : `${next}\n`;
  return usesCrlf ? withEol.replace(/\n/g, "\r\n") : withEol;
}

/** Flat file (`.npmrc`): replace the first `key=...` line, else append. */
function upsertFlat(text: string, key: string, line: string): string {
  const lines = splitKeepEmpty(text);
  const idx = lines.findIndex((l) => keyMatches(l, key));
  if (idx >= 0) {
    lines[idx] = line;
    return joinTrim(lines);
  }
  return appendLine(text, line);
}

/** Sectioned file (pip/cargo): place `key` under `[section]`, creating it if needed. */
function upsertSectioned(text: string, section: string, key: string, line: string): string {
  const header = `[${section}]`;
  const lines = splitKeepEmpty(text);
  const headerIdx = lines.findIndex((l) => l.trim() === header);

  if (headerIdx < 0) {
    // Section absent: append a fresh `[section]` block.
    const block = `${header}\n${line}`;
    return appendLine(text, block);
  }

  // Scan the section body until the next header (or EOF) for an existing key.
  let end = lines.length;
  for (let i = headerIdx + 1; i < lines.length; i += 1) {
    if (/^\s*\[[^\]]+\]\s*$/.test(lines[i] ?? "")) {
      end = i;
      break;
    }
  }
  for (let i = headerIdx + 1; i < end; i += 1) {
    if (keyMatches(lines[i] ?? "", key)) {
      lines[i] = line;
      return joinTrim(lines);
    }
  }
  // Key absent within the section: insert just after the header.
  lines.splice(headerIdx + 1, 0, line);
  return joinTrim(lines);
}

/** True when a config line assigns `key` (ignoring leading whitespace and `=`/` = `). */
function keyMatches(rawLine: string, key: string): boolean {
  const m = rawLine.match(/^\s*([A-Za-z0-9_.-]+)\s*=/);
  return m?.[1] === key;
}

function splitKeepEmpty(text: string): string[] {
  if (text.length === 0) return [];
  return text.replace(/\n+$/, "").split("\n");
}

function joinTrim(lines: string[]): string {
  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}

function appendLine(text: string, line: string): string {
  const trimmed = text.replace(/\n+$/, "");
  return trimmed.length > 0 ? `${trimmed}\n${line}\n` : `${line}\n`;
}
