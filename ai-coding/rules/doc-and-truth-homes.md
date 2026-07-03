# Docs & truth homes

Where a fact belongs, what public text may say, and how to work with the owner.
The detailed maintainer session contract lives in the private companion repo;
sessions operating with maintainer credentials follow it. This file is the
public-safe half.

## The GitHub repo is public

- Strategy, GTM, competitive analysis, pricing, field-report source text,
  company-identifying details, and maintainer runbooks live **only** in the
  private companion repo. Never quote private content into a public issue, PR,
  commit, or canon file. The public `ROADMAP` is a sanitized derivative.
- Public-facing text (README, docs, npm page, release notes, report copy) must
  not claim: *enterprise-grade, production-proven, guaranteed, secure by default,
  compliant, production-ready* (and the broader banned list the docs-quality
  skill enforces). Absolute claims (*never / always / nothing*) need a scoping or
  carve-out; "no telemetry" reads "no default phone-home" (telemetry is an
  opt-in command); provenance wording claims the material, not a level.
- Em dashes are house style here — this overrides the generic prose-linter's ban.
- When auditing which docs are public-safe, audit against `main`, not a working
  branch.

## One home per kind of truth

- **Validated, public-safe defect or feature** → a GitHub issue, using only the
  existing label taxonomy (`bug`, `enhancement`, `documentation`,
  `type:security`, `area:*`, `priority:P*`, `enterprise`, `roadmap`,
  `breaking-change`, `release-blocker`) — never invent a label. Body shape:
  Problem (with evidence) → Fix → Acceptance → Source. Close only with evidence (a
  command + output, or a merged PR), never silently. Filing needs the owner's go.
- **Live backlog / resume state / session handoffs** → the private companion
  repo, not the public tracker.
- **Never hand-edit a generated or byte-locked doc.** `ai-coding/project.md` is
  rendered by `aih contract`; `docs/coverage/language-coverage.md` is
  snapshot-byte-asserted (edit the renderer, not the file); generated `ai-coding/`
  output is fixed generator-side or a re-init throws the edit away.
- **Doc passes at scale:** split files disjointly across agents with a claim
  ledger verified against `src/` and the built CLI; leave accurate files
  untouched; treat a docs/code mismatch as a possible source bug, not just a doc
  fix.

## Working with the owner

- **Merge and publish only on an explicit ask in the current turn** (an explicit
  selection in an ask-user prompt counts). A delegated/background session stops at
  a pushed branch + PR — it never marks ready or merges on its own.
- **One wave, not N chips.** Batch small same-theme fixes into a single wave
  branch/PR with one gate, one review, one merge — do not file per-fix chips or
  chain unrequested follow-up PRs. Its counterweight: keep each PR tightly scoped
  with an explicit out-of-scope list, and honor a plan doc's PR boundaries — never
  fold a deferred sibling into the current PR just because the adjacent code
  invites it.
- **Surface tangents, don't chase them.** Fix the reported ask end-to-end; name
  any mid-task discovery in one line and ask before acting on it — even when the
  fix would be correct and green.
- **Push back with evidence.** When the scope or idea is flawed, say so directly
  with code/data-grounded evidence and name the loop-that-bites risk;
  agree-and-execute is a failure mode. Judge a proposal by whether it helps an
  agent understand the contract and pick the right skill/command, or just adds
  surface.
- **Lock release/feature scope before coding it**; deferred refinements are filed
  to the next milestone, never silently absorbed.
