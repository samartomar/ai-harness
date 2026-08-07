# Repo contract

> Facts about how this repo is built and run — manually mirrored from
> `ai-coding/project.json` under the permanent self-hosting boundary. Never run AIH
> against this checkout; update both files in the same reviewed change. Working
> agreements live in the agent canon (`RULE_ROUTER.md` → ECC / Superpowers).

aih is a cross-platform TypeScript CLI that prepares developer workstations and
repositories for reviewable, governed AI-assisted coding using dry-run plans,
local guardrails, repo canon, skill approval records, and offline report and
evidence artifacts.

## Stack

- Languages: TypeScript/Node.js
- Package manager: npm

Auxiliary Python assets are not repository workspaces: the tree contains one
packaged skill script and four pinned `uv` analyzer/runtime manifests under
`packs/` and `tools/`. The root npm lifecycle remains authoritative.

## Commands

- **verify (completion gate)** — `npm run verify` _(detected)_
- **typecheck** — `npm run typecheck` _(detected)_
- **test** — `npm test` _(detected)_
- **build** — `npm run build` _(detected)_
- **lint** — `npm run lint` _(detected)_

## Scale

- 990 tracked files · medium · single-package repository

## Entry points

- `dist/cli.js`
- `dist/index.js`
- `src/cli.ts`
- `src/index.ts`

## MCP servers

_No root `.mcp.json` servers detected._

## Sensitive paths

_Never read or log these. Inventory path names only through repository-owned checks._

_None detected._

## Known gaps

_None — the contract is clean._
