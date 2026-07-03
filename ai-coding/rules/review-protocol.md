# Review protocol

`CONTRIBUTING.md` and `RULE_ROUTER.md` require running and recording code review
+ security review + the domain reviewer before a PR is ready or merged. This file
is the concrete implementation of that mandate, plus the verification steps green
unit tests do not cover.

## Dual-lens review for high-risk PRs

For any PR that deletes/moves files, touches trust/security surfaces or exec
paths, or changes release machinery, run **two independent lenses** before merge:

1. An external security review (the exact non-TTY invocation is in the maintainer
   review runbook — it must run only against a clean, trusted checkout, with the
   results file in gitignored `.aih/`, never against unreviewed third-party code).
2. A **complementary** specialized agent — `security-reviewer` for destructive
   surfaces, `code-reviewer` for correctness. Never the same lens twice; never a
   general-purpose agent for this.

Every confirmed finding is **applied with a regression test, then re-verified**,
then merged — reviews end in fixes, not filed reports. This loop has returned
real request-changes findings on consecutive destructive/gate PRs (among them
#90, #101, #104, #116). Routine feature work does **not** need the external pass.

**Verify a reviewer's fix-list against source before applying.** Reviewers have
named symbols and flags that do not exist. Grep every symbol/flag a review cites
against `src/` and the built CLI `--help` before acting on it.

## A green unit suite is a sanity gate, not a completion gate

Hermetic tests (fakeRunner + `makeHostAdapter`) have repeatedly missed real bugs
here — the `.cmd`-shim class, marker/CRLF handling, a doctor false-positive, a
CRITICAL/HIGH hidden behind a green gate on every trust slice. For any behavior
change:

- **Run the real built CLI** (`npm run dev -- <cmd>`, or `node dist/cli.js <cmd>`
  after build) against a real repo/fixture, with **both** a passing case (exit 0)
  and a failing case (exit 1) — especially on Windows.
- For marker-block, EOL, or spawn-path code, build fixtures from real divergent
  content and run the real functions; the cross-platform fixtures that matter are
  a CRLF round-trip and a path-with-spaces through `-z` NUL splits.
- Before handing back a branch, confirm it builds from a **fresh checkout** — an
  untracked generated `src/` file once left a locally-green branch build-broken on
  CI. Generated-but-required source files must be committed.

## Acting on external feedback (and your own old notes)

External AI reviews and field reports about this repo run heavily stale or
premise-broken, in both directions, and reviewer track records invert between
rounds. Never act on one without in-repo verification:

- Assign each claim **CONFIRMED / REFUTED / PARTIAL / STALE / UNVERIFIABLE** with
  `file:line` evidence against current `origin/main`; refute by default; record
  the baseline commit the feedback was written against. Live-repro any Windows
  claim with the real CLI before verdicting. Never weight a reviewer's past
  accuracy — re-verify every claim every round.
- The same discipline applies to our own artifacts. Re-verify weeks-old issues
  against `main` before implementing — many describe already-fixed code. In a
  spec or plan doc, sections marked **LOCKED / RESOLVED** are binding owner
  decisions (do not re-litigate); everything else is the executing session's to
  weigh, with the choice recorded in the PR. `file:line` refs in those docs
  anchor to a named commit — re-verify against current `main`.
