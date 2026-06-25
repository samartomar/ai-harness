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

/** The aih-ownership marker in the generated config header (user files lack it). */
export const PRECOMMIT_MARKER = "managed by aih guardrails";

/** The gitleaks `repos:` list item (2-space indent), reused by the config + merge doc. */
export function gitleaksRepoBlock(): string[] {
  const args = GITLEAKS_ARGS.map((a) => JSON.stringify(a)).join(", ");
  return [
    "  - repo: https://github.com/gitleaks/gitleaks",
    `    rev: ${GITLEAKS_REV}`,
    "    hooks:",
    "      - id: gitleaks",
    `        args: [${args}]`,
  ];
}

/** Render `.pre-commit-config.yaml` — gitleaks always, lint hook only if real. */
export function preCommitConfigYaml(stack?: RepoStack): string {
  const out = [
    `# .pre-commit-config.yaml — local commit gate (${PRECOMMIT_MARKER})`,
    "# Policy intent: block secrets before they ever reach history. Runs the same",
    "# gitleaks config CI uses, so local and pipeline verdicts agree.",
    "repos:",
    ...gitleaksRepoBlock(),
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

/**
 * Guidance shown when a USER-authored `.pre-commit-config.yaml` already exists:
 * aih leaves it untouched (never clobbers a team's hooks) and hands over the exact
 * gitleaks block to paste under their `repos:` list.
 */
export function gitleaksMergeSnippet(): string {
  return lines(
    "This repo already has a .pre-commit-config.yaml, so aih left it untouched to",
    "preserve your hooks. To enable the same secret gate CI runs, add gitleaks under",
    "your existing `repos:` list:",
    "",
    ...gitleaksRepoBlock(),
  );
}
