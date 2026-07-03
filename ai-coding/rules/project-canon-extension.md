# Project canon extension

Repo-specific rules for `ai-harness` that extend — and, on conflict, override —
the generic Layer-1 baseline (ECC + Superpowers) and the working discipline in
`agent-behavior-core.md`. This file is user-owned; `aih bootstrap-ai` references
it but never regenerates it, so hand edits here survive.

These rules exist because each was learned from a real incident in this repo,
not from generic best practice. Load only the slice your task touches; verify
every claim against current repo evidence (source, tests, CI) before acting.

## Load order

- **Any change on this Windows dev box / CI matrix** → `rules/windows-environment.md`
- **Committing, branching, running the gate, reading CI** → `rules/git-ci-discipline.md`
- **Opening/reviewing a PR, acting on external feedback** → `rules/review-protocol.md`
- **Editing `src/` (engines, checks, plans, trust, writers, tests)** → `rules/engine-invariants.md`
- **Proposing a feature, flag, or file family; report/dashboard work** → `rules/product-principles.md`
- **Writing docs, filing issues, choosing where a fact lives** → `rules/doc-and-truth-homes.md`

Precedence: this extension is Layer 2. Where it conflicts with the generic
baseline, this wins. Where a rule points at a committed contract doc
(`CONTRIBUTING.md`, `RELEASING.md`, `STABILITY.md`, `SECURITY.md`,
`docs/ARCHITECTURE.md`, `docs/THREAT_MODEL.md`), that doc is the source of
truth — these files carry only the deltas the incident record proved agents
keep missing.
