import { type ParseError, parse as parseJsonc, printParseErrorCode } from "jsonc-parser";
import { MergeError } from "../errors.js";

/**
 * Parse JSON or JSONC text (tolerant of comments + trailing commas). Returns
 * `undefined` for empty input. Throws {@link MergeError} on a genuine syntax
 * error: `jsonc-parser` returns a PARTIAL value for malformed input (incomplete
 * braces, trailing garbage), and merging onto a partial parse would silently
 * drop the user's real config — so we fail closed and ask for a manual fix
 * instead of overwriting from a half-read file.
 */
export function parseJsoncText(text: string): unknown {
  if (text.trim().length === 0) return undefined;
  const errors: ParseError[] = [];
  const value = parseJsonc(text, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0) {
    const detail = errors
      .map((e) => `${printParseErrorCode(e.error)} at offset ${e.offset}`)
      .join("; ");
    throw new MergeError(
      `refusing to merge into malformed JSON/JSONC (fix the file first): ${detail}`,
    );
  }
  return value;
}

export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Deep-merge `incoming` (harness-generated) onto `base` (existing user config),
 * preserving every key that exists only in `base`. Objects merge recursively;
 * primitive arrays become a deduped union (base order first) so things like
 * `permissions.deny` accumulate instead of clobbering; for any other type
 * mismatch, `incoming` wins.
 */
export function deepMerge(base: unknown, incoming: unknown): unknown {
  if (incoming === undefined) return base;
  if (isPlainObject(base) && isPlainObject(incoming)) {
    const out: Record<string, unknown> = { ...base };
    for (const [k, v] of Object.entries(incoming)) {
      out[k] = k in base ? deepMerge(base[k], v) : v;
    }
    return out;
  }
  if (Array.isArray(base) && Array.isArray(incoming)) {
    return unionUnique(base, incoming);
  }
  return incoming;
}

function unionUnique(a: unknown[], b: unknown[]): unknown[] {
  const seen = new Set<string>();
  const out: unknown[] = [];
  for (const item of [...a, ...b]) {
    const key = typeof item === "object" && item !== null ? JSON.stringify(item) : String(item);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(item);
    }
  }
  return out;
}
