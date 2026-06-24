/**
 * Deterministic string-building helpers shared by capability templates. All
 * generated files flow through these so golden-file tests stay stable: no dates,
 * no random ordering, single trailing newline.
 */

/** Join parts (strings or string arrays) with newlines; exactly one trailing newline. */
export function lines(...parts: Array<string | string[]>): string {
  const flat = parts.flat();
  return `${flat.join("\n").replace(/\n+$/, "")}\n`;
}

/** Indent every non-empty line of `text` by `n` spaces. */
export function indent(text: string, n = 2): string {
  const pad = " ".repeat(n);
  return text
    .split("\n")
    .map((l) => (l.length > 0 ? pad + l : l))
    .join("\n");
}

/** Render a YAML frontmatter block from ordered key/value pairs (insertion order). */
export function frontmatter(fields: Record<string, string | boolean | number | string[]>): string {
  const body = Object.entries(fields)
    .map(([k, v]) => {
      if (Array.isArray(v)) return `${k}: [${v.map((x) => JSON.stringify(x)).join(", ")}]`;
      return `${k}: ${v}`;
    })
    .join("\n");
  return `---\n${body}\n---`;
}

/** Stable 2-space JSON with a trailing newline (insertion order preserved). */
export function jsonFile(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** Ensure exactly one trailing newline. */
export function ensureTrailingNewline(text: string): string {
  return `${text.replace(/\n+$/, "")}\n`;
}

/** Marker that opens an aih-managed region (comment syntax works in sh + PowerShell). */
export function beginMarker(scope: string): string {
  return `# >>> aih managed (${scope}) >>>`;
}

/** Marker that closes an aih-managed region. */
export function endMarker(scope: string): string {
  return `# <<< aih managed (${scope}) <<<`;
}

/** Wrap `body` in begin/end markers for in-place regeneration. */
export function managedBlock(scope: string, body: string): string {
  return `${beginMarker(scope)}\n${body.replace(/\n+$/, "")}\n${endMarker(scope)}`;
}
