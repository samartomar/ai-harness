# v9 Report Release Checklist

**Branch:** `feat/local-report-v9` · **PR:** #62 · **Base:** `main` at `534ce8c`

## Release Decisions

- `aih report --v9` ships opt-in. Legacy report and `--v4` stay intact.
- v9-only digests stay v9-only instead of being folded into shared `localPanels`.
- PREVIEW and EMPTY states are acceptable and intentional when local data has not accrued.

## Cleared

- Hook correctness rechecked for Codex and Gemini; Codex uses `.codex/hooks.json`, resolves the recorder from the git root, includes `commandWindows`, and documents project trust/review.
- Branch rebased onto current `origin/main`.
- Full gate green: `npm run lint:fix && npx @biomejs/biome ci src tests && npm run typecheck && npm test && npm run build`.
- Coverage green: 94.23% statements / 80.85% branches.
- Honesty matrix passed in static no-JS body and hydrated DOM: off-canon, on-canon/no-usage, no-ECC, no-track-history, and no-run-ledger.
- Syntegris live v9 generation passed: `aih report --v9 --apply --no-log --out <temp> D:\dev\syntegris`.
- Browser visual QA passed at 1440px and 320px: no horizontal overflow, radar labels fit, bars stay within tracks, matrices fit.
- `aih usage --apply` idempotency smoke passed for targeted CLIs; existing hooks preserved.
- `aih usage --rollup` smoke passed across two repos.

## Still Owner-Gated

- Push the final branch head and wait for GitHub CI to go green.
- Convert PR #62 from draft only when the owner wants review to begin.
- Owner review / `/code-review` pass.
- Squash-merge only after explicit owner go-ahead.

## Final Local Gate

Run before final push if anything changes:

```bash
npm run lint:fix && npx @biomejs/biome ci src tests && npm run typecheck && npm test && npm run build
npm run test:cov
```
