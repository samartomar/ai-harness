/**
 * Extract project-specific support guidance from a repo's SETUP.md (or similar
 * setup file). Two things feed the templates:
 *
 *   - projectContext  — WHY a correct environment matters for this project, woven
 *     into the "Why this matters" section of an external ticket.
 *   - corporateGuidance — an instruction telling the author/agent to rewrite the
 *     message in the organisation's standard support language, surfaced as an
 *     "adapt before sending" footer.
 *
 * Both are opt-in via explicit HTML-comment markers (precise, unambiguous); for
 * projectContext we also fall back to the first paragraph under a `## Why` /
 * `## Background` / `## Overview` / `## Purpose` / `## About` heading so existing
 * setup files contribute something without edits.
 *
 * Pure string parsing — the caller does the file read (integration). Marker names
 * are intentionally generic (`support:*`), carrying no tool branding into the
 * project's own setup file.
 */

export interface SupportGuidance {
  /** Why correct environment config matters here (markers win over the heading fallback). */
  projectContext?: string;
  /** How to adapt the outgoing message to corporate language. */
  corporateGuidance?: string;
  /**
   * Real routing metadata (assignment group, ticket prefix, …) the project chose
   * to publish. Rendered verbatim in the ticket's Environment block. Only ever
   * present when the setup file provides it — never inferred or invented.
   */
  routing?: string;
}

/** Headings whose first paragraph is a reasonable "why this matters" fallback. */
const HEADING_RE = /^#{1,6}\s+(why|background|overview|purpose|about)\b/i;
const ANY_HEADING_RE = /^#{1,6}\s/;

/** Trim and collapse all whitespace runs (incl. newlines) to single spaces. */
function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Content between `<!-- support:<name> -->` and `<!-- /support:<name> -->`, if any. */
function betweenMarkers(text: string, name: string): string | undefined {
  const re = new RegExp(
    `<!--\\s*support:${name}\\s*-->([\\s\\S]*?)<!--\\s*/support:${name}\\s*-->`,
    "i",
  );
  const inner = collapse(text.match(re)?.[1] ?? "");
  return inner.length > 0 ? inner : undefined;
}

/** First paragraph beneath the first matching heading, or undefined. */
function firstParagraphUnderHeading(text: string): string | undefined {
  const rows = text.replace(/\r\n/g, "\n").split("\n");
  const start = rows.findIndex((l) => HEADING_RE.test(l));
  if (start < 0) return undefined;
  const para: string[] = [];
  for (let i = start + 1; i < rows.length; i++) {
    const line = rows[i] ?? "";
    if (ANY_HEADING_RE.test(line)) break; // hit the next heading
    if (line.trim().length === 0) {
      if (para.length > 0) break; // end of the first paragraph
      continue; // skip blank lines before it
    }
    para.push(line.trim());
  }
  const joined = collapse(para.join(" "));
  return joined.length > 0 ? joined : undefined;
}

/** Parse SETUP.md text into the guidance the support templates consume. */
export function parseSupportGuidance(text: string): SupportGuidance {
  return {
    projectContext: betweenMarkers(text, "why") ?? firstParagraphUnderHeading(text),
    corporateGuidance: betweenMarkers(text, "language"),
    routing: betweenMarkers(text, "routing"),
  };
}
