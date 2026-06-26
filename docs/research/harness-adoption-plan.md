# aih Improvement Plan — deep code-grounded specs + build roadmap

_Generated 2026-06-26. Each spec was written after reading BOTH the source package's real code AND aih's actual target files. Most candidates came back `partial` (aih already does part of it) and were scoped down accordingly. Two real bugs surfaced during grounding — see the roadmap and the capability-registry / token-loadgroup specs._

> Companion: [competitive-harness-landscape.md](competitive-harness-landscape.md) — the 23-package landscape this plan was distilled from.

## Contents
1. Build roadmap (waves, dependencies, what to do first, what to drop)
2. LINT — canon-markdown-lint (**do first**)
3. LOAD — token-loadgroup-gate
4. SARIF — scan-hygiene-sarif
5. REG — capability-registry (fixes the mcp per-tool bug)
6. POLICY — command-policy-risk-gates
7. SCORE — harness-scorecard
8. CONFIG — config-truth-templates (mostly declined)

---

# 1. Build Roadmap


# aih Improvement Roadmap — Build Sequencing

Seven specs, sequenced by shared-infrastructure dependencies, value, and posture risk. Spec IDs used below:

- **REG** — Declarative per-tool capability registry (`cli-registry.ts`)
- **LINT** — Canon markdown lint (isolint subset)
- **LOAD** — Per-tool load-group token model + `--gate`
- **POLICY** — Command-policy lexicon + risk gates
- **SARIF** — gitignore scan + SARIF + `--since`
- **SCORE** — Maturity scorecard for doctor/report
- **CONFIG** — `.aih-config.json` marker + dirty-worktree gate (descoped slice of the blazity spec)

---

## 1. Shared infrastructure & dependency order

The load-bearing fact across the specs: **per-CLI knowledge is currently smeared across three parallel `Record<Cli,…>` tables** (`SIGNALS` in cli-detect.ts, `CLI_BOOTLOADERS` + `CLI_META` in canon.ts), and **mcp/* hardcodes Claude's `.mcp.json` for all 11 CLIs**. Two specs consume per-CLI facts that only REG (or its export) provides.

```
                 ┌───────────────────────────────────────────┐
                 │ REG  cli-registry.ts                        │
                 │ (per-CLI: configPath/mcpKey/format,         │
                 │  bootloaders, capability fields)            │
                 └───────────────────────────────────────────┘
                    │ provides mcpProfile()       │ subsumes CLI_BOOTLOADERS
                    │ + correct per-tool MCP write │ (LOAD only needs it EXPORTED)
                    ▼                              ▼
        ┌────────────────────┐         ┌──────────────────────────┐
        │ POLICY (MCP/perms  │         │ LOAD  loadgroups.ts       │
        │ projection rides   │         │ inverts file→tool map     │
        │ on .claude paths)  │         │ for worst-case headline   │
        └────────────────────┘         └──────────────────────────┘

  INDEPENDENT (no REG dependency — touch report/, lint/, internals/ seams):
     LINT ── reads generated strings + plannedPaths
     SARIF ── async git seam + FsTransaction + VerificationReport→SARIF
     SCORE ── reuses bootloaderProbe / inventory / scanContextBloat
     CONFIG ── .aih-config.json marker + worktree-gate preflight
```

**Critical nuance on the REG↔LOAD coupling (from the LOAD spec itself):** LOAD does **not** need the full REG registry. Its only hard prerequisite is that `CLI_BOOTLOADERS` in `canon.ts` becomes `export`-ed (a one-line change). LOAD inverts that *already-exact* file→tool map. So:

- **LOAD's blocker is a 1-line export, not REG.** Do not gate LOAD on the full registry landing.
- **REG, when it lands, should consume the same exported `CLI_BOOTLOADERS`** via `bootloadersFor()` — REG deletes the duplicate, it does not invent a new source. Sequence REG's `canon.ts` refactor *after* LOAD has pinned the export with a test, so REG inherits a locked contract instead of racing it.

**The real dependency edges:**

| Edge | Hard or soft | Why |
|---|---|---|
| `canon.ts` exports `CLI_BOOTLOADERS` → LOAD | **hard** | LOAD inverts it; without export it can't import |
| REG → POLICY | **soft** | POLICY writes `.claude/settings.json` + sandbox managed-settings, all Claude-pathed today; REG only *generalizes* those paths later. POLICY ships standalone. |
| REG → mcp per-tool write | **hard (this is REG's headline value)** | mcp can't write Codex's `config.toml` without `mcpProfile()` |
| REG → SCORE / SARIF / LINT / CONFIG | **none** | they reuse existing probes/seams |

---

## 2. Ranked build order (waves)

### Wave 1 — High value, unblocks others, low posture risk

| # | Spec | One-line value | Effort | Unblocks |
|---|---|---|---|---|
| 1 | **LINT** | aih finally checks that the paths it generates resolve and its canon is weak-model-safe — *its own value proposition*, currently unverified | **S** | Establishes `src/lint/` + the read-only-probe-in-`--verify` pattern reused conceptually by SARIF |
| 2 | **LOAD** (incl. the `CLI_BOOTLOADERS` export) | Fixes a *confirmed overcount* in the flagship report headline + makes `--gate` actually flip exit code via the existing `alwaysVerify` path | **M** | The `export CLI_BOOTLOADERS` it ships is the contract REG later consumes; SCORE reuses its load-group numbers |
| 3 | **SARIF** | gitignore-honoring scan (kills the source+generated double-count) + SARIF for GitHub code-scanning + `--since` PR filter | **M** | Adds `internals/scan-allowlist.ts` + `internals/sarif.ts` seams reused by any future scan |

**Why these three first:** LINT is the only **S**, it's **high priority**, it has zero dependencies, and it ships aih's literal selling point (weak-model-safe context). LOAD fixes a *confirmed-wrong* number on the most-visible surface and emits the registry-coupling primitive (the export) the rest of the roadmap leans on. SARIF is additive plumbing on seams that already exist (`gitRead`, `FsTransaction`, `VerificationReport`).

### Wave 2 — High value, depends on Wave 1 primitives or generalizes them

| # | Spec | One-line value | Effort | Depends on |
|---|---|---|---|---|
| 4 | **REG** | One zod-validated `CLI_REGISTRY`; **fixes mcp to write the correct config file per tool** (Codex `config.toml` via non-destructive sidecar, not Claude's `.mcp.json`) | **M** | Consumes the `CLID_BOOTLOADERS` export pinned by LOAD; threads `resolveTargets` into mcp (latent `--cli` bug fix) |
| 5 | **POLICY** | Machine-readable deny/ask command lexicon + 7 risk-gate categories projected defense-in-depth into the `.claude/settings.json` aih already writes | **M** | Soft on REG (cleaner once registry generalizes `.claude` paths); shares the two-writer `.claude/settings.json` merge LINT/scaffold already exercise |

**Why second:** REG's headline win (correct per-tool MCP config) is real and high-value, but it's a **medium-priority M** that benefits from LOAD first locking the `CLI_BOOTLOADERS` contract — so REG's `canon.ts` deletion inherits a tested export rather than refactoring a moving target. POLICY is high-priority but its `.claude/settings.json` two-writer merge is *verified safe* and independent; it slots here to ride REG's path generalization and to batch the `.claude/settings.json` golden-output churn with REG rather than spreading it across waves.

### Wave 3 — Aggregation & ergonomics (depend-on / lower urgency)

| # | Spec | One-line value | Effort | Depends on |
|---|---|---|---|---|
| 6 | **SCORE** | Rolls the *already-running* drift/budget/inventory checks into a weighted 0–100 maturity grade for `report` + systematic doctor remediation hints | **M** | Best *after* LOAD (reuses corrected load-group numbers) so the score isn't built on the overcounted headline |
| 7 | **CONFIG** (descoped) | Committed `.aih-config.json` marker so doctor/re-runs stop silently checking the wrong context dir + dirty-worktree `--apply` preflight | **M** | None hard; sequenced last as pure ergonomics |

**Why last:** SCORE is explicitly an *aggregation layer over checks that already exist* — building it before LOAD/SARIF correct the underlying numbers would bake an overcount into the headline grade. CONFIG is the smallest-value survivor of its source spec (two of three blazity ideas dropped — see §3) and is pure quality-of-life.

---

## 3. Drop / descope

| Spec | Verdict | Rationale (cites gap_status) |
|---|---|---|
| **CONFIG** (blazity) | **Descope to 2 narrow lifts** | `gap_status: partial`, and the spec's own analysis says *"Mostly conflicts as proposed."* **DROP** named repo-shape templates (redundant with aih's empirical `scanRepo`/`workspace` detection — they only fed a `pathAliases` map aih deliberately lacks). **DROP** `doctor --fix` (duplicates aih's intentional diagnose/repair split; failing probes already print the exact fix command). **KEEP** only: (A) committed `.aih-config.json` root marker, (B) dirty-worktree `--apply` preflight. |
| **REG** — confidence scoring | **Drop sub-feature** | Spec already excludes it: "Do NOT add confidence scoring (no consumer)." Reviewer must reject it if it reappears. |
| **REG** — runtime-orchestration fields | **Hard-reject in review** | `dispatch/workboard/claimTasks/memory.backend/lifecycleEvents` — *aih is not an agent runtime.* Nothing consumes them. Gate this in REG's PR review. |
| **REG** — sandbox `--cli` threading | **v1-defer** | Spec marks `sandbox/templates.ts` as OPTIONAL/v1-deferred; keep sandbox Claude-centric until `--cli` threading lands. Drop from v1 if it grows. |
| **SCORE** — paniolo corpus breadth | **Already descoped (correct)** | ~5 aih-specific dimensions, not paniolo's 8 dims / ~100 corpus checks. Lock the scope; don't let it creep toward a general repo linter. |

No spec is dropped wholesale — all seven carry real value — but CONFIG loses two-thirds of its surface.

---

## 4. Single highest-leverage change to do FIRST

**LINT (canon markdown lint) — Wave 1, item 1.**

Reasons, in order:

1. **It ships aih's core promise.** aih's pitch is *weak-model-safe, resolvable context*. Today it generates ~15 markdown docs and verifies only that one shared block hasn't drifted — it never checks that the file paths it cites resolve, or that its prose avoids soft imperatives that confuse weak models. The single biggest credibility gap is that the tool doesn't validate the thing it exists to produce.
2. **Lowest effort, highest priority.** It's the only **S** that is also **high** priority. Fast, visible win.
3. **Zero dependencies, zero posture risk.** Read-only `probe` actions inside `bootstrap-ai --verify`; pure regex over already-generated *in-memory* strings + `existsSync`. No process spawn (so no Runner-seam / Windows `.cmd`-shim hazard), no new dependency, no AST, no LLM. Exit code flips only on hard `fail`.
4. **It's verified non-breaking.** The spec confirms aih's current generated canon already passes the fail-tier rules — so it locks in a regression guard without retroactively breaking CI.
5. **It establishes the read-only-probe-in-`--verify` muscle** that SARIF and SCORE reuse conceptually.

Concrete first PR: `src/lint/rules.ts` + `src/lint/run.ts`, wired into `bootstrapAiPlan` (lint `block.body`, **not** the merged file, so user hand-edits aren't policed) + a doctor section, with the regression-lock test asserting today's canon passes.

---

## 5. Cross-cutting risks & how the waves mitigate them

### A. Posture conflicts (the non-negotiable line)

- **Non-destructive vs. foreign config formats (REG/POLICY).** Codex uses TOML; aih has no TOML dep and deep-merging it risks clobbering a hand-tuned file. **Mitigation (already in REG/POLICY specs):** emit a *sidecar/doc* for TOML, never merge; JSON configs go through the existing `writeJson(..., {merge:true})` + `*.aih.bak` path. Wave-2 batching of REG+POLICY means the "sidecar-not-merge" decision is made once, consistently.
- **Advisory ≠ enforced (POLICY).** A deny lexicon only acts if the consuming CLI honors it. **Mitigation:** POLICY ships an explicit enforce/document per-CLI table + advisory banner; aih enforces only where a native seam exists (Claude `settings.json` permissions + sandbox managed settings) and documents everywhere else. Surface this honestly — it's a false-confidence risk in a tool that sells a license/safety gate.
- **`--gate`/exit-code discipline (LOAD/SARIF).** Both must flip exit code *only* through the existing `VerificationReport.exitCode()` / `alwaysVerify` path — **never** raw `process.exit` (isolint's reference does this; both specs deliberately do NOT lift it). **Mitigation:** add the explicit test that *over-budget without `--gate` still exits 0*, so bare `aih report` never breaks on unrelated panels.
- **Agent-runtime scope creep (REG).** Single biggest scope risk. **Mitigation:** REG's PR review hard-rejects any `dispatch/workboard/lifecycleEvents/memory.backend` field. Make this an explicit review checklist item, not a hope.

### B. Cross-platform (Win/Linux/macOS through the Runner seam)

- **No direct spawn; all git read-only via `gitRead` (SARIF/CONFIG).** SARIF's `ls-files`/`diff`/`rev-parse` and CONFIG's `status --porcelain` go through the async `ctx.run` seam — *not* `execFileSync` (isolint's reference spawns directly; not lifted). Keeps mocks able to intercept.
- **NUL-split + CRLF (SARIF/LINT).** `git ls-files -z` interior NULs survive `gitRead`'s trailing-whitespace trim, but verify with a path-with-spaces fixture (add `gitReadRaw` if it bites). LINT normalizes `\r\n→\n` on the doctor disk path; in-memory generated strings are already LF. **Mitigation:** both are called out as required test fixtures in Wave 1.
- **`.cmd` shim hazard is absent for all seven** because none of these specs spawn package managers — the load-bearing cross-platform work is "route reads through the seam," already the pattern.

### C. Test burden & golden-output drift

- **Golden `.mcp.json` drift is the top churn risk (REG/LOAD).** Threading `--cli` into mcp and switching the report headline to worst-case will move snapshots. **Mitigation:** keep the **default (claude) `.mcp.json` and `.claude/settings.json` byte-identical** and assert that golden; only multi-CLI/Codex/`--gate` runs differ. Batch REG+POLICY in Wave 2 so the `.claude/settings.json` two-writer churn lands once.
- **`SUPPORTED_CLIS` ordering (REG).** Deriving from `Object.keys(CLI_REGISTRY)` must preserve canonical order (detection, reports, fallback notice all depend on it). **Mitigation:** declare RAW in exact order + pin with a test; REG spec already calls for SIGNALS-migration parity snapshots.
- **Two-writer `.claude/settings.json` (POLICY + scaffold).** *Verified safe* — `deepMerge` does deduped array union and names `permissions.deny` as the accumulate case, so scaffold `Read()` + POLICY `Bash()` rules compose. **Mitigation:** the coordination test proving both survive the merge is mandatory, not optional.
- **License hygiene across the lifts.** Mixed licenses: canonical **LGPL-3.0**, RevealUI **FSL-1.1-MIT**, isolint **MIT**, LeanHarness **MIT** (the POLICY brief said Apache-2.0 — *it's MIT*, fix the attribution), blazity/paniolo/francove **unconfirmed**. **Mitigation:** re-express data models / field names, copy no function bodies, attribution comments per module; **confirm the unconfirmed licenses (paniolo, blazity, francove) before shipping any lifted constants** — gate this in each PR.

### How the wave ordering mitigates the above

- **Wave 1 front-loads the zero-spawn, zero-merge, read-only specs** (LINT/SARIF) so the team builds the probe + git-seam + SARIF muscles on low-risk surfaces before touching config-writing.
- **Wave 2 batches the two config-writing specs (REG+POLICY)** so all `.claude/settings.json` / per-tool config golden churn and the sidecar-not-merge decision happen together, once.
- **Wave 3 builds the aggregation layer (SCORE) last**, on top of *corrected* numbers, so the headline maturity grade isn't computed from the overcount LOAD/SARIF fix.

**First commit to write:** `src/lint/rules.ts` + `src/lint/run.ts`, wired into `bootstrap-ai --verify` against `block.body`, with the regression test asserting today's canon passes the fail-tier rules.
---

# Spec: Lint aih's own generated markdown for weak-model safety

Adopt a small deterministic subset of `@razroo/isolint`'s rules and run them on the
markdown aih *itself emits* (RULE_ROUTER, bootloaders, Kiro steering, scaffold context).
Surface findings as fail-closed `probe` actions inside `bootstrap-ai --verify`, plus a
matching `aih doctor` lint section — no new top-level command, no LLM, no dependency.

---

## 1. Gap status: **GAP (real, narrow, high-confidence)**

aih generates ~15 distinct markdown docs (`canon.ts`, `templates.ts`, `kiro/content.ts`)
and verifies exactly one property of them: that a bootloader's shared block has not
drifted (`bootloaderProbe` in `src/bootstrap-ai/index.ts:46`). It never validates that
the *content it ships* is internally consistent — that the file paths it names actually
exist, that its prose is weak-model-safe, or that scaffold skeletons got filled before a
re-run claims "in sync". Nothing in `src/` imports a markdown linter or runs one.

This matters because aih's whole value proposition is *provisioning weak/local-model-safe
context* (`adopt-design-ideas-additively` memory; the canon prose literally says "verify
against repo evidence … never model memory"). aih shipping its own prose with soft
imperatives or a dangling `#[[file:...]]` reference is a credibility hole the project
should not have. isolint is the exact tool for this and is MIT-licensed.

**Honest scoping after reading the code** — three things shrink the work:

1. **Most isolint rules don't apply to aih's hand-tuned canon.** `canon.ts` prose is
   already crisp ("MUST/ALWAYS/NEVER", imperative bullets, no `etc.`, no taste words). I
   grepped the generated strings: the behavioral-core and router prose would pass
   `soft-imperative`/`taste-word`/`trailing-etc` today. So those rules are valuable as a
   **regression guard on future edits**, not a backlog of current violations. Ship them,
   but don't expect them to fire now.

2. **The placeholder rule needs a precise carve-out, or it produces nothing but false
   positives.** aih's skeletons deliberately use `_italic placeholders_` and
   `_None detected — …_` (see `templates.ts:90`, `architectureDoc`/`tasksDoc`). isolint's
   `placeholder-leftover` (deterministic.js:1056) targets `TODO`/`FIXME`/`<insert X>`/
   `[INSERT X]`/`{{var}}` — **none of which aih emits**. So the rule is *safe* on aih's
   output (won't false-positive on `_italics_`) but also **won't catch aih's actual
   "unfilled skeleton" failure mode**. The real value is a *different* check: detect that
   `architecture.md`/`conventions.md` still contain the literal italic skeleton markers
   after setup. That is an aih-native heuristic, not a lift. See §4 rule `skeleton-unfilled`.

3. **`bootstrap-ai --verify` already has the perfect seam.** It's a `probe`-based
   drift gate today. Adding lint probes is additive and on-brand — no new posture.

So: **GAP for link/file-reference resolution and weak-model lint; PARTIAL→design-fresh for
the placeholder/skeleton angle** (the isolint rule as-is is a no-op on aih output; the
useful check is aih-specific).

---

## 2. What fits aih's posture

| Posture invariant | How this fits |
|---|---|
| Dry-run by default, `--verify` read-only | Lint runs as `probe` actions — read-only, contribute to the `VerificationReport`, flip exit code only on `fail`. Zero writes. |
| Never mutates remote | Pure local file reads + regex. No network, no spawn. |
| Cross-platform via Runner/host seam | **No Runner needed** — lint is pure string/regex over already-generated content + `existsSync` for ref resolution (same primitive `doctor.ts` and `bootloaderProbe` already use). No process spawn = no `.cmd`-shim hazard. |
| Many small files (200–400 lines) | New `src/lint/` dir: one file per concern (`rules.ts`, `run.ts`), each well under 400. |
| Match nearest peer | Probes mirror `bootloaderProbe`/`routerProbe` exactly (return `Check`, `verdict: pass|fail|skip`). |
| TS ESM + zod + vitest + biome | All. Lint config (if any) validated with zod like `config/settings.ts`. |

The one judgment call: **lint aih's own generated strings, not arbitrary user context
files.** Rationale below (§3) — keep the scope to "files aih authored this run" so a
false positive can never block a user whose hand-written context aih doesn't control.

---

## 3. Design decision: lint *generated content in-memory*, not files on disk

`bootstrap-ai` computes every doc as a string **before** writing (`ruleRouterDoc(...)`,
`sharedCanonicalBlockBody(...)`, etc. in `index.ts:115-162`). The cleanest, most
deterministic place to lint is **the generated string itself**, keyed by its target path,
*before* it becomes a `writeText` action. This means:

- Lint runs even in dry-run (no file needs to exist) — matches "diagnose by default".
- Ref-resolution (`#[[file:...]]`, RULE_ROUTER's `` `dir/...` `` paths) is checked against
  **the set of paths this same plan will write** + `existsSync` for pre-existing repo files.
  This is strictly better than isolint's repo-walk: aih *knows* exactly which files it's
  creating, so a forward reference to `ai-coding/rules/agent-behavior-core.md` resolves
  correctly even on a fresh repo where the file doesn't exist on disk yet.
- We do **not** lint user-owned files (`architecture.md` body after the human fills it,
  `tasks.md`). The one exception is the **`skeleton-unfilled` probe**, which is a
  `skip`-not-`fail` informational check (you can't fail a user for not having done setup).

**Where it lives:** `bootstrap-ai --verify` (primary) + surfaced in `aih doctor` (secondary,
read-only). **Not** a standalone `aih lint` — that would invite "lint any file", which
breaks the "aih provisions, doesn't police arbitrary content" boundary and duplicates
isolint itself (which the user can run directly if they want general linting).

---

## 4. The rule subset (smallest high-value set)

Ported/adapted from isolint `dist/lint/rules/deterministic.js`. Three buckets:

### Bucket A — reference resolution (the highest-value, aih-specific) — **LIFT + adapt**

- **`canon-ref-resolves`** — adapted from `missing-file-reference` (deterministic.js:950)
  and `stale-link-reference` (deterministic.js:633). aih's docs reference paths two ways:
  - Backtick paths: `` `ai-coding/RULE_ROUTER.md` ``, `` `ai-coding/rules/agent-behavior-core.md` ``
    (router, regeneration, harness-update docs).
  - Kiro live-refs: `#[[file:ai-coding/RULE_ROUTER.md]]` (`canon.ts:473`, `otherToolsDoc:419`).

  **Heuristic to port (cite deterministic.js:966):** the filename regex
  ```
  /(?<![\w\-./])([\w\-./]+\.(?:md|mdc|mdx|json|ya?ml|txt))\b/g
  ```
  Plus a Kiro-specific extractor for `#\[\[file:([^\]]+)\]\]`. Resolve each against
  `plannedPaths ∪ existsSync(join(root, ref))`. Skip `http(s)://`, `mailto:`, anchors.
  **Verdict:** `fail` (a dangling canon reference is a real defect aih can and should never
  ship). This is the rule that justifies the whole feature.

### Bucket B — weak-model prose safety (regression guard) — **LIFT verbatim (regex + word lists)**

Run only over the **prose aih authors** (router/core/adapter/Kiro-steering bodies), skipping
fenced code and inline backticks via a ported skip-interval pass.

- **`soft-imperative`** (deterministic.js:33) — word list verbatim:
  `should|could|might|may want to|consider|perhaps|probably|ideally|preferably`.
- **`taste-word`** (deterministic.js:99) — builtin list verbatim (creative/engaging/robust/
  seamless/holistic/…).
- **`ambiguous-deictic`** (deterministic.js:154) — regex verbatim
  (`the section above|section below|…`).
- **`enum-without-list`** (deterministic.js:267) — regex verbatim.
- **`trailing-etc`** (deterministic.js:334) — regex verbatim (`etc\.?|and so on|and such`).
- **`context-budget`** (deterministic.js:1005) — file-level word count; **info** at 1500,
  **warn** at 3000, strip code fences first. aih's docs are short, so this is a guard that a
  future edit doesn't bloat a bootloader past what a 7B model holds.

**Verdict for Bucket B:** `fail` would be too aggressive for `info`-tier rules. Map
isolint severity → aih verdict: isolint `warn`/`error` → `fail`; isolint `info` →
**`skip`** (surfaced in the report, never flips exit code). This keeps the gate honest:
only an unambiguous defect (soft imperative in shipped canon, dangling ref) fails CI.

### Bucket C — placeholder / skeleton — **DESIGN FRESH (isolint rule is a no-op here)**

- **`skeleton-unfilled`** — aih-native, NOT an isolint lift. Detect that a *scaffolded*
  context file still carries the literal skeleton sentinels aih emits:
  - italic placeholders: `/^_.*_$/m` on a line, e.g. `_Expand: what this system does…_`
  - `_None detected — …_`, `_No lint/test command detected…_`
  These strings come straight from `templates.ts` (`architectureDoc`, `conventionsDoc`,
  `projectGuardrailsDoc`). **Verdict: `skip`** with detail "context not yet filled — run
  SETUP-TASKS.md". This is the check `templates.ts`'s own `VALIDATION.md` step 2 tells the
  human to do by eye (`templates.ts:273`) — we automate the eyeball.
  - It only runs when the file **exists on disk** (i.e. a prior `--apply` scaffolded it),
    so a dry-run on a fresh repo doesn't report it.
- We DO port isolint's `placeholder-leftover` regexes (deterministic.js:1065/1074/1083) into
  the same rule module as a **belt-and-suspenders fail** for `TODO|FIXME|<insert X>|[INSERT X]`
  — these should *never* appear in aih's generated output, so if one ever does (a future
  template bug), it's a hard `fail`. Today it catches nothing, which is correct.

**Explicitly dropped** (don't port): `numbered-step-gap`, `step-without-verb`,
`heading-without-imperative`, `dangling-variable-reference`, `undefined-step-reference`,
`invalid-json-fence`, `table-column-mismatch`, `mixed-list-marker`, `long-sentence`,
`nested-conditional`, `output-format-no-example`, `word-count-target`, `vague-quantifier`,
`double-negation`, `pronoun-no-antecedent`, `heading-hierarchy`, `implicit-conditional`,
`multiple-output-formats`. Reason: aih's generated docs are not step/prompt harnesses with
`$input.X` vars or JSON fences, have no tables/numbered procedures in the linted bodies, and
the AST-dependent rules would force porting isolint's whole `ast.js` (`mdast`/`unified`
dependency) — a disproportionate cost for zero current signal. If a future doc grows a table
or JSON example, revisit. **Keep the port regex-only; do not add an mdast dependency.**

---

## 5. File-level change list

### New: `src/lint/rules.ts` (~220 lines) — the ported regex rules

Mirrors the data-driven shape of isolint but trimmed to Buckets A–C. No AST, no sentence
tokenizer beyond a tiny skip-interval helper (port the *concept* from `source.js`, ~25 lines,
not the file).

```ts
// src/lint/rules.ts
/**
 * Deterministic weak-model-safety lint for aih's OWN generated markdown.
 * Ported from @razroo/isolint v1.4.1 (MIT) — deterministic.js rules
 * soft-imperative, taste-word, ambiguous-deictic, enum-without-list,
 * trailing-etc, context-budget, missing/stale-file-reference, placeholder-leftover.
 * Regex/word-lists lifted verbatim; reference resolution adapted to aih's
 * planned-path model (it knows what it will write).
 */
