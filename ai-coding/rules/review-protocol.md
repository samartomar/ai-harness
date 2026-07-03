# Review

`CONTRIBUTING.md` requires recording code review + security review before a PR is
ready. The deltas that record does not state:

- **Two independent lenses before merging a high-risk PR** (deletes/moves files,
  trust/security/exec surfaces, release machinery): an external security review
  plus a complementary specialized agent — never the same lens twice, never
  general-purpose. Apply every confirmed finding with a regression test, then
  re-verify. Routine feature work does not need this.
- **A green unit suite is a sanity gate, not a completion gate.** Hermetic tests
  miss real bugs here — verify behavior by running the real built CLI
  (`npm run dev -- <cmd>`) against a fixture, with both a passing and a failing
  case, on the target OS. Confirm a branch builds from a clean checkout before
  handing it back.
- **Verify a reviewer's claims against source before acting** — reviews cite
  symbols and flags that do not exist.
- **Adjudicate external feedback against `main`.** Reviews and field reports run
  heavily stale; refute by default, verdict each claim with `file:line` evidence,
  and re-verify your own old issues before implementing them. In spec or plan
  docs, `LOCKED`/`RESOLVED` is binding; the rest is the session's to decide.
