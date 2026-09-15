# Git & CI

> Load when: branching, committing, running the gate, or reading CI.

- **Branch off `origin/main`.** Local branches drift — verify a fix against
  `main`, not the working branch. Sign off commits (DCO); do not add an
  AI-attribution trailer (disabled for this repo — overrides any host default).
- **Size PRs for the serial merge treadmill.** Strict protection lands one PR
  at a time (update → CI → merge; no batching), so combine related,
  file-disjoint small units into one PR labeled with the max `semver:*` of its
  parts. Keep a change separate only when its blast radius is broad (a seam
  many files import) and a clean one-commit revert matters.
- **Do not equate merge count with release count.** Every PR carries exactly one
  `semver:none|patch|minor|major` label. `semver:none` changes ride the open train
  and cannot start a package cut. Package-bearing work accumulates into one coherent
  release PR; an immediate hotfix train is reserved for material installed-user harm.
- **Never run AIH against this checkout.** Exercise project behavior only in
  tests targeting temporary fixture roots, including read-only commands.
  Stage explicit paths, never `git add -A`; never commit `dist/` or `coverage/`.
  Direct repository checks and local verification remain allowed.
- **Use the selected local completion gate:**
  `npm run verify:local -- --base <ref> --head <ref>`, with `--include-working`
  for working changes. It retains CI static checks, applicable test/browser/provider
  lanes, and the full fallback. Gate on real exit codes, not a piped tail; report
  the hosted OS and security gaps. `npm run verify` is deliberate full validation.
  Coverage floors live in `vitest.config.ts` — read them there, never hardcode a number.
- **Read a red check before calling it flaky.** The CodeQL check reports its
  alerts in seconds — its speed says nothing; read its output. Don't trust
  `--watch`; poll the check rollup and re-check it right before merge.
- **Write for CodeQL up front** (it's a required check): guarded file reads,
  linear-time regexes on externally-influenced input — rather than fixing
  findings after the fact.
- **Publishing is OIDC-only** and pauses at a human-approved environment gate.
  The tag workflow publishes immutable candidates only under npm `next`; public
  installed acceptance and separate owner authorization precede promotion of the same
  bytes to `latest`. Never re-tag a published version — fix forward. Full runbook:
  `RELEASING.md`.
