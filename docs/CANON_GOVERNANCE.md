# Canon governance — practices and how they are enforced

Hand-maintained. How this repo keeps its agent-instruction layer (the generated
`CLAUDE.md`/`AGENTS.md` bootloaders and the `ai-coding/` canon) small, current,
and actually load-bearing. Distilled from the 2026-08-01 audit of the canon
against Anthropic's context-engineering guidance; landed via PRs #580–#583,
first shipping in the release after v3.3.0.

The rules themselves live in the canon — this file maps each practice to its
enforcement and does not restate rule text. The per-control ledger is
[CONTROL_MATRIX.md](CONTROL_MATRIX.md).

## Practices and enforcement

| Practice | Stated in | Enforced by |
| --- | --- | --- |
| Small always-loaded bootloader; task rules routed lazily | `ai-coding/RULE_ROUTER.md`; trigger table in `ai-coding/rules/project-canon-extension.md` | Lazy-canon selector `selectLazyCanonFiles` (`src/context/index.ts`) + `tests/context/budget.test.ts`; otherwise agent-directed |
| Generated projections from one authored source — never hand-edit a generated block | Markers in `CLAUDE.md`/`AGENTS.md`; `doc-and-truth-homes.md` § generated docs | `aih bootstrap-ai --verify` drift probes (`cli.bootloader-drift`, `canon.generated-drift`); CI step `npm run check:canon-drift` (`.github/workflows/ci.yml`); byte-identity tests in `tests/bootstrap-ai/generated-output-consistency.test.ts` |
| Drift checks are checkout-independent | — (product behavior) | Repo display name derives from the origin remote or `package.json`, not the folder name (`src/internals/repo-name.ts`), so the gate holds in clones and worktrees |
| Verification blind spots are visible, not silent | — (product behavior) | `cli.bootloader-unmanaged` advisory skip per bootloader outside the resolved target set (`src/bootstrap-ai/index.ts`); flows into the report and SARIF at note level |
| Safety prohibitions are always-loaded — a rule that isn't loaded isn't a rule | Invariants in the generated shared block (incl. `public-surfaces`), authored in `src/bootstrap-ai/canon.ts` | Generation from `DISCIPLINE_INVARIANTS` + the drift gate keeping the block current; agent-directed at runtime (CONTROL_MATRIX `CANON-22`) |
| Rules load at the moments they matter | `doc-and-truth-homes.md` load-when line; router trigger table | Selector loads the docs rule for closeout tasks (`tests/context/budget.test.ts` pins it); trigger text names filing issues, drafting PRs, committing |
| Git subprocesses are hermetic — inherited `GIT_*` never redirects them | — (product invariant) | `hermeticGitEnv()` applied in the central runner seam (`src/internals/git-env.ts` via `src/internals/proc.ts`) and inlined into generated scripts; source-scan test fails CI on any new unguarded git spawn; vitest-worker scrub (`tests/setup-git-env.ts`) protects the suite itself |
| One home per kind of truth; docs point, they don't restate | `doc-and-truth-homes.md`; `project-canon-extension.md` | `docs:lint` (banned-phrase policy in `PUBLIC_DOCS_POLICY.md`); otherwise agent-directed |
| PRs sized for the serial merge treadmill | `ai-coding/rules/git-ci-discipline.md` | `semver-label` required check enforces labeling; sizing itself is agent-directed |

"Agent-directed" means the control relies on the rule being loaded and followed
rather than a machine gate — which is why the always-loaded placement and the
drift gate above are themselves the enforcement backbone.

## Known gaps (from the same audit, deliberately deferred)

- The always-loaded block still carries a few generic working-agreement bullets
  that duplicate `agent-behavior-core.md`.
- Task routing exists in two places (router sections and the extension trigger
  table); one should point at the other.
- `repo-ai-tools.md` hand-maintains tool version pins that duplicate
  `tools/repo-ai-tools.mjs`.

Revisit these when next touching the canon generator; each is small and none is
safety-relevant.
