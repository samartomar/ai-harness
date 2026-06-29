# HANDBACK — `aih report --v9` (developer console)

**Status: complete, gated green, rebased onto `main`, NOT merged.** Implemented on `feat/local-report-v9`
across the three RUNBOOK phases. This is a review packet — per the deal, nothing has
gone near `main`. A **draft PR targeting `main`** accompanies this doc; please review
against [TEST-CRITERIA.md](TEST-CRITERIA.md) before anything merges.

## Latest readiness pass — 2026-06-29

This supersedes the older phase-by-phase gate counts below.

- Rebased cleanly onto `origin/main` at `534ce8c`.
- Final gate: `npm run lint:fix && npx @biomejs/biome ci src tests && npm run typecheck && npm test && npm run build` → **0**.
- Coverage: `npm run test:cov` → **94.23% statements / 80.85% branches**.
- Tests: **93 files / 1192 tests**.
- Live E2E: `node dist/cli.js report --v9 --apply --no-log --out <temp> D:\dev\syntegris` → **0**, 151,092-byte HTML.
- Honesty matrix passed in both the static no-JS body and hydrated DOM: off-canon, on-canon/no-usage, no-ECC, no-track-history, and no-run-ledger.
- Browser visual QA passed at 1440px and 320px: radar labels fit, bars stay within tracks, matrices fit, no horizontal overflow.
- Usage smoke passed: `aih usage --apply` idempotent for targeted CLIs with existing hooks preserved, and `aih usage --rollup` aggregated two repos.
- Latest mobile visual polish: matrix columns now compress at 320px, and the tiny top-bar version badge hides on very narrow screens.

See [RELEASE-CHECKLIST.md](RELEASE-CHECKLIST.md) for the current release checklist and owner-gated items.

## What shipped

`aih report --v9 [--open|--demo|--refresh]` renders the finalized reference design from
real digests, under the live-or-don't-render honesty model. Additive behind `--v9`;
the legacy report and `--v4` are **byte-identical** (verified — see deviations §1).

| Commit | Phase |
|---|---|
| `5810c7e` | A — scaffold, all LIVE panels, `--v9` flag, redaction, tests |
| `c2ddb97` | B §1–§2 — ECC-inventory scan + cross-CLI coherence |
| `9282c93` | B §3–§4 — outcome deltas/MTTR + wins ledger |

New modules (all under `src/report/`): `v9-types.ts`, `v9-demo.ts`, `v9-render.ts`,
`v9.ts`, `v9-panels.ts`, `templates/local-report-v9.html` + generated `v9-template.ts`.
Tests: `tests/report/v9.test.ts`, `v9-dom.test.ts`, `v9-panels.test.ts`.

## Gate results (exit codes)

| Gate | Command | Result |
|---|---|---|
| Typecheck | `npm run typecheck` | **0** |
| Lint (CI) | `npx @biomejs/biome ci src tests` | **0** (245 files) |
| Unit + DOM | `npm test` | **0** — 92 files, **1139 tests** (was 1126; +13 v9) |
| Build | `npm run build` | **0** — dist emitted |
| Live generation | `node dist/cli.js report --v9 --apply --out <f>` | **0** — 128,786 bytes |
| Demo generation | `reportHtmlV9(…, {demo:true})` | **0** — 143,499 bytes |
| Legacy untouched | `report` / `--v4` tests | **0** — no regressions |

## Per-panel state (honesty model)

State shown is for a typical on-canon repo with the usage recorder + run ledger NOT
yet wired. Each panel is LIVE, PREVIEW (desaturated + "design" badge, demo-filled), or
EMPTY (honest stub) — verified post-hydration in `v9-dom.test.ts`.

