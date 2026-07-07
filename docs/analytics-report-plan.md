# `aih report` — analytics dashboard implementation plan

_Status: ✅ shipped & verified — both tracks (E + P) plus D4 file output; on main
(`src/report/org.ts`, `org-render.ts`, `pricing.ts`; digest primitives in
`src/internals/plan.ts` / `execute.ts`). Date: 2026-06-24._

Consolidates the **org-analytics research note**
with the readable framing of the _"aih Dashboard Architecture: Personal Dev vs. Enterprise
Views"_ research PDF, keeping only what survives contact with the codebase. This is the
**Tier 1** slice the research note recommends: a local aggregation command, aggregate-first,
no per-developer instrumentation, no hosted service.

## 1. Decision

Build **`aih report`** (Tier 1). The Admin API *is* the published edition — `GET
/v1/organizations/analytics/skills` + `usage_report/claude_code` answer the entire stated ask
(top skills, tokens, cost, cache savings, accept/reject, block-rate) from **one org admin key,
zero per-dev opt-in**. That turns "build a SaaS" into "ship a command." Tier 2 (per-skill cost
via a shared collector) and Tier 3 (hosted SaaS) stay deferred; their aggregate-first scope,
privacy constraints, and trigger conditions are tracked in
[research/deferred-analytics-tiers.md](research/deferred-analytics-tiers.md).

## 2. Adopted from the PDF (the good parts)

- **Dual-audience framing** — dev-velocity view vs. fleet-governance view. Kept as the
  product north star; the dev view is **roadmap**, not this slice (see §6).
- **ROI centered on cache savings** as the one defensible dollar figure (formula corrected, §5).
- **Capabilities Distribution** — rank skills by usage to spot training/architecture gaps.
- **Tooling Saturation** — adoption across Claude Code / ECC / Kiro / Cursor; surface idle seats.
- **Tiered rollout** (local key → team collector → hosted) — already the research note's spine.
- **Privacy stance** — aggregate-first, redacted, no raw prompt/keystroke streaming.

## 3. Not carried forward (PDF claims the code contradicts)

| PDF claim | Reality | Resolution |
|---|---|---|
| Personal console runs `localhost:4200` / `aih status --live` | `aih status` is a static `existsSync` presence inventory; no `--live`, no server ([status.ts](../src/status.ts)) | Dev view is a future roadmap item, present-tense removed |
| "Aggregates counts of blocked prompts" from guardrails | gitleaks/sandbox/MCP gates **prevent** but log no block event | Block-rate comes from Claude Code OTEL `code_edit_tool.decision` (`decision=reject`), not aih configs |
| `~/.aih/metrics.jsonl` dev metrics store | Only `.kiro/metrics.jsonl` exists (Kiro hook, `{ts,sha,subject}`, no tokens/skills) ([kiro/content.ts:89](../src/kiro/content.ts)) | aih stores nothing centrally; report ingests fetched Admin-API JSON |
| Context files `.ai-context` / `.clauderules` | `.clauderules` is fictional; context dir default is `ai-coding/` | n/a (dev-view detail, dropped) |
| ROI formula "mathematically bulletproof" | Ignores cache-**write** premium + is counterfactual | Corrected & labeled avoided-cost (§5) |

## 4. Ground truth — telemetry gap status (research note was stale)

The research note's "three gaps" are now **all three fixed** (verified against code today):

1. ~~Exports nothing~~ → **FIXED**: `OTEL_METRICS_EXPORTER` / `OTEL_LOGS_EXPORTER` both pinned
   to `otlp` ([templates.ts](../src/telemetry/templates.ts)).
2. ~~`EVENT_TYPES` stale (5, missing `skill_activated`)~~ → **FIXED**: 23 types incl.
   `skill_activated` ([templates.ts](../src/telemetry/templates.ts)).
3. ~~Fetcher hits `usage_report/claude_code` only, not `/analytics/skills`~~ → **FIXED**: the
   generated `fetch-analytics.mjs` now queries both endpoints and emits `{ usage_report, skills }`
   ([templates.ts](../src/telemetry/templates.ts); see §7 Track E.1). This was the leads' #1 metric
   and the prerequisite for the report's skills panel.

## 5. The first slice

### 5a. Close gap #3 — skills-analytics fetch _(✅ shipped — see §7 Track E.1)_

Extend the generated `fetch-analytics.mjs` (or add a sibling) to also query
`https://api.anthropic.com/v1/organizations/analytics/skills` (Enterprise plan; 3-day
finalization lag; per skill: `skill_name`, `distinct_user_count`, per-surface session counts).
Same operator gating as today: prints curl, only calls out on `--run`. The network boundary
stays inside this standalone script — **aih itself never calls a remote system.**

### 5b. `aih report` — local aggregation + digest

