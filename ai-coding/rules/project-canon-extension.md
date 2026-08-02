# Project canon extension

Repo-specific rules for `ai-harness` that extend — and, on conflict, override —
the generic baseline and `agent-behavior-core.md`. This file is user-owned;
`aih bootstrap-ai` references it but never regenerates it.

## Self-hosting boundary

Never use AIH project-truth or project-governance surfaces to govern the
`ai-harness` checkout itself. This includes `truth`, `init`, `bootstrap-ai`,
`contract`, `adopt`, `doctor`, and equivalent state-changing setup flows, whether
through an installed binary or `src/cli.ts`. Validate their product behavior in
repository tests using temporary fixture roots. Repository-owned development
checks such as docs lint, version/help smoke tests, build, and test are allowed.
The read-only canon drift gate is one of them: `npm run check:canon-drift` runs
`bootstrap-ai --cli claude,codex --verify` without `--apply`, writes nothing, and
only confirms the committed canon matches its generator. Never clear a red drift
gate with an in-repo apply run — regeneration is a deliberate maintainer action.

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
| closing out a unit of work; before opening a PR | `rules/tracking-and-done.md` |
| running a decision session — "decision session", "close decisions", weighing an aih product/governance choice | `.claude/skills/decision-partner/SKILL.md` (repo root; Claude also auto-loads it as `/decision-partner`) |

Precedence: this extension is Layer 2 and wins over the generic baseline on
conflict. Where a rule points at `CONTRIBUTING.md`, `RELEASING.md`,
`STABILITY.md`, `SECURITY.md`, or `docs/ARCHITECTURE.md`, that doc is the source
of truth.
