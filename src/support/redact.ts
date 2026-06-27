/**
 * Redaction for support output. Templates are pasted into tickets, so anything
 * that reaches them must be scrubbed of secrets AND of local filesystem layout.
 *
 * Three layers, composed by {@link redactText}:
 *   - {@link redactSecrets} (reused from guardrails) — pattern-based token masking.
 *   - {@link scrubHome} — replace the user's home dir with `<home>` so a workspace
 *     path doesn't leak the account/machine layout into a ticket.
 *   - {@link redactArgv} — KEY-AWARE masking of `--token`/`--password`/… values,
 *     which the pattern matcher can't catch (the value is positional). `--ca-pattern`
 *     is deliberately NOT masked: it's a diagnostic the recipient needs.
 */

import { redactSecrets } from "../guardrails/redact.js";

/** Flags whose following value (or `=value`) is sensitive and must be masked. */
const SENSITIVE_FLAG = /^--?(token|password|passwd|pass|secret|api[-_]?key|apikey|auth|bearer)$/i;
const REDACTED = "[REDACTED]";

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Replace the user's home directory (either separator style, case-insensitively) with `<home>`. */
export function scrubHome(text: string, env: NodeJS.ProcessEnv): string {
  const home = env.USERPROFILE || env.HOME;
  if (!home) return text;
  const variants = new Set([home, home.replace(/\\/g, "/"), home.replace(/\//g, "\\")]);
  const pattern = [...variants]
    .filter((v) => v.length > 0)
    .map(escapeRegExp)
    .join("|");
  return pattern.length > 0 ? text.replace(new RegExp(pattern, "gi"), "<home>") : text;
}

/** Key-aware argv masking: `--token x` / `--token=x` → `--token [REDACTED]` / `--token=[REDACTED]`. */
export function redactArgv(argv: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i] ?? "";
    const eq = tok.match(/^(--?[\w-]+)=(.*)$/);
    if (eq && SENSITIVE_FLAG.test(eq[1] ?? "")) {
      out.push(`${eq[1]}=${REDACTED}`);
      continue;
    }
    out.push(tok);
    if (SENSITIVE_FLAG.test(tok) && i + 1 < argv.length) {
      out.push(REDACTED);
      i++; // skip the now-masked value
    }
  }
  return out;
}

/** Secrets + home scrub for any free text bound for a ticket. */
export function redactText(text: string, env: NodeJS.ProcessEnv): string {
  return scrubHome(redactSecrets(text), env);
}
