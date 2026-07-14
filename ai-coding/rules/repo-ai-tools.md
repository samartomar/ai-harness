# Repo AI tools

This is the repo-owned routing contract for AI tooling in `ai-harness`. It is
available to Claude and Codex through their project configuration and overrides
generic baseline advice when the two conflict.

## Pick one tool for one job

| Need | Tool | Boundary |
|---|---|---|
| Blast radius, affected flows, compact reviewer context | `code-review-graph` | A blast-area and reviewer-context aid only; never correctness, security, test, or release proof. |
| Symbol definitions, references, and semantic refactoring | Serena | Use its semantic tools when relationships cross symbols or files; keep its memory and duplicate file/shell tools disabled. |
| Low-token structural navigation and targeted code outlines | Token Savior | Use the `optimized` profile; memory, capture, command rewriting, and shell hooks stay disabled. |
| Session token measurement and continuity checkpointing | Token Optimizer | Project `Stop` hook only (`quiet` profile); on-demand report/coach commands are allowed, but no global hooks, daemon, status line, auto-update, or command rewriting. |
| Durable decisions and architectural recall | `codebase-memory-mcp` | Store and retrieve ADR-level context; do not repeat structural or blast-radius queries here. |

Do not fan the same question across these tools. Start with the narrowest row
that matches the task, then fall back to committed source, tests, schemas, and CI.

## Failure and evidence boundary

All helper-tool families are advisory. A missing, stale, or failed helper
must not block product work, trigger a repair detour, or be presented as product
evidence. State the warning once and continue from repository evidence. Repair a
helper only when repairing that helper is the assigned task.

This rule specifically narrows the generic large-repo graph rule for this repo:
`code-review-graph` should be used when available to reduce blast-area review
cost, but it is not a gate.

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
