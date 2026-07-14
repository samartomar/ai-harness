# Repo AI tools

This is the repo-owned routing contract for AI tooling in `ai-harness`. It is
available to Claude and Codex through their project configuration and overrides
generic baseline advice when the two conflict.

## Default decision path

Pick the first matching row. A known, local edit needs no helper: inspect the
source and tests directly.

| Question | First action | Stop condition |
|---|---|---|
| Where does this unfamiliar behavior start, and what is its compact shape? | Use Token Savior read-only: start with `get_entry_points`, `search_codebase`, `find_symbol`, or `get_call_chain`; retrieve exact code only with `get_function_source` / `get_full_context`. | Stop when the likely files or symbols are known; confirm them in committed source. |
| What could this broad or multi-file change affect? | Ask `code-review-graph` once for blast radius, affected flows, and likely tests before editing or reviewing. | Stop after one useful impact result. Validate every edge against source and tests. Skip it for an already-localized change. |
| Which definitions and references must be inspected or changed exactly? | Use Serena: `get_symbols_overview` → `find_symbol` → `find_referencing_symbols` / `find_implementations`; use `rename_symbol`, `replace_symbol_body`, or insert tools only when editing was requested. | Stop when the exact edit set is known, then inspect the diff and run tests. |
| Is prompt/tool overhead itself the assigned problem? | Use `node tools/repo-ai-tools.mjs token-optimizer-report`, then `token-optimizer-coach` only if recommendations are needed. | Stop after the requested measurement or recommendation. Do not run the report or coach on every task. |
| Is this a durable architectural decision that future sessions must recall? | Store or retrieve it with `codebase-memory-mcp`. | Keep ADR-level decisions only; do not duplicate navigation or impact queries. |

Token Savior is the low-token orientation lane, not the editing lane.
Do not use `replace_symbol_source` or `add_field_to_model`; make semantic edits
with Serena or normal source editing. Serena owns exact symbol/refactor work, so
its memory, basic file, shell, and project-switching tools stay disabled.

Do not fan the same question across helpers. Use at most one fallback, then
continue from committed source, tests, schemas, and CI.

## Normal work loop

1. Localize cheaply with source search or Token Savior.
2. For broad changes only, use one graph impact query to focus review.
3. Use Serena only for exact cross-symbol inspection or semantic edits.
4. Verify with repository evidence. Token Optimizer runs the quiet project
   `Stop` checkpoint automatically; it is not a correctness or completion gate.

## Failure and evidence boundary

All helper-tool families are advisory. A missing, stale, or failed helper
must not block product work, trigger a repair detour, or be presented as product
evidence. State the warning once and continue from repository evidence. Repair a
helper only when repairing that helper is the assigned task.

This rule specifically overrides generic large-repo graph advice for this repo:
`code-review-graph` is a blast-area and reviewer-context aid only. It reduces
review cost, but it is never a start, correctness, security, test, merge, or
release gate.

## Installation and licensing

Run `node tools/repo-ai-tools.mjs install` from the repository root, then
`node tools/repo-ai-tools.mjs verify`. Installation is confined to a
project-keyed user cache outside the worktree, so third-party source cannot be
mistaken for product topology. Claude reads `.mcp.json` and
`.claude/settings.json`; Codex reads `.codex/config.toml` and
`.codex/hooks.json`.

For an on-demand local audit, run
`node tools/repo-ai-tools.mjs token-optimizer-report`. For repo-scoped coaching,
run `node tools/repo-ai-tools.mjs token-optimizer-coach`. These are the same
entry points for Claude and Codex and do not modify either client's global
configuration.

Serena 1.5.3 and Token Savior 4.4.1 are MIT-licensed. Serena's installer applies
the exact patched transitive overrides recorded by `repo-ai-tools.mjs`; changing
them requires a fresh dependency audit and health/start probe. Token Optimizer
5.11.44 uses PolyForm Noncommercial 1.0.0; this repo installs an untracked local
checkout and does not vendor or redistribute it. Commercial use requires an
appropriate license from its author.
