import { lines } from "../internals/render.js";

/**
 * Enterprise secret-scanning rules layered on top of gitleaks' default ruleset.
 *
 * `[extend] useDefault = true` keeps the upstream rules (hundreds of provider
 * patterns) and adds the enterprise-specific detections the blueprint calls out:
 * AWS access-key IDs and any PEM private-key header. The allowlist intentionally
 * exempts only LOCAL scratch directories — never source — so a developer's
 * throwaway `.var/` cache can hold a fixture token without tripping the gate.
 */

/** AWS access-key ID (long-term `AKIA…` and temporary `A3T…`). */
export const AWS_KEY_REGEX = "(?i)(A3T[A-Z0-9]{16}|AKIA[0-9A-Z]{16})";

/** Any PEM private-key block header (RSA/EC/OPENSSH/DSA/…). */
export const PRIVATE_KEY_REGEX = "-----BEGIN [A-Z]+ PRIVATE KEY-----";

/** Local, non-synced scratch roots exempted from scanning (root-anchored regexes, never source dirs). */
export const SCRATCH_ALLOWLIST = ["^\\.var/", "^\\.aih-scratch/"];

/** Render `.gitleaks.toml` — default rules + enterprise regex + scratch allowlist. */
export function gitleaksToml(): string {
  return lines(
    "# .gitleaks.toml — secret-scanning policy (managed by aih guardrails)",
    "# Policy intent: inherit gitleaks' default ruleset, then add the enterprise",
    "# detections the security blueprint mandates. Edit rules here, not in CI.",
    "",
    "[extend]",
    "# Keep every upstream rule; enterprise rules below are additive.",
    "useDefault = true",
    "",
    "# --- Enterprise rules (blueprint: Security Guardrails) ---------------------",
    "",
    "[[rules]]",
    'id = "aws-access-key-id"',
    'description = "AWS access key ID (long-term AKIA or temporary A3T credentials)"',
    `regex = '''${AWS_KEY_REGEX}'''`,
    'tags = ["key", "AWS"]',
    "",
    "[[rules]]",
    'id = "generic-private-key"',
    'description = "PEM private key block (RSA/EC/OPENSSH/DSA and friends)"',
    `regex = '''${PRIVATE_KEY_REGEX}'''`,
    'tags = ["key", "private"]',
    "",
    "# --- Allowlist -------------------------------------------------------------",
    "# Exempt LOCAL scratch only. These dirs hold caches/SQLite/fixtures and are",
    "# git-ignored; source trees are always scanned.",
    "[allowlist]",
    'description = "Local scratch directories (never synced, never source)"',
    `paths = [${SCRATCH_ALLOWLIST.map((p) => `'''${p}'''`).join(", ")}]`,
  );
}
