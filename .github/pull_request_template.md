## What & why

<!-- What does this change do, and why? Link any issue: Closes #123 -->

## Checklist

- [ ] `npm run typecheck`, `npm run lint`, `npm test`, and `npm run build` pass
- [ ] New/changed behavior has tests (unit tests are hermetic — injected `Runner`, no real process/network)
- [ ] Honors the action model: no remote mutation; cloud/setup stays `doc`; local-only `exec` runs under `--apply`
- [ ] Generated files stay deterministic (no dates/nonces in output) and dry-run-safe
- [ ] No hardcoded secrets; docs updated if the command surface changed
- [ ] Required review skills/agents ran before ready-for-review or merge (`code-review`, `security-review`, and any domain-specific reviewer) and their feedback is recorded in this PR

## Notes for the reviewer

<!-- Anything to look at closely, trade-offs, or follow-ups. -->