import { z } from "zod";

export type LintSeverity = "fail" | "info"; // info → report-only (maps to Check skip)

export interface LintFinding {
  ruleId: string;
  severity: LintSeverity;
  message: string;
  /** byte offset for snippet context (optional, for detail string). */
  index?: number;
}

/** Build skip intervals: fenced code blocks, inline code, HTML comments.
 *  Ported concept from isolint source.js computeSkipIntervals. */
export function skipIntervals(src: string): Array<[number, number]> { /* … */ }

/** A rule is (path, source) -> findings. `plannedPaths`/`fileExists` injected for refs. */
export interface LintRule {
  id: string;
  appliesTo: (path: string) => boolean; // e.g. only prose docs for Bucket B
  run: (src: string, ctx: LintRuleCtx) => LintFinding[];
}

export interface LintRuleCtx {
  path: string;
  plannedPaths: ReadonlySet<string>;       // canonical (posix) paths this plan will write
  fileExists: (relPath: string) => boolean; // existsSync(join(root, p)) wrapper
}

// Word lists lifted verbatim from deterministic.js
const SOFT = ["should","could","might","may want to","consider","perhaps","probably","ideally","preferably"];
const TASTE = ["creative","engaging","appropriate","polished","natural","nice","good","great",/* …deterministic.js:112 */];

export const RULES: LintRule[] = [ /* canonRefResolves, softImperative, tasteWord, … */ ];
```

### New: `src/lint/run.ts` (~90 lines) — turn rules into aih `probe` actions

```ts
// src/lint/run.ts
import { existsSync } from "node:fs";
import { join } from "node:path";
import { type Action, type PlanContext, probe } from "../internals/plan.js";
import type { Check } from "../internals/verify.js";
import { RULES, type LintRuleCtx } from "./rules.ts";

/** One probe per linted file. fail-tier findings → fail; info-tier → skip (report-only). */
export function lintProbes(
  generated: ReadonlyArray<{ path: string; source: string }>,
  plannedPaths: ReadonlySet<string>,
  root: string,
): Action[] {
  return generated.map(({ path, source }) =>
    probe(`lint ${path}`, (_ctx: PlanContext): Check => {
      const rctx: LintRuleCtx = {
        path,
        plannedPaths,
        fileExists: (p) => existsSync(join(root, p)),
      };
      const findings = RULES.filter((r) => r.appliesTo(path)).flatMap((r) => r.run(source, rctx));
      const fails = findings.filter((f) => f.severity === "fail");
      const infos = findings.filter((f) => f.severity === "info");
      if (fails.length > 0) {
        return { name: `lint ${path}`, verdict: "fail",
          detail: fails.map((f) => `${f.ruleId}: ${f.message}`).join("; ") };
      }
      if (infos.length > 0) {
        return { name: `lint ${path}`, verdict: "skip",
          detail: infos.map((f) => `${f.ruleId}: ${f.message}`).join("; ") };
      }
      return { name: `lint ${path}`, verdict: "pass", detail: "weak-model-safe" };
    }),
  );
}
```

### Edit: `src/bootstrap-ai/index.ts` — wire lint probes into the plan

In `bootstrapAiPlan`, after building the doc strings, collect them with their paths and the
planned-path set, then push the lint probes alongside the existing `routerProbe`/
`bootloaderProbe`. Peer to mirror: the existing probe-append block at `index.ts:192-194`.

```ts
// after the actions array is assembled, before pushing existing probes:
const plannedPaths = new Set(
  actions.filter((a): a is WriteAction => a.kind === "write").map((a) => a.path),
);
const generated = actions
  .filter((a): a is WriteAction => a.kind === "write" && typeof a.contents === "string")
  .map((a) => ({ path: a.path, source: a.contents as string }));

actions.push(routerProbe(dir));
for (const relPath of bootloaders) actions.push(bootloaderProbe(relPath, dir));
for (const cli of clis) actions.push(presenceProbe(cli));
actions.push(...lintProbes(generated, plannedPaths, ctx.root)); // NEW
```

This lints RULE_ROUTER, the shared block source, agent-behavior-core, every adapter note,
REGENERATION, harness-update, every bootloader (the merged preamble+block string), and the
Kiro `agent-tools.md` steering — exactly the surface aih authors. `canon-ref-resolves` now
sees `plannedPaths` so `#[[file:ai-coding/RULE_ROUTER.md]]` and the backtick paths resolve.

### Edit: `src/doctor.ts` — add a read-only lint section (secondary surface)

`doctor` is `readOnly` and can't recompute the plan, so its lint probe reads the **already-
written** canon files from disk (`readIfExists`) and lints them, resolving refs against
`existsSync`. One probe summarizing the canon dir; mirror the existing `canonical context dir`
probe at `doctor.ts:51`. `skip` if the dir isn't scaffolded (don't fail a fresh repo).

```ts
probe("canon markdown lint", () => {
  const dir = join(ctx.root, ctx.contextDir);
  if (!existsSync(dir)) return { name: "canon-lint", verdict: "skip", detail: "not scaffolded" };
  // read RULE_ROUTER.md + adapters/* + rules/* from disk, run RULES, aggregate
  // fail → fail; info/skeleton → skip with detail
});
```

### New tests (vitest): `tests/lint/rules.test.ts`, `tests/bootstrap-ai/lint.test.ts`

(Project uses `tests/` not `test/`; mirror `tests/doctor.test.ts` ctx shape.)

---

## 6. What to LIFT vs design fresh

| Item | Source | Action | License |
|---|---|---|---|
| `soft-imperative` word list + regex builder | deterministic.js:51-52 | **Lift verbatim** | MIT — attribute in file header |
| `taste-word` builtin list | deterministic.js:112-137 | **Lift verbatim** | MIT |
| `ambiguous-deictic` regex | deterministic.js:160 | **Lift verbatim** | MIT |
| `enum-without-list` regex | deterministic.js:273 | **Lift verbatim** | MIT |
| `trailing-etc` regex | deterministic.js:347 | **Lift verbatim** | MIT |
| `context-budget` thresholds + strip logic | deterministic.js:1014-1020 | **Lift verbatim** | MIT |
| `placeholder-leftover` keyword/angle/square regexes | deterministic.js:1065/1074/1083 | **Lift verbatim** (belt-and-suspenders fail) | MIT |
| filename regex for ref resolution | deterministic.js:966 | **Lift, adapt** resolution to planned-paths | MIT |
| skip-interval concept (fenced/inline/comment) | source.js `computeSkipIntervals` | **Port concept** (~25 lines), not the file | MIT |
| Kiro `#[[file:...]]` extractor | — | **Design fresh** (aih-specific) | n/a |
| planned-path resolution model | — | **Design fresh** (aih knows its writes) | n/a |
| `skeleton-unfilled` (`_italics_` detector) | — | **Design fresh** (isolint rule no-ops on aih) | n/a |
| `LintRule`/`Check` glue, probe wiring | mirror `bootloaderProbe` | **Design fresh** to aih's `Action`/`Check` model | n/a |

