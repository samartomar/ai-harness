# Repo AI tools

This is the repo-owned routing contract for AI tooling in `ai-harness`. It
overrides generic baseline advice when the two conflict. The repository does
not commit client-specific MCP or hook launchers. `repo:init` creates an ignored
Codex projection from this contract; source plus tests remain authoritative
when any helper is absent.

## Default decision path

Pick the first matching row. A known, local edit needs no helper: inspect the
source and tests directly.

| Question | First action | Stop condition |
|---|---|---|
| Where does this unfamiliar behavior start, and what is its compact shape? | Use Token Savior read-only: start with `get_entry_points`, `search_codebase`, `find_symbol`, or `get_call_chain`; retrieve exact code only with `get_function_source` / `get_full_context`. | Stop when the likely files or symbols are known; confirm them in committed source. |
| What could this broad or multi-file change affect? | Ask `code-review-graph` once for broad impact, affected flows, and likely tests before editing or reviewing. | Stop after one useful impact result. Validate every edge against source and tests. Skip it for an already-localized change. |
| Which definitions and references must be inspected or changed exactly? | Use Serena: `get_symbols_overview` → `find_symbol` → `find_referencing_symbols` / `find_implementations`; use `rename_symbol`, `replace_symbol_body`, or insert tools only when editing was requested. | Stop when the exact edit set is known, then inspect the diff and run tests. |
| Is prompt/tool overhead itself the assigned problem? | Use `node tools/repo-ai-tools.mjs token-optimizer-report`, then `token-optimizer-coach` only if recommendations are needed. | Stop after the requested measurement or recommendation. Do not run the report or coach on every task. |
| Must the agent find, trace, and recall a relationship or durable architectural decision? | Use `codebase-memory-mcp` for graph search, path tracing, snippets, architecture, and ADR-level memory. | Stop when the relationship or decision is recovered. Do not duplicate the graph tool's broad-impact query. |

Token Savior is the low-token orientation lane, not the editing lane.
Do not use `replace_symbol_source` or `add_field_to_model`; make semantic edits
with Serena or normal source editing. Serena owns exact symbol/refactor work, so
its memory, basic file, shell, and project-switching tools stay disabled.
Codebase memory owns semantic relationship retrieval and durable ADR recall;
code-review-graph owns change-time blast area and reviewer context. Neither is
evidence, and neither should receive the other tool's question.

Do not fan the same question across helpers. Use at most one fallback, then
continue from committed source, tests, schemas, and CI.

## Normal work loop

- Localize cheaply with source search or Token Savior.
- For broad changes only, use one graph impact query to focus review.
- Use codebase memory only when semantic relationships, trace paths, or durable
  decisions would prevent repeated exploration.
- Use Serena only for exact cross-symbol inspection or semantic edits.
- Verify with repository evidence. Token Optimizer is an explicit on-demand
  audit only; it is not a correctness or completion gate.

## Failure and evidence boundary

All helper-tool families are advisory. A missing, stale, or failed helper
must not block product work, trigger a repair detour, or be presented as product
evidence. State the warning once and continue from repository evidence. Repair a
helper only when repairing that helper is the assigned task.

This rule specifically overrides generic large-repo graph advice for this repo:
`code-review-graph` is a blast-area and reviewer-context aid only. It reduces
review cost, but it is never a start, correctness, security, test, merge, or
release gate.

Graph currency is not maintained by a committed hook. If a locally projected
graph is stale or absent, warn once and continue from source and tests.

## Installation and licensing

Run `npm run repo:init` from the repository root. The bootstrap installs exact
pins in a repository-and-toolset-keyed user cache, initializes external graph
and memory data, installs or refreshes ECC natively, and writes the ignored
project-local Codex projection. Run `npm run repo:doctor` to prove plugin state,
projection allowlists, populated indexes, and real MCP handshakes. Start a new
Codex task after initialization so the client loads the projection.
Use `node tools/repo-ai-tools.mjs setup-codex --refresh-ecc` only when a native
ECC marketplace refresh is explicitly required; normal idempotent setup verifies
the installed plugin without adding a network clone to every rerun.

