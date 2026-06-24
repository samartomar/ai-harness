# Working in this repo as an AI agent

This file is the standing brief for **AI agents** (the Claude GitHub Action,
Claude Code, Codex, Cursor, or any autonomous contributor) asked to do work here.
It encodes the jobs and rules that can't be conveyed in a one-line instruction.
Read it before changing code.

## Orient in 60 seconds

`aih` is a TypeScript (ESM) CLI that bootstraps governed, proxy-safe AI-assisted
coding into workstations and repos. It is **dry-run by default** and **never
mutates a remote system**.

```bash
npm ci
npm run typecheck   # tsc --noEmit
npm run lint        # biome
npm test            # vitest
npm run build       # tsup → dist/cli.js
node dist/cli.js --help
```

- Entry: `src/cli.ts` → `src/program.ts` → `src/commands/index.ts` (registry).
- Shared core: `src/internals/` (plan/action model, fs transaction, env-file
  blocks, deep-merge, render helpers, verification report, process runner).
- OS abstraction: `src/platform/` (`base.ts` interface + windows/darwin/linux).
- One capability per directory: `src/<cap>/index.ts` exports `command: CommandSpec`.
- Settings: `src/config/settings.ts` (fail-closed, `AIH_*` env, dry-run default).

## The non-negotiable boundary

Every unit of work a capability returns is one of four **actions**:

- `write` — a local file (use `writeJson(..., { merge: true })` to preserve user keys).
- `exec` — a **local** mutating command (icacls/chmod/ln/mklink). Runs only under
  `--apply`. **Never** a remote command.
- `probe` — a **read-only** check (runs under `--verify`); tool-absent → `skip`,
  never `fail`.
- `doc` — guidance/commands for a human. **All cloud setup goes here**
  (SSO/Entra/Okta, MCP gateway, Langfuse, Bindplane backend, hosted servers, MDM,
  cron install, CI runs). Emit the commands; do not run them.

**No module may authenticate to, provision, or mutate a remote system. No cloud
SDK imports.** This is what lets the harness run unattended without "faking"
infrastructure. A change that violates this will be rejected.

## How to add or change a capability

1. `plan()` is a pure function `(ctx: PlanContext) => Plan`. It only *returns*
   actions — the executor decides dry-run vs `--apply`. Never touch the filesystem
   or spawn a process inside `plan()`.
2. Build files with the `render`/`envfile` helpers so output is deterministic
   (golden-testable): no dates, no random ordering, one trailing newline.
3. Honor `ctx.contextDir` for canonical-context paths and `ctx.options` for flags.
4. Thin IDE adapters (`CLAUDE.md`/`AGENTS.md`/`.cursor/rules/*.mdc`) stay **< 30
   lines** and pointer-style ("This file is not the full rulebook." → route to the
   context dir).
5. Add `tests/<cap>/<cap>.test.ts` driven by a `fakeRunner` + `makeHostAdapter`
   (no network, no real processes). Assert on `plan.actions` (content/argv/kind).
6. Keep diffs scoped to your module. Verify: `npx vitest run tests/<cap>`,
   `npx biome check --write src/<cap> tests/<cap>`, `npx tsc --noEmit`.

## Delegatable jobs (good agent tasks)

Pick one, open a PR, keep CI green. Each is self-contained.

- **macOS/Linux smoke coverage** — the darwin/linux adapters are fixture-tested
  but unverified on metal. Add CI matrix jobs (ubuntu + macos runners) that run a
  dry-run of `aih hardware`/`aih vdi`/`aih doctor` and assert no crash.
- **`certs` real verification** — extend `--verify` to test the generated `.npmrc`/
  pip/cargo config actually resolves a package behind a proxy (probe only).
- **`mcp` schema validation** — add a zod schema for `.mcp.json` and a probe that
  validates the merged file.
- **`telemetry` collector lint** — validate the generated `collector.yaml` against
  the OTel collector config schema (offline).
- **`profile` language packs** — add detection + a tailored `.mdc` for more stacks
  (Ruby/Bundler, PHP/Composer, Swift/SPM) following the existing pattern.
- **`bootstrap`/`init` phase reports** — emit a `--json` phase summary suitable for
  a dashboard.
- **Uninstall path** — `aih <cap> --revert` that removes managed env blocks
  (`removeManagedBlock` already exists) and restores `*.aih.bak`.
- **Docs** — per-capability pages under `docs/` generated from `command.summary` +
  examples.

Avoid: adding npm dependencies without discussion; touching `src/internals/**` or
`src/platform/base.ts` for a single capability's needs (raise it as its own PR);
anything that reaches a remote system from production code.

## Using the Claude GitHub Action

Comment `@claude <task>` on an issue or PR (see `.github/workflows/claude.yml`).
The action runs Claude Code on a fresh checkout, opens/updates a PR, and obeys
this file. It requires the `ANTHROPIC_API_KEY` repo secret — the canonical setup
is to run `claude /install-github-app` once from the terminal.
