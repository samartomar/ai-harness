import type { EnvShell } from "../platform/base.js";
import { beginMarker, endMarker, stripTrailingNewlines } from "./render.js";

export interface EnvVar {
  key: string;
  value: string;
}

/** Format a single env assignment for the target shell. */
export function formatExport(v: EnvVar, shell: EnvShell): string {
  if (shell === "powershell") {
    return `$env:${v.key} = ${JSON.stringify(v.value)}`;
  }
  return `export ${v.key}=${posixQuote(v.value)}`;
}

function posixQuote(s: string): string {
  if (/^[A-Za-z0-9_./:@%+=-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Insert or replace the aih-managed block for `scope` in a shell profile.
 *
 * Idempotent by construction: the region between the begin/end markers is
 * replaced wholesale, so re-running with the same vars yields byte-identical
 * output and lines outside the markers are never touched. Preserves the file's
 * existing EOL style (CRLF vs LF).
 */
export function upsertManagedBlock(
  existing: string,
  scope: string,
  vars: EnvVar[],
  shell: EnvShell,
): string {
  const begin = beginMarker(scope);
  const end = endMarker(scope);
  const blockBody = vars.map((v) => formatExport(v, shell)).join("\n");
  const block = `${begin}\n${blockBody}\n${end}`;

  const usesCrlf = /\r\n/.test(existing);
  const normalized = existing.replace(/\r\n/g, "\n");

  const pattern = new RegExp(`${escapeRegExp(begin)}[\\s\\S]*?${escapeRegExp(end)}`);

  let next: string;
  if (pattern.test(normalized)) {
    next = normalized.replace(pattern, block);
  } else {
    const trimmed = stripTrailingNewlines(normalized);
    next = trimmed.length > 0 ? `${trimmed}\n\n${block}\n` : `${block}\n`;
  }
  if (!next.endsWith("\n")) next += "\n";
  return usesCrlf ? next.replace(/\n/g, "\r\n") : next;
}

/** Remove the managed block for `scope` if present (used by uninstall paths). */
export function removeManagedBlock(existing: string, scope: string): string {
  const begin = beginMarker(scope);
  const end = endMarker(scope);
  const usesCrlf = /\r\n/.test(existing);
  const normalized = existing.replace(/\r\n/g, "\n");
  const pattern = new RegExp(`\\n*${escapeRegExp(begin)}[\\s\\S]*?${escapeRegExp(end)}\\n*`);
  const next = normalized.replace(pattern, "\n").replace(/^\n+/, "");
  return usesCrlf ? next.replace(/\n/g, "\r\n") : next;
}
