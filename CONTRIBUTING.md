# Contributing

Thanks for helping improve `aih`. Human and AI contributors follow the same rules.

## Dev loop

```bash
npm ci
npm run typecheck && npm run lint && npm test && npm run build
```

CI (`.github/workflows/ci.yml`) runs the same gates on every push/PR — keep them green.

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
(commands for a human), never executed. See
[`.github/AGENT_TASKS.md`](.github/AGENT_TASKS.md) for the full agent brief,
architecture, and a backlog of good tasks.

## Pull requests

Keep diffs scoped. Add tests for new behavior. Reference the capability and the
boundary in your description. For AI-delegated work, comment `@claude <task>` on
an issue (see the Claude workflow).

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

