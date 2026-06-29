# TEST CRITERIA — v9 acceptance + gates

## A. Hard gates (all must be green; paste results in HANDBACK.md)
| Gate | Command | Pass = |
|---|---|---|
| Typecheck | `npm run typecheck` | exit 0, no errors |
| Lint (CI) | `npx @biomejs/biome ci src tests` | exit 0, no warnings |
| Unit + DOM tests | `npm test` | exit 0, all files pass; suite count ≥ prior + new |
| Build | `npm run build` | exit 0, dist emitted |
| Live generation | `node dist/cli.js report --v9 --apply --out <f>` | exit 0; file written |
| Legacy untouched | existing `aih report` / `--v4` tests | still green (no regressions) |

## B. Required tests (new)
1. **`tests/report/v9.test.ts`** — `buildAihDataV9`:
   - maps each LIVE digest to its panel data (scorecard→hero radar/score; bloat+loadgroups→
     context; velocity→activity; cli-coverage→MCP+drift; config/tools/machine→adoption;
     support→escalation; heal+run-ledger→wins).
   - **gating:** off-canon (no scorecard) → hero radar empty/omitted, not faked; no git →
     activity omitted; not-built capability → its panel flagged PREVIEW.
2. **`tests/report/v9-dom.test.ts`** (happy-dom, pattern from `v4-dom.test.ts`) — execute the
   page/hydrate and assert:
   - LIVE panels show real values; **PREVIEW panels carry the `.preview` class + badge**;
   - the action board (★) renders ranked items; the wins board (✓) renders remediation rows;
   - an EMPTY case (e.g., no events) renders the honest stub, not zeros;
   - **no uncaught errors** during hydration.
3. **Per-capability unit tests** (CAPABILITIES.md): ECC scan counts + dormant diff; coherence
   agreement %; outcome/MTTR from synthetic ledger; wins from heal verdicts. Each: real input →
   value, empty input → undefined.
4. **Determinism test:** `reportHtmlV9` over the same digests twice → byte-identical.

## C. Coverage
- ≥ 80% on new modules (`v9.ts` + the new capability digests), per project testing rules.
- Behavior-focused (data mapping, gating, honesty), not snapshot-brittle.

## D. Per-panel acceptance (each panel: LIVE-bound OR honestly gated)
- **Hero:** wiring score + radar from real scorecard; labeled "wiring," not quality; Δ-vs-last-run
  shows or degrades gracefully; usage stat is activity (not cost).
- **★ Action board:** items derived from real advisory/nextsteps verdicts; ranked High/Med/Low;
  each has a runnable `aih` command; **empty state** when nothing to fix.
- **✓ Wins:** remediation items from real heal verdicts (cert/npm/PATH/MCP); cumulative from run
  ledger; never-broken = "n/a", not a fake win; "run `aih heal`" stub when heal never ran.
- **01 Context:** per-turn worst bundle vs budget is the headline; full corpus is secondary.
- **02 Activity:** heatmap + LOC + repo from real git; usage-by-CLI honest (partial/PREVIEW until
  per-tool hooks); no streak weighted into any score.
- **03 Guardrails+ECC:** enforcement flags **present≠installed** red; ECC inventory LIVE once the
  scan exists else PREVIEW; test ratio labeled "file ratio, not line coverage."
- **04 Drift+coherence:** drift LIVE; coherence matrix PREVIEW until the diff capability.
- **05 MCP:** wiring + pre-flight LIVE; **egress** column present (none/local/vendor/third-party),
  third-party flagged; no runtime call counts.
- **06 Adoption:** checks + tools + runnable-vs-config CLIs, all real.
- **07 Enterprise support:** escalation ticket is **redacted** and copyable; findings split.
- **08 Over the period:** trends LIVE once `aih track` hooked else stub; outcome deltas PREVIEW
  until the capability.
- **09 Skill ledger:** heavy lifters from real invocations (partial); dormant PREVIEW until ECC scan.

## E. Honesty + safety (review-council non-negotiables)
- No demo/sample value renders as real in LIVE mode (grep the output: PREVIEW panels must carry
  the badge; LIVE numbers trace to a digest).
- No cost/$ or budget-forecast anywhere.
- Whole rendered report passes redaction (no secrets, `<home>` scrubbed) — add a test asserting a
  seeded secret/home path is scrubbed from the HTML.
- Determinism: re-render is byte-stable.

## F. Definition of done
- [ ] `aih report --v9` (+ `--open`/`--demo`/`--refresh`) renders the v9 layout from real data.
- [ ] Every panel LIVE, PREVIEW-badged, or honestly omitted.
- [ ] CAPABILITIES §1–§4 implemented + tested; their panels flipped to LIVE (or justified PREVIEW).
- [ ] All §A gates green; §B tests present; §C coverage met.
- [ ] Legacy report + `--v4` unchanged.
- [ ] Redaction pass done; determinism verified.
- [ ] Draft PR opened (not merged) + `HANDBACK.md` written. **Nothing on `main`.**
