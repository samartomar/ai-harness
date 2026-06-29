# Repo-Contract v1 — compact `ai-coding/` contract: work definition + build roadmap

_Generated 2026-06-29 on `feat/repo-contract-v1` (off `main` @ d675500). Self-contained: a cold session can execute this without prior chat context. Every claim was grounded against the live source (an 8-agent codebase audit + a re-baseline dry-run on this exact HEAD). File:line references are to this branch._

> Companion memory: `aih-repo-contract-plan.md`, `ai-coding-lean-contract-direction.md`, `local-report-v9-shipped.md` (in the user's memory vault). This doc is the authoritative build spec; the memories are the index.

## Problem

First-run `aih init --cli claude` emits **28 writes, 16 under `ai-coding/`** (verified dry-run on d675500). That is a "documentation garden": ~11 of those 16 are generated prose/meta-docs (REGENERATION, harness-update, other-tools, INDEX, architecture, conventions, tasks, SETUP-TASKS, VALIDATION, project-guardrails, example SKILL). The research thesis (ETH Zurich arXiv:2602.11988): verbose/auto-generated context *reduces* agent task success ~3% and raises cost >20%. The product goal is a **small, evidence-backed repo operating contract** that improves the next agent's first diff — not a canon file-family.

PR #62 ("lean scaffold canon", merged d675500) trimmed per-file *content* but removed no files — so the 16-file scatter is intact and this redesign is fully needed.

## The target (locked)

Default `aih init` emits a **4-file compact core** under `ai-coding/` plus the unchanged machinery:

```
ai-coding/
  RULE_ROUTER.md          # KEEP — bootloader; repointed to load project.json/project.md
  project.json            # NEW — machine-readable contract (the seam)
  project.md              # NEW — human mirror, RENDERED from project.json (never hand-authored)
  setup.md                # NEW — first-run setup, write-once ({once:true})
  adapters/_shared-canonical-block.md   # KEEP — managed-block merge source
  adapters/<cli>.md       # KEEP — per-tool; report "wired" detection reads this
  rules/agent-behavior-core.md          # KEEP, slimmed (point at ECC/Superpowers, don't duplicate)
  risk-gates.json         # KEEP — guardrails CI sidecar
```

Default drops 16 → ~7 under `ai-coding/`. The ~11 prune targets move **behind `--canon legacy`** (byte-identical to today's output; the compiler NEVER deletes). Folds: `architecture.md`+`conventions.md` → `project.md`; `SETUP-TASKS.md` → `setup.md`; `INDEX.md` → `RULE_ROUTER.md`; `project-guardrails.md` sensitive-paths → `project.json`.

### Locked decisions (Samar, 2026-06-29)
1. **4-file core keeping `RULE_ROUTER.md`** as the bootloader (reuse its managed-block merge), NOT renaming to README.
2. **`verified` command-confidence tier → Phase 2.** Phase 1 emits only `detected`/`inferred` (pure static `scanRepo`, no `ctx.run`, no spawn).
3. **Legacy flag-gated, no deletion.** `--canon legacy` reproduces today's full set byte-for-byte; pruning is opt-in via `aih adopt`.
4. **Scale-safety reuse.** `src/scale-safety.ts` is on main (d675500); PR 1D reuses `scaleSafetyCheck` directly.
5. **Agent-behavior dedup** (see §6): `project.md` = FACTS ONLY — it must NOT carry a working-agreement copy.

## 1. Architecture decision

New capability folder `src/contract/` — matches the per-capability idiom (`src/scaffold/`, `src/guardrails/`, `src/bootstrap-ai/`). It REUSES the engine wholesale; **no new `Action` kind**.

| Piece | Mechanism | Reuse |
|---|---|---|
| `project.json` writer | `writeJson(posix.join(ctx.contextDir,"project.json"), obj, "...", {merge:true})` | `src/internals/plan.ts`; stable 2-space output free via `jsonFile` in `resolveContents` |
| `project.md` / `setup.md` | `writeText(...)`, setup.md `{once:true}` | render via `lines()`/`frontmatter()` (`src/internals/render.ts`); copy the `(dir, stack)` shape of `scaffold/templates.ts` `architectureDoc`/`conventionsDoc` |
| portable-path validation | `probe("contract portable-paths", () => check(obj))` → gates `--verify`/exit | `normalizeRel` (`src/internals/worktree-gate.ts`) + `isEscapingRef`/`normalizeRef` idiom (`src/lint/rules.ts`); return a `Check` like guardrails' gitleaks probe |
| schema + fail-soft reader | `ProjectContractSchema` + `readProjectContract` + `projectContractJson` | pattern **byte-for-byte** on `src/config/marker.ts` (`AihConfigSchema`/`readAihConfig`/`aihConfigJson`) |

**Registration:** export `command: CommandSpec` from `src/contract/index.ts`; add to `CAPABILITIES[]` in `src/commands/index.ts` (gets all shared flags + dry-run-by-default). To run in `aih init`: append an `InitPhase` to `INIT_PHASES` (`src/init/phases.ts`) **after the scaffold phase** (scaffold lays `ctx.contextDir`). Keep the one-writer-per-file invariant — no other phase may write `project.json`/`project.md`/`setup.md`, and preserve init's `.claude/settings.json` `deepMerge` fold (`src/init/index.ts:132-153`).

**Do NOT extend `AihConfigSchema`.** `.aih-config.json` (repo root) records *bootstrap intent* (schemaVersion/contextDir/targets/adopt); the contract is a *separate* artifact under `ctx.contextDir` with a different lifecycle (re-derived each run). They coexist as siblings; the contract READS `targets`/`contextDir` from the marker but never rewrites it.

**Do-not-rebuild (already shipped — reference, don't reimplement):** `src/profile/scan.ts` (`scanRepo`→`RepoStack`), `src/secrets/scan.ts` (`scanSecrets`, value-blind), `src/adopt/{classify,cli-footprint}.ts`, `src/scale-safety.ts`, `src/internals/{plan,execute,merge,render}.ts`, `src/guardrails/*`, `src/mcp/policy.ts`. `assertContained` (`execute.ts`) already guards every repo-scoped write — the contract writes nothing `external:true`, so no escape guard to add.

## 2. Phase 1 PR stack (strict order; 1A before 1B)

### PR 1A — `project.json` schema + synthesizer + writer  ·  effort M · risk Low
Goal: land the contract object + schema + the `writeJson` emitter + portable-path probe. No prose, no init wiring.
- Create `src/contract/schema.ts` (`ProjectContractSchema` + `readProjectContract` + `projectContractJson`, patterned on `src/config/marker.ts`), `src/contract/synth.ts` (`synthesizeContract(ctx, stack): Promise<ProjectContract>` — root/contextDir/targets come off `ctx`; calls `scanRepo`, derives confidence per §3, scale class, `scanSecrets`, `knownGaps` from `classifyCanon`+`cliFootprint`), `src/contract/index.ts` (`CommandSpec`; `plan()` emits the `writeJson` + portable-path `probe`). Register in `CAPABILITIES[]`.
- Acceptance: `tests/contract/contract.test.ts` (mirror `tests/scaffold/scaffold.test.ts`). Copy `ctx()` (force `platform:'linux'`) + `writePaths`/`writesByPath` verbatim. Assert: `writePaths` contains `<dir>/project.json`; the JSON parses against the schema; **determinism** (two `plan()` runs → byte-identical `resolveContents`); **no exec actions** (`p.actions.some(a=>a.kind==='exec')===false`); portable-path probe passes clean / fails on a seeded `..`/drive-letter value. New `tests/contract/fixtures.ts`: `seedMindworksLike`, `seedNoPackageJson`, `seedMonorepoSmall`, `seedPortablePaths`, `seedLargeRepoNoGraph` (put-into-tmpdir seeders).
- Depends on: nothing.

### PR 1B — `project.md` + `setup.md` renderers  ·  effort S · risk Low
Goal: render the human contract from **1A's object** (never re-scan).
- `src/contract/templates.ts` (`projectContractDoc(dir, contract)`, `setupDoc(dir, contract)`). Extend `index.ts` `plan()` to append two `writeText` actions (`setup.md` `{once:true}`).
- Acceptance: extend the test — exact 3-file set `['<dir>/project.json','<dir>/project.md','<dir>/setup.md'].sort()` via `expect(writePaths(...).sort()).toEqual(...)`; prose-vs-JSON agreement (test command in `project.md` === `contract.commands.test.value`); EOL-normalize every compare `(s)=>s.replace(/\r\n/g,'\n')`; `setup.md` idempotency (`effect==='kept'` when present).
- Depends on: 1A.

### PR 1C — compact default + `--canon legacy` gate + agent-behavior fold  ·  effort L · risk HIGH
Goal: make compact the DEFAULT init; move the ~11 meta-docs behind `--canon legacy`; fold the agent-behavior tightening (§6).
- `src/init/phases.ts`: append `contract` `InitPhase` after `scaffold`.
- `src/scaffold/index.ts` + `src/bootstrap-ai/index.ts`: gate the meta-docs behind a `legacyCanon` predicate from a new init option `--canon legacy|compact` (default `compact`). Keep always-emitted core (RULE_ROUTER, _shared-canonical-block, adapters/<cli>, risk-gates.json). Repoint `RULE_ROUTER.md`/`INDEX`(folded) at `project.md`/`project.json`. Update `routerProbe`/`bootloaderProbe` + `VALIDATION.md` refs (legacy path only).
- Acceptance: `tests/init/init.test.ts` "compact default" case — default `--apply` `writePaths` drops the meta-docs, includes the 3 contract files; one-writer-per-file holds (`filter(write).length===1` per contract path); `--canon legacy` reproduces today's set. **Preserve** the existing `.claude/settings.json` union-across-3-writers assertion (must not regress).
- Risk mitigation: gate strictly (compact=default, legacy=byte-identical regression-frozen); ship after 1A/1B green; push + confirm on the 2nd PC before merge (see `push-and-confirm-for-remote-testing`).
- Depends on: 1A, 1B.

### PR 1D — doctor contract probe (reuse scale-safety)  ·  effort S · risk Low
Goal: wire portable-path/scale validation into `aih doctor` as a fail-closed probe.
- `contractTruthCheck(ctx): Promise<Check>` in `src/contract/check.ts`; one `probe('contract truth', …)` into `doctor.ts` `base[]` (scale-safety probe is already at `doctor.ts:210`); add CheckCode `contract.path-unportable` to `src/internals/verify.ts`. Reuse `scaleSafetyCheck`/`trackedFileCount`/`LARGE_REPO_FILE_THRESHOLD` from `src/scale-safety.ts`.
- Acceptance: probe `fail` (flips exit) on `seedPortablePaths` bad value; `pass` clean; on `seedLargeRepoNoGraph` validation is gated/skipped (not a false fail) when graph unavailable — same semantics as `scaleSafetyCheck`.
- Depends on: 1A.

## 3. `project.json` field → detector + confidence

One `scanRepo(ctx.root,{maxDepth:8,contextDir})` feeds everything. Confidence is LATENT in `deriveTest`/`deriveLint`/`configLint` (`src/profile/scan.ts:519-543`) — surface the source tier, don't collapse to a bare string. Enum: `"verified"|"detected"|"inferred"` (`verified` deferred to Phase 2).

| field | detector | confidence |
|---|---|---|
| `commands.test` | `RepoStack.testRunner` (`deriveTest`, skips placeholder `echo` via `isPlaceholderScript:546`) | `npm test` script → `detected`; runner dep → `inferred`; language default → `inferred` |
| `commands.build` | `RepoStack.buildCommand` | `npm run build` script → `detected`; **non-Node language default (`go build ./...`, `cargo build`, `./mvnw clean package`, `./gradlew build`, `dotnet build`) → `inferred`** (uniform with test/lint, scan.ts:475-496); else omit. Every `inferred` command also emits a `knownGaps` "unconfirmed … verify it runs" entry (synth.ts:87-92), so inferred is strictly better than omit (gives the agent the conventional command + a verify flag). |
| `commands.lint` | `RepoStack.lintCommand`/`configLint` | script → `detected`; dep/config-file → `inferred` |
| `commands.start` | `RepoStack.startCommand` | `npm start` script → `detected`; else omit. `scanRepo` derives **no language-default start** (scan.ts:475-496 set test+build only), so start is `detected`-or-omit in practice — `toCommand` stays uniform/future-proof if a start default is ever added. |
| `languages`/`frameworks`/`cloud`/`databases`/`packageManager` | `RepoStack.*` | presence-based, no enum |
| `entrypoints` | `RepoStack.entryPoints` | — |
| `scale.trackedFiles` | `gitTrackedSet` (`src/internals/scan-allowlist.ts:30`) / `git ls-files` | from git; `undefined` if not a git repo |
| `scale.class` | **new** pure bucketer over `trackedFiles` (+`isMonorepo`) | reuse `LARGE_REPO_FILE_THRESHOLD=1000` as the large floor |
| `sensitivePaths` | `scanSecrets(root)` (`src/secrets/scan.ts:49`) | **value-blind** — path/kind only, never values |
| `knownGaps` | `classifyCanon` + `cliFootprint` + sub-`detected` commands | foreign-scheme/marker-divergent → "reconcile canon"; `importCandidates>0` → "N un-imported CLI rule sets"; `legacyArtifacts` → "retire scripts"; command `< detected` → "unconfirmed `<cmd>`" |
| `contextDir`/`targets` | `ctx.contextDir` / resolved targets, cross-checked vs `.aih-config.json` (read-only) | — |

## 4. Phase 2 PR stack (consumes the contract; never forks it)

All read `readProjectContract(ctx)`; none re-derive the stack or write the contract.
- **2A** report contract-truth panel + `--gate` (M) — new `src/report/contract.ts` `contractTruthDigest` (omit-undefined like `graphDigests`); wire into `localPanels()` (`src/report/local.ts`); gate via `reportAdvisories` (`src/report/advisories.ts`) + CheckCode `report.contract-untrue`; v9 field in `v9-types.ts`/`v9-render.ts`. Sibling to extend: `src/report/scorecard.ts`.
- **2B** token-optimization index (M) — compact 3-file vs old 16-file load surface; anchor to byte counts, not a fuzzy score; reuse loadgroups machinery.
- **2C** hook-enforcement projection (M) — project `commands.{test,lint}`+`sensitivePaths` into `precommit.ts`/`command-policy.ts`/`risk-gates.ts`; advisory except existing hard-blocks (gitleaks, AGPL/SSPL); respect the `.claude/settings.json` `deepMerge` fold.
- **2D** governance digest by reference (M) — reuse `mcp/policy.ts` `PolicyVerdict` + guardrails CheckCodes as the status enum; defer certs/hardware/vdi to `aih bootstrap`.
- **2E** `verified` command tier (S) — run candidate cmd via `ctx.run`, gate on `!spawnError && code===0` (mirror `cli-detect.binaryOnPath`); opt-in/default-off so plans stay pure.
- **2E′ (consider)** fold `aih usage` capture into init + add Superpowers/canon skill provenance — makes trigger-point capture default-on (today `aih usage` is standalone; skill `source` is ECC-path-detected only). See `aih-repo-contract-plan` notes.

## 5. The Phase 1↔2 seam (the rule that keeps both viable)

> **`ProjectContract` (the object behind `project.json`) is the only shared structure. Phase 1 is its SOLE writer (one-writer-per-file). Phase 2 capabilities are READ-ONLY consumers via `readProjectContract` — never re-derive the stack, never write the contract. The schema evolves ADDITIVELY only (new fields optional with defaults, `AihConfigSchema` discipline) so old committed contracts still parse and a missing contract degrades to omitted panels — never fabricated metrics or a parallel manifest. No Phase-2 PR may add a required field or a second writer.**

## 6. Agent-behavior tightening (fold into PR 1C)

Research-grounded (ETH arXiv:2602.11988; GitHub 2,500-repo study; Karpathy anti-assumption clause 41%→11%; sycophancy arXiv:2510.03667). Edits in `src/bootstrap-ai/canon.ts` — the floor edit MUST be in `sharedCanonicalBlockBody` (single source) so `aih bootstrap-ai --verify` drift check stays green.

- **One canonical home:** full discipline lives in `agent-behavior-core.md`; `sharedCanonicalBlockBody` = compressed floor; `ruleRouterDoc` POINTS (stop re-spelling the secrets command + code-review-graph rule — currently 3–4× each); `project.md` = FACTS ONLY (no working-agreement copy).
- **Two additions only (high-leverage):** (1) anti-attestation — replace the Reporting line with *"Claiming done / tests pass / typecheck clean requires showing the command and its output — a sanity gate is not a completion gate. If you couldn't run it, say so and name what's unverified."* (2) tool-selection — *"Use the canonical tool this repo names; don't load MCP servers just-in-case; when two tools look alike, pick the one the canon names."*
- **Cuts/tightens:** drop "immutable updates over mutation" from the floor (linter-enforced, false for idiomatic Go/Rust; keep "no silent failures"); cut the duplicate "repo evidence is the truth" Invariant line in the floor (already in "Start here"); trim "no abstraction for single-use code" (echo of "nothing speculative"); cut the 3-line core preamble to one; cut "would a senior call this overcomplicated?" (unverifiable). Net token-negative.

## 7. Migration / compat

Reuse brownfield machinery — don't rebuild. `classifyCanon`/`isAdoptable` already redirect re-runs to `aih adopt` instead of clobbering (`src/init/index.ts:16-33`). `project.json` is `{merge:true}` (preserves user keys); `setup.md` is `{once:true}`. Upgrade is additive-then-opt-in-prune: compact added, old docs left until `--canon compact` (the compiler never deletes). Surface the retirement as a `knownGaps` entry sourced from `legacyArtifacts`.

## 8. Test idiom (no `__snapshots__`, no committed fixtures today)

Assertion is action-list inspection. Header imports from `tests/scaffold/scaffold.test.ts`. `ctx()` forces `platform:'linux'`. Exact-set: `expect(writePaths(p.actions).sort()).toEqual([...].sort())`. Content: `writesByPath(...).get(path)?.contents` → `toContain(...)`, EOL-normalized. Determinism + idempotency (`executePlan` twice → `effect==='unchanged'`). vitest coverage ratchet **91/78/94/92** applies to new `src/` automatically; tests must be `tests/**/*.test.ts`. No real-CLI spawn; a compact contract emits pure `WriteAction`s so the Windows `.cmd` shim is irrelevant.

## START HERE (cold session)

1. Confirm branch: `git rev-parse --abbrev-ref HEAD` → `feat/repo-contract-v1` (off d675500). `git pull` not needed.
2. Read this doc + `src/config/marker.ts` (schema pattern) + `src/profile/scan.ts:15-46,427,519-549` (RepoStack + confidence tiers) + `tests/scaffold/scaffold.test.ts` (test idiom) end-to-end.
3. Build **PR 1A** exactly as §2/§3: `src/contract/{schema,synth,index}.ts` + `tests/contract/{contract.test.ts,fixtures.ts}`. Gates: `npm run typecheck`, `npm run lint` (biome ci), `npm test`, `npm run build` — all green (verify exit codes, not pipe tails).
4. Then 1B → 1C (the heavy one; fold §6) → 1D. One PR at a time; push + confirm hash before merging 1C.
