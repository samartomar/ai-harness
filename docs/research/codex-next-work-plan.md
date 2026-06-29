# Codex next-work plan — contract freshness, language coverage, strict tier, nightly engine

_Generated 2026-06-29, rebased onto `main` @ `f4088ea` (v2 governance / PR #64 now MERGED — the posture dial, `org-policy/drift.ts`, `gradeVerdict`, and the token-optimization index this plan reuses are on `main`). Sequenced, not a dump: Wave 1 is the foundation; Waves 2-3 are explicitly gated on Wave 1's output. Every item names the principle it must respect. Build top-down; do not parallelize across waves._

> Companions: `docs/research/repo-contract-v1-plan.md` (the contract substrate), `docs/research/repo-contract-v2-plan.md` (the governance plane), `docs/research/compact-contract-polish.md` (polish — P1 already landed). Memories: `aih-repo-contract-plan`, `push-back-and-pick-right-skill`.

## Guardrails (non-negotiable — these constrain every item)

1. **aih is the sole writer of the contract.** No skill/hook/agent writes or auto-applies edits to `ai-coding/project.json|project.md|setup.md` or the shared canon. Freshness is a **signal** (a detect/probe), never an **edit**.
2. **Strict-omit over guessing.** Every command added for any language is **derived from that language's manifest/convention** (`Cargo.toml` ⇒ `cargo test`), graded by the confidence enum (declared ⇒ `detected`, convention ⇒ `inferred`, absent ⇒ omit). Never invent a command.
3. **Measure before you enhance.** The coverage matrix (W1.2) picks the targets; do not pre-decide a language list.
4. **Don't rebuild what works.** Node/TS is already deep (npm, TypeScript, 12 frameworks incl. Angular/Vue/React/AWS-CDK, 5 test runners, 4 linters, DBs, package managers, browser-test + browser-vs-Node label). Do **not** "enhance" these — the one narrow Node gap worth a look is **AWS CDK verbs** (`cdk synth/deploy/diff`), since aih labels CDK but emits npm scripts only.
5. **Dual-control for anything autonomous** (W3.2): the agent detects + proposes (issue/PR); a **human merges and releases.** No auto-merge, no auto-release.
6. **The format stays boring and universal.** `project.json` stays JSON (every model + tool reads it). If traversal ever becomes a bottleneck, change the **access pattern** (query-on-demand over the codebase via the graph), not the serialization — see "Deferred".

### Already landed — do NOT re-do
- Polish P1: guardrails prose docs (`guardrails-taxonomy.md`, `command-policy.md`) gated behind `--canon legacy` (`src/guardrails/index.ts:137`).
- `browserTest`/Karma-headless detection + browser-vs-Node language label (`src/profile/scan.ts`).

---

## Wave 1 — Foundation (do now; no inter-dependency)

### W1.1 — Contract staleness gate  ·  effort M · risk Low · deps: none
**Goal:** aih tells you when the committed `project.json` has drifted from the live repo (stale context poisons; today there's no such check — `src/contract/check.ts:19` explicitly defers "deep staleness validation").
- **Build:** in `contractTruthCheck` (`src/contract/check.ts`), re-run `synthesizeContract(ctx, stack)` fresh and diff its **facts-subset** against the committed `project.json` (read via `readProjectContract`). **Reuse** the diff helpers from `src/org-policy/drift.ts` (`sameJson` / `missingProjectionParts` / `stable`).
- **Facts-subset:** `commands.{test,build,lint,start}`, `scale`, `entrypoints`, `languages`/`frameworks`, `sensitivePaths`, `workspaces`. **Exclude user-added keys** (`project.json` is `{merge:true}` — a user key must not trip staleness).
- Emit a **posture-graded** `contract.stale` Check (vibe=warn, team/enterprise=fail via `gradeVerdict`). Add the CheckCode to `src/internals/verify.ts` + `src/support/findings.ts` + the check-code exhaustiveness test.
- **Scale-safety:** defer deep staleness on `>= LARGE_REPO_FILE_THRESHOLD` exactly as `contractTruthCheck` already defers (don't false-fail big repos).
- Surface in **doctor** + the **report contract panel**: "contract drifted from the live repo: `<fields>` — re-run `aih contract`." Advised fix = regeneration, **never** an agent edit.
- **Tests:** seed repo → `aih contract` → mutate `package.json` (add a script) → assert `contract.stale` fires with the field diff; in-sync does not fire; a user-added `project.json` key does not trip it; large-repo deferral holds.

### W1.2 — Language-coverage benchmark + matrix  ·  effort M · risk Low · deps: none
**Goal:** the "measure first" step — produce the artifact that PICKS the Wave-2 targets (and becomes the nightly engine's living constant).
- **Build:** a coverage probe that runs `scanRepo` against a set of fixtures + representative repos and grades, per ecosystem, what aih detects vs ground truth. Write `docs/coverage/language-coverage.md` — a matrix: ecosystem × {languages, frameworks, test, build, lint, db, package-manager, monorepo/workspace} graded good/partial/none, with the gap noted.
- **Include the daily-stack as a LOCK baseline** (npm/TS/Angular/Vue/React/CDK) — representative repos that must stay green; you are guarding, not enhancing them.
- **Seed the gaps** the audit will surface: Python (single `pytest`/`ruff`, only when no root `package.json`), Rust (single `cargo` default, same condition), Go/Java/.NET (one default cmd, no frameworks/lint/db), and **polyglot coexistence** (the non-Node branch at `src/profile/scan.ts:468` only fires when there's no root `package.json`, so Node+Rust/Node+Python loses the secondary toolchain entirely).
- **Tests:** the matrix generation is deterministic given the fixture set; assert grades for a few known fixtures.

---

## Wave 2 — Coverage enhancement (data-driven; ORDER picked by the W1.2 matrix)

One ecosystem per PR. Each PR = detection + manifest-derived commands (evidence-backed, strict-omit, confidence-graded) + fixture tests + matrix update. Likely order, by Samar's real repos:

- **W2.1 — Python** (syntegris, mockapi-bot, eicp): detect `pyproject.toml`/`requirements.txt`/`poetry`/`uv`; commands `pytest`/`ruff`/`black`/`mypy`; frameworks FastAPI/Django/Flask; flag virtualenv presence.  · M · deps: W1.2
- **W2.2 — Rust** (ruflo): `Cargo.toml` ⇒ `cargo test`/`build`/`clippy`/`fmt`.  · S · deps: W1.2
- **W2.3 — Polyglot coexistence + per-workspace commands** (the structural one): make `scanRepo` detect **multiple toolchains coexisting** (lift the non-Node detection out of the `else`-only branch) and emit **per-workspace** commands (a `workspaces` map; each sub-package's commands derived from ITS manifest). This is the highest-value structural fix for the monorepos.  · L · risk Med · deps: W1.2, W2.1, W2.2
- **W2.4 (optional) — AWS CDK verbs**: emit `cdk synth/deploy/diff` for a CDK project (currently labeled but only npm scripts surface).  · S · deps: none

**Do NOT** touch npm/TS/Angular/Vue/React detection — covered; W1.2 locks them as a regression baseline.

---

## Wave 3 — Downstream (after the foundation is proven)

### W3.1 — `--canon strict` tier  ·  effort M · risk Med · deps: W1 proven
**Goal:** an opt-in, even-leaner context tier for managed/enterprise environments — measured by the token-optimization index.
- Extend `CanonMode` (`src/internals/canon-mode.ts`) to `legacy | compact | strict`. **strict** = `project.json` + a one-line bootloader; **drop** `project.md` prose and the inlined discipline (`agent-behavior-core` essentials) and rely on **ECC/Superpowers (Layer 1)** for the working agreement.
- **HARD limits (or it bites):** strict shaves **prose/ceremony, NEVER the evidence** — `commands`/`paths`/`scale`/`gaps` always stay (drop those and the agent guesses → first-diff accuracy craters). It is a **fixed mode**, not an open-ended "keep reducing".
- **Gate it:** strict trades the self-contained discipline floor for ECC-dependence, so it's only safe where Layer 1 is guaranteed — **gate to enterprise posture / a managed env**, or an explicit opt-in that **checks ECC is present** and warns otherwise. Never a greenfield default.
- Report the token delta vs compact via the token-optimization index. Tests: strict emits exactly {project.json, thin bootloader}; the facts are identical to compact; legacy/compact unchanged.

### W3.2 — Nightly coverage engine  ·  effort L · risk Med · deps: W1.2 + W2 trustworthy
**Goal:** the continuous-improvement loop — find coverage gaps nightly, propose fixes, release when mature. Built so it inverts the anti-pattern (detect+propose, human merges/releases).
- **Corpus = ground truth:** `coverage/corpus.json` — curated public repos per language/framework/monorepo with their expected stack + commands.
- **Nightly Action** (`.github/workflows/coverage-nightly.yml`, cron): run `scanRepo` against the corpus, diff detected vs expected, score per ecosystem, **update `docs/coverage/language-coverage.md`** (the living public constant).
- **Gap → proposal:** open an issue, or spawn a headless agent to draft a fix PR. **A human reviews + merges. Never auto-merge.**
- **Release gate:** when N ecosystems reach "good" + gates green, open a **release PR** — a **human cuts the release. Never auto-release.**
- **Why safe:** the corpus is an independent verifier (improvement is measured, not self-reported); detection stays deterministic/manifest-derived; the writer of durable truth stays the human-on-merge.

---

## Optional / small

### Git-conditional scaffold  ·  effort S · deps: none
Today scaffold/guardrails write `.githooks/pre-commit` + `.pre-commit-config.yaml` and `setup.md` says `git config core.hooksPath .githooks` **unconditionally** — dead/misleading in a non-git dir (e.g. `ai-os`). aih is fail-soft (no crash), but the artifacts are noise. Gate those writes + the setup.md guardrail step on `git rev-parse --is-inside-work-tree`; in a non-git dir, rely on the file-based deny layer aih already writes (`.claudeignore`, `.claude/settings.json` deny). Note: `src/workspace/detect.ts` already does some git detection — reuse it.

## Deferred — NOT now (frontier; revisit only after the facts are proven)

**Query-on-demand facts interface.** "Something an AI can traverse faster" is real — but it's the **codebase** layer, not the contract, and the lever is the **access pattern**, not a faster file format. `project.json` is tiny and JSON's universality is a feature; do not replace it. The real version (later): a queryable interface (MCP-served) so a polyglot monorepo's facts are *asked* (`"test command for the auth package?"`) not loaded whole — composes with W2.3 + code-review-graph. Same rule: the agent queries; aih + the human write. Do not start this until W1–W2 are proven.

---

## START HERE (cold session)
1. Confirm landed state (don't re-do): `git grep -n "canonMode" src/guardrails/index.ts` (P1 done), `browserTest` in `src/profile/scan.ts` (done). Confirm the staleness gate is still absent (`git grep -n "synthesizeContract" src/contract/check.ts` → only the deferral comment).
2. Build **W1.1** (staleness gate) and **W1.2** (coverage matrix) — independent, foundation. Gates each: `npm run typecheck`, `npm run lint` (biome ci), `npm test`, `npm run build` — all green (verify exit codes, not pipe tails).
3. Let **W1.2's matrix pick** the Wave-2 order; enhance one ecosystem per PR (W2.1 Python → W2.2 Rust → W2.3 polyglot). Do not enhance the covered Node stack.
4. Only after Wave-2 is trustworthy: **W3.1** (`--canon strict`, bounded + posture-gated) and **W3.2** (nightly engine, dual-control). Push + 2nd-PC verify before merging the structural PRs (W2.3, W3.x).
