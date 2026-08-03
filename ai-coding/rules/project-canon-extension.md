# Project canon extension

Repo-specific rules for `ai-harness` that extend — and, on conflict, override —
the generic baseline and `agent-behavior-core.md`. This file is user-owned;
the public generator would normally reference it, but this self-hosting checkout
maintains it manually.

## Self-hosting boundary

Never run AIH against this checkout. This includes installed, `npx`, source, and
built CLI entry points; it includes read-only and state-changing forms of
`truth`, `init`, `bootstrap-ai`, `contract`, `adopt`, `doctor`, `secrets`,
`guardrails`, and equivalent project behavior. There is no verify-mode exception.

Validate product behavior only in repository tests that use temporary fixture
roots. Direct repository checks—docs inspection, canon mirror comparison,
version/help smoke tests, build, typecheck, lint, and tests—remain allowed because
they do not apply AIH project behavior to this tree. Follow
`../SELF-HOSTING.md`; never clear drift by running a generator here.

**Load on demand.** This map is the only always-read part. Read a rule file only
when your task hits its trigger — don't load the set. Each rule is a crisp
principle that points at the code or contract doc for the detail rather than
re-spelling it; verify against repo evidence before acting.

| When you are… | Load |
|---|---|
| touching platform / shell / spawn / paths | `rules/environment.md` |
| choosing code navigation, graph, semantic editing, or token tooling | `rules/repo-ai-tools.md` |
| branching, committing, reading CI | `rules/git-ci-discipline.md` |
| reviewing a PR, or acting on review/external feedback | `rules/review-protocol.md` |
| editing `src/` engines, checks, plans, trust, writers | `rules/engine-invariants.md` |
| proposing a feature or flag; report / dashboard work | `rules/product-principles.md` |
| writing docs; filing issues; drafting PRs; committing; choosing where a fact lives | `rules/doc-and-truth-homes.md` |
| creating, editing, or reviewing public documentation | `rules/doc-and-truth-homes.md`, `../../PUBLIC_DOCS_POLICY.md`, then `../curated-skills/betterdoc/SKILL.md` (repo-curated BetterDoc copy; resolve relative to this file) |
| closing out a unit of work; before opening a PR | `rules/tracking-and-done.md` |
| running a decision session — "decision session", "close decisions", weighing an aih product/governance choice | `../curated-skills/decision-partner/SKILL.md` (CLI-neutral canonical skill; resolve relative to this file) |

Precedence: this extension is Layer 2 and wins over the generic baseline on
conflict. Where a rule points at `CONTRIBUTING.md`, `RELEASING.md`,
`STABILITY.md`, `SECURITY.md`, or `docs/ARCHITECTURE.md`, that doc is the source
of truth.
