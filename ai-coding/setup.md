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

## 3. MCP and AI tooling

- Review and apply the repo AI tooling surface: `aih init --apply`.
- Detected root `.mcp.json` servers:
  - `code-review-graph`
  - `codebase-memory-mcp`
  - `context7`
  - `github`
  - `sequential-thinking`

## 4. Close the known gaps

- [ ] 1 un-imported CLI rule set — review with `aih adopt`
