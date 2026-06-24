import { lines } from "../internals/render.js";
import type { RepoStack } from "../profile/scan.js";

/**
 * Pre-commit wiring: always run gitleaks against the managed config on every
 * commit, and add a repo-local lint hook ONLY when the repo actually defines a
 * lint command — never reference a script that doesn't exist. Hand-written YAML
 * so the exact `rev`/`args` the blueprint pins survive verbatim.
 */

/** Pinned gitleaks hook revision (the v8 tag the blueprint standardizes on). */
export const GITLEAKS_REV = "v8.24.2";

/** gitleaks hook args: verbose output, scoped to the aih-managed config. */
export const GITLEAKS_ARGS = ["--verbose", "--config=.gitleaks.toml"];

/** Render `.pre-commit-config.yaml` — gitleaks always, lint hook only if real. */
export function preCommitConfigYaml(stack?: RepoStack): string {
  const args = GITLEAKS_ARGS.map((a) => JSON.stringify(a)).join(", ");
  const out = [
    "# .pre-commit-config.yaml — local commit gate (managed by aih guardrails)",
    "# Policy intent: block secrets before they ever reach history. Runs the same",
    "# gitleaks config CI uses, so local and pipeline verdicts agree.",
    "repos:",
    "  - repo: https://github.com/gitleaks/gitleaks",
    `    rev: ${GITLEAKS_REV}`,
    "    hooks:",
    "      - id: gitleaks",
    `        args: [${args}]`,
  ];
  if (stack?.lintCommand) {
    out.push(
      "  - repo: local",
      "    hooks:",
      "      - id: aih-lint",
      "        name: aih lint",
      `        entry: ${stack.lintCommand}`,
      "        language: system",
      "        pass_filenames: false",
      "        stages: [pre-commit]",
    );
  }
  return lines(...out);
}
