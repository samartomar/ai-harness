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
