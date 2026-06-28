# Handoff — `aih report` v9 dashboard (the developer console)

**You are picking up a finalized UI design and making it real.** A multi-turn design
process (v4 → v9) plus a 5-lens review council converged on this layout. Your job is
to implement it against real `aih` data, on this isolated branch, fully tested, then
hand it **back for review** — it must **not reach `main`** until the report is right and
every gate is green.

## The deal (read first — these are hard rules)
1. **Branch isolation.** Work only on `feat/local-report-v9` (or child branches off it).
   **Never merge or push to `main`.** No PR-to-main. When done you open a **draft PR**
   (or produce a review packet) and stop — a human reviews before anything merges.
2. **Live-data-or-don't-render.** Never render demo/sample numbers as if they were real.
   A panel is one of: **LIVE** (real data), **PREVIEW** (visibly badged "not wired yet",
   desaturated), or **EMPTY/omitted**. This is the #1 trust rule from the review council.
3. **No cost, no forecast.** Cost/budget/$ and budget *forecasting* are deliberately
   out — unmeasurable locally and/or guesswork. "This week" is **usage** (activity), not cost.
4. **Honesty over polish.** Every panel states a finding and (where actionable) the exact
   `aih` command. The maturity number is **wiring** (present + in sync), never "quality."
5. **Gate on real exit codes** (see RUNBOOK) — never a piped tail. CI uses `biome ci`.

## The reference design
[`reference-v9.html`](reference-v9.html) is the **visual source of truth** — open it in a
browser. It's a static mockup (assembled by a throwaway script, realistic demo data). Your
job is to reproduce its layout/feel from real digests + a demo dataset. ⌘K opens a command
palette; the theme toggle is top-right.

## What the report tells (the arc)
**What aih unblocked** (origin value) → **what to fix next** (action board) → **current
health** (context, quality, drift, MCP, adoption) → **how it trends over the period**.

## Documents
| File | What |
|---|---|
| [SPEC.md](SPEC.md) | Architecture + per-panel data contract (what binds to which digest) |
| [CAPABILITIES.md](CAPABILITIES.md) | The 3 new capabilities to build (ECC scan, coherence diff, outcome/MTTR) + the wins-ledger wiring |
| [RUNBOOK.md](RUNBOOK.md) | Build order, commands, commit + handback discipline |
| [TEST-CRITERIA.md](TEST-CRITERIA.md) | Acceptance criteria + the gates + definition of done |
| [DEMO-DATA.md](DEMO-DATA.md) | The demo dataset (drives demo mode + the reference look) |

## Reuse what's proven
This branch descends from `feat/local-report-v4-phase0`, which already shipped a working
renderer pattern. **Study and reuse it** before writing anything new:
- `src/report/v4.ts` — the AIH_DATA injection + hydration pattern, digest reading via
  `describe` prefix, the exported hydrate function for testing.
- `tests/report/v4.test.ts` + `tests/report/v4-dom.test.ts` — unit + **happy-dom DOM** test pattern.
- `src/report/index.ts` — the `--v4` flag wiring (model `--v9` on it).
- `biome.json` — how the big generated template is excluded from lint.

The v9 layout differs from v4 (different panels, no money), so you will re-scope, not copy.

## Definition of done (short form — full list in TEST-CRITERIA.md)
- `aih report --v9 [--open|--demo]` renders the v9 layout from real data.
- Every panel is LIVE, PREVIEW-badged, or omitted — never fake-as-real.
- The 3 new capabilities exist, tested, gated (empty when no data).
- All gates green: typecheck · `biome ci` · vitest (incl. a happy-dom DOM test) · build · a live generation smoke.
- Legacy `aih report` is untouched (v9 is additive behind the flag).
- A draft PR / review packet is prepared. **Nothing merged to main.**
