import { GITHOOKS_PATH_COMMAND } from "../internals/git-hooks.js";
import { lines } from "../internals/render.js";

/**
 * Local guardrail: a `.githooks/pre-commit` that runs the repo's pre-commit
 * policy (when present) plus lint/test before a commit lands. Written with
 * `mode: 0o755` so it is executable. It is opt-in — the user must point git at it
 * (`git config core.hooksPath .githooks`), which the plan emits as a `doc` rather
 * than running, because configuring the repo is the human's call.
 */
export function preCommitHook(): string {
  return lines(
    "#!/bin/sh",
    "# Managed by `aih scaffold`. Local guardrail: block a commit that fails",
    "# the pre-commit policy, lint, or tests. Enable with: git config core.hooksPath .githooks",
    "set -eu",
    "",
    'echo "[aih] pre-commit: policy + lint + test"',
    "",
    "# If aih guardrails wrote a pre-commit policy, run it through the same hook path.",
    "if [ -f .pre-commit-config.yaml ]; then",
    "  if command -v pre-commit >/dev/null 2>&1; then",
    "    pre-commit run --hook-stage pre-commit",
    "  else",
    '    echo "[aih] .pre-commit-config.yaml is present but pre-commit is not installed" >&2',
    "    exit 1",
    "  fi",
    "fi",
    "",
    "# Prefer the repo's package scripts; skip gracefully if a script is absent.",
    "if [ -f package.json ]; then",
    '  if node -e "process.exit(require(\\"./package.json\\").scripts?.lint ? 0 : 1)"; then npm run --silent lint; fi',
    '  if node -e "process.exit(require(\\"./package.json\\").scripts?.test ? 0 : 1)"; then npm test --silent; fi',
    "fi",
  );
}

/** The opt-in wiring command, shown to the human as guidance (never run). */
export { GITHOOKS_PATH_COMMAND as HOOKS_PATH_COMMAND };
