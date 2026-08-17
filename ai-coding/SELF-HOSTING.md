# AIH self-hosting contract

<!-- AIH_SELF_HOSTING_BOUNDARY_v1 -->

Never run AIH against this checkout. Do not target `ai-harness` with an
installed binary, `npx`, `src/cli.ts`, `dist/cli.js`, or any equivalent public
AIH command, whether the command is read-only or state-changing.

AIH product behavior may be exercised only against temporary fixture roots in
tests. Repository-owned direct checks, TypeScript compilation, lint, builds,
unit/integration tests, and version/help smoke tests are allowed because they do
not apply AIH project behavior to this checkout.

## Current conditional shape

This repository manually preserves the compact structure AIH would select from
the current facts without letting AIH manage itself:

| Condition | Current fact | Manually maintained result |
|---|---|---|
| Canon mode | compact | router + behavior core + project extension |
| Context directory | `ai-coding` | all durable repo AI truth stays under `ai-coding/` |
| Targets | Claude and Codex | `CLAUDE.md`, `AGENTS.md`, and two adapters only |
| Stack | TypeScript/Node.js product + auxiliary Python assets | npm owns the root lifecycle; pinned uv analyzer manifests are runtime inputs, not workspaces |
| Repository shape | medium single-package repository | tracked count and package-shape facts stay mirrored in `project.json` / `project.md` |
| Root MCP config | absent from Git | `mcpServers: []`; `repo:init` generates an ignored, operator-owned Codex projection |
| Client hooks/config | uncommitted | no client-specific launcher, settings, or hook registry becomes repo truth |
| Brownfield extension | present | `rules/project-canon-extension.md` remains repo-owned and manually maintained |
| Repo-curated skills | decision-partner + BetterDoc | `curated-skills/` holds manually adopted, CLI-neutral copies; AIH does not project or refresh them |

## Truth and mirror homes

- `project.json` is the machine-readable repository-fact truth.
- `project.md` is its manually maintained human-readable mirror.
- `setup.md` is the clone/operator checklist.
- `RULE_ROUTER.md` is the cross-tool routing authority.
- `rules/agent-behavior-core.md` is the full shared working discipline.
- `rules/project-canon-extension.md` owns repository-specific overrides.
- `curated-skills/` owns manually adopted, repository-specific skill copies
  shared by every supported client; their task routes live in the project canon
  extension.
- `adapters/_shared-canonical-block.md` is the manual source copied byte-for-byte
  into the fenced blocks in `AGENTS.md` and `CLAUDE.md`.
- `adapters/claude.md` and `adapters/codex.md` contain only client-loading notes.

Do not add `.aih-config.json`, `.mcp.json`, generated client directories, AIH
state, or lifecycle receipts merely to make this checkout resemble an installed
consumer repository. `npm run repo:init` may write the ignored
`.codex/config.toml` operator projection and external versioned tool caches, but
neither becomes repository truth. Committed source and tests remain authoritative.

## Manual maintenance procedure

1. Inspect the relevant generator, schema, registry, and tests as source
   evidence. Never execute the generator against this checkout.
2. Update `project.json` directly, then update `project.md` and `setup.md` in the
   same change when their displayed facts change.
3. Edit the shared block source first, then copy its body exactly into both root
   bootloaders. Keep repo-specific preamble text outside the fenced block.
4. Add or remove adapters and bootloaders only when the target list changes.
5. Run `npm run check:self-hosting-canon`, focused fixture tests, typecheck, and
   lint. `npm run verify` is allowed only while every repository-scoped check in
   that chain remains a direct repository check rather than an AIH CLI command.

If generated product defaults later change, review them as upstream source
changes. Adopt useful behavior manually; never clear drift by applying AIH here.
