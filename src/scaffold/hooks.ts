import { lines } from "../internals/render.js";

/**
 * Local guardrail: a `.githooks/pre-commit` that runs lint + test before a commit
 * lands. Written with `mode: 0o755` so it is executable. It is opt-in — the user
 * must point git at it (`git config core.hooksPath .githooks`), which the plan
 * emits as a `doc` rather than running, because configuring the repo is the
 * human's call, not a remote mutation the harness performs.
 */
export function preCommitHook(): string {
  return lines(
    "#!/bin/sh",
    "# Managed by `aih scaffold`. Local guardrail: block a commit that fails",
    "# lint or tests. Enable with: git config core.hooksPath .githooks",
    "set -eu",
    "",
    'echo "[aih] pre-commit: lint + test"',
    "",
    "# Prefer the repo's package scripts; skip gracefully if a script is absent.",
    "if [ -f package.json ]; then",
    '  if npm run --silent | grep -qE "^  lint"; then npm run --silent lint; fi',
    '  if npm run --silent | grep -qE "^  test"; then npm test --silent; fi',
    "fi",
  );
}

/** The opt-in wiring command, shown to the human as guidance (never run). */
export const HOOKS_PATH_COMMAND = "git config core.hooksPath .githooks";
