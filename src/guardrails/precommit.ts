import { lines } from "../internals/render.js";

/**
 * Pre-commit wiring: run gitleaks against the managed config on every commit,
 * plus a repo-local lint hook. Hand-written YAML so the exact `rev`/`args` the
 * blueprint pins survive verbatim (no serializer reordering keys or quoting).
 */

/** Pinned gitleaks hook revision (the v8 tag the blueprint standardizes on). */
export const GITLEAKS_REV = "v8.24.2";

/** gitleaks hook args: verbose output, scoped to the aih-managed config. */
export const GITLEAKS_ARGS = ["--verbose", "--config=.gitleaks.toml"];

/** Render `.pre-commit-config.yaml` — gitleaks scan hook + a local lint hook. */
export function preCommitConfigYaml(): string {
  const args = GITLEAKS_ARGS.map((a) => JSON.stringify(a)).join(", ");
  return lines(
    "# .pre-commit-config.yaml — local commit gate (managed by aih guardrails)",
    "# Policy intent: block secrets before they ever reach history. Runs the same",
    "# gitleaks config CI uses, so local and pipeline verdicts agree.",
    "repos:",
    "  - repo: https://github.com/gitleaks/gitleaks",
    `    rev: ${GITLEAKS_REV}`,
    "    hooks:",
    "      - id: gitleaks",
    `        args: [${args}]`,
    "  - repo: local",
    "    hooks:",
    "      - id: aih-lint",
    "        name: aih lint",
    "        entry: npm run lint",
    "        language: system",
    "        pass_filenames: false",
    "        stages: [pre-commit]",
  );
}
