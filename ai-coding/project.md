# Repo contract

> Facts about how this repo is built and run — rendered from `ai-coding/project.json`.
> Do not hand-edit; re-run `aih contract` to refresh. Working agreements live in the
> agent canon (`RULE_ROUTER.md` → ECC / Superpowers), not here.

Enterprise AI Bootstrapping Harness — governed AI-assisted coding for enterprise workstations and repos: TLS trust, repo canon, skill supply chain, evidence

## Stack

- Languages: TypeScript/Node.js
- Package manager: npm

## Commands

- **verify (completion gate)** — `npm run verify` _(detected)_
- **typecheck** — `npm run typecheck` _(detected)_
- **test** — `npm test` _(detected)_
- **build** — `npm run build` _(detected)_
- **lint** — `npm run lint` _(detected)_

## Scale

- 578 tracked files · medium

## Entry points

- `dist/cli.js`
- `src/cli.ts`
- `src/index.ts`

## MCP servers

- `code-review-graph`
- `codebase-memory-mcp`
- `context7`
- `github`
- `sequential-thinking`

## Sensitive paths

_Never read or log these — `aih` denies agent reads of them._

_None detected._

## Known gaps

- 1 un-imported CLI rule set — review with `aih adopt`
