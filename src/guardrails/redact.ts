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
import { PROVIDER_TOKEN_PATTERNS } from "./token-patterns.js";

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
  ...PROVIDER_TOKEN_PATTERNS.map((pattern) => globalPattern(pattern.re)),
  /bearer\s+[A-Za-z0-9._-]+/gi, // Authorization: Bearer <token>
  /\b[A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|ACCESS_KEY)[A-Z0-9_]*\s*[:=]\s*["']?[^\s"']{8,}/gi,
  /\b[A-Z_]*(?:TOKEN|SECRET|PASSWORD|API_KEY)\s*=\s*\S+/g, // FOO_TOKEN=…, API_KEY=…
];

/** Replace any matched secret material in `text` with `[REDACTED]`. */
export function redactSecrets(text: string): string {
  return PATTERNS.reduce((s, re) => s.replace(re, REDACTED), text);
}
