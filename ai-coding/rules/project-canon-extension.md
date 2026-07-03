# Project canon extension

Repo-specific rules for `ai-harness` that extend — and, on conflict, override —
the generic baseline and `agent-behavior-core.md`. This file is user-owned;
`aih bootstrap-ai` references it but never regenerates it.

Each rule is a crisp principle learned from this repo, and points at the code or
committed contract doc for the detail rather than re-spelling it. Load only the
slice your task touches; verify against repo evidence before acting.

- **Any platform-specific behavior** → `rules/environment.md`
- **Branching, committing, the gate, reading CI** → `rules/git-ci-discipline.md`
- **Opening/reviewing a PR, acting on feedback** → `rules/review-protocol.md`
- **Editing `src/` engines, checks, plans, trust, writers** → `rules/engine-invariants.md`
- **Proposing a feature or flag; report/dashboard work** → `rules/product-principles.md`
- **Writing docs, filing issues, choosing where a fact lives** → `rules/doc-and-truth-homes.md`

Precedence: this extension is Layer 2 and wins over the generic baseline on
conflict. Where a rule points at `CONTRIBUTING.md`, `RELEASING.md`,
`STABILITY.md`, `SECURITY.md`, or `docs/ARCHITECTURE.md`, that doc is the source
of truth.
