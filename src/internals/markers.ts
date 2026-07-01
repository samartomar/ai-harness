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

import { stripTrailingNewlines } from "./render.js";

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
    const head = stripTrailingNewlines(preamble);
    return `${head}\n\n${rendered}\n`;
  }

  const usesCrlf = /\r\n/.test(existing);
  const normalized = existing.replace(/\r\n/g, "\n");
  const pattern = blockPattern(block.marker);

  let next: string;
  if (pattern.test(normalized)) {
    next = normalized.replace(pattern, rendered);
  } else {
    const trimmed = stripTrailingNewlines(normalized);
    next = trimmed.length > 0 ? `${trimmed}\n\n${rendered}\n` : `${rendered}\n`;
  }
  if (!next.endsWith("\n")) next += "\n";
  return usesCrlf ? next.replace(/\n/g, "\r\n") : next;
}

/**
 * Remove a managed block (and the blank lines hugging it) from `existing`, leaving
 * everything OUTSIDE the fence verbatim and preserving the file's EOL style. The
 * inverse of {@link mergeManagedBlock}: `aih prune` uses it to SUBTRACT aih's
 * canonical block from a co-owned bootloader when the CLI is dropped, so the
 * tool-specific preamble and any human edits survive. Returns `existing` unchanged
 * when the marker is absent (no-op), and `""` when the block was the file's entire
 * content. It never deletes the file — the caller writes the stripped remainder in
 * place (the bootloader has no reliable "pure-aih remainder" signal, so we keep it).
 */
export function stripManagedBlock(existing: string, marker: string): string {
  const normalized = existing.replace(/\r\n/g, "\n");
  // Greedily consume the blank lines around the fence so removing it doesn't leave a
  // double-blank gap where the block used to be.
  const pattern = new RegExp(
    `\\n*<!-- BEGIN ${escapeRegExp(marker)}[\\s\\S]*?${escapeRegExp(endLine(marker))}\\n*`,
  );
  if (!pattern.test(normalized)) return existing;
  const stripped = normalized
    .replace(pattern, "\n\n") // block + hugging blanks → a single paragraph break
    .replace(/\n{3,}/g, "\n\n") // never leave more than one blank line
    .replace(/^\n+/, "")
    .replace(/\n+$/, "");
  const next = stripped.length > 0 ? `${stripped}\n` : "";
  return /\r\n/.test(existing) ? next.replace(/\n/g, "\r\n") : next;
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

/** The sub-marker that fences a human "project extension" inside a managed block. */
export const PROJECT_EXTENSION_MARKER = "project-extension";

/** Trimmed, non-empty lines of a body — the unit the extension diff works on. */
function meaningfulLines(text: string): string[] {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l.trim().length > 0);
}

/**
 * Carve the human "project extension" out of an on-disk managed-block body — the
 * core of `aih adopt`'s non-destructive reconcile. A brownfield bootloader (e.g.
 * eicp) folded project-specific guidance INTO the shared block; regenerating the
 * block from the canonical source would silently delete it. This isolates exactly
 * those human lines so the caller can re-home them to a project-owned file BEFORE
 * the block is regenerated clean.
 *
 * Two strategies (the decided "diff-inferred now + sub-marker going forward"):
 *  1. **Sub-marker (precise)** — if `onDisk` fences a region with
 *     `<!-- BEGIN project-extension -->…<!-- END project-extension -->`, that
 *     region's content IS the extension, verbatim and order-preserving.
 *  2. **Diff-inferred (legacy)** — otherwise, the extension is the set of on-disk
 *     lines whose trimmed form is absent from `canonical`, kept in on-disk order
 *     with their original text. Whitespace-only and pure-structure lines that also
 *     appear in canonical are dropped, so a reordering alone yields no false extension.
 *
 * Returns the extension as a trimmed markdown string, or `""` when there is none
 * (i.e. the on-disk body is canonical — already adopted).
 */
export function splitManagedBody(onDisk: string, canonical: string): string {
  const sub = extractManagedBlock(onDisk, PROJECT_EXTENSION_MARKER);
  if (sub !== undefined) return sub.trim();

  const canonicalSet = new Set(meaningfulLines(canonical).map((l) => l.trim()));
  const extension: string[] = [];
  for (const line of onDisk.replace(/\r\n/g, "\n").split("\n")) {
    const t = line.trim();
    if (t.length === 0) {
      // Keep a single separating blank between kept lines; never lead with one.
      if (extension.length > 0 && extension[extension.length - 1] !== "") extension.push("");
      continue;
    }
    if (!canonicalSet.has(t)) extension.push(line.trimEnd());
  }
  // Drop any trailing blank, then join.
  while (extension.length > 0 && extension[extension.length - 1] === "") extension.pop();
  return extension.join("\n").trim();
}
