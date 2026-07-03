# Docs & truth homes

> Load when: writing docs, filing issues, or choosing where a fact lives.

The GitHub repo is public. The detailed maintainer session contract lives in the
private companion repo; sessions with maintainer credentials follow it. This is
the public-safe half.

## Public vs private

- Strategy, competitive analysis, pricing, field-report text, and maintainer
  runbooks live only in the private companion repo — never quoted into a public
  issue, PR, commit, or canon file. The public `ROADMAP` is a sanitized
  derivative.
- Public-facing text (README, docs, npm page, report copy) doesn't claim
  *enterprise-grade, production-ready, guaranteed, secure by default, compliant*
  (and the rest of the docs-quality skill's banned list). Scope absolute claims;
  "no telemetry" reads "no default phone-home". Em dashes are house style here.
- Audit which docs are public-safe against `main`, not a working branch.

## One home per kind of truth

- **Validated, public-safe defect or feature** → a GitHub issue using the
  existing label taxonomy (never invent a label), body Problem → Fix → Acceptance
  → Source, closed only with evidence. Filing needs the owner's go.
- **Backlog, resume state, handoffs** → the private companion repo.
- **Never hand-edit a generated or byte-locked doc** — edit its renderer;
  generated `ai-coding/` output is fixed generator-side or a re-init discards the
  edit.

## Working with the owner

- **Merge and publish only on an explicit ask this turn.** A background session
  stops at a pushed branch + PR — it never marks ready or merges on its own.
- **One wave, not N chips** — batch small same-theme fixes into a single
  branch/PR. Its counterweight: keep each PR tightly scoped with an explicit
  out-of-scope list; don't fold a deferred sibling in because adjacent code
  invites it.
- **Surface tangents, don't chase them** — name a mid-task discovery in one line
  and ask before acting, even when the fix would be correct.
- **Push back with evidence** when the scope or idea is flawed; agree-and-execute
  is a failure mode. Lock release/feature scope before coding it.
