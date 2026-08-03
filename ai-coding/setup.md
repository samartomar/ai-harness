# Setup

> First-run setup for this repo, manually maintained from
> `ai-coding/project.json`. Never run AIH against this checkout. The maintenance
> boundary and current conditional shape are in `ai-coding/SELF-HOSTING.md`.

## 1. Install & verify

- Install dependencies: `npm install`.
- Run the completion gate: `npm run verify`.
- Fast partial checks: `npm run typecheck`, `npm test`, `npm run build`, `npm run lint`.

## 2. Turn on the guardrails (once per clone)

- `git config core.hooksPath .githooks` — enables the repo-owned pre-commit
  lint/test hook.
- `git ls-files -- ".env" ".env.*" "secrets/**"` — inspect tracked sensitive
  path names only; readable `.env.example` / `.env.sample` templates are the only
  expected exceptions.
- `npm run check:self-hosting-canon` — verify bootloader mirrors, contract facts,
  and the no-self-application boundary.

## 3. MCP and AI tooling

- No client-specific MCP or hook registration is committed in this checkout.
- Optionally install the repo-pinned Token Savior, Token Optimizer, and Serena tools:
  `node tools/repo-ai-tools.mjs install`.
- Verify the exact local pins: `node tools/repo-ai-tools.mjs verify`.
- Installation alone does not register those tools with Claude, Codex, or any
  other client; local projection remains operator-owned.

## 4. Maintain the AIH-shaped canon

- Update `project.json`, `project.md`, and this setup file together when detected
  repository facts change.
- Edit `adapters/_shared-canonical-block.md` first, then copy its body exactly into
  the fenced blocks in `AGENTS.md` and `CLAUDE.md`.
- Inspect generator source and fixture tests for useful upstream behavior, but
  adopt it manually; never execute a product project command against this tree.
