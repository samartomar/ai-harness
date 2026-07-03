# Git & CI discipline

Working-tree hygiene, the real completion gate, and how to read CI truthfully.
Generic commit hygiene (sign-off, `git status` before staging) comes from the
Layer-1 baseline — this file carries only what this repo's incidents proved.

## Working tree

- **Never target the repo-root working tree with an `aih` write/apply run**
  (`node dist/cli.js … --apply`, `npm run dev -- … --apply`). `aih` rewrites
  `.gitignore` (`aihIgnoreWrite` in `src/internals/gitignore.ts`) and apply runs
  emit files — this once swept **7,346 generated files** into a fix PR and
  created 2 HIGH CodeQL alerts (cleanup: #135). Run apply-mode validation in an
  isolated worktree or scratch clone. Running `npm run verify` / tests in-repo is
  expected and fine — the hazard is *apply-mode writes* and staging build output.
- **Stage with explicit paths** — never `git add -A` / `git add .`. If a diff
  shows `.gitignore` unexpectedly shrinking, **stop and restore it**. Never stage
  `dist/` or `coverage/` (the `check:artifacts` gate blocks them, but catch it
  before CI does).
- **Never `git clean -fdx` on a repo `aih` has written to** — it has wiped a
  working tree including `.git`. Reset a validation clone with
  `rm -rf <dir> && git clone` instead.

## Branching

- **Branch new work off `origin/main`, always.** Checked-out local branches are
  routinely stale, and a fix believed "done" has meant "stranded on an unmerged
  branch" more than once (re-landed as #76). Before asserting a fix exists, grep
  the file on `origin/main`, not the working branch.
- Sign off every commit (`git commit -s`, DCO). **Do not add an AI-attribution
  trailer** (`Co-Authored-By`, `Generated with …`) — attribution is disabled for
  this repo; this overrides any host default that appends one.

## The gate is `npm run verify`

`verify` = `check:artifacts && typecheck && lint:ci && test:cov && build` — five
steps, `check:artifacts` first. Two traps:

- **`npm run lint` is weaker than CI.** Local `lint` is `biome check`; CI runs
  `lint:ci` = `biome ci src tests`, which is stricter. Gate on real exit codes —
  a `cmd | tail && commit` once masked a failing Biome (#12). Run each step
  standalone and check its exit code.
- **Coverage runs on the ubuntu leg only**, so a green Windows run can still fail
  CI. Coverage floors live in `vitest.config.ts` (`coverage.thresholds`); they
  ratchet upward only and a meta-test blocks removing them. Read the file for
  current values — never hardcode them into prose or another file.

## Reading CI

- **Read every red check's actual output before calling it flaky.** The ~3-second
  "CodeQL" check-run is the *alert reporter* — its speed says nothing about
  findings. Two HIGH alerts were merged past as "flaky" because nobody read the
  title. Use `gh pr checks` plus `gh api …/check-runs --jq '.output.title'` and
  the code-scanning alerts API; only call a check flaky once you've confirmed it
  carries no finding.
- **Don't trust `gh pr checks --watch`** — it exits 0 when the check set changes
  after its snapshot (CodeQL registers late; this burned two full CI cycles).
  Poll `gh pr view <n> --json statusCheckRollup` until nothing is `IN_PROGRESS`,
  and re-check the rollup immediately before merge.
- **Merges serialize.** The ruleset requires up-to-date branches and auto-merge
  is off: update-branch → full re-CI → manual merge. If `gh pr update-branch`
  throws a transient GraphQL error, fall back to
  `git switch -c tmp origin/<branch> && git merge origin/main && git push origin tmp:<branch>`.

## Write CodeQL-proof code up front

CodeQL is a required branch-protection check and has twice caught what human +
agent review missed. Write the passing pattern the first time:

- **Guarded fd reads for any new fs-reading code:**
  `openSync(path, O_RDONLY | O_NOFOLLOW)` → `fstatSync(fd).isFile()` →
  `readFileSync(fd)` (see `readRegularFile` in `src/marketplace/build.ts`).
  Stat-then-read on a path — even inside try/catch — flags `js/file-system-race`.
  `O_NOFOLLOW` is absent at runtime on Windows despite the TS typings; mask with
  `(fsConstants as Record<string, number | undefined>).O_NOFOLLOW ?? 0`.
- **Hash the same in-memory buffer you package** — a second read of the file lets
  a swap ship unverified bytes (a real bug CodeQL caught).
- **Keep regexes linear-time when input can be influenced** by plugins, external
  libraries, or user config — prefer `indexOf` scans over trailing `.*$` matches
  (`js/polynomial-redos`, #116). When a PR reroutes external input into existing
  helpers, budget one CI round-trip for CodeQL.

## Release & publish guardrails

The full runbook is `RELEASING.md` — follow it. Durable guardrails an agent must
not violate:

- **Publishing is OIDC trusted-publisher only.** Never introduce token-based npm
  publishing. The publish pauses at the `npm-publish` GitHub environment for a
  one-click human approval — after a tag push, report "waiting at the gate";
  never try to bypass it.
- **Never re-tag a published version — fix forward.** npm package pages are
  immutable per version; a presentation/README fix ships as a docs-only SemVer
  patch with the contract fixture untouched.
- **Verify external-tool invocations in `release.yml` against the live runner
  version before tagging** — signing-tool flag drift has broken release runs.
  Any workflow step that can't execute before merge (signing, publishing) must be
  named as unverified in the PR body.
- Prereleases (version contains `-`) publish to the `next` dist-tag.
- Codecov is wired tokenless and informational-only — never add a token or make
  it a blocking check. Dependency advisories on dev-only transitive deps are
  handled via `npm overrides` pins — keep the pin and confirm `npm audit` is
  clean when touching deps.
