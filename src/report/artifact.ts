import type { DigestAction } from "../internals/plan.js";
import { lines } from "../internals/render.js";

/** HTML-escape text for safe embedding in `<pre>` / `<title>`. */
function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Render the report's digests as a Markdown document — one section per digest,
 * the verbatim body in a fenced block so the aligned columns survive. Byte-stable
 * (no timestamp) so re-applying the artifact is a no-op when nothing changed.
 */
export function reportMarkdown(title: string, digests: DigestAction[]): string {
  const parts: string[] = [`# ${title}`, ""];
  for (const d of digests) {
    parts.push(`## ${d.describe}`, "", "```text", d.text.replace(/\n+$/, ""), "```", "");
  }
  return lines(...parts);
}

/**
 * Render the report's digests as a self-contained static HTML page (no external
 * assets, dark/light aware). Same byte-stable contract as {@link reportMarkdown}.
 */
export function reportHtml(title: string, digests: DigestAction[]): string {
  const sections = digests
    .map(
      (d) =>
        `  <section>\n    <h2>${esc(d.describe)}</h2>\n    <pre>${esc(d.text.replace(/\n+$/, ""))}</pre>\n  </section>`,
    )
    .join("\n");
  return lines(
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '  <meta charset="utf-8">',
    '  <meta name="viewport" content="width=device-width, initial-scale=1">',
    `  <title>${esc(title)}</title>`,
    "  <style>",
    "    :root { color-scheme: dark light; }",
    "    body { font: 15px/1.6 ui-sans-serif, system-ui, sans-serif; max-width: 880px;",
    "      margin: 2rem auto; padding: 0 1.25rem; }",
    "    h1 { font-size: 1.5rem; margin-bottom: 1.5rem; }",
    "    h2 { font-size: 1.05rem; margin: 1.75rem 0 0.5rem; padding-bottom: 0.3rem;",
    "      border-bottom: 1px solid color-mix(in oklch, currentColor 25%, transparent); }",
    "    pre { font: 13px/1.5 ui-monospace, SFMono-Regular, monospace; white-space: pre-wrap;",
    "      background: color-mix(in oklch, currentColor 6%, transparent);",
    "      padding: 1rem 1.1rem; border-radius: 8px; overflow-x: auto; }",
    "  </style>",
    "</head>",
    "<body>",
    `  <h1>${esc(title)}</h1>`,
    sections,
    "</body>",
    "</html>",
  );
}