A capability that **ingests already-fetched Admin-API JSON** and renders a digest. It does not
fetch (see §6, decision D2). Reuses existing primitives: a `doc` action carries the rendered
terminal digest; `--apply` optionally writes it to a file.

**Shape** (mirrors `CommandSpec`, registered in `src/commands/index.ts`):

```
aih report [root] [--org <export.json>] [--format terminal|md|html] [--json]
```

**Computed metrics** (only fields the API actually returns):

| Panel | Source | Notes |
|---|---|---|
| Top skills | `analytics/skills` | by `distinct_user_count` + session counts |
| Tokens by type/model + cost | `usage_report` | `type=input\|output\|cacheRead\|cacheCreation`, `estimated_cost` |
| **Cache savings** | computed (§ below) | the one defensible dollar number, labeled avoided-cost |
| Accept / reject | `tool_actions` / `code_edit_tool.decision` | productivity signal, not dollars |
| LOC · commits · PRs | `usage_report` | vanity-trap: pair with counter-signal, never LOC alone |
| Block-rate | `decision=reject` | from Claude Code, **not** aih guardrail configs |
| Tooling saturation | presence + per-CLI | idle-seat view across Claude/ECC/Kiro/Cursor |

**Corrected cache-savings (net, avoided-cost):**

```
cache_efficiency = cacheRead / (cacheRead + input)            # defensible %
gross_avoided    = cacheRead   × (P_input − P_cacheRead)      # read-side win
write_premium    = cacheCreate × (P_cacheWrite − P_input)     # the cost of caching
net_savings      = gross_avoided − write_premium
```

`P_cacheRead ≈ 0.1×`, `P_cacheWrite ≈ 1.25×` (5-min) / `2×` (1-hour) of `P_input` — **pull exact
multipliers from current Anthropic pricing, do not hard-code these.** Always rendered as an
estimate ("$Y avoided at the uncached rate"), never as proven incurred-then-saved cost.

## 5c. Personal dev view (local) — honest scoping

Same `aih report` command, **local scope** (default). Reads only this workstation/repo — no
network, no org key. The dev-velocity view is a **static digest** (`aih report`, especially the
v9 HTML artifact), not a localhost console or long-running server; D6 below locks that decision.
What's actually buildable today vs. blocked on a data source:

| Panel | Buildable now? | Source |
|---|---|---|
| **Context-bloat tracker** | **Yes** | Size + token-estimate the agent context the repo loads: `CLAUDE.md`/`AGENTS.md`/`GEMINI.md`, the `--context-dir` tree, `.cursor/rules/*.mdc`. Warn past a budget. No external dep, no network. |
| Path / VDI / SSL health | **Already exists** | `aih doctor` / `aih status` probes — **reuse, don't rebuild**; report points at them. |
| Local token / cache economy | **Data-gated live** | Reads optional token/cache counters from the gitignored `.aih/usage.jsonl` sink. Empty sink stays an honest stub and points at `aih report --org <export>`. |
| Skill execution ledger | **Data-gated live** | Reads local skill-invocation rows from `.aih/usage.jsonl`; v9 no longer shows demo skill rows when the sink is empty. |

v1 personal view = **context-bloat (real) + health pointers** plus data-gated local cache/skill
panels. Empty local sinks render explicit stubs; we do not fake data.

## 6. Decisions (locked 2026-06-24)

- **D1 — Command surface → new `aih report`, two scopes.** Local (default) for the personal
  view; `--org <fetched.json>` for the enterprise digest. `status` stays a pure presence
  inventory and `doctor` keeps health verification — `report` owns analytics only. One cohesive
  digest engine, two data sources. _(Rationale: `status` is 9 `existsSync` probes that never
  read file contents; folding token-sizing + JSON aggregation into it would muddy a deliberately
  dead-simple command. Many small cohesive commands > one overloaded one.)_
- **D2 — Network seam → fetcher only.** `aih report` reads locally-saved JSON; it never calls
  out. The standalone `fetch-analytics.mjs` stays the sole network boundary. aih's "never calls
  a remote system" invariant stays intact.
- **D3 — Build both tracks in parallel.** Enterprise (org digest) and Personal (local digest)
  share the command + render engine; see §7.
- **D4 — Output → ✅ DONE.** terminal + `--json`; plus `--format md|html` writes a single combined
  artifact under `--apply` to `.aih/reports/<scope>-report.<ext>` (`--out` overrides). _Deviation
  from the plan's literal `<context-dir>/reports/`: writing into the context dir would make the
  report re-scanned as agent context — inflating the footprint it measures — and break idempotent
  re-apply. `.aih/reports/` sits outside the scanned set and stays byte-stable (no timestamp)._
