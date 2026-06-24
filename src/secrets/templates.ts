import { lines } from "../internals/render.js";
import type { SecretScan } from "./scan.js";

/**
 * Agent read-deny rules merged into `.claude/settings.json`. Kept as constants so
 * the plan and its golden tests share one source of truth, and so a future
 * `permissions.deny` union (see internals/merge `unionUnique`) accumulates these
 * exact strings instead of duplicating near-misses.
 */
export const DENY_ENV = "Read(./.env*)";
export const DENY_SECRETS = "Read(./secrets/**)";

/** The `permissions.deny` payload, in deny-rule order, for the settings merge. */
export const DENY_RULES: readonly string[] = [DENY_ENV, DENY_SECRETS];

/** Structured value handed to `writeJson(..., { merge: true })`. */
export function settingsDenyPatch(): {
  permissions: { deny: string[] };
} {
  return { permissions: { deny: [...DENY_RULES] } };
}

/**
 * `.claudeignore` body — a coarse, tool-agnostic backstop to the settings deny
 * rules. Lists the same plaintext-secret surfaces so an agent that honors the
 * ignore file never even enumerates them. Deterministic, single trailing newline.
 */
export function claudeIgnore(): string {
  return lines(
    "# Managed by aih (secrets). Keep plaintext secret material out of agent context.",
    "# This complements the Read(...) deny rules in .claude/settings.json.",
    "",
    "# Environment files (real secrets) — .env.example / .env.sample stay visible.",
    ".env",
    ".env.*",
    "!.env.example",
    "!.env.sample",
    "",
    "# Secret bundles / mounted material.",
    "secrets/",
    "**/secrets/",
  );
}

/**
 * Dynamic-vault-injection guidance. Cloud/secret-manager setup is DOC ONLY — we
 * never connect to a vault or fetch a credential. The example execution hook
 * shows how to pull a SHORT-LIVED token at runtime so nothing is ever written to
 * disk in plaintext. `contextDir` routes the reader back to the canonical rules.
 */
export function vaultGuidance(contextDir: string): string {
  return lines(
    "# Secrets: redirect to a vault, never plaintext on disk",
    "",
    "Plaintext `.env` files and `secrets/` bundles are blocked from agent context",
    "(see `.claude/settings.json` deny rules + `.claudeignore`). Replace them with",
    "DYNAMIC INJECTION: fetch short-lived credentials at process start, keep them in",
    "the environment for the lifetime of the run, and never write them to disk.",
    "",
    "aih does NOT connect to any vault. Run the commands below yourself (or wire them",
    "into your own runtime), after authenticating with your platform's normal flow.",
    "",
    "## HashiCorp Vault (short-lived, leased)",
    "",
    "```sh",
    "# Authenticate out-of-band (OIDC / AppRole / Kubernetes auth), then:",
    "export VAULT_ADDR=https://vault.internal:8200",
    'export OPENAI_API_KEY="$(vault kv get -field=api_key secret/ai/openai)"',
    "# Prefer a dynamic, leased credential over a static KV value where available:",
    "#   vault read -field=token database/creds/ai-app   # auto-expires on lease end",
    "```",
    "",
    "## AWS Secrets Manager (fetch at boot, hold in env)",
    "",
    "```sh",
    'export ANTHROPIC_API_KEY="$(aws secretsmanager get-secret-value \\',
    '  --secret-id ai/anthropic --query SecretString --output text)"',
    "# Use a short-session role (STS AssumeRole) so the fetch itself is time-bounded.",
    "```",
    "",
    "## 1Password CLI (op run — never materializes the secret)",
    "",
    "```sh",
    "# .env holds REFERENCES like OPENAI_API_KEY=op://vault/openai/api_key, not values.",
    "op run --env-file=.env.op -- <your-agent-command>",
    "# `op run` injects resolved values into the child process env only, in memory.",
    "```",
    "",
    "## Example execution hook (pull short-lived tokens at runtime)",
    "",
    "Drop this in front of any command that needs credentials so secrets live only in",
    "the process environment — never in a file an agent can Read:",
    "",
    "```sh",
    "#!/usr/bin/env sh",
    "# aih-secrets-preflight.sh — resolve short-lived creds, then exec the real command.",
    "set -eu",
    'OPENAI_API_KEY="$(vault kv get -field=api_key secret/ai/openai)"',
    "export OPENAI_API_KEY",
    'exec "$@"   # credentials are in-env for the child only; nothing is written to disk',
    "```",
    "",
    `See \`${contextDir}\` for the canonical rules this guidance extends.`,
  );
}

/**
 * Warning emitted only when the scan found plaintext secret files already on
 * disk. Lists each offending path and tells the operator to migrate it into a
 * vault and delete the plaintext copy. Deterministic ordering from the scan.
 */
export function exposureWarning(scan: SecretScan): string {
  const bullets = scan.matches.map((p) => `  - ${p}`);
  return lines(
    "# WARNING: plaintext secret material detected in this repo",
    "",
    "aih found the following plaintext secret path(s). These are now blocked from",
    "agent context, but the files still exist on disk and remain a leak risk:",
    "",
    bullets,
    "",
    "Remediate each one:",
    "  1. Move the values into your vault / secret manager (see the vault guidance).",
    "  2. Replace the file with dynamic injection at runtime (no plaintext on disk).",
    "  3. Delete the plaintext copy and purge it from git history if it was committed",
    "     (e.g. `git filter-repo` / BFG), then rotate every exposed credential.",
  );
}
