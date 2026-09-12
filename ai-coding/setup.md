# Setup

> First-run setup for this repo, manually maintained from
> `ai-coding/project.json`. Never run AIH against this checkout. The maintenance
> boundary and current conditional shape are in `ai-coding/SELF-HOSTING.md`.

## Ready a clone for Codex work

Prerequisites are Node.js 20+, npm, Git, Codex CLI, `uv` with an installed
Python 3.13, `rg`, `fd`, and `tree`. Then run:

```powershell
npm install
npm run repo:init
```

`repo:init` is the single idempotent bootstrap. It enables the repository hook,
installs the exact repo tool pins in a repository-and-pin-keyed user cache,
installs or refreshes ECC through the native Codex plugin lifecycle, writes an
ignored project-local Codex MCP projection, creates the graph and memory indexes,
and runs the doctor. It preserves unrelated user MCP servers and Codex settings.

Memory indexes use managed runtime and cache roots derived from the canonical
repository root and memory pin, independently of the worktree's tool-install
directory. The managed launcher avoids joining an unrelated account daemon;
`AIH_REPO_AI_TOOLS_HOME` selects a custom parent for this local managed state.
Each launcher still sets its own indexing root. Setup checks cache admission
and initializes the memory index before client setup changes, then checks the
live root-specific index before reusing a completion marker. The marker is
valid only for its recorded canonical root and memory generation. The launcher
captures the managed cache-home selection so a GUI or new shell preserves it.
Managed preflight disables `auto_watch` and `auto_index` in the private cache
configuration before manual indexing, so background work cannot race that check.
The [resource ownership contract](rules/repo-ai-tools.md#resource-ownership-across-worktrees)
describes which state is shared and which belongs to a worktree.

Start a new Codex task after setup so Codex loads ECC and the project MCP
projection. Verify that its commands launch and its tools report the intended
worktree before relying on the new session. Setup does not prove that a fresh
client can execute commands under its own sandbox.

## Prove the setup

Run `npm run repo:doctor`. A successful JSON result proves all of the following:

- exact Serena, Token Savior, Token Optimizer, code-review-graph, and
  codebase-memory-mcp pins;
- the ECC plugin is installed, enabled, and has a real installed path;
- Codex resolves the four repo launchers with their narrow tool allowlists;
- every MCP completes a real protocol handshake and exposes its expected tools;
- the external graph and memory indexes are present; and
- the `ai-coding` routing contract is available.

The doctor is a setup proof, not a product completion gate. If a helper later
fails during normal work, warn once and continue from source, tests, schemas,
and CI. Run `npm run repo:init` again only to repair or refresh the tool setup.
Use `node tools/repo-ai-tools.mjs setup-codex --dry-run` to inspect its mutation
scope without changing anything. A fresh setup installs the current ECC
marketplace snapshot. Later ECC marketplace refresh is explicit because the
native operation is network-bound: run
`node tools/repo-ai-tools.mjs setup-codex --refresh-ecc` when that refresh is the
assigned task; normal reruns retain and verify the installed plugin.

## Work and verification

- Editing loop: run the focused Vitest files for the changed behavior.
- Routine local completion gate:
  `npm run verify:local -- --base origin/main --head HEAD --include-working`.
  Add `--plan` to inspect selection without running checks. Supply the intended
  base/head refs; omit `--include-working` only for a clean checkout.
- Browser/provider lanes require pinned Chromium:
  `npx --no-install playwright install chromium`. Local results leave the printed
  hosted OS, CodeQL, and protected-check gaps for CI.
- Deliberate full validation: `npm run verify`; release acceptance remains separate.
- Sensitive path-name check: `git ls-files -- ".env" ".env.*" "secrets/**"`.
- Self-hosting check: `npm run check:self-hosting-canon`.
- Treat the root as one npm package. Pinned `uv` manifests under `tools/` are
  analyzer runtime inputs, not independently managed repository workspaces.

## Maintain the AIH-shaped canon

- Update `project.json`, `project.md`, and this setup file together when detected
  repository facts change.
- Edit `adapters/_shared-canonical-block.md` first, then copy its body exactly into
  the fenced blocks in `AGENTS.md` and `CLAUDE.md`.
- Inspect generator source and fixture tests for useful upstream behavior, but
  adopt it manually; never execute a product project command against this tree.