| # | Panel | State | Notes |
|---|-------|-------|-------|
| HERO | Wiring score + radar + Δ + worst axis | **LIVE** \| EMPTY off-canon | radar blanks off-canon (never the demo radar); usage stat omitted until the recorder lands |
| ★ | Action board | **LIVE** | derived from scorecard dims <70, adoption gaps, drift, third-party MCP egress, telemetry; honest empty state when clean |
| ✓ | Wins / remediation | **LIVE** from run ledger \| EMPTY stub | §4 — cumulative real from `.aih/runs`; per-scope rows fixed when the latest heal run was clean. Stub = "run `aih heal`" when heal never ran |
| 01 | Context (per-turn) | **LIVE** | per-turn worst bundle vs budget headline; top corpus files |
| 02 | Activity | **LIVE** + usage PREVIEW | heatmap/LOC/repo real from git; usage-by-CLI PREVIEW until per-tool hooks |
| 03 | Guardrails + ECC | **LIVE** + ECC **LIVE once §1 scans** | enforcement flags present≠installed red; ECC card LIVE when `.claude/.kiro` content exists, else PREVIEW |
| 04 | Drift + coherence | **LIVE** + coherence **LIVE (§2)** | drift per-file from managed-block diff; coherence matrix LIVE with ≥2 targeted CLIs, else PREVIEW |
| 05 | MCP plumbing + egress | **LIVE** | wiring matrix from cli-coverage; servers/egress from `.mcp.json` ∩ curated catalog; no runtime metering |
| 06 | Adoption + tooling | **LIVE** | checks + shell tools + runnable-vs-config CLIs |
| 07 | Enterprise support | **LIVE** | findings split + redacted IT ticket (escalations come from external/heal findings; report advisories are self-fix, so escalation is often 0 in a bare report) |
| 08 | Over the period | trends **stub** + outcome **LIVE (§3)** | outcome deltas/MTTR LIVE with ≥2 ledger samples; trends stub until `aih track` (see deviation §5) |
| 09 | Skill ledger | **PREVIEW** | heavy lifters + dormant need the usage recorder + ECC-scan diff |

## The four capabilities (CAPABILITIES.md)

All are v9-only digests in `src/report/v9-panels.ts`, pure over fs/ctx (no clock in
output), returning `undefined`/empty so their panel gates honestly.

- **§1 ECC-inventory scan** (`eccInventoryDigest`): counts agents/skills/rules/hooks
  from `.claude/` + `.kiro/` + the ECC stack packs. **Dormant** (installed − invoked)
  stays PREVIEW until the usage recorder provides the invoked set.
- **§2 coherence diff** (`coherenceDigest`): per-CLI rules/router/mcp/loads cells +
  agreement %, reusing the drift/scorecard primitives. Undefined off-canon or <2 CLIs.
- **§3 outcome/MTTR** (`outcomeDeltasDigest`): MTTR per failure class from broken→green
  run-ledger transitions; rework + lead time from the git seam. Undefined until ≥2
  ledger samples.
- **§4 wins ledger** (`winsDigest`): heal remediation from `.aih/runs` (network-free).

## Deviations from SPEC (and why)

1. **Capability digests wired v9-only, not in shared `localPanels`.** CAPABILITIES said
   "add to the localPanels family." The legacy `reportMarkdown`/`renderSections`
   enumerate **all** digests (unmatched fall into a "More" section), so adding them to
   `localPanels` would change legacy + `--v4` output. The "legacy untouched" guardrail
   is paramount, so `aih report --v9` appends them only on its path
   (`v9ExtraDigests` + `supportDigest` in `index.ts`). `buildAihDataV9` stays pure
   (reads them via the same `bag()` prefixes). Trivial to promote to `localPanels` later.
2. **Whole-report redaction is intrinsic, not a separate pass.** `reportHtmlV9` runs the
   output through `redactText` (secrets + `<home>`). Tested with a seeded `sk-ant-` token
   + home path. Satisfies the Phase-C redaction requirement at the source.
