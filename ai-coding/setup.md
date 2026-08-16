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

Start a new Codex task after setup so Codex loads ECC and the project MCP
projection. That task can begin product work immediately; no separate helper
registration or initial indexing step is expected.

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

- Fast product checks: `npm run typecheck`, `npm test`, `npm run build`, and
  `npm run lint`.
- Full product completion gate: `npm run verify`.
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
