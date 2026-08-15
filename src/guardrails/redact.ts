/**
 * Source-side secret redaction for aih's OWN printed/written output (digests,
 * reports, roll-ups) — distinct from the collector layer (telemetry, destination)
 * and the gitleaks layer (scan). AWS / private-key patterns are imported from
 * {@link ./gitleaks.js}; provider token shapes are imported from
 * {@link ./token-patterns.js}, shared with the config and MCP detector paths.
 *
 * The added patterns (sk-ant / ghp_ / bearer / `KEY=VALUE`) mirror the redaction
 * set in LeanHarness `.lh/policies/claude-code.yml` (MIT) — concept only, regexes
 * authored against aih's needs.
 */

import { AWS_KEY_REGEX, PRIVATE_KEY_REGEX } from "./gitleaks.js";
import { PROVIDER_TOKEN_REDACTION_PATTERNS } from "./token-patterns.js";

const REDACTED = "[REDACTED]";

/**
 * Build a JS `RegExp` from a gitleaks-style pattern string. gitleaks uses Go's
 * inline `(?i)` case-insensitivity prefix, which is NOT valid JS regex syntax — so
 * strip a leading `(?i)` and fold it into the JS `i` flag instead.
 */
function fromGitleaks(src: string): RegExp {
  const ci = src.startsWith("(?i)");
  return new RegExp(ci ? src.slice(4) : src, ci ? "gi" : "g");
}

function globalPattern(re: RegExp): RegExp {
  return new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
}

/**
 * Patterns applied in order. Anchored / specific so benign text is untouched:
 * `KEY=VALUE` only fires on an UPPERCASE secret-ish key immediately followed by
 * `=`, so a bare lowercase `token` in prose is never redacted.
 */
const PATTERNS: RegExp[] = [
  fromGitleaks(AWS_KEY_REGEX), // AKIA… / A3T… access-key ids
  fromGitleaks(PRIVATE_KEY_REGEX), // -----BEGIN … PRIVATE KEY-----
  ...PROVIDER_TOKEN_REDACTION_PATTERNS.map((pattern) => globalPattern(pattern.re)),
  /bearer\s+[A-Za-z0-9._-]+/gi, // Authorization: Bearer <token>
];

const ASSIGNMENT_KEYWORDS = ["TOKEN", "SECRET", "PASSWORD", "PASSWD", "API_KEY", "ACCESS_KEY"];
const SHORT_ASSIGNMENT_KEYWORDS = ["TOKEN", "SECRET", "PASSWORD", "API_KEY"];

function isAsciiLetter(char: string): boolean {
  return (char >= "A" && char <= "Z") || (char >= "a" && char <= "z");
}

function isAssignmentKeyChar(char: string): boolean {
  return isAsciiLetter(char) || (char >= "0" && char <= "9") || char === "_";
}

function isAsciiWordChar(char: string | undefined): boolean {
  return char !== undefined && (isAssignmentKeyChar(char) || char === "_");
}

function skipWhitespace(text: string, index: number): number {
  while (index < text.length && /\s/.test(text[index] ?? "")) index++;
  return index;
}

/**
 * Redact `KEY=VALUE` diagnostics with a single forward scan. This preserves the
 * two former assignment-pattern behaviors without regex backtracking on
 * attacker-controlled uppercase diagnostic text.
 */
function redactSecretAssignments(text: string): string {
  let copied = 0;
  let output: string | undefined;
  for (let index = 0; index < text.length; ) {
    if (!isAsciiLetter(text[index] ?? "") || isAsciiWordChar(text[index - 1])) {
      index++;
      continue;
    }
    const keyStart = index;
    while (index < text.length && isAssignmentKeyChar(text[index] ?? "")) index++;
    const keyEnd = index;
    const key = text.slice(keyStart, keyEnd);
    const separatorAt = skipWhitespace(text, keyEnd);
    const separator = text[separatorAt];
    if (separator !== ":" && separator !== "=") continue;
    const valueAt = skipWhitespace(text, separatorAt + 1);
    const quote = text[valueAt];
    const unquotedValueAt = quote === '"' || quote === "'" ? valueAt + 1 : valueAt;
    let longValueEnd = unquotedValueAt;
    while (
      longValueEnd < text.length &&
      !/\s/.test(text[longValueEnd] ?? "") &&
      text[longValueEnd] !== '"' &&
      text[longValueEnd] !== "'"
    ) {
      longValueEnd++;
    }
    const upperKey = key.toUpperCase();
    if (
      longValueEnd - unquotedValueAt >= 8 &&
      ASSIGNMENT_KEYWORDS.some((keyword) => upperKey.includes(keyword))
    ) {
      output ??= "";
      output += text.slice(copied, keyStart) + REDACTED;
      copied = longValueEnd;
      index = longValueEnd;
      continue;
    }
    if (separator === "=" && SHORT_ASSIGNMENT_KEYWORDS.some((keyword) => key.endsWith(keyword))) {
      let shortValueEnd = valueAt;
      while (shortValueEnd < text.length && !/\s/.test(text[shortValueEnd] ?? "")) shortValueEnd++;
      if (shortValueEnd > valueAt && /^[A-Z_]+$/.test(key)) {
        output ??= "";
        output += text.slice(copied, keyStart) + REDACTED;
        copied = shortValueEnd;
        index = shortValueEnd;
      }
    }
  }
  return output === undefined ? text : output + text.slice(copied);
}

/** Replace any matched secret material in `text` with `[REDACTED]`. */
export function redactSecrets(text: string): string {
  return redactSecretAssignments(PATTERNS.reduce((s, re) => s.replace(re, REDACTED), text));
}
