import { postureGradeCheck } from "../config/governance.js";
import type { Posture } from "../config/posture.js";
import { type ProbeAction, probe } from "../internals/plan.js";
import type { Check } from "../internals/verify.js";
import type { ConfigSecretHit, SecretScan } from "./scan.js";

/**
 * Stable SARIF rule id shared by every plaintext-secret finding. One rule, many
 * results (one per path) — so GitHub code-scanning groups all exposures under a
 * single rule, exactly as the drift gate uses one stable `drift` id rather than a
 * per-instance name. {@link reportToSarif} dedupes rules by check name, so every
 * probe carries this same `name`; the per-path detail keeps each result distinct.
 */
export const SECRET_RULE = "plaintext-secret";

/**
 * One read-only probe per detected plaintext-secret path. Posture decides whether
 * it is warning-only (`vibe`) or a failing gate (`team`/`enterprise`); only failing
 * verdicts flip the exit code and render as SARIF errors.
 *
 * Pure and boundary-safe: the scan already read the filesystem at plan-build time,
 * so the probe just returns its precomputed verdict — it spawns nothing, contacts
 * no remote, and mutates nothing. A probe is a read-only verdict carrier, never a
 * mutation, so this stays within the harness's no-remote-mutation contract. The
 * detail names only the offending PATH, never any secret value, so no plaintext
 * material is ever emitted.
 */
export function secretProbes(scan: SecretScan, posture: Posture): ProbeAction[] {
  return scan.matches.map((path) =>
    probe(
      `plaintext secret: ${path}`,
      (): Check =>
        postureGradeCheck(
          {
            name: SECRET_RULE,
            verdict: "fail",
            detail: `${path} — plaintext secret on disk; migrate to a vault and rotate the exposed credential`,
            code: "secrets.plaintext-detected",
            location: { uri: path, startLine: 1 },
            fingerprint: `${SECRET_RULE}:${path}`,
          },
          "secrets",
          posture,
        ),
    ),
  );
}

/** Stable SARIF rule id for hardcoded-secret-in-config findings (one rule, many results). */
export const MCP_SECRET_RULE = "mcp-hardcoded-secret";

/**
 * One read-only probe per hardcoded secret found in an MCP config file. Like
 * {@link secretProbes}, the scan ran at plan-build time so each probe just carries
 * its posture-graded verdict — no spawn, no remote, no mutation. The detail names
 * the FILE + KEY + match kind, never the secret value, so no plaintext material is
 * emitted.
 */
export function mcpConfigSecretProbes(hits: ConfigSecretHit[], posture: Posture): ProbeAction[] {
  return hits.map((h) =>
    probe(
      `hardcoded secret: ${h.file}${h.key ? ` (${h.key})` : ""}`,
      (): Check =>
        postureGradeCheck(
          {
            name: MCP_SECRET_RULE,
            verdict: "fail",
            detail: `${h.file}${h.key ? ` → "${h.key}"` : ""} holds a ${h.kind} — move it to an env var referenced as \${ENV_VAR} and rotate the exposed value`,
            code: "mcp.hardcoded-secret",
            location: { uri: h.file, startLine: 1 },
            fingerprint: `${MCP_SECRET_RULE}:${h.file}:${h.key}`,
          },
          "secrets",
          posture,
        ),
    ),
  );
}