The generated Serena context is single-project and excludes memory, file,
shell, project-switching, and line-editor overlap. Token Savior uses its
optimized profile with memory and capture disabled, then Codex exposes only its
six orientation tools. code-review-graph is externally cached and exposes only
impact/review operations. codebase-memory-mcp receives a worktree-specific
`CBM_ALLOWED_ROOT` for indexing and uses managed runtime and cache roots derived
from the canonical repository root and memory pin. These allowlists minimize
tool confusion; they are not a security boundary and do not replace repository
authorization rules.

### Resource ownership across worktrees

| Resource | Owner and lifetime |
|---|---|
| Pinned executables and Python environments | Repository-path-and-toolset-keyed user cache; existing toolsets remain available to their active clients. This bootstrap does not deduplicate installations across worktrees. |
| Serena context and review graph | Worktree-specific state under the repository/toolset cache. Existing installations remain available to active clients. |
| Memory completion marker | Per-root, per-memory-generation state. Reuse requires a matching root and generation plus live populated inventory. |
| Memory graph databases and daemon | Managed runtime/cache state is separate per canonical repository root and memory pin. The launcher derives these roots under the managed tool home and does not join an unrelated account daemon. |
| Memory indexing boundary | `CBM_ALLOWED_ROOT` is set to the current worktree for each session. Native root grants and daemon workers also participate in authorization; this setting alone is not runtime proof of confinement or usability. Query tools can expose other indexed projects. Select and verify the intended project by its returned `root_path`. |
| Codex projection | Ignored `.codex/config.toml` in each worktree, with launchers bound to that worktree. |
| Native ECC plugin | Account-owned installation shared across worktrees; normal setup verifies the existing plugin, and marketplace refresh remains explicit. |

Codebase-memory-mcp 0.10.5 uses `CBM_RUNTIME_DIR` for daemon rendezvous and
requires runtime and cache roots to remain consistent across clients. The
managed launcher supplies separate roots for the canonical repository and
memory pin, while `AIH_REPO_AI_TOOLS_HOME` selects a custom managed home.
Existing toolset/worktree installations remain available; changing the memory
pin creates a new generation and does not migrate an existing graph database.
Before manual indexing, managed preflight writes `auto_watch = false` and
`auto_index = false` in the private cache configuration to avoid background
work racing the bounded admission and index check.
See the pinned [upstream configuration contract](https://github.com/DeusData/codebase-memory-mcp/blob/v0.10.5/docs/CONFIGURATION.md).

Setup checks memory admission and initializes its index after preparing pinned
tools and before publishing client setup changes. If either stage fails,
installed tool files may remain for reuse; the failure is reported and existing
sessions, caches, and native plugin state are not rolled back. An index failure
does not publish a completion marker. Retry with the same managed root and
generation; do not delete another session's cache or stop its daemon.

An active daemon created by an older bootstrap retains its original cache and
runtime. A new managed client uses its private generation rather than joining,
stopping, or migrating that daemon. An indexing rejection after successful
admission is a separate boundary failure. The selected native client,
configuration, and sandbox policy must be checked for the intended root before
relying on that session; this does not establish usability for every client or
configuration. Do not automatically add native root grants to make this check
pass.

For an on-demand local audit, run
`node tools/repo-ai-tools.mjs token-optimizer-report`. For repo-scoped coaching,
run `node tools/repo-ai-tools.mjs token-optimizer-coach`. These are the same
entry points for Claude and Codex and do not modify either client's global
configuration.

Serena 1.7.0, Token Savior 4.21.0, code-review-graph 2.3.7, and
codebase-memory-mcp 0.10.5 are MIT-licensed. Serena's installer applies the exact
patched transitive overrides recorded by `repo-ai-tools.mjs`; changing them
requires a fresh dependency audit and health/start probe. Token Optimizer
5.11.68 uses PolyForm Noncommercial 1.0.0; this repo installs an untracked local
checkout and does not vendor or redistribute it. Commercial use requires an
appropriate license from its author.
