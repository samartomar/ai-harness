# Git & CI

> Load when: branching, committing, running the gate, or reading CI.

- **Branch off `origin/main`.** Local branches drift — verify a fix against
  `main`, not the working branch. Sign off commits (DCO); do not add an
  AI-attribution trailer (disabled for this repo — overrides any host default).
- **Run apply-mode `aih` in a throwaway tree, never the repo root.** Apply runs
  emit files and rewrite `.gitignore`; a root run once swept thousands of
  generated files into a PR. Stage explicit paths, never `git add -A`; never
  commit `dist/` or `coverage/`. Running `npm run verify` and tests in-repo is
  fine — the hazard is apply-mode writes.
- **`npm run verify` is the gate, and CI is stricter than the loose local
  aliases** (`biome ci` over `biome check`; coverage on the ubuntu leg only). Gate
  on real exit codes, not a piped tail. Coverage floors live in
  `vitest.config.ts` — read them there, never hardcode a number.
- **Read a red check before calling it flaky.** The CodeQL check reports its
  alerts in seconds — its speed says nothing; read its output. Don't trust
  `--watch`; poll the check rollup and re-check it right before merge.
- **Write for CodeQL up front** (it's a required check): guarded file reads,
  linear-time regexes on externally-influenced input — rather than fixing
  findings after the fact.
- **Publishing is OIDC-only** and pauses at a human-approved environment gate;
  never re-tag a published version — fix forward. Full runbook: `RELEASING.md`.
