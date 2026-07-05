/**
 * Source-side secret redaction for aih's OWN printed/written output (digests,
 * reports, roll-ups) — distinct from the collector layer (telemetry, destination)
 * and the gitleaks layer (scan). One source of truth: the AWS / private-key
 * patterns are IMPORTED from {@link ./gitleaks.js}, not re-declared, so there is no
 * third copy of those regexes to drift.
 *
 * The added patterns (sk-ant / ghp_ / bearer / `KEY=VALUE`) mirror the redaction
 * set in LeanHarness `.lh/policies/claude-code.yml` (MIT) — concept only, regexes
 * authored against aih's needs.
 */

import { AWS_KEY_REGEX, PRIVATE_KEY_REGEX } from "./gitleaks.js";

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

/**
 * Patterns applied in order. Anchored / specific so benign text is untouched:
 * `KEY=VALUE` only fires on an UPPERCASE secret-ish key immediately followed by
 * `=`, so a bare lowercase `token` in prose is never redacted.
 */
const PATTERNS: RegExp[] = [
  fromGitleaks(AWS_KEY_REGEX), // AKIA… / A3T… access-key ids
  fromGitleaks(PRIVATE_KEY_REGEX), // -----BEGIN … PRIVATE KEY-----
  /\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{10,}\b/g, // GitHub tokens
  /\bsk-[A-Za-z0-9_-]{12,}\b/g, // OpenAI-style API keys
  /sk-ant-[A-Za-z0-9_-]{8,}/g, // Anthropic API keys
  /ghp_[A-Za-z0-9]{36,}/g, // GitHub personal-access tokens
  /bearer\s+[A-Za-z0-9._-]+/gi, // Authorization: Bearer <token>
  /\b[A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|ACCESS_KEY)[A-Z0-9_]*\s*[:=]\s*["']?[^\s"']{8,}/gi,
  /\b[A-Z_]*(?:TOKEN|SECRET|PASSWORD|API_KEY)\s*=\s*\S+/g, // FOO_TOKEN=…, API_KEY=…
];

/** Replace any matched secret material in `text` with `[REDACTED]`. */
export function redactSecrets(text: string): string {
  return PATTERNS.reduce((s, re) => s.replace(re, REDACTED), text);
}
