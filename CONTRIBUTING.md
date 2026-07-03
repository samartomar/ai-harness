# Contributing

Thanks for helping improve `aih`. Human and AI contributors follow the same rules.

## Dev loop

```bash
npm ci
npm run typecheck && npm run lint && npm test && npm run build
```

`npm run verify` runs the same gates in one command, with the coverage thresholds CI
enforces. CI (`.github/workflows/ci.yml`) runs them on every push/PR — keep them green.

## Running vs. developing `aih`

`aih` is published to npm, so you may have it installed globally. Inside this repo a
bare `aih` runs the **published** binary against your working tree — not your edits.
Always exercise your changes through the source runner:

```bash
npm run dev -- <command>     # runs src/ live via tsx — your working tree, no build
node dist/cli.js <command>   # a built artifact, after `npm run build`
```

A global `aih` is fine for other projects; just don't rely on it here. A short alias
keeps the two unambiguous — `aihd <command>` = this repo, `aih <command>` = published:

```bash
alias aihd='npm run dev --'
```

`aih --version` reports the same number for both until the `VERSION` constant in
`src/program.ts` is bumped, so it cannot tell you which binary ran.

## Conventions

- TypeScript ESM, `commander` for the CLI, `zod` for boundary validation,
  `vitest` for tests, `biome` for lint/format (2-space, double quotes).
- One capability per `src/<cap>/` directory exporting `command: CommandSpec`.
  `plan()` is pure — it returns actions; the executor performs them.
- Generated output must be deterministic (golden-testable). Drive tests with
  `fakeRunner` + `makeHostAdapter`; never hit the network or spawn real processes.

## The one hard rule

No production code may authenticate to, provision, or mutate a **remote** system.
Cloud/SSO/gateway/observability-backend/MDM setup is emitted as `doc` actions
(commands for a human), never executed. Design and architecture docs live under
[`docs/`](docs/README.md).

## Pull requests

Keep diffs scoped. Add tests for new behavior. Reference the capability and the
boundary in your description. For AI-delegated work, comment `@claude <task>` on
an issue (see the Claude workflow).

A CLI-surface change (command/flag/positional) must regenerate
`tests/contract/command-surface.json` in the same PR
(`AIH_REGEN_CONTRACT=1 npx vitest run tests/contract/command-surface.test.ts`) and
carry the `contract:additive` label; removals/renames are majors-only — see
[STABILITY.md](STABILITY.md).

## Contributor rules

By contributing you agree that:

- Your contribution is licensed under the project's [Apache-2.0](LICENSE) license.
- You have the right to submit it. **Do not submit employer-confidential, proprietary, or
  otherwise restricted code**, or anything you are not authorized to release as open source.
- **Do not submit secrets, tokens, credentials, private keys, or sensitive logs** — not in
  code, tests, fixtures, or commit history.

## Developer Certificate of Origin (DCO)

Sign off every commit to certify the [DCO](https://developercertificate.org/) — that you wrote
the change or have the right to submit it under Apache-2.0:

```bash
git commit -s -m "your message"     # adds: Signed-off-by: Your Name <you@example.com>
```

