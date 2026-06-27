import { type ProbeAction, probe } from "../internals/plan.js";
import type { Check } from "../internals/verify.js";
import type { SecretScan } from "./scan.js";

/**
 * Stable SARIF rule id shared by every plaintext-secret finding. One rule, many
 * results (one per path) — so GitHub code-scanning groups all exposures under a
 * single rule, exactly as the drift gate uses one stable `drift` id rather than a
 * per-instance name. {@link reportToSarif} dedupes rules by check name, so every
 * probe carries this same `name`; the per-path detail keeps each result distinct.
 */
export const SECRET_RULE = "plaintext-secret";

/**
 * One read-only `fail` probe per detected plaintext-secret path. Under `--verify`
 * each verdict flips the exit code — turning `aih secrets --verify` into the
 * secret-scan CI gate the README markets — and `--sarif` renders one error-level
 * result per path for GitHub code-scanning.
 *
 * Pure and boundary-safe: the scan already read the filesystem at plan-build time,
 * so the probe just returns its precomputed verdict — it spawns nothing, contacts
 * no remote, and mutates nothing. A probe is a read-only verdict carrier, never a
 * mutation, so this stays within the harness's no-remote-mutation contract. The
 * detail names only the offending PATH, never any secret value, so no plaintext
 * material is ever emitted.
 */
export function secretProbes(scan: SecretScan): ProbeAction[] {
  return scan.matches.map((path) =>
    probe(
      `plaintext secret: ${path}`,
      (): Check => ({
        name: SECRET_RULE,
        verdict: "fail",
        detail: `${path} — plaintext secret on disk; migrate to a vault and rotate the exposed credential`,
        code: "secrets.plaintext-detected",
        location: { uri: path, startLine: 1 },
        fingerprint: `${SECRET_RULE}:${path}`,
      }),
    ),
  );
}
