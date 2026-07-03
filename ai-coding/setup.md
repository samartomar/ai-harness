# Setup

> First-run setup for this repo, derived from `ai-coding/project.json`. Write-once:
> edit it freely — `aih` will not overwrite your changes. The full contract is in
> `ai-coding/project.md`.

## 1. Install & verify

- Install dependencies: `npm install`.
- Run the tests: `npm test`
- Lint: `npm run lint`

## 2. Turn on the guardrails (once per clone)

- `git config core.hooksPath .githooks` — enables the pre-commit lint/test/secret hook.
- `aih secrets --verify` — confirm no plaintext secrets are committed.

## 3. Close the known gaps

- [x] No gaps reported — the contract is clean.
