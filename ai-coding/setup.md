# Setup

> First-run setup for this repo, derived from `ai-coding/project.json`. Write-once:
> edit it freely — `aih` will not overwrite your changes. The full contract is in
> `ai-coding/project.md`.

## 1. Install & verify

- Install dependencies: `npm install`.
- Run the completion gate: `npm run verify`.
- Fast partial checks: `npm run typecheck`, `npm test`, `npm run build`, `npm run lint`.

## 2. Turn on the guardrails (once per clone)

- `git config core.hooksPath .githooks` — enables the pre-commit lint/test/secret hook.
- `aih secrets --verify` — confirm no plaintext secrets are committed.

## 3. MCP and AI tooling

- No client-specific MCP or hook registration is committed in this checkout.
- Optionally install the repo-pinned Token Savior, Token Optimizer, and Serena tools:
  `node tools/repo-ai-tools.mjs install`.
- Verify the exact local pins: `node tools/repo-ai-tools.mjs verify`.
- Installation alone does not register those tools with Claude, Codex, or any
  other client; local projection remains operator-owned.

## 4. Close the known gaps

- [ ] 1 un-imported CLI rule set — review with `aih adopt`