**Attribution:** add to `src/lint/rules.ts` header: `Ported from @razroo/isolint v1.4.1
(MIT, https://github.com/razroo/isolint) — regex rules and word lists.` Add isolint to a
NOTICE/THIRD-PARTY section if the repo keeps one (check before shipping; OSS license type
for aih itself is still OPEN per the `oss-open-decisions` memory — keep attribution
self-contained in the file header so it's correct regardless).

Do **not** add `@razroo/isolint` as a runtime dependency — porting ~10 regexes avoids a
dep, an mdast transitive tree, and a version-coupling. This is a deliberate copy, licensed.

---

## 7. Effort / priority / risks

**Effort: S–M.** ~310 new lines across two small files + ~15-line edit to `bootstrap-ai`
+ ~12-line edit to `doctor` + tests. No new dependency, no Runner/host work, no AST. The
hard part is getting `canon-ref-resolves` correct against the planned-path set; everything
else is verbatim regex.

**Priority: HIGH** for `canon-ref-resolves` (a dangling canon reference is a shipped defect
in aih's core output and a CI gate catches it for free); **MED** for the Bucket B prose
guard (regression value, fires rarely now); **MED** for `skeleton-unfilled` (automates the
VALIDATION.md eyeball). Bundle them — the framework is shared.

**Risks**
- *False positives blocking a real run.* Mitigated: only `fail`-tier rules (refs +
  placeholder-leftover + soft/taste in shipped canon) flip the exit; `info`/skeleton are
  `skip`. And aih's current canon passes the fail-tier rules (verified by reading the
  generated strings), so turning this on does not retroactively break `--verify`.
- *Ref regex matching prose words that look like filenames* (e.g. "package.json" in a
  sentence). Mitigated by the `(?<![\w\-./])` boundary lifted from isolint and by resolving
  against planned-paths first; an unresolved ref in a sentence is genuinely worth flagging
  anyway. If noise appears, scope `canon-ref-resolves` to backtick-wrapped and `#[[file:]]`
  refs only (stricter, near-zero false positive).
- *CRLF / offset drift on Windows.* aih's render helpers emit LF; markers.ts normalizes
  CRLF. Lint reads the in-memory generated string (always LF) in `bootstrap-ai`, and on the
  `doctor` disk path, normalize `\r\n`→`\n` before regex (one line). Cross-platform safe.
- *Linting the merged bootloader string* (preamble + user hand-edits outside markers) could
  flag a user's prose. Mitigated: lint **only the generated managed-block body**, not the
  whole merged file — pass `block.body`, not `merged`, for bootloader entries. (Adjust the
  `generated` collection accordingly: for bootloader paths, push `block.body` not `merged`.)

---

## 8. Test plan (vitest)

`tests/lint/rules.test.ts` (AAA, mirrors isolint's own rule tests in spirit):
- `soft-imperative`: asserts "you should validate" → one `fail` finding; "Validate the
  input" → zero. Asserts a `should` **inside a fenced code block is skipped** (skip-interval).
- `taste-word`: "write engaging prose" → finding; same word inside backticks → none.
- `trailing-etc` / `enum-without-list` / `ambiguous-deictic`: one positive + one
  code-fence-negative each.
- `context-budget`: a 3100-word fixture → `info`/report-tier; a 200-word doc → none; assert
  fenced code is stripped before counting.
- `canon-ref-resolves`:
  - `` `ai-coding/RULE_ROUTER.md` `` with that path in `plannedPaths` → pass (no finding).
  - `#[[file:ai-coding/MISSING.md]]` not planned and not on disk → `fail` finding.
  - `https://example.com/x.md` → ignored (no finding).
  - a ref present on disk via `fileExists` but not in `plannedPaths` → resolves (no finding).
- `placeholder-leftover`: `<insert role>` → `fail`; aih's real `_italic placeholder_` →
  **no finding** (proves the carve-out: the rule does not fire on aih's intentional sentinels).
- `skeleton-unfilled`: `architectureDoc(...)` output (contains `_Expand: …_`) → one `skip`
  finding; a filled doc with no italic-only lines → none.

`tests/bootstrap-ai/lint.test.ts` (mirrors `tests/doctor.test.ts` ctx + `findProbe`):
- Build the real plan via `command.plan(ctx)`; assert `lint ai-coding/RULE_ROUTER.md` probe
  exists and **passes** on the current canon (regression lock: today's generated prose is
  clean — if a future edit adds a soft imperative, this test goes red).
- Assert there is a lint probe for every generated doc path (count matches write actions
  with string contents, minus user-owned merged bootloader files which lint `block.body`).
- Inject a stubbed rule / craft a fixture proving a dangling `#[[file:]]` ref produces a
  `fail` verdict and a non-zero `report.exitCode()`.
- `doctor` lint probe: `skip` when context dir absent; `pass`/`fail` aggregation when present.

Coverage target ≥80% on `src/lint/*` (matches project testing rule).

---

## 9. One-paragraph summary for the lead

aih generates ~15 markdown docs and verifies only that one block hasn't drifted; it never
checks that the paths it cites resolve or that its prose is weak-model-safe. Port a 10-rule
regex subset of isolint (MIT) into `src/lint/`, run it as `probe` actions inside
`bootstrap-ai --verify` (lint the in-memory generated strings against the set of paths the
same plan will write, so forward refs resolve on a fresh repo) and a read-only section in
`aih doctor`. Hard-fail only on dangling canon references + leftover `<insert>`/`TODO`
sentinels + soft imperatives in shipped canon; everything else is report-only `skip`. The
isolint `placeholder-leftover` rule is a deliberate no-op on aih's `_italic_` skeletons, so
add an aih-native `skeleton-unfilled` check instead. No new dependency, no Runner/AST,
no LLM — pure regex over content aih already authored. S–M effort, HIGH value on the
reference rule.

---

# Spec: Per-tool-load-group token model + CI budget gate for `aih report`

## 1. Problem & current state (verified against aih source)

`scanContextBloat` in `D:/dev/ai-harness/src/report/bloat.ts` builds one flat set
of context files:

```
const rels = new Set<string>(ROOT_CONTEXT_FILES);   // CLAUDE.md + AGENTS.md + GEMINI.md
                                                     // + .windsurfrules + .github/copilot-instructions.md
for (const dir of [contextDir, ...EXTRA_CONTEXT_DIRS]) { ... walk ... }  // .ai-context/** + .cursor/rules/**
...
const totalTokens = files.reduce((n, f) => n + f.tokens, 0);             // SUMS ALL of them
return { ..., totalTokens, overBudget: totalTokens > budgetTokens };
```

Two confirmed gaps (the lead's read is correct):

1. **Overcount.** `totalTokens` sums *every* root bootloader. No single tool loads
   all of them. Claude loads only `CLAUDE.md`; Cursor loads only `.cursor/rules/*.mdc`;
   Copilot loads only `.github/copilot-instructions.md`. The reported per-turn cost
   is the union of mutually-exclusive load groups — strictly an overestimate of any
   real tool's footprint. This is exactly the failure mode isolint's `groupByTool`
   (`dd/_razroo_isolint/dist/cli/cost.js:74-137`) fixes: "You pay ONE group's bundle
   per turn, not all of them summed together."

2. **No gate.** `--budget` exists (`src/report/index.ts:202-205`, parsed at
   `budgetOf`, line 28) but `overBudget` only decorates the headline string
   (`contextHeadline`, line 33-36: `" — OVER budget"`). The plan emits a `digest`
   action; `report` is NOT `readOnly`/`alwaysVerify`, has no `probe`, so a bloated
   repo still exits 0. There is no CI-usable failing exit.

### The decisive advantage aih has over isolint

isolint *guesses* the file→tool mapping with regexes (`CLAUDE_FILE_RE`,
`AGENTS_MD_RE`, `CURSOR_RULE_RE`, …) and falls back to an `iso/instructions.md`
stand-in. **aih does not need to guess** — it *writes* the bootloaders, and the
authoritative file→tool map already exists in the repo:

`D:/dev/ai-harness/src/bootstrap-ai/canon.ts:435` —
```ts
const CLI_BOOTLOADERS: Record<Cli, string[]> = {
  claude:      ["CLAUDE.md"],
  codex:       ["AGENTS.md"],
  opencode:    ["AGENTS.md"],
  zed:         ["AGENTS.md"],
  kimi:        ["AGENTS.md"],
  antigravity: ["AGENTS.md", "GEMINI.md"],
  gemini:      ["GEMINI.md"],
  cursor:      [".cursor/rules/00-canon.mdc"],
  windsurf:    [".windsurfrules"],
  copilot:     [".github/copilot-instructions.md"],
  kiro:        [".kiro/steering/00-canon.md"],
};
```

This is the "capability-registry candidate's file→tool map" the task warns about.
**The coupling is already satisfied** — `CLI_BOOTLOADERS` is the registry. We make
it the single source of truth shared by `bootstrap-ai` (writes) and `bloat`
(measures). No new registry needs to be invented for this candidate; we only need
to (a) export it and (b) decide how the *shared context dir* attributes to groups.

## 2. gap_status: **partial → gap**

- The per-tool-load-group model is a **genuine gap**. `bloat.ts` has no notion of
  load groups; it sums everything. Real work.
- The gate is a **genuine gap**. `--budget` is informational only; no probe, no exit.
- BUT the dependency the task flags as a risk ("depends on capability-registry
  candidate for the file->tool map") is **already-done**: `CLI_BOOTLOADERS` exists
  and is exact. So scope DOWN on that axis — do not build a registry.

Net: implement (1) load-group footprint + worst-case headline, (2) an opt-in gate
probe. Reuse the existing map. Keep chars/4 as the only estimator (offline-safe).

## 3. Design: shared-dir attribution (the one real modeling decision)

isolint only models the *shared-prefix root files* per group; it has no equivalent
of aih's `.ai-context/**` canon tree (RULE_ROUTER, adapters, rules). In aih, EVERY
tool's bootloader is a thin preamble + a managed block that points into
`.ai-context/`. The router/adapters are loaded *on demand by the agent following a
pointer*, not auto-injected every turn. So:

**Per-turn footprint of tool group G = sum(tokens of G's bootloader files only).**
The `.ai-context/**` tree and `.cursor/rules/**` non-canon files are reported as a
separate **"on-demand canon"** bucket (informational), NOT folded into the per-turn
worst-case number. This matches isolint's split of `shared` (always-loaded) vs
`modes`/`agents` (conditional), and matches aih's own REGENERATION model where the
bootloader is the always-loaded surface.

Caveat to surface in a `note` (mirroring isolint's Cursor `alwaysApply` note):
Cursor `.mdc` and Kiro steering files with `inclusion: always` frontmatter *are*
always-loaded. We attribute the single canon bootloader (`00-canon.mdc` /
`00-canon.md`) to the group (it carries the managed block) and put any *other*
`.cursor/rules/*.mdc` into the on-demand bucket with a note that frontmatter-aware
counting is not yet implemented — verbatim-adapt isolint's caveat wording.

Worst-case headline = `max over groups present of group.tokens`. A group is
"present" if at least one of its bootloader files exists on disk (so a repo that
only ran `bootstrap-ai --cli claude` reports just the Claude group).

## 4. What to LIFT vs design fresh

### Lift (with attribution)
isolint (`@razroo/isolint`) — check its `package.json` license before copying; the
dist is on local disk only. Treat as **design-lift, not verbatim code** unless the
license is MIT/Apache (then a short attribution comment is sufficient). The
*algorithm and structure* are the value, not the bytes:

| From | What | Verbatim OK? |
|---|---|---|
| `cost.js:74-176` `groupByTool` + `computeCost` | The load-group reducer + worst-case selection algorithm. Reshape to aih's `Cli`/`CLI_BOOTLOADERS` (no regex guessing). | No — re-author against aih types. Cite as design source. |
| `cost.js:35-37` `approxTokens = ceil(len/4)` | Identical to aih's existing `estimateTokens` (`bloat.ts:77`). Already present — keep aih's. | N/A — already in aih. |
| `cost.js:123,133` Cursor `alwaysApply` / stand-in `note` strings | The caveat wording for frontmatter-aware caveats. | Adapt wording, not load-bearing. |
| `performance.js:417-432` `perfSharedPrefixBudget` (1500-word threshold; "split stable core from on-demand reference") | Secondary signal: a per-file "this bootloader is heavy" warning. | Adapt threshold + message. |
| `_francove_create-ai-harness/bin/cli.js:282-336` `runMetrics` | Per-file line-budget rubric: `.ai total>250`, `largest>80`, `ACTIVE_TASK>8`, `score: good|needs review`, named-offender warnings. MIT-style (verify). | Adapt the rubric numbers + the good/needs-review verb, re-authored for `.ai-context/`. |

### Design fresh
- The `LoadGroup` shape + group-from-`CLI_BOOTLOADERS` builder (aih-specific).
- The gate probe (aih's `Check`/`VerificationReport` model — isolint uses a raw
  `process.exit`, which violates aih's seam discipline).
- Shared-dir on-demand bucket split.

## 5. aih file-level change list

Nearest peer to mirror throughout: `src/report/bloat.ts` (pure size scan, no
content reads, deterministic sort) and `src/doctor.ts` (probe-driven gate).

### 5a. EDIT `src/bootstrap-ai/canon.ts` — export the map
`CLI_BOOTLOADERS` is currently module-private. Export it (and keep `bootloaderPaths`
using it) so `bloat.ts` consumes the *same* source of truth. One-line change:

```ts
/** The root bootloader file(s) each CLI reads, in canonical path form. */
export const CLI_BOOTLOADERS: Record<Cli, string[]> = { /* unchanged */ };
```

Rationale: avoids drift between what bootstrap-ai *writes* and what bloat *measures*.
This is the entire "registry coupling" — one `export` keyword.

### 5b. NEW `src/report/loadgroups.ts` (~120 lines) — the model
Mirror `bloat.ts` conventions (POSIX rels, `fileSize` only, deterministic sort,
chars/4). Reuse `bloat.ts`'s `ContextFile` + size helpers (export them from
`bloat.ts` or move the shared helpers — prefer exporting `estimateTokens` and a
`fileFootprint(root, rel)` helper to keep one tokenizer).

```ts
import { CLI_BOOTLOADERS } from "../bootstrap-ai/canon.js";
import { SUPPORTED_CLIS, type Cli } from "../internals/clis.js";
import { type ContextFile, fileFootprint } from "./bloat.js";

/** One tool's always-loaded per-turn footprint (its bootloader files only). */
export interface LoadGroup {
  /** Tools that share this bootloader set (e.g. codex+opencode+zed+kimi → AGENTS.md). */
  clis: Cli[];
  /** Human label, e.g. "Claude Code (CLAUDE.md)" / "AGENTS.md convention (codex, opencode, zed, kimi)". */
  label: string;
  files: ContextFile[];
  tokens: number;
  bytes: number;
  /** Present iff ≥1 file exists on disk. Absent groups are excluded from worst-case. */
  present: boolean;
  note?: string;
}

export interface LoadGroupModel {
  groups: LoadGroup[];                 // sorted: present desc-by-tokens, then label
  worst: LoadGroup | null;             // heaviest PRESENT group
  worstTokens: number;                 // 0 when nothing present
  budgetTokens: number;
  overBudget: boolean;                 // worstTokens > budgetTokens  ← gate input
  onDemandFiles: ContextFile[];        // .ai-context/** + non-canon .cursor/rules/** (informational)
  onDemandTokens: number;
}

export function scanLoadGroups(
  root: string,
  contextDir: string,
  budgetTokens: number,
): LoadGroupModel { /* group CLIs by identical bootloader-set; sum each group's
                      existing files; pick heaviest present; collect on-demand. */ }
```

Grouping detail: invert `CLI_BOOTLOADERS` by stringified file-set so
codex/opencode/zed/kimi collapse into one `AGENTS.md` group (matches isolint's
single "AGENTS.md convention" group). `antigravity` (AGENTS.md + GEMINI.md) is its
own group. Label lists the member CLIs.

### 5c. EDIT `src/report/bloat.ts` — keep but re-anchor
Keep `scanContextBloat` for the full inventory (still useful as the "everything on
disk" view and for the existing largest-contributors list). Export `estimateTokens`
+ add `fileFootprint(root, rel): ContextFile | undefined`. Do NOT delete — the HTML
dashboard's largest-contributors list and JSON consumers depend on the full set.

### 5d. EDIT `src/report/render.ts` — render groups
Add `loadGroupDigest(model: LoadGroupModel): string` beside `contextBloatDigest`.
Mirror isolint's `formatToolGroups` layout (per-group token/turn, member files,
worst-case line) but in aih's `lines()` style. Surface the on-demand bucket as a
trailing informational block. Keep numbers locale-independent via `thousands`.

### 5e. EDIT `src/report/index.ts` — headline, gate flag, gate probe
1. Replace `contextHeadline(bloat)` headline math with the worst-case group number:
   `Per-turn context — ~${worstTokens} tokens (worst tool: ${worst.label}) across N tools`.
2. Add the digest from `loadGroupDigest`.
3. Add `--token-budget <tokens>` and `--gate` options (keep `--budget` as a
   deprecated alias mapping to the same value — do not break the existing flag).
4. When `--gate` is set, push a **probe** so the existing verify→exitCode path runs:

```ts
if (ctx.options.gate === true) {
  actions.push(
    probe("per-turn token budget", () =>
      model.overBudget
        ? { name: "token-budget", verdict: "fail",
            detail: `worst tool ${model.worst?.label} ~${model.worstTokens} tok > budget ${model.budgetTokens}` }
        : { name: "token-budget", verdict: "pass",
            detail: `worst tool ~${model.worstTokens} tok ≤ budget ${model.budgetTokens}` }),
  );
}
```

For the probe to drive the exit code on an otherwise-non-readOnly command, set the
command flag `alwaysVerify: true` ONLY when `--gate` is present, OR (cleaner) add
`alwaysVerify: true` unconditionally to `report` — but that changes default exit
semantics for all reports. **Decision: gate behind `--gate` by making the probe
present only with `--gate`, and add `alwaysVerify: true` to the `report`
CommandSpec.** A bare `aih report` emits only digests (no probes) so `alwaysVerify`
is a no-op; with `--gate` the single probe runs and `VerificationReport.exitCode()`
returns 1 on breach. This is exactly how `heal` uses `alwaysVerify` (plan.ts:162-168)
— cite that as the precedent. Confirm in `src/commands/run.ts` that a verify report
with a failing probe already flips the process exit (it does — that's the drift gate
path for `bootstrap-ai --verify`).

CI usage: `aih report --gate --token-budget 12000` → exit 1 when the worst tool's
bootloader exceeds 12k tokens. Dry-run safe (digests + one probe, zero writes).

### 5f. (Optional, secondary) per-file line rubric
Add `src/report/canon-rubric.ts` adapting francove's `runMetrics` for `.ai-context/`:
flag `largest file > 80 lines`, `ACTIVE_TASK-equivalent` if present, total canon
lines. Emit as a `digest` (informational `score: good | needs review` + named
offenders). This is the "secondary signal" — keep it out of the gate (line budgets
are softer than the token budget).

## 6. Effort / priority / risks

- **effort: M.** Two files of real logic (loadgroups + render), three edits, one
  export, one probe, tests. The map already exists, which removes the hardest part.
- **priority: high.** The current headline is a *wrong number* in the product's
  flagship `report`/dashboard, and the missing gate is the difference between a
  toy and a CI control. Both are credibility issues.

### Risks
1. **Behavior change to the headline.** Existing snapshot tests / demo data assert
   the old summed total. Must update `demo.ts` and any `report` snapshot. Mitigate:
   keep the full-inventory total available in `--json` under a `contextBloat` key;
   add the new model under `loadGroups`.
2. **Shared-dir attribution is a judgment call.** If a reviewer believes the canon
   tree IS always-loaded for some tool, the worst-case undercount could be argued.
   Mitigate: the on-demand bucket is shown explicitly and the note states the
   assumption; a follow-up can read `inclusion: always` frontmatter (isolint defers
   the same thing for `.mdc`).
3. **`alwaysVerify` on `report`.** Must verify it does not make bare `aih report`
   start exiting non-zero from unrelated `--team`/org panels (those emit digests,
   not probes — safe). Add a test asserting `aih report` (no `--gate`) exits 0 even
   when over budget, and only `--gate` flips it.
4. **Circular import.** `report/loadgroups.ts` importing `bootstrap-ai/canon.ts`:
   confirm `canon.ts` does not import from `report/`. (It does not — canon.ts imports
   render/clis/markers only.) Keep the import one-directional.
5. **chars/4 honesty.** Keep the existing "estimate, bytes/4" disclaimer in the
   render (bloat.ts already says it). Justified offline fallback per the posture.

## 7. Test plan (vitest — mirror existing `src/report/*.test.ts` shape)

`src/report/loadgroups.test.ts`:
- **groups collapse correctly**: a fixture root with `AGENTS.md` present → the
  AGENTS.md group lists `codex, opencode, zed, kimi` and `antigravity` is its own
  group; assert `groups` membership.
- **worst-case excludes absent groups**: only `CLAUDE.md` on disk (10k tok) →
  `worst.clis` includes `claude`, `worstTokens === CLAUDE.md tokens`, AGENTS/Cursor
  groups `present === false`.
- **worst-case picks the heaviest present group**: `CLAUDE.md` (4k) +
  `.github/copilot-instructions.md` (9k) → `worstTokens` = copilot's 9k, not the
  12k sum.
- **overBudget gates on worst, not sum**: budget 10k, CLAUDE 4k + copilot 9k +
  windsurf 8k (sum 21k) → `overBudget === false` (max 9k ≤ 10k). Asserts the whole
  point: summing would falsely fail.
- **on-demand bucket**: `.ai-context/RULE_ROUTER.md` is in `onDemandFiles`, not in
  any group's `files`, and not in `worstTokens`.
- **empty repo**: no files → `worst === null`, `worstTokens === 0`,
  `overBudget === false`.
- **chars/4 estimate**: a file of known byte length N → `tokens === ceil(N/4)`.

`src/report/index.test.ts` (extend existing):
- **`--gate` over budget → fail probe**: build plan with a fixture over budget +
  `--gate`; assert a `probe` action named `token-budget` exists and its `run`
  yields `verdict: "fail"`.
- **`--gate` within budget → pass probe**: yields `verdict: "pass"`.
- **no `--gate` → no probe, exit 0 even over budget**: assert no `token-budget`
  probe in the plan; (integration) `VerificationReport` empty → exit 0.
- **`--budget` alias still parses**: `--budget 5000` sets the same budget as
  `--token-budget 5000` (back-compat).
- **dry-run invariant**: plan with `--gate` contains zero `write`/`exec` actions
  (only digests + the one probe).

`src/report/render.test.ts`:
- `loadGroupDigest` output is byte-stable (no dates, comma-grouped, deterministic
  sort) and contains the worst-case line + on-demand bucket.

## 8. Posture fit

- **dry-run by default**: model is pure read (sizes only); gate is a probe, runs
  under the existing verify path; no writes. ✓
- **no remote mutation**: pure local fs `statSync`. ✓
- **cross-platform**: POSIX rel paths already normalized in `bloat.ts`; no spawning. ✓
- **TS ESM + zod + commander**: new options via the existing `CommandSpec.options`;
  no new zod schema needed (numeric budget parsed like `budgetOf`). ✓
- **many small files**: loadgroups + render + optional rubric kept under ~150 lines
  each. ✓
- **drift-gate consistency**: reuses `VerificationReport.exitCode()` + `alwaysVerify`,
  the exact mechanism `bootstrap-ai --verify` and `heal` already use. ✓

---

# Spec: gitignore-honoring scan + SARIF emission + `--since` changed-files

Candidate: adopt three scan-hygiene/DevSecOps capabilities from `@razroo/isolint` (MIT, v1.4.1)
into aih's report-bloat / secrets-scan / verify paths.

Status: **GAP** on all three sub-features after reading aih's actual code. Nothing here is
redundant. Scope is real but bounded; the host-runner seam and plan/probe model already exist,
so the work is additive plumbing, not new architecture.

---

## 0. Grounding — what aih does today (confirmed by reading source)

| Surface | File | Current behavior | Gap |
|---|---|---|---|
| Context footprint | `src/report/bloat.ts` | `walk()` via `readdirSync`/`statSync`; no gitignore. Walks `contextDir` + `.cursor/rules` + root bootloaders. | Counts generated per-tool copies AND ignored files. Double-counts: aih compiles ONE canon → N per-CLI adapters; both the source and the generated copy live under scanned trees. |
| Secret scan | `src/secrets/scan.ts` | `visit()` via `readdirSync`/`statSync`, depth 1; no gitignore. | Would flag a `.env` that's already gitignored as if exposed (it IS exposed on disk, so this is arguably correct — see §2 nuance) but cannot distinguish tracked vs ignored. |
| Drift / verify gate | `src/bootstrap-ai/index.ts` (`bootloaderInSync` probe), `src/doctor.ts` | Probes return `Check{verdict}`; `executePlan` folds them into a `VerificationReport`; `run.ts` maps `report.exitCode()` to process exit. Output is text or `--json` (`PlanResult` shape). | No SARIF. README markets CI gates + wires CodeQL but emits nothing GitHub code-scanning can ingest. |
| `--since <ref>` | none | No changed-files filter anywhere. | Full scan every CI run; no fast PR path. |
| Runner seam | `src/internals/proc.ts` (`Runner`), `src/internals/git.ts` (`gitRead`/`gitInt`) | `gitRead(ctx, args)` runs `git -C root …` through `ctx.run`, returns trimmed stdout or `undefined`. Async. | Present and correct — reuse it. Do NOT call `execFileSync` like isolint does. |

Key architectural fact that shapes the design: **`scanContextBloat` and `scanSecrets` are
synchronous pure functions.** `bloat.ts` is also called synchronously from
`src/report/history.ts:80` (`scanContextBloat(ctx.root, ctx.contextDir).totalTokens`). The git
allowlist requires the **async** Runner. Therefore we must NOT make the scan functions async.
Instead: compute the allowlist async in the caller (which already has `ctx`), then pass an
optional path-predicate into the still-sync scanners. This keeps both functions pure, keeps
the existing sync call sites compiling, and keeps unit tests hermetic (no spawn).

isolint's reference does the opposite (calls `execFileSync` inside the walker) — that violates
aih's "no direct spawn mocks can't intercept" posture. We lift the *algorithm and git argv*, not
the spawn mechanism.

---

## 1. What to LIFT vs design fresh

### Lift (verbatim where it's data/argv, MIT — attribution in file header)
- **git argv for the allowlist**: `git ls-files --cached --others --exclude-standard -z`
  (from `dist/lint/scanner.js` `gitAllowlist`). NUL-delimited so paths with spaces survive.
- **The "tracked OR untracked-but-not-ignored" semantics** + the **directory-set derivation**
  (walk each file's `dirname` chain into a `dirs` set so directory pruning is O(1)).
  From the same function. We reimplement against `gitRead` rather than copy the body verbatim.
- **`--since` three-source union** (from `dist/lint/git-diff.js` `changedFilesSince`):
  1. `git diff --name-only --diff-filter=ACMR <ref>...HEAD` (committed, skip deletes)
  2. `git diff --name-only --diff-filter=ACMR HEAD` (working tree, staged+unstaged)
  3. `git ls-files --others --exclude-standard` (untracked, not ignored)
  Lift the argv + the dedupe-into-a-Set shape + the "ref invalid → throw" behavior.
- **SARIF 2.1.0 envelope shape** (from `dist/lint/report.js` `formatSARIF`): `$schema`,
  `version`, `runs[0].tool.driver{name,informationUri,rules[]}`, `results[]` with
  `ruleId`/`level`/`message.text`/`locations[].physicalLocation.{artifactLocation.uri,region}`.
  Lift the structure; remap our verdicts to SARIF levels.

### Design fresh
- The `Runner`-based async allowlist helper (`gitTrackedSet`) in `src/internals/git.ts` next to
  `gitRead` — fail-soft `undefined` when not a repo / git absent, mirroring `gitRead`.
- The optional `accept?: (relPosix: string) => boolean` predicate threaded into `scanContextBloat`
  and `scanSecrets`.
- The verdict→SARIF mapping and the aih `driver.name`/`informationUri`.
- The `--sarif <file>` write wiring as a normal `writeText` action (so dry-run/backup/containment
  all come for free).

---

## 2. File-level change list

### 2.1 NEW `src/internals/scan-allowlist.ts` (~70 lines)
The async git layer + the predicate factory. Lives in `internals` next to `git.ts`; peer file:
`src/internals/git.ts` (same `gitRead`/Runner idiom, same fail-soft contract).

```ts
import type { PlanContext } from "./plan.js";
import { gitRead } from "./git.js";

/**
 * Lifted from @razroo/isolint (MIT) dist/lint/scanner.js `gitAllowlist` and
 * dist/lint/git-diff.js `changedFilesSince` — argv + set semantics. Reimplemented
 * against aih's async Runner seam (no execFileSync) so tests stay hermetic.
 */

/** Repo-relative POSIX paths git considers tracked-or-untracked-but-not-ignored. */
export interface Allowlist {
  /** Set of repo-relative POSIX file paths. */
  files: ReadonlySet<string>;
}

/** Normalize a git-reported path to repo-relative POSIX (git already emits POSIX). */
function norm(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "");
}

/**
 * Ask git for the set of paths in `ctx.root`'s repo that are tracked OR
 * untracked-but-not-ignored, via the injected Runner. Returns `undefined` when
 * the root isn't a git repo or git is absent — callers fall back to a raw FS walk.
 * Uses `-z` (NUL) so paths with spaces/newlines survive.
 */
export async function gitTrackedSet(ctx: PlanContext): Promise<Allowlist | undefined> {
  // gitRead trims trailing whitespace which is fine; we split on NUL.
  const raw = await gitRead(ctx, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"]);
  if (raw === undefined) return undefined;
  const files = new Set<string>();
  for (const p of raw.split("\0")) {
    if (p) files.add(norm(p));
  }
  return { files };
}

/**
 * Paths changed since `ref` — committed (ref...HEAD), working tree, and untracked —
 * for fast PR CI (`--since`). `undefined` when not a repo / git absent. Throws via
 * the caller only if `ref` is explicitly bad AND we are in a repo (see callers).
 */
export async function changedSince(
  ctx: PlanContext,
  ref: string,
): Promise<ReadonlySet<string> | undefined> {
  const inRepo = (await gitRead(ctx, ["rev-parse", "--show-toplevel"])) !== undefined;
  if (!inRepo) return undefined;
  const out = new Set<string>();
  const add = (s: string | undefined) => {
    for (const line of (s ?? "").split("\n")) {
      const t = line.trim();
      if (t) out.add(norm(t));
    }
  };
  // ref...HEAD committed (skip deletes). undefined here = bad ref → surface upstream.
  const committed = await gitRead(ctx, [
    "diff", "--name-only", "--diff-filter=ACMR", `${ref}...HEAD`,
  ]);
  add(committed);
  add(await gitRead(ctx, ["diff", "--name-only", "--diff-filter=ACMR", "HEAD"]));
  add(await gitRead(ctx, ["ls-files", "--others", "--exclude-standard"]));
  return out;
}

/** A path predicate: keep `rel` only if the allowlist contains it (or no allowlist). */
export function acceptIn(allow: Allowlist | undefined): (rel: string) => boolean {
  if (!allow) return () => true;
  return (rel) => allow.files.has(norm(rel));
}

/** Intersect an allowlist predicate with a changed-set (for `--since`). */
export function acceptChanged(
  allow: Allowlist | undefined,
  changed: ReadonlySet<string> | undefined,
): (rel: string) => boolean {
  const inAllow = acceptIn(allow);
  if (!changed) return inAllow;
  return (rel) => inAllow(rel) && changed.has(norm(rel));
}
```

Note: `gitRead` collapses trailing whitespace but leaves interior NUL bytes intact, so the
`-z` split is safe. (Confirm in a test; if `gitRead`'s `replace(/\s+$/,"")` ever eats a trailing
NUL it only drops a trailing empty token, which the `if (p)` guard already skips.)

### 2.2 EDIT `src/report/bloat.ts` — add optional predicate (sync stays sync)
Mirror the existing signature; default keeps current behavior so `history.ts` is untouched.

```ts
export interface ScanOptions {
  /** Keep only paths this predicate accepts (repo-relative POSIX). Default: keep all. */
  accept?: (rel: string) => boolean;
}

export function scanContextBloat(
  root: string,
  contextDir: string,
  budgetTokens: number = DEFAULT_CONTEXT_BUDGET_TOKENS,
  opts: ScanOptions = {},
): ContextBloat {
  const accept = opts.accept ?? (() => true);
  // … unchanged collection …
  for (const rel of [...rels].sort()) {
    if (!accept(rel)) continue;            // ← NEW: drop ignored/generated/non-tracked
    const bytes = fileSize(join(root, rel));
    …
  }
}
```
ROOT_CONTEXT_FILES that are gitignored (rare) also get dropped — correct, since an agent only
loads what exists; but note this is a behavior change for repos that gitignore `CLAUDE.md`. Keep
the predicate applied uniformly; document it.

### 2.3 EDIT `src/report/index.ts` `buildReport` — compute allowlist, pass predicate
`buildReport` is already `async` and has `ctx`. Add:

```ts
import { gitTrackedSet, acceptChanged, changedSince } from "../internals/scan-allowlist.js";

// inside local-scope branch, before scanContextBloat:
const allow = ctx.options.gitignore === false ? undefined : await gitTrackedSet(ctx);
const since = typeof ctx.options.since === "string" ? await changedSince(ctx, ctx.options.since) : undefined;
const bloat = scanContextBloat(ctx.root, ctx.contextDir, budgetOf(ctx), {
  accept: acceptChanged(allow, since),
});
```
Add two options to `report.command.options`: `--no-gitignore` (escape hatch) and `--since <ref>`.
(commander turns `--no-gitignore` into `options.gitignore === false`.)

`history.ts:80` stays as-is (no allowlist) — trend data wants the *raw* footprint floor and runs
without a `--since`; leaving it unfiltered is intentional and avoids changing the time series
mid-stream. Document this divergence in a one-line comment.

### 2.4 EDIT `src/secrets/scan.ts` — same predicate pattern
```ts
export function scanSecrets(root: string, opts: { accept?: (rel: string) => boolean } = {}): SecretScan {
  const accept = opts.accept ?? (() => true);
  // inside visit(), when recording an env file or secrets dir:
  } else if (isEnvFile(entry)) {
    if (accept(rel)) envFiles.add(rel);     // ← NEW
  }
  // secretDirs likewise gated on accept(rel)
}
```
**Nuance / decision:** a `.env` on disk is a real exposure even if gitignored. For the *secrets*
path, the right default is the INVERSE of bloat: gitignore-honoring should mean "scan what an
agent could enumerate". The agent deny-rules already cover gitignored `.env`. Recommended
default: **secrets scan keeps NO-gitignore behavior by default** (flag everything on disk, since
a plaintext secret is a finding regardless of git status), and only honors `--since` for the fast
PR path. i.e. pass `acceptChanged(undefined, since)` for secrets, NOT the tracked-set. This avoids
a regression where a gitignored-but-present `.env` silently stops being flagged. The double-count
problem is a *bloat* problem, not a *secrets* problem — apply the tracked-set only to bloat.

### 2.5 NEW `src/internals/sarif.ts` (~60 lines) — SARIF 2.1.0 from a VerificationReport
Peer: `src/internals/verify.ts` (consumes `Check[]`). Pure, no I/O.

```ts
import type { Check, VerificationReport } from "./verify.js";
import { VERSION } from "../program.js";

const SARIF_SCHEMA = "https://json.schemastore.org/sarif-2.1.0.json";

/** aih verdict → SARIF level. `skip` → note (informational, never fails code-scan). */
function level(v: Check["verdict"]): "error" | "warning" | "note" {
  return v === "fail" ? "error" : v === "skip" ? "note" : "note";
}

/** Render a VerificationReport (drift/secrets/doctor probes) as SARIF 2.1.0 JSON. */
export function reportToSarif(report: VerificationReport, toolName = "aih"): string {
  const ruleIds = [...new Set(report.checks.map((c) => c.name))];
  const rules = ruleIds.map((id) => ({
    id,
    name: id,
    shortDescription: { text: id },
    defaultConfiguration: { level: "warning" as const },
  }));
  // Only fail/skip become results worth surfacing? No — emit all so passing checks
  // show as resolved. Code-scanning treats note/warning/error by level; pass→note.
  const results = report.checks.map((c) => ({
    ruleId: c.name,
    level: level(c.verdict),
    message: { text: c.detail ?? c.name },
    locations: [],                       // probes are repo-global, not line-anchored
  }));
  const sarif = {
    $schema: SARIF_SCHEMA,
    version: "2.1.0",
    runs: [{
      tool: { driver: {
        name: toolName,
        informationUri: "https://github.com/<org>/ai-harness",
        version: VERSION,
        rules,
      }},
      results,
    }],
  };
  return JSON.stringify(sarif, null, 2);
}
```
Decision on `pass`: emit pass checks as `note` too (some teams want the full ledger). Alternative:
only emit non-pass to keep the SARIF small — pick non-pass-only if README's CodeQL upload step is
noise-sensitive. Default to emitting all checks; it's deterministic and small.

### 2.6 WIRE `--sarif <file>` as a write action
Add `--sarif <file>` to the shared flags? No — it's verify-specific. Add it as a per-command
option on the commands whose probes are the gate: `bootstrap-ai`, `secrets`, `doctor`.
Cleanest seam: do it in `run.ts` AFTER `executePlan`, because that's where the
`VerificationReport` exists and where exit codes are computed. But `run.ts` writes nothing
transactionally — to honor dry-run/backup/containment, the SARIF should be a `writeText` action.

Recommended approach (keeps the plan/Action contract intact):
- Add `--sarif <file>` to the three commands' `options`.
- In each command's `plan`, AFTER building probes, if `ctx.options.sarif` is set, append a
  **deferred** write: but the report doesn't exist at plan time. So instead:
- Add a thin post-step in `run.ts`: if `opts.sarif` is a string and `result.report` exists, write
  the SARIF through the same `FsTransaction`/containment used by `executePlan`. Concretely, expose
  a tiny `writeArtifact(ctx, relPath, contents)` helper in `execute.ts` that stages+commits one
  contained file (reusing `assertContained`). Under dry-run, print "would write <file>" and skip.

```ts
// run.ts, after computing verifyCode:
if (typeof opts.sarif === "string" && result.report) {
  const sarif = reportToSarif(result.report);
  await writeArtifact(ctx, opts.sarif, sarif);   // contained, dry-run-aware, *.aih.bak on overwrite
  if (!json) write(`  [sarif]${ctx.apply ? "" : " (would write)"} ${opts.sarif}\n`);
}
```
`writeArtifact` is the only new export in `execute.ts` (~12 lines wrapping `assertContained` +
`FsTransaction`). It honors `ctx.apply` (dry-run → no write) and `external` semantics (SARIF
usually lands at a CI path like `aih.sarif` at root — contained; an absolute CI path opts out
like `--out` does in report).

### 2.7 `--since` on the verify/secrets paths
- `report`: §2.3 (footprint of only-changed context files — fast PR view).
- `secrets`: pass `acceptChanged(undefined, await changedSince(ctx, since))` so a PR CI run only
  scans `.env`/secrets touched in the diff.
- Bad ref handling: if `ctx.options.since` is set and we ARE in a repo but `git diff ref...HEAD`
  returns `undefined`, throw `AihError("invalid --since ref: <ref>", "AIH_SCAN")` so CI fails
  loud (mirrors isolint's throw). If not a repo, `--since` is a silent no-op (full scan).

---

## 3. Posture fit

- **Dry-run default**: SARIF write is a `writeArtifact` gated on `ctx.apply`; predicates are
  read-only. ✓
- **No remote mutation**: all git calls are read-only (`ls-files`, `diff`, `rev-parse`). ✓
- **Cross-platform via Runner**: every git call goes through `gitRead`→`ctx.run`; no
  `execFileSync`. NUL-split handles Windows paths; `norm()` collapses backslashes. ✓
- **Idempotent / non-destructive**: SARIF write reuses `FsTransaction` (`*.aih.bak`, containment,
  unchanged-skip). ✓
- **Determinism**: `bloat.files` already sorted; allowlist is a Set membership test that doesn't
  reorder; SARIF `ruleIds` derived via `[...new Set(...)]` preserve first-seen order from the
  already-deterministic `checks[]`. ✓
- **Small files**: 2 new files ~70 + ~60 lines; edits are surgical. ✓

Conflicts: none. One judgment call (secrets should NOT honor the tracked-set, only `--since`) is
documented in §2.4 and is the safer default.

---

## 4. Effort / priority / risks

- **Effort: M.** Two small new files, four surgical edits, one `run.ts` post-step, plus tests.
  No async refactor of the scanners (the predicate trick avoids it).
- **Priority: high.** The double-count bug in bloat is a correctness issue aih actively markets
  against (it sells "context footprint"); SARIF is the missing piece of the CI/CodeQL story the
  README already advertises. `--since` is the cheapest of the three and rides the same helper.

### Risks
1. **`gitRead` trailing-whitespace strip vs `-z`**: `gitRead` does `replace(/\s+$/,"")`. NUL is not
   matched by `\s`, so interior NULs survive; only a trailing run of whitespace is trimmed. Verify
   with a path-with-spaces fixture. If it ever bites, add a `gitReadRaw` that skips the trim.
2. **Behavior change for repos that gitignore a root bootloader** (e.g. gitignored `CLAUDE.md`):
   bloat would stop counting it. Acceptable (agent loads only what's present + tracked) but
   surface it in `--no-gitignore` docs.
3. **`history.ts` divergence**: trend floor stays unfiltered on purpose; a reviewer may "fix" it.
   Guard with a comment so the time series isn't silently rebased.
4. **SARIF location-less results**: GitHub code-scanning prefers a physicalLocation. Probes are
   repo-global, so `locations: []` is valid SARIF but renders as a repo-level annotation. Acceptable;
   note it. If a probe ever carries a file (e.g. drift names the bootloader path), enrich `Check`
   with an optional `path` later and map it into `artifactLocation.uri`.
5. **Not-a-repo fallback**: must keep the raw FS walk. Covered by `gitTrackedSet → undefined →
   acceptIn(undefined) → keep-all`.

---

## 5. Test plan (vitest)

New `tests/internals/scan-allowlist.test.ts`:
- `gitTrackedSet` with a `fakeRunner` that returns `"a.md\0gen/a.md\0"` for the `ls-files -z` argv
  → asserts `files` has `a.md` and `gen/a.md`, size 2.
- `gitTrackedSet` returns `undefined` when the runner reports `spawnError` (git absent) → fallback.
- `acceptIn(undefined)` keeps everything; `acceptIn(allow)` drops a path not in the set.
- `changedSince`: fakeRunner maps `rev-parse --show-toplevel`→root, `diff …ref...HEAD`→`"x.md"`,
  working-tree diff→`"y.md"`, untracked→`"z.md"` → union `{x,y,z}`. Bad-ref (committed diff
  `spawnError`/undefined while in repo) → caller throws (assert in report/secrets test).
- Path-with-spaces: `"my file.md\0"` survives the `-z` split + `norm`.

Extend `tests/report/report.test.ts`:
- Plant `contextDir/RULE_ROUTER.md` (tracked) + `contextDir/generated.md` and have the fake git
  allowlist OMIT `generated.md` → assert `bloat.files` excludes it and `totalTokens` drops.
- `--no-gitignore` → allowlist not consulted, generated copy counted (regression guard).
- `--since ref` with changed-set `{RULE_ROUTER.md}` → only that file in `bloat.files`.

Extend `tests/secrets/secrets.test.ts`:
- Default scan still flags a gitignored `.env` (assert tracked-set is NOT applied to secrets).
- `--since` with empty changed-set → no env findings (fast PR path scoped out).

New `tests/internals/sarif.test.ts`:
- Build a `VerificationReport` with one pass, one fail, one skip → `reportToSarif` parses as JSON,
  `version === "2.1.0"`, `runs[0].tool.driver.name === "aih"`, results levels map
  `fail→error, skip→note, pass→note`, `ruleId` equals each `check.name`. Deterministic snapshot.

Wiring (`tests/commands/run` or per-command):
- `bootstrap-ai --verify --sarif aih.sarif` in dry-run → prints `[sarif] (would write)`, no file
  on disk. With `--apply --verify` → file written, contained, re-run is `unchanged` (no `.aih.bak`
  churn the second time / backup the first overwrite).
- Containment: `--sarif ../escape.sarif` → `PathContainmentError`.

Run: `npx vitest run` + `npx biome ci` (stricter than `check`, per project memory). Assert exit
codes via the real CLI for the `.cmd`-shim Windows path if any git invocation is shelled (it
isn't here — all via Runner — but verify on the Windows box per the push-and-confirm habit).

---

## 6. Attribution

Add to `scan-allowlist.ts` and `sarif.ts` headers:
`// Algorithm/argv/shape adapted from @razroo/isolint (MIT, https://github.com/razroo/isolint).`
MIT permits modification + redistribution; reimplemented against the Runner seam so no verbatim
function bodies are copied (argv arrays and the SARIF object literal are the only verbatim bits,
which are facts/format, not creative code).

---

# Spec: Declarative per-tool capability registry for aih

Status: ready to implement
Effort: M
Priority: medium
Owner-file (new): `src/internals/cli-registry.ts`

---

## 1. Problem & current state (verified by reading aih's code)

Per-CLI knowledge is real but **scattered across four files**, each with its own
hand-maintained `Record<Cli, …>` keyed on the same 11-CLI union. There is no
single typed table:

| Fact | Today lives in | Shape |
|---|---|---|
| CLI id list | `src/internals/clis.ts` | bare `SUPPORTED_CLIS = [...] as const` |
| detect signals (configDirs/binaries) | `src/internals/cli-detect.ts` | `SIGNALS: Record<Cli, {configDirs, binaries}>` |
| native entry / bootloader file(s) | `src/bootstrap-ai/canon.ts` | `CLI_BOOTLOADERS: Record<Cli, string[]>` **and** `CLI_META: Record<Cli, CliMeta>` (label/entry/loads/baseline prose) |
| MCP config (key, file, format) | NOT per-CLI at all | `src/mcp/servers.ts` always writes `.mcp.json` with key `mcpServers` for every CLI |
| hooks / sandbox / context window | nowhere | — |

So there are **two** parallel `Record<Cli,…>` maps in `canon.ts` alone
(`CLI_META`, `CLI_BOOTLOADERS`) plus `SIGNALS` in `cli-detect.ts` — three tables,
one key space, three places to edit when adding a CLI. That is the redundancy the
registry removes.

**gap_status: `partial`.** aih already has: the id union, binary detection through
the Runner seam, native-entry mapping, and an MCP mode/scope model. What is
genuinely **missing**:
- a single typed source of truth (the three tables are not unified);
- any `mcpKey` / `configFormat` / `configPath` per CLI — `mcp/*` is hardcoded to
  Claude's `.mcp.json`/`mcpServers` shape for all 11 CLIs (a real correctness gap
  for Codex, Gemini, VS Code, OpenCode — see §6);
- capability fields (hooks granularity, sandbox modes, supportsMcp/Skills/Worktrees,
  maxContextTokens).

Honest scoping note: aih is **not** an agent runtime. The RevealUI `dispatch{…}`,
`readWorkboard`, `claimTasks`, `resumable`, `forkable`, `memory.backend`,
`lifecycleEvents` fields are runtime-orchestration concepts with **no consumer in
aih** and must NOT be copied in — doing so is the over-engineering trap. Only the
fields that an existing aih command would *read* belong in the table.

---

## 2. What to LIFT vs design fresh

### Lift (data/shape, with attribution)

1. **Registry entry shape** — from `@canonical` `harnesses.js`
   (`id/name/detect/configPath/configFormat/mcpKey/skillsPath`). License **LGPL-3.0**.
   We are *not* copying its code (it depends on `@canonical/task` effect monads);
   we re-express the **data model** in aih's own zod/Runner idiom. Re-implementing
   an interface/shape is not a derivative work of the copyrighted code; still, add
   a one-line attribution comment naming the project + LGPL-3.0 in `cli-registry.ts`.
   - Lift verbatim as **data**: the per-CLI `mcpKey`/`configFormat`/config-file
     facts — Codex → `config.toml` / key `mcp_servers` / format `toml`;
     OpenCode → `opencode.json` / key `mcp`; VS Code → `.vscode/mcp.json` / key
     `servers`; Gemini → `.gemini/settings.json` / key `mcpServers`. These are
     objective facts about each tool, not creative expression — safe to use.

2. **Capability field set** — from RevealUI `TOOL_PROFILES` /
   `createDefaultCapabilities()` (`chunk-YREITEN6.js`). License **FSL-1.1-MIT**
   (becomes MIT after 2 years; the *idea/field-names* are not the licensed
   software — we copy neither code nor the adapter). Lift only the **field names
   we will consume**: `hooks{supported,granularity,canBlock}`,
   `sandbox{supported,modes}`, `supportsMcp/supportsSkills/supportsWorktrees`,
   `maxContextTokens`. Re-typed in aih's zod style.

3. **`degradation` enum concept** — `native | polyfill | absent` from
   `DEGRADATION_TABLE`. Adopt the *three-state vocabulary* (see §6), not the table
   contents (its event list is runtime-specific). MIT-equivalent risk = none (idea).

### Design fresh (aih-specific)
- The zod schema + `parse`-on-load fail-closed wiring (mirrors `config/settings.ts`).
- All accessor functions and the migration of the three existing tables.
- The MCP-key-aware write path (aih's `writeJson(..., {merge:true})` + a new TOML branch decision).

**Do NOT lift:** `@canonical/task` monads, RevealUI's RPC server / adapters /
`config-sync.ts` / process detection, isolint's YAML parser. The isolint
`frontmatter.js` per-tool required-field SCHEMAS are interesting but aih does not
currently *lint* generated frontmatter — out of scope (flag as a possible
follow-up, not this spec).

---

## 3. The registry shape (zod, aih conventions)

New file `src/internals/cli-registry.ts` (~220 lines). Mirrors `config/settings.ts`
(zod + fail-closed) and is the new home for what `clis.ts` + `cli-detect.ts:SIGNALS`
+ `canon.ts:CLI_META/CLI_BOOTLOADERS` hold today.

```ts
import { z } from "zod";

/** native | polyfill | absent — does the tool support a capability natively,
 *  can aih emit a fallback, or is it simply unavailable. Vocabulary adopted from
 *  RevealUI's DEGRADATION_TABLE (FSL-1.1-MIT; concept only). */
export const Support = z.enum(["native", "polyfill", "absent"]);

export const HookProfile = z.object({
  support: Support,                                   // native|polyfill|absent
  granularity: z.enum(["all-tools", "command", "none"]),
  canBlock: z.boolean(),
});

export const McpProfile = z.object({
  support: Support,
  /** file the client reads, repo-relative (posix). undefined when support=absent */
  configPath: z.string().optional(),
  /** top-level key holding the server map */
  configKey: z.enum(["mcpServers", "mcp_servers", "mcp", "servers"]).optional(),
  configFormat: z.enum(["json", "toml"]).optional(),
});

export const CliEntry = z.object({
  id: z.string(),                                     // matches the Cli union below
  label: z.string(),                                  // "Claude Code" (from CLI_META)
  // —— detection (moved verbatim from cli-detect.ts SIGNALS) ——
  configDirs: z.array(z.string()),
  binaries: z.array(z.string()),
  // —— native rule entry (moved from canon.ts CLI_BOOTLOADERS) ——
  bootloaders: z.array(z.string()),                   // ["CLAUDE.md"], etc.
  // —— capabilities (new; consumed by mcp/sandbox) ——
  mcp: McpProfile,
  hooks: HookProfile,
  sandbox: z.object({ support: Support, modes: z.array(z.string()) }),
  supportsSkills: z.boolean(),
  supportsWorktrees: z.boolean(),
  maxContextTokens: z.number().int().nonnegative(),
});
export type CliEntry = z.infer<typeof CliEntry>;
```

The `Cli` union and `SUPPORTED_CLIS` stay in `clis.ts` (so `resolveClis` and every
import keep working) — but `clis.ts` now derives the list **from the registry keys**
to guarantee they never drift:

```ts
// clis.ts
import { CLI_REGISTRY } from "./cli-registry.js";
export const SUPPORTED_CLIS = Object.keys(CLI_REGISTRY) as [Cli, ...Cli[]];
```

(Keep the `as const` ordering deterministic — `CLI_REGISTRY` is declared in the
current canonical order: claude, codex, cursor, antigravity, gemini, copilot,
windsurf, opencode, zed, kimi, kiro.)

The table itself is plain data validated once at module load:

```ts
const RAW: Record<string, CliEntry> = {
  claude: {
    id: "claude", label: "Claude Code",
    configDirs: [".claude"], binaries: ["claude"],
    bootloaders: ["CLAUDE.md"],
    mcp: { support: "native", configPath: ".mcp.json", configKey: "mcpServers", configFormat: "json" },
    hooks: { support: "native", granularity: "all-tools", canBlock: true },
    sandbox: { support: "native", modes: ["devcontainer", "managed-settings"] },
    supportsSkills: true, supportsWorktrees: true, maxContextTokens: 200_000,
  },
  codex: {
    id: "codex", label: "Codex CLI",
    configDirs: [".codex"], binaries: ["codex"],
    bootloaders: ["AGENTS.md"],
    mcp: { support: "native", configPath: ".codex/config.toml", configKey: "mcp_servers", configFormat: "toml" },
    hooks: { support: "polyfill", granularity: "none", canBlock: false },
    sandbox: { support: "polyfill", modes: ["devcontainer"] },
    supportsSkills: false, supportsWorktrees: true, maxContextTokens: 200_000,
  },
  // … cursor (.cursor/mcp.json/mcpServers), gemini (.gemini/settings.json/mcpServers),
  //   opencode (opencode.json/mcp), vscode-style entries, windsurf, copilot, zed, kimi, kiro …
};
export const CLI_REGISTRY = z.record(z.string(), CliEntry).parse(RAW); // fail-closed at load
```

Accessors (the seam every consumer uses — no `Record[cli]` indexing elsewhere):

```ts
export function entry(cli: Cli): CliEntry { return CLI_REGISTRY[cli]; }
export function mcpProfile(cli: Cli) { return CLI_REGISTRY[cli].mcp; }
export function bootloadersFor(clis: readonly Cli[]): string[] { /* dedupe, stable */ }
```

> The capability values (hooks granularity, sandbox modes, maxContextTokens) must
> be filled from each tool's real docs at implementation time, not guessed. The
> values above are illustrative; cite the source doc in a comment per non-obvious
> field. Where a value is unknown, set `support: "polyfill"` / conservative default
> rather than inventing a number.

---

## 4. File-level change list

### New
- **`src/internals/cli-registry.ts`** — schema + `CLI_REGISTRY` + accessors (§3).
- **`test/internals/cli-registry.test.ts`** — schema + invariants (§7).

### Edited (consumers READ the registry instead of branching)

1. **`src/internals/clis.ts`** — derive `SUPPORTED_CLIS` from `Object.keys(CLI_REGISTRY)`.
   `resolveClis` unchanged. Keeps `Cli` type exported here (avoid a churn of imports).

2. **`src/internals/cli-detect.ts`** — delete the local `SIGNALS` map and
   `DetectSignal` interface; read `configDirs`/`binaries` from `entry(cli)`.
   `detectOne`, `detectClisByConfig` keep identical behavior (binary presence,
   config-dir-wins). **Decision: do NOT add confidence scoring** — see §5.

3. **`src/bootstrap-ai/canon.ts`** — delete `CLI_BOOTLOADERS`; `bootloaderPaths`
   calls `bootloadersFor`. Keep `CLI_META`'s *prose* (`loads`/`baseline`) — that is
   adapter-note copy, not capability data, and has no other consumer; leave it in
   `canon.ts` (move only `label` + `entry` file refs are already implied by
   `bootloaders`). Minimal change: `CLI_META.entry/label` can stay; only the
   bootloader-path table moves.

4. **`src/mcp/servers.ts` + `src/mcp/index.ts`** — the real capability payoff.
   Today `writeJson(".mcp.json", {mcpServers: servers}, …, {merge:true})` is
   hardcoded. Change `planMcp`/`planMcpOffline` to emit one write **per targeted
   CLI** using `mcpProfile(cli)`:
   - `configFormat === "json"` → `writeJson(profile.configPath, {[profile.configKey]: servers}, …, {merge:true})` (existing deep-merge path).
   - `configFormat === "toml"` (Codex only today) → see §6 decision.
   - `mcp.support === "absent"` → skip that CLI (emit a `doc` noting it).
   This requires `planMcp` to know the target CLIs — wire it through
   `resolveTargets(ctx)` exactly as `bootstrap-ai/index.ts` already does
   (peer pattern: `bootstrapAiPlan` line 110). Until then `mcp` ignores `--cli`
   entirely, which is itself a latent bug this change fixes.

5. **`src/sandbox/templates.ts`** — low-touch. Optionally gate
   `managedSandboxSettings`/devcontainer emission on `entry(cli).sandbox.support`
   when `--cli` is threaded through; if sandbox stays Claude-centric for now, just
   read `sandbox.modes` for a doc line. Keep this change OUT of v1 if it grows —
   sandbox is Claude-specific today and the registry read is cosmetic there.

Peer files to mirror: `config/settings.ts` (zod fail-closed load),
`mcp/servers.ts` (deterministic insertion order + golden-stable output),
`bootstrap-ai/index.ts` (`resolveTargets` threading + `Action[]` assembly).

---

## 5. Decision: confidence-scored detection — NOT worth it for aih

The canonical `scoreConfidence` returns high/medium/low, but its own code comments
admit every reachable path is "high" (`/* v8 ignore … hasHighSignal always true */`,
medium/low marked "unreachable"). aih's detection is intentionally **binary +
provenance** (`present` + `via: "config"|"binary"` + `detail`), already richer than
a useless three-bucket score. aih's posture is "present is high-signal, absent just
means not-found-here, never an error" (cli-detect.ts:11). **Recommendation: skip
confidence scoring.** Adopting it would add a field with no consumer — the same
over-engineering trap as the runtime fields.

---

## 6. Decision: Codex TOML path + the degradation table

**TOML merge — adopt a minimal, non-destructive path, but do not hand-roll a parser.**
aih currently has **no TOML dependency** and writes `.mcp.json` for *every* CLI,
which is wrong for Codex (it reads `~/.codex/config.toml` → key `mcp_servers`). Two
honest options, pick per posture:

- **(A) Preferred for v1 — emit, don't merge.** For `configFormat==="toml"` CLIs,
  do NOT write into `config.toml` (deep-merging TOML safely needs a real
  parser/serializer and risks clobbering a hand-tuned file — violates
  non-destructive). Instead emit a `doc` action with the exact `[mcp_servers.<name>]`
  blocks to paste, plus write a `.mcp.codex.toml.example` sidecar via `writeText`.
  This fits "never destructive, dry-run by default" with zero new deps.
- **(B) Later — real merge.** Add `smol-toml` (tiny, ESM, MIT) and implement a
  marker-free section merge mirroring canonical `config.js` `mergeTomlSection`.
  Gate behind a follow-up because it adds a dependency and a backup/rollback path
  for a second file format. The canonical `mergeTomlSection` is LGPL-3.0 — re-implement,
  do not copy.

**Recommendation: ship (A).** It closes the correctness gap (Codex users currently
get a `.mcp.json` Codex never reads) without a parser or a new dep, and stays
non-destructive. Record (B) as a Part-2 decision.

**Degradation table → drive `mcp --mode`?** aih already has `--mode standard|offline|none`
and an `offlineVendoredProbe`. The three-state `native|polyfill|absent` vocabulary
is worth adopting on the registry's `mcp.support`/`hooks.support` fields (it makes
"this CLI can't do MCP, skip it" explicit and testable). But aih's `--mode` is an
*operator egress choice*, not a per-tool capability — keep them separate. Use
`mcp.support === "absent"` to skip a CLI within any mode; do **not** import the
event-keyed `DEGRADATION_TABLE` (its 10 lifecycle events have no aih consumer).

---

## 7. Test plan (vitest)

`test/internals/cli-registry.test.ts`:
- `CLI_REGISTRY` parses (the `z.record(...).parse(RAW)` throws on malformed → a
  bad future edit fails the suite, not production).
- Every `Cli` in `SUPPORTED_CLIS` has exactly one entry and vice-versa (no orphan).
- `entry("codex").mcp` = `{support:"native", configPath:".codex/config.toml",
  configKey:"mcp_servers", configFormat:"toml"}` (the lifted facts, asserted).
- `bootloadersFor(["codex","opencode","zed","kimi"])` === `["AGENTS.md"]` (dedupe
  preserved — this is the current `canon.ts` behavior, now must not regress).
- `entry("claude").configDirs`/`binaries` equal the old `SIGNALS.claude` values
  (migration parity — snapshot the pre-migration map and assert equality).

`test/internals/cli-detect.test.ts` (existing): unchanged assertions must still
pass after `SIGNALS` is sourced from the registry (proves behavior-preserving).

`test/mcp/*.test.ts`: add a case asserting that with `--cli codex`, the plan emits
the TOML sidecar/doc and NOT a `.mcp.json` write; with `--cli claude` (default) the
golden `.mcp.json` output is byte-identical to today (no regression for the common
path).

---

## 8. Risks

- **Golden-output drift in `mcp`.** Threading `--cli` into `planMcp` changes which
  files are emitted. Mitigate: default (no `--cli`) = claude = byte-identical to
  current `.mcp.json`; only multi-CLI/Codex runs differ. Assert the default golden.
- **`SUPPORTED_CLIS` ordering.** Deriving from `Object.keys` must preserve the
  current canonical order (detection, reports, fallback notice all depend on it).
  Declare `RAW` in that exact order; add a test pinning the array.
- **Filling capability values wrong.** hooks granularity / maxContextTokens for 11
  tools is research, not invention. Risk = shipping a guessed number. Mitigate:
  comment each non-obvious field with its source; default unknowns to conservative
  `polyfill`/`0` rather than a fabricated value. These fields have no behavioral
  consumer in v1 anyway (they are inventory/report data), so a wrong value is
  low-blast-radius and easily corrected.
- **License.** Canonical is LGPL-3.0 — we re-express the data model, copy no code;
  RevealUI is FSL-1.1-MIT — we copy field names/idea only. Both safe as designed;
  add attribution comments. Do not paste any function bodies from either dist.
- **Scope creep into runtime fields.** Explicitly excluded (§1). A reviewer should
  reject any PR that adds `dispatch`/`workboard`/`lifecycleEvents` to `CliEntry`.

---

## 9. Summary

Consolidate aih's three parallel `Record<Cli,…>` tables (`SIGNALS`,
`CLI_BOOTLOADERS`, and the data half of `CLI_META`) into one zod-validated
`CLI_REGISTRY` in `src/internals/cli-registry.ts`, and add the missing
per-CLI MCP facts (`configPath`/`configKey`/`configFormat`) plus inventory-grade
capability fields. The highest-value side effect is fixing `mcp` to write the
**correct config file per tool** (Codex `config.toml`/`mcp_servers`, not Claude's
`.mcp.json`) instead of one hardcoded shape for all 11 CLIs. Detection stays binary
(skip confidence scoring), TOML stays non-destructive (emit-don't-merge in v1),
and runtime-orchestration fields are deliberately excluded — aih provisions
environment+context, it is not an agent runtime.

---

# Spec: Machine-readable command-policy lexicon + risk gates (aih `guardrails`)

Status: ready for implementation
Author: research subagent (grounded in real source + aih code, 2026-06-25)
Target capability: `aih guardrails` (extend), with a defense-in-depth projection into native CLI permission files and the sandbox managed settings.

---

## 1. Gap status: **gap (with one small partial)**

After reading aih's actual code, not a summary:

- `guardrails/taxonomy.ts` is **prose only**. It renders Golden Paths / Guardrails / Safety Nets markdown (`taxonomyDoc()`), names gitleaks + the CI license gate as the only concrete enforced controls. There is **no machine-readable command policy and no risk-gate category data** anywhere in the tree.
- `internals/shell-safety.ts` is **not** a policy. `assertNoCmdInjection()` blocks cmd.exe metacharacters (`& | < > ^ % ! "` + newline) on the Windows `cmd /c` launcher seam. It is an injection guard, not a deny/ask lexicon. Unrelated to this work; do not touch it.
- `sandbox/templates.ts` `managedSandboxSettings()` emits `sandbox.{enabled, failIfUnavailable, allowUnsandboxedCommands, allowedDomains}` — an **egress allowlist**, not a command exec policy. There is no command deny/ask list in the sandbox settings.
- **PARTIAL — native CLI permissions:** `scaffold/index.ts` already writes `.claude/settings.json` with `{ permissions: { deny: ["Read(./.env*)", "Read(./secrets/**)"] } }` as a **merge** write (`SETTINGS_DENY`). So aih *does* emit native Claude permission `deny[]` today — but it is two `Read(...)` rules for secret files only. There is **no `Bash(...)` command deny/ask projection**. This is the hook to extend, not invent.
- `bootstrap-ai/canon.ts` emits **markdown bootloaders only** (CLAUDE.md, AGENTS.md, .cursor/rules, etc.). It does **not** emit any native settings JSON or permission arrays. The per-CLI `CLI_META`/`CLI_BOOTLOADERS` table is the right place to read each tool's capability, but canon is the wrong writer for JSON permission files (one-writer-per-file: scaffold owns `.claude/settings.json`).
- **Redaction (PARTIAL, but different layer):** `telemetry/templates.ts` emits a redacting OTel/Bindplane collector config (`processors.redaction.blocked_values` = `sk-ant-…`, bearer, `AKIA…`, email). `guardrails/gitleaks.ts` exports `AWS_KEY_REGEX` + `PRIVATE_KEY_REGEX`. But these are *destination-side* (collector) and *scan-side* (gitleaks) patterns. There is **no shared source-side `redactSecrets()` applied to aih's own report/usage/digest output** before it is printed or written. `usage/capture.ts` `.aih/usage.jsonl` and the `digest` action `text`/`data` are emitted unredacted. Small real gap.

Conclusion: build the command-policy lexicon + risk-gate categories as new data modules under `guardrails/`, render them as (a) a managed sandbox exec policy block, (b) an extension of the existing `.claude/settings.json` deny/ask projection, and (c) a CI-checkable risk-gates doc/JSON that the prose taxonomy now *links to*. Add a small shared `redactSecrets()` and apply it at the one source-side seam (digest/report text). Do **not** duplicate the gitleaks or collector patterns — import them.

---

## 2. What to LIFT vs design fresh

### Source license correction (IMPORTANT)
The task brief says the source is **Apache-2.0**. The actual file on disk —
`C:/Users/samar/AppData/Local/Temp/claude/.../dd/_feneto_lh/LICENSE` — is **MIT**
("Copyright (c) 2026 LeanHarness contributors"). MIT is still liftable with
attribution; the attribution line must say MIT, not Apache-2.0. Verify once more at
implementation time, but treat as MIT.

### Lift verbatim (data tables — the high-value port)
From `dd/_feneto_lh/.lh/policies/commands.yml` (MIT):
- The **4-tier pattern+reason table**: `deny`, `ask`, `safe_read_only`, `safe_verification`. Port every pattern and its `reason` string verbatim into a typed TS data module. These cover: `rm -rf /`, `rm -rf ~`, `.git` deletion, `git push --force`/`-f`, `git reset --hard`, `git clean -fd/-fx/-fxd`, `DROP DATABASE`/`DROP TABLE`, `cat .env*`, `printenv`, `env`, `> /dev/sd*`, `dd if=*`, `mkfs*`, fork bomb `:(){ :|:& };:*`; ask-tier npm/pnpm/yarn/bun/pip/poetry/cargo install+update, `git push`, `git reset`, `git clean`, `*migrate reset*`, `*db reset*`, `*deploy*`, `*curl*|*sh*`, `rm -r*`; safe_read_only git status/diff/log/branch/show/blame + ls/find/grep/rg/sed -n/wc/head/tail; safe_verification test/lint/typecheck runners across npm/pnpm/yarn/bun/pytest/go/cargo/node --check/python.

From `dd/_feneto_lh/.lh/policies/risk-gates.yml` (MIT):
- The **named risk-gate categories** with `description`, `path_patterns`, `command_patterns`, `behavior: ask`: `auth_rewrite`, `payment_logic`, `destructive_migration`, `new_dependency`, `public_api_break`, `broad_refactor`, `security_sensitive_change`. Port verbatim.
- The `approval_sources` precedence note and `enforcement_notes` (ask-not-deny; multiple gates may trigger; conservative approval detection) — port as prose into the rendered doc.

From `dd/_feneto_lh/.lh/policies/claude-code.yml` (MIT):
- The `permissions.{allow,ask,deny}` projection into Claude `Bash(...)` matchers is the proven shape for how the lexicon maps to a native CLI permission file. Lift the **mapping convention** (deny-tier → `Bash(<pattern>)` in `permissions.deny`, ask-tier → `permissions.ask`, safe_* → `permissions.allow`), not the file itself.

### Design fresh (aih conventions)
- The zod schema for the policy (aih uses zod + commander; the source uses raw YAML with no schema).
- The aih `plan()`/`Action` integration (writeJson merge, doc, the marker-block model) — the source ships runtime hooks; aih ships **declarative artifacts** and never runs an enforcement hook itself.
- The per-CLI **capability decision** (enforce vs document) keyed off `bootstrap-ai`'s `Cli` set — the source only targets Claude + opencode.
- `redactSecrets()` — the source's compiled `redactSecrets` lives in bundled dist; reading minified dist is low value. Design a small fresh function seeded from aih's **own** existing patterns (gitleaks `AWS_KEY_REGEX`/`PRIVATE_KEY_REGEX` + the telemetry `blocked_values` list) so there is one source of truth, not a third copy.

---

## 3. Posture fit

Fits the non-negotiable posture cleanly:
- **Dry-run by default / --apply:** all artifacts are `writeText`/`writeJson`/`doc` actions in `guardrailsPlan` — the executor decides dry-run vs apply. No new exec.
- **Idempotent + non-destructive:** sandbox exec-policy + `.claude/settings.json` go through `writeJson(..., { merge: true })` (deep-merge, `*.aih.bak`, transactional). The risk-gates doc is a `doc` action under the context dir. Byte-identical re-runs (data tables are static, `lines()`/`jsonFile()` are deterministic).
- **Never mutates remote systems:** zero exec, zero network. CI risk-gate check is a **doc** ("runs in YOUR CI"), mirroring the existing `ciNote()` pattern exactly.
- **Cross-platform:** pure data + string rendering; no spawning. The deny patterns are documented as *advisory projections* the target CLI's own hook engine enforces — aih does not execute them.
- **Not an agent runtime:** aih emits the policy files; the AI CLI (Claude/etc.) enforces them via its native permission/hook layer. aih provisions, does not gate live tool calls.

One honest conflict to call out in the doc: a YAML/JSON deny lexicon is **advisory** unless the consuming CLI actually honors it. aih can *enforce* only where the CLI has a permission/hook seam (Claude `settings.json` permissions, sandbox managed settings). For CLIs without one, the lexicon is **documentation**. This is the enforce-vs-document split in §4.4.

---

## 4. File-level change list

Nearest peer to mirror throughout: **`guardrails/sca.ts`** (typed data table + render fn + exported constants tested directly) and **`guardrails/gitleaks.ts`** (regex constants exported for reuse + a `*Toml()` renderer). Wire-in mirrors `guardrails/index.ts`.

### 4.1 NEW `src/guardrails/command-policy.ts` (~220 lines)
The lexicon data + renderers. Mirrors `sca.ts` structure (data array + render + exported helpers).

```ts
import { jsonFile, lines } from "../internals/render.js";

/** Policy tiers, most-to-least restrictive. Ported from LeanHarness commands.yml (MIT). */
export type PolicyTier = "deny" | "ask" | "safe_read_only" | "safe_verification";

export interface CommandRule {
  /** glob-ish command pattern, verbatim from the source lexicon. */
  pattern: string;
  /** human reason (deny/ask only; safe tiers are self-explanatory). */
  reason?: string;
}

/**
 * The 4-tier command classification lexicon. Ported verbatim from
 * `.lh/policies/commands.yml` (LeanHarness, MIT) — pattern + reason preserved.
 * Source: https://github.com/<leanharness> .lh/policies/commands.yml
 */
export const COMMAND_LEXICON: Record<PolicyTier, CommandRule[]> = {
  deny: [
    { pattern: "rm -rf /", reason: "Refuses to delete filesystem root." },
    // …every deny rule from commands.yml, verbatim…
    { pattern: ":(){ :|:& };:*", reason: "Refuses fork bombs." },
  ],
  ask: [ /* …npm/pnpm/yarn/bun/pip/poetry/cargo install+update, git push/reset/clean, *deploy*, *curl*|*sh*, rm -r* … */ ],
  safe_read_only: [ /* git status/diff/log/…, ls/find/grep/rg/… */ ],
  safe_verification: [ /* npm test, pytest, go test, cargo test, node --check, … */ ],
};

/** Project the lexicon into Claude-style `permissions` matchers (`Bash(<pattern>)`). */
export function claudeBashPermissions(): { deny: string[]; ask: string[]; allow: string[] } {
  return {
    deny: COMMAND_LEXICON.deny.map((r) => `Bash(${r.pattern})`),
    ask: COMMAND_LEXICON.ask.map((r) => `Bash(${r.pattern})`),
    allow: [...COMMAND_LEXICON.safe_read_only, ...COMMAND_LEXICON.safe_verification].map(
      (r) => `Bash(${r.pattern})`,
    ),
  };
}

/** Project the lexicon into the sandbox managed-settings exec-policy block. */
export function sandboxExecPolicy(): Record<string, unknown> {
  return {
    commandPolicy: {
      deny: COMMAND_LEXICON.deny.map((r) => ({ pattern: r.pattern, reason: r.reason })),
      ask: COMMAND_LEXICON.ask.map((r) => ({ pattern: r.pattern, reason: r.reason })),
      safeReadOnly: COMMAND_LEXICON.safe_read_only.map((r) => r.pattern),
      safeVerification: COMMAND_LEXICON.safe_verification.map((r) => r.pattern),
    },
  };
}

/** Markdown reference table for humans (lives under the context dir). */
export function commandPolicyDoc(): string {
  return lines(/* deterministic table rendered from COMMAND_LEXICON */);
}
```

### 4.2 NEW `src/guardrails/risk-gates.ts` (~150 lines)
The named risk-gate categories + renderer. Ported verbatim from `risk-gates.yml`.

```ts
export interface RiskGate {
  name: string;
  description: string;
  pathPatterns: string[];
  commandPatterns: string[];
  behavior: "ask"; // ask-not-deny, per the source's enforcement note
}

/** Ported verbatim from `.lh/policies/risk-gates.yml` (LeanHarness, MIT). */
export const RISK_GATES: RiskGate[] = [
  { name: "auth_rewrite", description: "Replacing or broadly restructuring authentication/session behavior.",
    pathPatterns: ["**/auth/**", "**/session/**", "**/*auth*", "**/*session*"], commandPatterns: [], behavior: "ask" },
  // payment_logic, destructive_migration, new_dependency, public_api_break, broad_refactor, security_sensitive_change …
];

export const APPROVAL_SOURCES = [ /* the 3 precedence sources, verbatim */ ];

/** A doc + a CI-checkable JSON sidecar (so a CI job can diff a PR's touched paths against the gates). */
export function riskGatesDoc(): string { /* lines(...) */ }
export function riskGatesJson(): Record<string, unknown> { /* { version, gates: RISK_GATES, approvalSources } */ }
```

### 4.3 NEW `src/guardrails/redact.ts` (~60 lines)
One shared source-side redactor seeded from aih's existing patterns (no third copy).

```ts
import { AWS_KEY_REGEX, PRIVATE_KEY_REGEX } from "./gitleaks.js";

/** Source-side secret redaction for aih's OWN printed/written output (digests, reports,
 * usage rollups) — distinct from the collector (destination) and gitleaks (scan) layers. */
const PATTERNS: RegExp[] = [
  new RegExp(AWS_KEY_REGEX, "g"),
  new RegExp(PRIVATE_KEY_REGEX, "g"),
  /sk-ant-[A-Za-z0-9_-]{8,}/g,
  /ghp_[A-Za-z0-9]{36,}/g,
  /(?i)bearer\s+[A-Za-z0-9._-]+/gi,
  /\b[A-Z_]*(TOKEN|SECRET|PASSWORD|API_KEY)\s*=\s*\S+/g,
];

export function redactSecrets(text: string): string {
  return PATTERNS.reduce((s, re) => s.replace(re, "[REDACTED]"), text);
}
```

### 4.4 EDIT `src/guardrails/index.ts` — `guardrailsPlan()`
Add three artifacts to the existing plan (after the taxonomy doc, before/with the CI note). Mirror the exact `writeText`/`doc` style already there.

- `writeText(COMMAND_POLICY_PATH, commandPolicyDoc(), "Command-policy lexicon (deny/ask/safe) — ported from LeanHarness (MIT)")` under the context dir, e.g. `${ctx.contextDir}/command-policy.md`. *(Or a `doc` with a path, matching the taxonomy doc which uses `doc(...)` with a path.)*
- `writeJson(".claude/settings.json", { permissions: claudeBashPermissions() }, "...", { merge: true })` — **merge** so it composes with scaffold's `Read(...)` deny rules instead of clobbering. (See §6 risk: coordinate the two writers.)
- `writeJson(RISK_GATES_PATH, riskGatesJson(), "Risk-gate categories (ask-not-deny), CI-checkable", )` + `doc("Risk gates run in YOUR CI", riskGatesCiNote())` mirroring the existing `ciNote()`.
- Extend `taxonomyDoc()` (or add a line in `index.ts`) so the **prose taxonomy links to** the new machine-readable files — closing the "taxonomy describes, policy enforces" loop the brief asks for.

### 4.5 EDIT `src/sandbox/templates.ts` — `managedSandboxSettings()`
Deep-merge `sandboxExecPolicy()` into the returned `sandbox` object so the egress allowlist and the command policy ship in the same managed-settings file:

```ts
return { sandbox: { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false,
  allowedDomains, ...sandboxExecPolicy() } };
```
(Import `sandboxExecPolicy` from `../guardrails/command-policy.js`.)

### 4.6 EDIT one source-side redaction seam (smallest honest scope)
Apply `redactSecrets()` to the `digest` action `text` at the single render seam where digests/reports are printed (the report/digest renderer in `report/render.ts` or `internals/execute.ts` digest handling — confirm the exact print site at implementation time). Do **not** sprinkle it; one chokepoint. This is the source-side complement to the existing collector redaction.

### 4.7 Capability registry note
No change to `commands/index.ts` — this rides inside the existing `guardrails` capability and the existing `sandbox` capability. No new top-level command. (The `Cli` capability-registry coupling is read-only: §4.x uses `bootstrap-ai`'s `Cli` set only to *decide* which CLIs get the native projection — see enforce/document table below.)

### Enforce vs document, per CLI
| CLI | Native seam aih can write | Enforcement |
| --- | --- | --- |
| Claude Code | `.claude/settings.json` `permissions.{deny,ask,allow}` `Bash(...)` + `.claude/managed-settings.json` sandbox commandPolicy | **Enforced** (defense-in-depth: both files) |
| Codex / opencode / others (AGENTS.md tools) | none today | **Documented** in `command-policy.md` |
| Cursor / Windsurf / Copilot / Gemini / Kiro | rules markdown only | **Documented** |

aih ships the lexicon as data once; it *projects* into native enforcement only where a seam exists, and documents everywhere else. State this explicitly in the doc so no one assumes a Gemini run is gated.

---

## 5. Effort / priority

- **Effort: M.** Two new data modules (verbatim ports), one small redactor, three plan edits, one sandbox edit, one redaction wiring + tests. No new infra, no new command, no async, no Runner work.
- **Priority: high.** It is a genuine gap directly on the security posture aih sells ("guardrails"), the data is liftable verbatim under MIT, and it strengthens an artifact (`.claude/settings.json`) aih already writes. Low blast radius.

---

## 6. Risks

- **Two writers to `.claude/settings.json` — VERIFIED SAFE.** `scaffold/index.ts` merges `permissions.deny` (Read rules); `guardrails` would merge `permissions.{deny,ask,allow}` (Bash rules). I read `internals/merge.ts`: `deepMerge` calls `unionUnique` on primitive arrays (deduped union, base order first) and its doc comment **names `permissions.deny` explicitly** as the accumulate-don't-clobber case. So both writers compose correctly with no extra work. Residual risk is only ordering/dedupe of object-valued entries (none here — both are strings), and it stays low. Still add the coordination test in §7 to lock the behavior against future merge.ts regressions.
- **Advisory ≠ enforced.** A deny pattern in a doc/settings file does nothing unless the CLI honors it. Risk of false confidence. Mitigation: the enforce/document table + an explicit "advisory" banner in `command-policy.md`.
- **Pattern format mismatch.** The source patterns are shell-glob-ish (`npm install*`). Claude's `Bash(...)` matcher and the sandbox engine may interpret globs differently. Mitigation: keep patterns verbatim, document that they are *prefix/glob* matchers, and add a test asserting the projection is a pure 1:1 string map (no transformation), so any matcher semantics live with the consuming CLI, not aih.
- **License attribution.** Brief said Apache-2.0; disk says MIT. Ship the correct MIT attribution comment in both new modules. Wrong attribution is a compliance bug given aih *sells* a license gate.
- **Redaction over-reach.** A greedy `TOKEN=*` regex could redact benign text in a digest. Mitigation: anchor patterns, test on benign-vs-secret fixtures, redact only at the print seam (never mutate stored `data`… or redact both consistently — decide and test).

---

## 7. Test plan (vitest, mirrors `tests/guardrails/guardrails.test.ts`)

New `tests/guardrails/command-policy.test.ts`:
- `COMMAND_LEXICON.deny` contains every ported pattern with a non-empty reason; spot-assert `rm -rf /`, `git push --force*`, `*DROP DATABASE*`, `dd if=*`, `mkfs*`, `:(){ :|:& };:*`.
- `ask` tier covers all package managers: assert `npm install*`, `pnpm add*`, `yarn add*`, `bun add*`, `pip install*`, `poetry add*`, `cargo add*`, plus `git push*`, `*deploy*`, `*curl*|*sh*`, `rm -r*`.
- `safe_read_only` / `safe_verification` carry the read + test runners; assert `git status*`, `npm test*`, `pytest*`, `go test*`, `node --check*`.
- `claudeBashPermissions()` is a **pure 1:1 projection**: `deny.length === COMMAND_LEXICON.deny.length`, every entry is `Bash(<exact pattern>)`, no transformation/dedupe surprises.
- `sandboxExecPolicy()` round-trips through `JSON.parse(JSON.stringify(...))` and carries `commandPolicy.deny[].{pattern,reason}`.
- Determinism: `commandPolicyDoc()` called twice is byte-identical.

New `tests/guardrails/risk-gates.test.ts`:
- `RISK_GATES` has exactly the 7 named categories; `auth_rewrite.pathPatterns` includes `**/auth/**`; `destructive_migration.commandPatterns` includes `*drop*`; `new_dependency.pathPatterns` includes `package.json` and `Cargo.toml`; every gate `behavior === "ask"` (ask-not-deny invariant).
- `riskGatesJson()` is valid JSON and includes `approvalSources`.

New `tests/guardrails/redact.test.ts`:
- `redactSecrets("AKIA1234567890ABCDEF")` → `[REDACTED]`; PEM header redacted; `sk-ant-…` redacted; bearer token redacted; `API_KEY=xyz` redacted.
- Benign text untouched: `"the deployment ran"` unchanged; a bare word `token` (no `=`) unchanged.

Extend `tests/guardrails/guardrails.test.ts`:
- Plan now writes/docs the command-policy artifact and the risk-gates artifact (update the `writePaths`/doc-count assertions — currently asserts exactly 3 writes + 2 docs + 1 probe; bump deliberately).
- `.claude/settings.json` write is `merge: true` and its `permissions.deny` contains `Bash(rm -rf /)`.
- BOUNDARY preserved: still **zero exec actions**; risk-gate CI activation is a `doc` whose text says "YOUR CI" (mirror the existing boundary test).

Extend `tests/sandbox/sandbox.test.ts`:
- `managed-settings.json` `sandbox.commandPolicy.deny` is present and includes the `rm -rf /` rule; existing allowlist + failIfUnavailable assertions still pass; still `merge: true`.

Coordination test (the §6 top risk):
- Apply `scaffold` then `guardrails` to the same temp root; assert the final `.claude/settings.json` `permissions.deny` contains **both** `Read(./.env*)` (scaffold) and `Bash(rm -rf /)` (guardrails) — proves array-union merge, no clobber.

Run: `npm test` (vitest run) + `npm run lint` (`biome check`) must be clean; remember CI uses `biome ci` (stricter).

---

# Spec: Weighted AI-harness maturity scorecard for `aih report`

Status: ready to implement
Effort: M
Priority: med
Author grounding date: 2026-06-25

---

## 0. TL;DR

Add ONE new read-only `digest` panel to `aih report` (local scope) — a **harness
maturity scorecard** — that aggregates aih's *already-existing* read-only checks
(router presence, bootloader drift, thin-pointer sizing, shared-block reuse,
context budget, guardrail/secret presence) into a small set of weighted
dimensions, each scored `round(passed/total*100)`, rolled up to one overall
score + letter grade. It reuses aih's `inventory()`, `scanContextBloat()`,
`sharedCanonicalBlockBody()` drift logic, and the `digest()` action model. No new
command, no mutation, no network, deterministic (byte-stable) output.

**Scope decision: a few high-signal dimensions, NOT paniolo's ~100 checks.**
aih generates a *fixed, known* artifact set (it is the generator), so a generic
~100-check corpus scanner is wrong altitude. We score what aih itself lays down.

**Evidence-grading: adopt a LIGHT version** — each check carries a stable `id` +
one-line `source` (the aih doc/command that defines it) + `remediation`. We do
NOT import paniolo's arXiv-cited `evidence_level`/`verified_on`/fixture tiers;
that is corpus-research provenance for a third-party auditor, not self-scoring.

---

## 1. Gap status — HONEST assessment

**`gap_status: partial` (leaning gap on the headline feature).**

What aih ALREADY does (verified by reading the code):

| paniolo concept | aih equivalent, today | file |
|---|---|---|
| `adapter-thin-*` (bootloader is a thin pointer) | bootloader drift probe asserts the managed shared block matches + references RULE_ROUTER | `src/bootstrap-ai/index.ts:46` `bootloaderProbe()` |
| `adapter-points-to-shared` | same probe: `text.includes("RULE_ROUTER.md")` + block-equality | `src/bootstrap-ai/index.ts:57-62` |
| `shared-rules-doc` / `shared-agents-md` | `_shared-canonical-block.md` is the single source; every bootloader carries it | `src/bootstrap-ai/canon.ts:140` |
| `always-loaded-budget` / `adapter-context-budget` | `scanContextBloat()` totals root bootloaders + context dir + cursor rules vs a token budget, `overBudget` flag | `src/report/bloat.ts:88` |
| guardrails severity | `guardrailDigest()` (gated on a real scan file) | `src/report/guardrail.ts:36` |
| artifact presence (mcp/secrets/devcontainer) | `inventory()` shared by `status` + report config panel | `src/status.ts:30` |
| per-check remediation hint | SEVERAL doctor probes already embed `run: aih …` hints in `detail` | `src/doctor.ts:58,69,85,104` |
| code-quality signal | `qualityDigest()` test/source file ratio | `src/report/quality.ts:47` |

What aih does NOT have (the real delta):

1. **No numeric score.** Every signal is `pass|skip|fail` (doctor) or a prose
   digest (report). There is no `0–100`, no letter grade, no rollup.
2. **No weighted dimensions.** The signals are scattered across `doctor`,
   `bootstrap-ai`, `status`, and individual report panels; nothing groups them
   into "layering / sharing / guardrails / …" and weights them.
3. **Remediation hints are inconsistent.** Some doctor probes embed `run: aih …`;
   others (`node-version`, `platform`, `git`) do not. paniolo's discipline of
   *every* check carrying a remediation is only PARTIALLY met.

**Conclusion:** Implement the score + dimension rollup as a new panel that
*reuses* the existing checks. Do NOT re-derive drift/budget/presence logic — call
the existing functions. Do NOT build a 100-check corpus scanner. Separately,
systematize remediation hints across doctor probes (small, independent cleanup).

---

## 2. What to LIFT vs design fresh

### Lift (verbatim data / formulas — MIT-style attribution in a header comment)

paniolo's `dist/` is a compiled bundle; the human-readable, liftable assets are
the JSON standards files. Treat as reference data, attribute in a comment.

1. **Grade bands** — lift verbatim from `cli.js`:
   `[{min:85,grade:"excellent"},{min:70,grade:"good"},{min:50,grade:"fair"},{min:0,grade:"poor"}]`.
   Remap labels to aih's voice: `mature(85) / solid(70) / emerging(50) / nascent(0)`
   OR keep `excellent/good/fair/poor`. (Author's call; spec uses mature/solid/emerging/nascent.)
2. **Dimension score formula** — lift verbatim: `Math.round(passed/total*100)`
   (`cli.js` `Hn()`/`Vn()`). This is the core math.
3. **Reference thresholds** — lift the *values* from
   `dist/standards/reference-thresholds.json`:
   `adapter_max_lines: 75`, `skill_max_lines: 300`, `sharing_target_percent: 65`.
   Encode as named constants. `adapter_max_lines: 75` is the thin-pointer
   ceiling; `sharing_target_percent: 65` is the shared-block reuse target.
4. **Per-check soft weights idea** — lift the *concept* from
   `dist/standards/weights.json` (`check_weights` < 1.0 for maturity-signal
   checks). Encode as an optional `weight` on each check (default 1).

Attribution: `weights.json` / `reference-thresholds.json` ship in paniolo's
distributed npm `dist/` (no LICENSE in the scratchpad copy — confirm paniolo's
package license before shipping; these are short factual thresholds + a public
formula, low IP risk, but cite the source package + commit in a comment).

### Design fresh (aih-specific)

- The **dimension → aih-check mapping** (paniolo scans an arbitrary repo; aih
  scores its OWN generated artifacts — the checks are bespoke).
- Reusing `scanContextBloat` / `inventory` / `sharedCanonicalBlockBody` as the
  evidence sources.
- The `digest`-shaped output + `--json` `data` payload.
- The doctor remediation-hint systematization.

---

## 3. Dimension model (scoped to aih's artifacts)

Five dimensions (not paniolo's eight — `session`/`deep` map to nothing aih
generates; fold the rest). Each dimension = a set of boolean checks; dimension
score = `round(passed / total * 100)`; overall = weighted mean of dimension
scores; grade from the lifted bands.

| Dimension | weight | checks (id → evidence source) |
|---|---|---|
| **layering** | 1.0 | `router-present` (RULE_ROUTER.md exists, reuse `routerProbe` logic) · `core-rules-doc` (`rules/agent-behavior-core.md` exists) |
| **sharing** | 1.0 | `shared-block-source` (`adapters/_shared-canonical-block.md` exists) · `bootloaders-in-sync` (every bootloader's managed block matches `sharedCanonicalBlockBody(dir)` — reuse `bootloaderProbe` core) · `bootloaders-point-to-router` (`includes RULE_ROUTER.md`) |
| **harnessWiring** | 1.0 | per-CLI bootloader present for each detected CLI · `.mcp.json` present · `claude-settings` present (from `inventory()`) |
| **guardrails** | 1.0 | `gitleaks` config present · `pre-commit` config present · `pre-commit` git hook installed (reuse `enforcementDetail` distinction — advisory vs enforced) |
| **discoverability** | 0.5 (soft) | `regeneration-doc` (`REGENERATION.md`) · context within budget (`!scanContextBloat().overBudget`) · adapter notes thin (each `adapters/*.md` ≤ `ADAPTER_MAX_LINES`=75) |

`session`/`deep` paniolo dims and the ~90 corpus checks (jsdoc enforcement, CI
gates, secret-scanning-configured, arXiv security postures) are OUT — aih neither
generates nor owns them per-repo. A future `--strict` could add them; not now.

Soft weight (0.5) on `discoverability` mirrors paniolo's `check_weights` for
maturity-signal-only checks (presence is nice-to-have, not load-bearing).

---

## 4. File-level change list

### NEW: `src/report/scorecard.ts` (~180 lines)

Mirror peer `src/report/guardrail.ts` + `src/report/quality.ts` (a single
`*Digest(ctx)` exported fn returning `DigestAction | undefined`, pure-ish, reuses
existing scanners). Nearest peer for the dimension math: nothing exists — design
fresh but keep it flat (small pure helpers, no classes).

```ts
// src/report/scorecard.ts
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readIfExists } from "../internals/fsxn.js";
import { extractManagedBlock } from "../internals/markers.js";
import { type DigestAction, digest, type PlanContext } from "../internals/plan.js";
import { lines } from "../internals/render.js";
import { SHARED_MARKER, sharedCanonicalBlockBody } from "../bootstrap-ai/canon.js";
import { inventory } from "../status.js";
import { scanContextBloat } from "./bloat.js";

/**
 * Reference thresholds lifted from paniolo's scan standards
 * (paniolo dist/standards/reference-thresholds.json) — thin-pointer ceiling.
 */
const ADAPTER_MAX_LINES = 75;

/** Grade bands lifted verbatim from paniolo (cli.js): min 85/70/50/0. */
const GRADE_BANDS = [
  { min: 85, grade: "mature" },
  { min: 70, grade: "solid" },
  { min: 50, grade: "emerging" },
  { min: 0, grade: "nascent" },
] as const;

type Grade = (typeof GRADE_BANDS)[number]["grade"];

interface CheckResult {
  id: string;
  passed: boolean;
  /** One-line fix; surfaced verbatim. Systematic — every check carries one. */
  remediation: string;
  /** The aih doc/command that defines this check (light evidence grade). */
  source: string;
}

interface DimensionResult {
  name: string;
  weight: number;
  score: number; // 0..100, round(passed/total*100)
  checks: CheckResult[];
}

function gradeOf(score: number): Grade {
  for (const b of GRADE_BANDS) if (score >= b.min) return b.grade;
  return "nascent";
}

function dimScore(checks: CheckResult[]): number {
  if (checks.length === 0) return 0;
  const passed = checks.filter((c) => c.passed).length;
  return Math.round((passed / checks.length) * 100); // lifted formula
}

// ... per-dimension builders: layeringChecks(ctx), sharingChecks(ctx), etc.
// each returns CheckResult[] using existsSync / readIfExists / scanContextBloat /
// sharedCanonicalBlockBody — NO new file reads of contents beyond what peers do.

export function scorecardDigest(ctx: PlanContext): DigestAction | undefined {
  const dims: DimensionResult[] = buildDimensions(ctx);
  // Off-canon repo (no RULE_ROUTER, no context dir) → undefined, like quality/repoinfo
  if (!existsSync(join(ctx.root, ctx.contextDir, "RULE_ROUTER.md"))) return undefined;

  const totalWeight = dims.reduce((n, d) => n + d.weight, 0);
  const overall = Math.round(
    dims.reduce((n, d) => n + d.score * d.weight, 0) / totalWeight,
  );
  const grade = gradeOf(overall);
  const body = lines(
    `Overall: ${overall}/100 (${grade})`,
    "",
    ...dims.map((d) => `  ${d.score >= 70 ? "✓" : d.score >= 50 ? "~" : "·"} ${d.name.padEnd(16)} ${d.score}/100  (${gradeOf(d.score)})`),
    "",
    // Surface only FAILING checks' remediation — systematic, deterministic order.
    ...dims.flatMap((d) =>
      d.checks.filter((c) => !c.passed).map((c) => `  → ${c.id}: ${c.remediation}`),
    ),
  );
  return digest(`Harness maturity — ${overall}/100 (${grade})`, body, {
    overall,
    grade,
    dimensions: dims.map((d) => ({
      name: d.name,
      score: d.score,
      grade: gradeOf(d.score),
      weight: d.weight,
      checks: d.checks.map((c) => ({ id: c.id, passed: c.passed, source: c.source })),
    })),
  });
}
```

Key conventions matched:
- returns `DigestAction | undefined` and is OMITTED off-canon — exactly like
  `qualityDigest` / `repoInfoDigest` (`return undefined`).
- `lines(...)` for byte-stable body; deterministic dimension + check ordering.
- `data` payload is the machine-readable score tree for `--json`.
- reuses `sharedCanonicalBlockBody(dir)` + `SHARED_MARKER` so the drift check is
  the SAME logic as `bootloaderProbe` (no second source of truth).
- NO `Runner`/process spawn — pure fs reads through existing helpers.

### EDITED: `src/report/local.ts`

Add to the `localPanels` array, placed after `qualityDigest` (both are
"code/harness quality" signals) and gated like the others:

```ts
import { scorecardDigest } from "./scorecard.js";
// ...
const panels: (DigestAction | undefined)[] = [
  ...(await velocityDigests(ctx)),
  aiEventsDigest(ctx),
  scorecardDigest(ctx),          // NEW — harness maturity, omitted off-canon
  await qualityDigest(ctx),
  // ...unchanged
];
```

This automatically flows into terminal output, `--format md|html` artifacts, and
`--json` (the report machinery just iterates digests — no other wiring needed).

### EDITED (optional, independent): `src/doctor.ts` — systematize remediation

Make EVERY `fail`/`skip` detail carry a `run: …` or actionable hint. Today
`node-version`, `git`, `platform` do not. Smallest change: append a hint to the
three bare ones. This satisfies paniolo's "every check has remediation" without a
schema change (doctor's `Check.detail` already carries it as prose — keep that
shape; do not add a field). Example:

```ts
// node-version fail
detail: `node ${process.versions.node} < 20 — install Node 20+ (nvm/winget/brew) and re-run`,
```

OPTIONAL doctor summary score: a final `digest` action appended to the doctor
plan reusing `scorecardDigest`. DEFER — doctor is `readOnly` and its plan is all
`probe`s today; mixing a `digest` in is a render change. Keep the score in
`report` only for v1. (Note the option; do not implement.)

---

## 5. Tests (vitest) — `tests/report/scorecard.test.ts`

Mirror `tests/report/local.test.ts` fixture shape (mkdtemp root, `ctx()` helper,
fakeRunner, makeHostAdapter). Assert behavior, not prose.

- **off-canon → undefined**: bare repo (no `RULE_ROUTER.md`) ⇒ `scorecardDigest(ctx())` is `undefined`; and `localPanels` length unchanged.
- **deterministic & byte-stable**: write a known canon (router + shared block +
  one in-sync bootloader via `sharedCanonicalBlockBody`), call twice, assert
  `digest.text` identical run-to-run (no dates/random).
- **scores the math**: a fixture passing 1/2 layering checks ⇒ `data.dimensions`
  layering `score === 50`; assert overall = weighted mean rounds correctly.
- **grade bands**: all checks pass ⇒ overall 100, `data.grade === "mature"`;
  craft a fixture landing at 84 vs 85 to assert the band boundary (lifted bands).
- **drift detection reuses canon**: write a bootloader whose managed block is
  mutated ⇒ `bootloaders-in-sync` check `passed === false` and its remediation
  appears in `text`.
- **budget reuse**: oversized context dir (> default budget) ⇒ the budget check
  in discoverability fails (assert via `data`), proving `scanContextBloat` reuse.
- **headline shape**: `describe` matches `/Harness maturity — \d+\/100 \((mature|solid|emerging|nascent)\)/`.
- **systematic remediation (doctor edit)**: extend `tests/doctor.test.ts` —
  assert the node-version FAIL branch detail contains an actionable hint
  (regex `/install Node 20/` or `/re-run/`).

Coverage target ≥ 80% of `scorecard.ts` (pure functions — easy to hit).

---

## 6. Posture fit

| Posture invariant | How the spec honors it |
|---|---|
| dry-run default / `--verify` read-only | scorecard is a `digest` — pure read, surfaces under both, mutates nothing |
| idempotent / non-destructive | no writes; the report artifact path is unchanged and already byte-stable |
| never mutates remote | pure local fs reads (existsSync/readIfExists/scanContextBloat) |
| cross-platform / Runner seam | NO process spawn at all — fs only; no `cmd /c` concern |
| TS ESM, zod, commander | no new CLI option, no new schema; `digest` already typed |
| many small files (200–400) | one new ~180-line file; `local.ts` +2 lines |
| match nearest peer | mirrors `guardrail.ts`/`quality.ts` (single `*Digest` fn, undefined off-data) |

No conflicts. The one judgment call: scope (5 dims, not paniolo's ~100 / 8) — and
that is the *correct* fit because aih scores its own fixed artifacts, not an
arbitrary corpus.

---

## 7. Risks

1. **Double-counting with existing panels.** Config panel already lists artifact
   presence; scorecard re-reads the same inventory. Mitigation: scorecard
   *aggregates into a score*, config *enumerates* — different altitude, both
   useful; acceptable. Don't remove the config panel.
2. **Score gaming / false confidence.** A 100 means "artifacts present + in
   sync", not "good rules content". Mitigation: headline says "maturity"
   (wiring), and the body lists failing checks — never implies content quality.
3. **Grade-band bikeshed.** mature/solid/emerging/nascent vs excellent/good/…
   — cosmetic; pick one, lock it in a test.
4. **paniolo license.** Confirm the source package's license before copying the
   threshold values + bands; low risk (short factual constants + a public
   `round(p/t*100)` formula) but attribute the source package in a header comment.
5. **Bootloader enumeration.** Scorecard must know which bootloader paths to
   drift-check; reuse `bootloaderPaths(detectedClis)` from canon rather than
   re-listing, or it will drift from the generator. (Design note for impl.)

---

## 8. Out of scope (explicit)

- paniolo's `evidence_level`/`verified_on`/arXiv `source_urls`/fixture tiers
  (E2–E5) — that is third-party auditor provenance, not self-scoring.
- The ~90 corpus checks (jsdoc-enforcement, ci-*-gates, secret-scanning-configured,
  agent-resource-budget-caps, llm-output-schema-validated, etc.).
- dzhechkov `benchmarkSkill` A–F per-skill grading — aih doesn't own a skill corpus.
- A doctor summary score (noted, deferred to a follow-up).
- Any new CLI command or `--strict` flag (could host the full corpus later).

---

# Spec: Config-as-source-of-truth + named repo templates + doctor --fix (blazity → aih)

Status: **scoped-down recommendation** after reading both codebases. Two of the three blazity
ideas are **redundant or actively conflicting** with aih's model; one is a **partial gap worth a
small, posture-respecting adoption**. Be honest: do NOT port blazity wholesale.

Source read (blazity `@blazity-atlas/ai-harness`, plain JS, no license header in the files read —
treat as "unknown/All-Rights-Reserved until LICENSE confirmed"; lift IDEAS and the path-alias DATA
TABLE, not verbatim code):
- `dd/_blazity-atlas_ai-harness/src/config.js` — `.ai/config.json` schema + `validateConfig` + alias resolution
- `…/doctor.js` — `collectDoctorFindings` / `applyFixes` / `classifyFindings`
- `…/init.js` — dirty-worktree gate (`gitStatus` → refuse unless `--force`)
- `…/templates.js` — `standard|library|app|monorepo|agency` path-alias tables
- `…/managed-blocks.js` — marker block (aih already has an equivalent)

aih target read:
- `src/doctor.ts` (VERIFY-only, fail-closed, probes only — NO `--fix`)
- `src/init/index.ts` + `src/init/phases.ts` (one-pass composition of leaf `command.plan(ctx)`)
- `src/config/settings.ts` (env `AIH_*` + flag overrides → `Settings`; `contextDir` single canonical dir)
- `src/scaffold/index.ts` (writes the one `contextDir`; no path-alias/multi-root notion)
- `src/internals/plan.ts` (Action model: write/probe/doc/exec/envblock/digest; `CommandSpec.alwaysVerify`)
- `src/internals/markers.ts` (`mergeManagedBlock` — aih's managed-block equivalent)
- `src/internals/git.ts` (`gitRead` through the Runner seam)
- `src/heal/index.ts` (the repair command; `alwaysVerify` = diagnose-by-default + apply under `--apply`)
- `src/workspace/index.ts` + `src/doctor.ts` (`.aih-workspace.json` marker, already a persisted-intent file)
- `src/internals/gitignore.ts` (**`.aih/` is git-ignored** generated output)

---

## 1. Honest verdict per idea

### (a) `.aih/config.json` source-of-truth (schemaVersion/contextDir/targets/paths) — **PARTIAL gap, adopt a NARROW slice**

What aih does today:
- Intent is **flag/env-driven** (`AIH_CONTEXT_DIR`, `--context-dir`, `--cli`, `--all-tools`, `--detect`,
  `--mcp-mode`). `loadSettings()` overlays env defaults with CLI overrides each run. There is **no
  persisted record** of "this repo was bootstrapped with context-dir=X targeting CLIs Y,Z".
- The closest persisted intent is **`.aih-workspace.json`** (workspace `repos` list + `dir`), which
  `doctor.ts` already reads (`workspaceRepos`) to drive per-child probes. So the *pattern* of "doctor
  reads a committed marker to know what to verify" **already exists** — just not for the single-repo case.
- `doctor.ts` re-derives `ctx.contextDir` from settings every run. If a user scaffolded with
  `--context-dir ai-coding` but later runs `aih doctor` without the flag, doctor checks the **default**
  `ai-coding`… which happens to match, but if they used a custom dir, `doctor` silently checks the wrong
  path. **This is the real, demonstrable gap.**

blazity's schema (config.js:51-69), for reference:
```json
{ "schemaVersion": 1, "template": "standard", "artifactRoot": ".ai",
  "paths": { "language": "LANGUAGE.md", "memory": "memory", "plans": "plans", ... },
  "pathAliases": { "docs/superpowers/plans": "plans", ... } }
```

**Conflict to call out:** blazity persists at **`.ai/config.json`** and treats `.ai` as the committed
artifact root. aih **git-ignores `.aih/`** (`internals/gitignore.ts`: `AIH_PATTERNS = [".aih/"]`) — it's
live output (history.jsonl, reports, usage.jsonl, graph.json). So a `.aih/config.json` in aih would be
**git-ignored and lost on clone** — the opposite of "source of truth". The committed-intent file in aih
must NOT live under `.aih/`. Put it at repo root as **`.aih-config.json`** (sibling of the existing,
committed `.aih-workspace.json`), or fold the fields INTO `.aih-workspace.json`'s single-repo form.

**Recommendation:** Adopt a **minimal persisted-intent marker** `.aih-config.json` recording ONLY what
aih re-derivation actually loses today: `schemaVersion`, `contextDir`, and `targets` (the resolved CLI
list). Do **NOT** port blazity's `paths`/`pathAliases`/`artifactRoot` map — aih has exactly ONE context
dir by deliberate design (`ctx.contextDir`), not eight named artifact subpaths. Porting the alias map
would import a whole "move misplaced files between doc roots" subsystem (blazity doctor.js:272-310) that
aih has no equivalent of and does not want (it's a docs-layout opinion, not an environment concern).

### (b) Named repo-shape templates (library/app/monorepo/agency) — **RECOMMEND AGAINST (redundant + off-posture)**

- blazity's templates (templates.js:10-42) are purely **doc-folder alias tables** — "in a library repo,
  `docs/api` maps to `research`". They exist ONLY to feed `pathAliases`. Since we're NOT adopting
  `pathAliases` (see above), the templates have nothing to configure.
- aih already does stack-shape detection **empirically** via `profile/scan.ts` (`scanRepo`, 20KB of real
  detection) and `workspace/` for the monorepo/multi-repo case. A static `template: "monorepo"` label is
  strictly weaker than aih's `detectChildRepos` + `.aih-workspace.json`.
- Adding a `--template` enum would create a second, lower-fidelity source of truth competing with
  `scanRepo`. That violates the "don't invent a redundant input" principle. **Skip entirely.**

### (c) `doctor --fix` (gated behind `--force` on dirty worktree) — **RECOMMEND AGAINST as `doctor --fix`; the capability already exists as `--apply` on the relevant leaves**

- aih **deliberately splits diagnose (read-only `doctor`) from repair**. `doctor.ts` is `readOnly: true`
  and emits only `probe` actions. Repairs live in the capability commands under `--apply`, and `heal`
  uses `alwaysVerify` to be diagnose-by-default-but-fixable.
- blazity's `doctor --fix` works because blazity's doctor is ALSO its scaffolder — `collectDoctorFindings`
  produces `fixable` findings whose `action` (write/mkdir/symlink/move) IS the scaffold (doctor.js:48-73,
  93-135). aih split these on purpose: `aih scaffold --apply`, `aih bootstrap-ai --apply`, etc. already
  ARE the deterministic repairs blazity bundles into `doctor --fix`. A `doctor --fix` in aih would
  **duplicate** `aih init --apply` / `aih scaffold --apply`.
- The honest gap is NOT "doctor can't fix" — it's "after `doctor` shows drift, the user has to know WHICH
  capability to re-apply." That's a **UX/remediation-hint gap**, solved by having each failing probe's
  `detail` already name the fix (doctor.ts already does this: `"… run: aih scaffold --apply"`,
  `"… run \`aih init ./${repo} --apply\`"`). So this is **already-done** in spirit.

**The one thing worth lifting from blazity here:** the **dirty-worktree gate logic** (init.js:27-36) —
*"refuse to apply deterministic repairs when the git worktree is dirty unless `--force`."* aih's `--apply`
path does **not** currently gate on a dirty worktree. That's a genuine safety improvement that fits the
posture (non-destructive, transactional). But it belongs as a **shared `--apply` preflight**, not as a
`doctor --fix` flag.

---

## 2. What to LIFT vs design fresh

| From blazity | Lift? | How |
|---|---|---|
| `.ai/config.json` schema shape | IDEA only | aih: `.aih-config.json` at root, fields `schemaVersion/contextDir/targets`. Drop `paths/pathAliases/artifactRoot`. |
| `validateConfig` (config.js:84-137) | NO (rewrite) | Use **zod**, mirror `config/settings.ts` style (`ContextDir` schema already exists there — reuse it). |
| dirty-worktree gate (init.js:27-36) | IDEA + logic | aih: shared `--apply` preflight using `gitRead(ctx, ["status","--porcelain"])`; refuse unless `--force`. |
| template alias tables (templates.js) | NO | Redundant with `scanRepo` / workspace. Skip. |
| `collectDoctorFindings` fixable/manual split | NO | aih already has probe verdicts (pass/fail/skip) + remediation hints in `detail`. |
| managed-blocks.js | NO | aih has `internals/markers.ts` already (superior: preserves EOL, note line). |

License note: the blazity source files read carry **no SPDX/license header**; the published package
license is unconfirmed. Since we are lifting only the **schema idea** and **dirty-gate idea** (facts /
short logic), re-expressed in aih's own zod + Runner idioms — **no verbatim copy** — attribution risk is
low. Add a one-line provenance comment ("schema shape inspired by @blazity-atlas/ai-harness") and confirm
LICENSE before any verbatim reuse. `verbatim_ok=false`.

---

## 3. aih file-level change list

### Slice A (recommended, M): persisted-intent marker `.aih-config.json` that doctor + re-runs read

**New file: `src/config/marker.ts`** (~120 lines). Mirror peer `src/config/settings.ts` (zod + fail-closed)
and the JSON-read pattern in `doctor.ts:workspaceRepos` / `internals/fsxn.ts:readIfExists`.

```ts
import { z } from "zod";
import { join } from "node:path";
import { readIfExists } from "../internals/fsxn.js";

export const AIH_CONFIG_FILE = ".aih-config.json"; // ROOT, committed (NOT under .aih/ which is gitignored)

// Reuse the SAME ContextDir constraints as settings.ts (extract to a shared zod fragment).
const AihConfig = z.object({
  schemaVersion: z.literal(1),
  contextDir: z.string().min(1).regex(/^[A-Za-z0-9._\-/]+$/),
  targets: z.array(z.string()).default([]), // resolved CLI list at bootstrap time
});
export type AihConfig = z.infer<typeof AihConfig>;

/** Read committed bootstrap intent, or undefined when absent/invalid (callers fall back to flags/env). */
export function readAihConfig(root: string): AihConfig | undefined {
  const raw = readIfExists(join(root, AIH_CONFIG_FILE));
  if (!raw) return undefined;
  try { return AihConfig.parse(JSON.parse(raw)); } catch { return undefined; }
}

/** The marker the bootstrap should persist (writeJson, merge:true — non-destructive). */
export function aihConfigJson(contextDir: string, targets: string[]): AihConfig {
  return { schemaVersion: 1, contextDir, targets };
}
```

**Edit `src/init/index.ts`** — append ONE `writeJson(".aih-config.json", aihConfigJson(ctx.contextDir,
resolvedTargets), "persist bootstrap intent (context-dir + targets) so re-runs/doctor read it", { merge:true })`.
Mirrors the existing `writeJson(".aih-workspace.json", …, { merge:true })` in `workspace/index.ts:44`.
Idempotent + non-destructive by construction (merge + same body = byte-identical).

**Edit `src/doctor.ts`** — before building probes, `const cfg = readAihConfig(ctx.root);` and use
`const dir = cfg?.contextDir ?? ctx.contextDir;` for the "canonical context dir" probe (doctor.ts:51-60)
and the workspace-child probe path. Add one probe: if a marker exists AND `cfg.contextDir !== ctx.contextDir`
(flag mismatch), emit a `skip` with a hint ("doctor is checking `<flag>` but this repo was bootstrapped
with `<cfg>` — omit --context-dir to use the committed value"). Closes the silent-wrong-path gap.

**Edit `src/commands/run.ts`** (the place that constructs `PlanContext` from `Settings`): when no explicit
`--context-dir` was passed, prefer `readAihConfig(root)?.contextDir` over the `"ai-coding"` default. Keep
flag > config > env > default precedence. (Confirm exact wiring in run.ts — not re-read here; it builds
ctx from loadSettings.)

### Slice B (recommended, S): shared dirty-worktree `--apply` gate (lifts blazity init.js:27-36 logic)

**New file: `src/internals/worktree-gate.ts`** (~40 lines). Peer: `internals/git.ts`.

```ts
import { gitRead } from "./git.js";
import type { PlanContext } from "./plan.js";

/** True when the git worktree has uncommitted changes (porcelain non-empty). undefined git → not dirty. */
export async function isWorktreeDirty(ctx: PlanContext): Promise<boolean> {
  const out = await gitRead(ctx, ["status", "--porcelain"]);
  return typeof out === "string" && out.trim().length > 0;
}
```

**Edit the executor (`src/internals/execute.ts`)** — in the `--apply` path, BEFORE writing, if
`isWorktreeDirty(ctx)` and not `ctx.options.force`, fail closed with the blazity-style message:
*"Refusing to apply with a dirty git worktree. Commit/stash changes or pass --force."* Add a `--force`
shared flag in `commands/index.ts:addSharedFlags`. This is the single highest-value, lowest-risk lift —
it makes every `--apply` (init/scaffold/bootstrap-ai/…) safe-by-default against clobbering uncommitted work,
and the existing `*.aih.bak` backups already cover the non-dirty case.

### NOT doing
- No `--template` flag, no `pathAliases`, no `artifactRoot` map, no `doctor --fix` subcommand.

---

## 4. Effort / priority / risks / tests

**Effort:** Slice A = **M**, Slice B = **S**. Combined ~ **M**.
**Priority (after grounding):** **med.** Slice B (dirty gate) is the strongest single item — argue to ship
it first/standalone. Slice A closes a real but narrow silent-wrong-path bug. The headline blazity ideas
(templates, doctor --fix, alias map) are **low/skip**.

**Risks:**
- `.aih-config.json` must be **committed** (not `.aih/`) or it's useless on clone — easy to get wrong;
  add a test asserting the path is repo-root and not matched by aih's gitignore patterns.
- Precedence ambiguity: explicit `--context-dir` must still win over the committed marker (don't trap a
  user who deliberately overrides). Test the full precedence ladder.
- Dirty-gate could surprise users who expect `--apply` to "just write." Mitigate with the `--force` escape
  hatch (same as blazity) and a clear message. Keep `report`/`track`/read-only commands EXEMPT (they don't
  hit the write path; verify they bypass the gate).
- Don't break the existing `.aih-workspace.json` consumer in doctor.ts — Slice A only ADDS a sibling file.

**Test plan (vitest, mirror existing `*.test.ts` around doctor/scaffold):**
1. `readAihConfig`: returns parsed config for a valid `.aih-config.json`; `undefined` for missing/invalid
   JSON/failed-zod (assert no throw — fail-soft).
2. `init --apply` writes `.aih-config.json` at ROOT with `{schemaVersion:1, contextDir, targets}`; second
   `--apply` is byte-identical (idempotent); merge preserves any extra user keys.
3. doctor reads the marker: scaffold with `--context-dir ai-coding`, then `aih doctor` with NO flag →
   context-dir probe checks `ai-coding` (from marker), `pass`. Without the fix it would check the default
   and the behavior is wrong — assert the new behavior.
4. doctor mismatch probe: marker says `ai-coding`, run `aih doctor --context-dir other` → emits the
   mismatch `skip`/hint, does not crash.
5. precedence: explicit `--context-dir foo` overrides marker `bar` (flag wins).
6. `isWorktreeDirty`: porcelain non-empty → true; empty → false; git absent (`spawnError`) → false.
   Use the injected Runner mock (no real git), per the Runner-seam rule.
7. `--apply` on a dirty worktree without `--force` → non-zero exit + refusal message, **nothing written**
   (assert no `*.aih.bak`, no target files). With `--force` → proceeds. Read-only commands unaffected.
8. Cross-platform: assert the marker path uses repo-root join and the gate routes git through `ctx.run`
   (no direct spawn) so the Windows `.cmd`/mock seam holds.

---

## 5. One-paragraph honest summary

Of blazity's three ideas, **two should be declined**: named repo templates are redundant with aih's
empirical `scanRepo`/workspace detection and only existed to feed a `pathAliases` map aih doesn't want;
and `doctor --fix` duplicates aih's deliberate diagnose/repair split (`doctor` read-only; `scaffold/init
--apply` ARE the deterministic repairs, and failing probes already print the exact fix command). The
**worthwhile** carve-outs are (A) a small COMMITTED `.aih-config.json` marker — sibling to the existing
`.aih-workspace.json`, explicitly NOT under the git-ignored `.aih/` — recording `contextDir`+`targets` so
`doctor` and re-runs stop silently checking the wrong context dir; and (B) lifting blazity's
dirty-worktree gate as a shared `--apply` preflight (`git status --porcelain` via the Runner seam, refuse
unless `--force`), which makes every aih write safe-by-default against clobbering uncommitted work.