- **D5 — Output rendering → R2 (RESOLVED, built).** _Found while building the slice:_ the
  harness `doc` primitive prints only a headline (`describe`); doc **body** text was dropped from
  `PlanResult` unless written to a file, and `--json` carried no structured data. **Built R2:** a
  new `digest` action kind → `PlanResult.digests` → `summarizeResult` prints the body verbatim and
  `--json` carries structured `data` (`src/internals/plan.ts`, `src/internals/execute.ts`).
  `ActionKind` now enumerates 6 kinds; `aih report` emits a digest. Serves both the personal
  terminal view and the enterprise machine-readable feed. _(R1 — write to a `*.md` artifact — was
  the alternative; rejected: a read-only report shouldn't need `--apply` to show its table.)_
- **D6 — Dev-velocity view → static digest, not a live server.** The personal view is a
  point-in-time `aih report`/`aih report --v9` digest rendered from local files. It must not add a
  `localhost` service, websocket, daemon, or `aih status --live`; `aih status` remains the static
  presence inventory named in D1. "Live" panels are honestly gated snapshots: `.aih/usage.jsonl`
  (written only after `aih usage --apply` hooks are installed) powers token/cache, skill-ledger,
  and usage-by-CLI panels; `.aih/history.jsonl` (written by `aih track --apply`) powers trends and
  deltas. Missing or empty sinks render explicit PREVIEW/empty stubs with setup commands, never
  demo values, zeros-as-measured, or implied background collection.

## 7. Parallel build plan

**Shared spine — ✅ DONE.** `digest` output channel (action kind + `PlanResult.digests` +
`summarizeResult` verbatim render + `--json data`); `aih report` `CommandSpec` registered in
`commands/index.ts`; render engine on `internals/render.ts`. _(Remaining: `--org <json>` /
`--format` flags land with Track E.)_

**Track P — Personal (local digest) — ✅ DONE.**
1. **Context-bloat tracker ✅** — sizes + token-estimates the loaded context; budget warning; `data`.
2. **Configuration + tooling ✅** — repo artifact presence (reuses `status`'s exported `inventory()`,
   no rebuild) + local AI-CLI saturation (reuses a new config-only `detectClisByConfig`). This also
   absorbs the tooling-saturation item deferred from Track E.
3. **Cache/skill economy ✅** — live from `.aih/usage.jsonl` when local token/cache or
   skill-invocation samples exist; empty stubs point at `aih report --org`.

The local `aih report` composes 4 digests (footprint + config + tooling + economy); the org scope
stays one. Dogfooded end-to-end — the tooling panel detected 7/11 CLIs on the dev box.

**Track E — Enterprise (org digest, `--org <fetched.json>`) — ✅ DONE.**
1. **Fetcher ✅** — `fetch-analytics.mjs` now queries `/analytics/skills` too and emits
   `{ usage_report, skills }` (same `--run` gate; `node --check`-valid; curl auditable).
2. **Aggregator ✅** — `src/report/org.ts` tolerant adapter → top skills, tokens by type
   (per-model in `data`), cost, accept/reject.
3. **Cache-savings ✅** — net-of-write formula + rate-independent efficiency %
   (`src/report/pricing.ts`), rendered as a labeled estimate.
4. **Block-rate ✅** from `tool_actions` accept/reject.
   _Deferred: tooling-saturation across CLIs — not in the Admin-API export; it belongs with local
   presence detection (a `status`-adjacent panel), so it rides with Track P._

**Adapter caveat:** the exact Admin-API wire shape is external/versioned; the adapter is tolerant
of field-name variants and `{data}` / `{data:[{results}]}` / bare-array nesting. Confirm against a
live `fetch-analytics.mjs --run` sample; if a field is renamed upstream, `src/report/org.ts` is the
single place to adjust.

**Converge:** README command row ✅; research-note cross-link ✅; D4 `--format md|html` file output ✅.

## 8. Post-ship follow-ups (2026-06-24) — ✅

- **Pricing verified** against platform.claude.com/docs/en/about-claude/pricing. Opus (4.1-era
  $15/$75 → **4.5 $5/$25**) and Haiku ($0.80/$4 → **4.5 $1/$5**) were stale and corrected; Sonnet
  was already right (`src/report/pricing.ts`). Net savings on the sample export dropped ~$128 → ~$48.
- **Per-model sub-panel** — the org digest now lists tokens + cache-served % per model
  (`src/report/org-render.ts`).
- **`.aih/` git-ignored** — added to the aih-managed `.gitignore` block so generated reports aren't
  committed (`src/internals/gitignore.ts`; written by `scaffold` / `bootstrap-ai` / `init`, and by
  `aih report --format md|html` itself when the artifact lands in `.aih/` — so a standalone report
  run can't leave sensitive aggregate data as an untracked file).
