## What & why

<!-- What does this change do, and why? Link any issue: Closes #123 -->

## Release tracking

- Milestone:
- Resolves:
- Change grouping:
  - BB row / theme:

## Checklist

- [ ] `npm run verify` passes
- [ ] New/changed behavior has tests (unit tests are hermetic — injected `Runner`, no real process/network)
- [ ] Honors the action model: no remote mutation; cloud/setup stays `doc`; local-only `exec` runs under `--apply`
- [ ] Generated files stay deterministic (no dates/nonces in output) and dry-run-safe
- [ ] No hardcoded secrets; docs updated if the command surface changed
- [ ] code-review-graph impact/review context was run and recorded
- [ ] Required review skills/agents ran before ready-for-review or merge (`code-review`, `security-review`, and any domain-specific reviewer) and their feedback is recorded in this PR
- [ ] High-risk or release PRs include ECC specialized internal review evidence before merge

## Notes for the reviewer

<!-- Anything to look at closely, trade-offs, or follow-ups. -->