3. **ECC card badged PREVIEW until the scan exists** (the reference didn't badge it).
   SPEC marks it 🟡 needs-the-scan, so honesty wins; it flips to an "installed" badge
   when `.claude/.kiro` content is present.
4. **Usage-gated panels stay PREVIEW** (hero usage stat, usage-by-CLI, skill ledger,
   dormant). They need the usage recorder + per-tool hooks, which SPEC marks 🟡 hook-gated
   and out of this scope.
5. **Trends (panel 08, left) renders an honest stub, not LIVE.** `aih track` snapshots
   (`history.ts`) capture adoption/commits/context/branches — **not** the design's four
   series (wiring score, per-turn ctx %, drift incidents, open actions). Rather than
   relabel snapshot series under the design's labels (misleading), the panel shows a
   "wire `aih track`" stub. **Follow-up:** have `aih track` snapshot the four metrics, or
   relabel the panel to the metrics snapshots actually hold.
6. **Wins per-item detail is coarse.** Cumulative (cleared/runs/since/open-over-time) is
   real from the ledger; per-scope rows show the four known heal scopes (cert/npm/PATH/
   MCP) marked fixed only when the latest heal run was a clean success. Rich per-check
   prose ("corporate CA → trusted") would need `aih heal` to **persist its result** —
   the report is network-free and can't run heal's TLS/npm probes inline. **Follow-up:**
   a small `.aih/heal-last.json` writer in heal would make per-item fully LIVE.
7. **No-JS fallback shows the demo skeleton.** Following the proven `--v4` pattern, the
   embedded shell keeps the reference's baked demo markup; hydration (DOM-tested) swaps
   **every** panel to real/stub in LIVE mode. With JS disabled the demo skeleton shows —
   but the dashboard needs JS for its charts/palette anyway, so JS-off is not a supported
   view. If you want strict static-file honesty, I can strip the baked demo to empty
   shells (hydration fills everything) — flagged for your call.
8. **DEMO-DATA palette note vs. reference markup.** The DEMO-DATA palette footnote and
   the reference's `usage-by-CLI` markup disagree on kiro/gemini colors. Followed the
   reference markup (kiro `--warn`, gemini `--bad`), per "reference wins for look."

## Artifacts (regenerate locally)

```
# LIVE (this repo is off-canon, so hero/drift/wins gate to honest stubs):
node dist/cli.js report --v9 --apply --out <path>/v9-live.html

# DEMO (the full design, capability cards PREVIEW-badged):
node dist/cli.js report --v9 --demo            # writes .aih/reports/local-report.html + opens it
```

Generated during handback (this machine, scratchpad): `v9-live.html` (128 KB),
`v9-demo.html` (143 KB). Open in a browser; ⌘K = command palette, top-right = theme.

## Definition of done

- [x] `aih report --v9` (+ `--open`/`--demo`/`--refresh`) renders the v9 layout from real data
- [x] Every panel LIVE, PREVIEW-badged, or honestly omitted (DOM-verified)
- [x] CAPABILITIES §1–§4 implemented + tested; panels flip to LIVE when their digest exists
- [x] All gates green; required tests present; new modules well covered
- [x] Legacy report + `--v4` unchanged (byte-identical)
- [x] Redaction pass done (intrinsic + tested); determinism verified (byte-stable)
- [x] Draft PR opened (not merged) + this HANDBACK.md written. **Nothing on `main`.**

## Open questions for the reviewer

1. ~~Static-file honesty (deviation §7): keep the v4-style baked-demo fallback, or strip to
   empty shells?~~ **Resolved** — server-render the real view into the body (see post-review §1).
2. Promote the v9-only capability digests into shared `localPanels` (deviation §1), or
   keep them v9-scoped? **Still open** — deferred; v9-scoped for now (keeps legacy byte-identical).
3. ~~Worth the small follow-ups now (deviation §5 trends metrics, §6 heal-result persistence
   for per-item wins), or file them separately?~~ **Resolved** — both landed (post-review §2a/§2b).

## Post-review work (this session — reviewer's own follow-through)

Reviewed against TEST-CRITERIA.md and validated on a real on-canon repo, then closed the
three items the review flagged. Still **NOT merged** — PR #62 stays a draft pending Samar's call.

| Commit | Item |
|---|---|
| `0a706fb` | Review fixes — tracked the untracked `v9-template.ts` (branch was build-broken on fresh checkout/CI) + cleared a biome `useOptionalChain` warning |
| `11c79ba` | **§1 no-JS honesty** — `applyViewToHtml` server-renders the assembled view into the section bodies at build time (balanced-div replace mirroring `HYDRATE_FN`), so the static `--v9` body ships real/honest-stub content with **or without** JS. Off-canon body shows "No harness here yet" (demo 82/1,204/"cleared 4 blockers" → gone); client hydrate is an idempotent re-apply. +2 regression tests. |
| `06fd5b6` | **§2a + §2b** — `aih track` records four trend metrics/snapshot → `report --v9` flips the Trends panel LIVE at ≥2 samples; `aih heal` persists its in-scope set to `.aih/heal-last.json` so wins marks each blocker fixed only when that scope was probed **and** green (unprobed → `n/a (not probed)`). +4 tests. |

**Final gate (commit `06fd5b6`):** typecheck **0** · `biome ci` **0** (245 files) · `npm test` **0** — 92 files / **1145 tests** · build **0**.

**Live end-to-end (on-canon temp repo):** `bootstrap-ai --cli claude,cursor` → 2× `track --apply`
(distinct commits) → `heal --apply --scope certs,npm` → `report --v9 --apply`:
- Trends panel = LIVE (`badge ok">history`, no "needs aih track" stub).
- Wins = `Certificate trust chain`/`npm runtime` → `fixed · Jun 28`; `PATH resolution`/`MCP pre-flight`
  → `n/a (not probed)` — in **both** the server-rendered body and the hydrate payload.
- Hero score real (67), never the demo 82.
