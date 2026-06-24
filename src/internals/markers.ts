/**
 * Managed markdown blocks delimited by HTML comments — the mechanism behind the
 * `ai-coding/` canon bootloaders. A bootloader is hand-written tool-specific
 * content PLUS one generated block fenced by:
 *
 *   <!-- BEGIN <marker> (<note>) -->
 *   …generated…
 *   <!-- END <marker> -->
 *
 * Regenerating replaces only the fenced region, so a human's edits outside the
 * block survive and re-running with the same body is byte-identical (idempotent).
 * This is the markdown analogue of {@link upsertManagedBlock} in envfile.ts.
 */

export interface ManagedBlock {
  /** Stable marker id, e.g. "ai-canonical:shared". */
  marker: string;
  /** Parenthetical note on the BEGIN line (e.g. the generated-from source path). */
  note: string;
  /** The block body (markdown), without the surrounding markers. */
  body: string;
}

export function beginLine(marker: string, note: string): string {
  return `<!-- BEGIN ${marker} (${note}) -->`;
}

export function endLine(marker: string): string {
  return `<!-- END ${marker} -->`;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function blockPattern(marker: string): RegExp {
  // Match `<!-- BEGIN <marker> … --> … <!-- END <marker> -->` regardless of note.
  return new RegExp(`<!-- BEGIN ${escapeRegExp(marker)}[\\s\\S]*?${escapeRegExp(endLine(marker))}`);
}

/**
 * Upsert a managed block into `existing` (`undefined` = the file does not exist
 * yet). Replaces the fenced region if present, appends it if the file exists
 * without the markers, or creates the file as `preamble` + block when `existing`
 * is undefined. Everything outside the markers is preserved verbatim, and the
 * file's existing EOL style (CRLF vs LF) is kept. Deterministic for a given body.
 */
export function mergeManagedBlock(
  existing: string | undefined,
  block: ManagedBlock,
  preamble: string,
): string {
  const rendered = `${beginLine(block.marker, block.note)}\n\n${block.body}\n\n${endLine(block.marker)}`;

  if (existing === undefined) {
    const head = preamble.replace(/\n+$/, "");
    return `${head}\n\n${rendered}\n`;
  }

  const usesCrlf = /\r\n/.test(existing);
  const normalized = existing.replace(/\r\n/g, "\n");
  const pattern = blockPattern(block.marker);

  let next: string;
  if (pattern.test(normalized)) {
    next = normalized.replace(pattern, rendered);
  } else {
    const trimmed = normalized.replace(/\n+$/, "");
    next = trimmed.length > 0 ? `${trimmed}\n\n${rendered}\n` : `${rendered}\n`;
  }
  if (!next.endsWith("\n")) next += "\n";
  return usesCrlf ? next.replace(/\n/g, "\r\n") : next;
}

/**
 * Extract a managed block's body (trimmed) from `text`, or `undefined` if the
 * markers are absent. Used by the drift check: compare the on-disk body to the
 * freshly generated one and fail if they differ.
 */
export function extractManagedBlock(text: string, marker: string): string | undefined {
  const normalized = text.replace(/\r\n/g, "\n");
  const pattern = new RegExp(
    `<!-- BEGIN ${escapeRegExp(marker)}[^\\n]*-->\\n([\\s\\S]*?)\\n${escapeRegExp(endLine(marker))}`,
  );
  const m = normalized.match(pattern);
  return m?.[1]?.trim();
}
