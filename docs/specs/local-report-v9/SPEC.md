# SPEC — v9 dashboard implementation

## 1. Architecture

Reuse the Phase-0 pattern (`src/report/v4.ts`): a renderer that **embeds a static shell
(CSS + chart JS) once, injects a typed `AIH_DATA` view-model, and a small hydrate step
binds it**, with server-side gating for honesty. Build it as a new module so the legacy
report and the `--v4` skin are untouched.

- **New module:** `src/report/v9.ts` exporting `buildAihDataV9(digests): AihDataV9` (pure,
  deterministic, no IO/clock — reads digest `.data` bags) and `reportHtmlV9(title, digests, opts)`.
- **Stylesheet/JS:** reuse the v4 design system (it already contains every component the v9
  layout needs: `donut`, `bars`, `mat`, `matrix`, `drift-*`, `hook-row`, `heatmap*`, `radar`,
  `cost-stack*` for the colorful usage bar, `anom-card` for the action/wins boards,
  `branches`, `timeline`, `pulse`, `callout`). Add only a small supplementary block:
  `.preview` (desaturate + "PREVIEW · not wired yet" badge), `.deltarow`, `.egress`, `.srv-row`.
  See `reference-v9.html`'s `<style>` for the exact supplementary CSS already written.
- **Flag:** add `--v9` to the report command (`src/report/index.ts`), modeled exactly on
  `--v4`: it forces `format = "html"` and routes the HTML path to `reportHtmlV9`. Legacy
  default unchanged. `--demo`/`--refresh`/`--open` compose with it as they do for `--v4`.
- **Determinism:** byte-stable output — no `Date.now()`/random in rendered HTML (timestamps
  are data from digests, formatted absolutely). Re-running `--apply` is a no-op diff.
- **Reference is the source of truth for markup/feel.** Match `reference-v9.html` section by
  section; the only difference is values come from `buildAihDataV9` (LIVE) or the demo set.

## 2. Honesty model (per panel state)
- **LIVE** — backed by a real digest today → render real values.
- **PREVIEW** — capability not built yet → render the card with `.preview` (desaturated +
  badge), using the demo dataset, so design intent shows but it never reads as real.
- **EMPTY/omitted** — LIVE panel whose data is absent on this run (e.g. off-canon, no git) →
  show the honest "not available / wire X" stub or omit; never zero-as-if-measured.
- Demo mode (`--demo`) shows everything populated from the demo dataset (clearly the demo view).

## 3. Panel inventory + data contract

Order matches `reference-v9.html`. `describe` = the digest whose `.describe` starts with that
string (read via the `bag(digests, prefix)` helper from `v4.ts`). State: 🟢 LIVE today ·
🟡 needs a new capability (CAPABILITIES.md) · 🔵 PREVIEW until its capability lands.

| # | Panel | State | Source / binding |
|---|-------|-------|------------------|
| HERO | Wiring score + Δ + worst axis + radar + "N actions this week" usage stat | 🟢 / 🟡 | score+radar from `bag("Harness maturity")` {overall, grade, dimensions[{name,score}]}; Δ-vs-last-run from history (🟡 needs `aih track`); usage stat from `aggregateUsage` event count (🟡 hook-gated) |
| ★ | **What to fix first** — High/Med/Low action board | 🟢 | Derive from `reportAdvisories` verdicts + `nextSteps` (`src/report/nextsteps.ts`, `advisories.ts`) + support findings. Map: advisory `fail`→high, `skip`→med; scorecard dim <50 → high; each item carries its exact `aih` command. **This is the spine.** |
| ✓ | **What aih unblocked** — remediation ledger + over-the-period | 🟢 | `aih heal` checks (cert trust chain / npm runtime / PATH / MCP pre-flight) + the run ledger `.aih/runs/`. See CAPABILITIES §4 (wiring, mostly real today). |
| 01 | Context + per-turn cost (merged) | 🟢 | `bag("Context footprint")` (bloat) + `bag("Per-turn context")` (loadgroups). Per-turn worst bundle vs budget is the headline; top files from bloat. |
| 02 | Activity — heatmap (Velocity is up) + LOC + repo + colorful Usage-by-CLI | 🟢 / 🟡 | heatmap+counts from `bag("Daily commits")` {commits, daily, daily90}; LOC from `bag("Lines of code")`; repo from `bag("Repo status")` {current,main,dirty,branches}; usage-by-CLI stacked bar from `aggregateUsage` per-tool (🟡 hook-gated — PREVIEW/partial until per-tool hooks) |
| 03 | Guardrails + ECC harness | 🟢 / 🟡 | enforcement (config present vs hook installed) from `bag("Configuration")` + scorecard guardrails checks + a real `.git/hooks` check; ECC inventory (agents/skills/rules/hooks/packs) 🟡 needs the **ECC-inventory scan** (CAPABILITIES §1); test ratio from `bag("Test coverage")` |
| 04 | Drift + coherence | 🟢 / 🔵 | **drift** 🟢 from scorecard `bootloadersInSync` / cli-coverage managed-block diff; **coherence matrix** 🔵 PREVIEW until the **coherence diff** (CAPABILITIES §2) |
| 05 | MCP plumbing + egress | 🟢 | per-CLI wiring from `bag("AI CLI wiring")` {rows[{cli,mcp{state,detail}}]}; servers + **egress** from `src/mcp/servers.ts` risk axes (classification/egress); pre-flight from `aih heal` mcp probe. No runtime call counts. |
| 06 | Adoption + tooling | 🟢 | `bag("Configuration")` (checks) + `bag("Tools installed")` (shell tools) + `bag("Machine tooling")` (runnable vs config-only CLIs) |
| 07 | Enterprise support — escalation tickets | 🟢 | support pipeline (`src/support/`): findings split self-fix/improvement/escalation; render the **redacted** copyable IT ticket. |
| 08 | Over the period — trends + outcome deltas | 🟡 / 🔵 | trends sparklines from history (`src/report/history.ts`, 🟡 needs `aih track`); **outcome deltas** (lead time, rework, time-to-green/MTTR) 🔵 PREVIEW until CAPABILITIES §3 |
| 09 | Skill ledger — heavy lifters + dormant | 🟡 / 🔵 | heavy lifters from `aggregateUsage.skills` (🟡 hook-gated); **dormant** 🔵 PREVIEW until the ECC-inventory scan can diff installed-minus-invoked (CAPABILITIES §1) |
| — | Footer methodology line | 🟢 | static: why cost/forecast omitted; velocity = activity not score; PREVIEW meaning; maturity = wiring |

## 4. Security / sharing (review-council asks — fold in)
- **Whole-report redaction** before it's safe to share: run the rendered HTML through the
  existing scrub (`src/support/redact.ts` / `src/guardrails/redact.ts` — secrets + `<home>` +
  key-aware argv). Top-files (01), tools/host inventory (06) can leak paths/fingerprint.
- **Guardrail enforcement, not presence:** "gitleaks config present but hook not installed" must
  flag red. Present ≠ enforced.
- **MCP egress first-class** (05): show none / local / vendor / third-party per server; flag
  third-party + hosted-remote.

## 5. Decisions already made (don't relitigate)
- Velocity (commits/LOC/streak) is **activity**, shown, never weighted into the score.
- Money/forecast: **out.** Usage replaces it.
- v9 is **additive behind `--v9`** until proven; flipping the default is a later, separate change.
- Reuse v4 CSS; do not restyle the loved look.
- Maturity radar relabeled "wiring," with Δ-vs-last-run.
