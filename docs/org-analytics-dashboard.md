# Org analytics dashboard — research & design note

_Status: research complete, awaiting a scope decision. Date: 2026-06-24._

**Goal.** In an org where many developers use aih-bootstrapped AI coding tools, engineering
leads want to see how it helps: which skills are used most, usage volume, token consumption
vs. savings, org-level policy blocks, and similar signals — so they can give better feedback.
The question: what does it take to make that dashboard real, and is a hosted "published
edition" needed?

## Bottom line

**No published edition is needed to satisfy the stated ask — for Claude Code orgs, Anthropic
already hosts the multi-tenant aggregation.** Claude Code exposes skill-name-level usage three
ways: a `skill.name` attribute on OTEL token/cost metrics, a `claude_code.skill_activated`
event, and a **Skill Usage Analytics Admin API** (`GET /v1/organizations/analytics/skills`,
Enterprise plan). The leads' #1 ask ("which skills are most used") is answerable **org-side from
one admin API key, with zero per-developer instrumentation**. That single fact turns this from
"build a SaaS" into "ship a command."

The other CLIs are weaker: ECC has a skills-ledger schema but the recorder is unwired;
Superpowers records nothing; Kiro meters a single credit pool with no per-capability breakdown.
So the dashboard's value tracks how Claude-Code-heavy the org is.

## A. What aih captures today

aih is a **bootstrapping tool, not a telemetry pipeline.** It writes config/docs that *enable*
others' telemetry; it stores nothing centrally and never calls a remote system (every cloud step
is `doc`/dry-run — a deliberate governance stance, `src/telemetry/index.ts`).

- `aih telemetry` writes the Claude Code OTEL env into the shell profile, a **redacting**
  OTel/Bindplane collector (`collector.yaml`), and an **Analytics Admin API fetcher**
  (`fetch-analytics.mjs`, prints curl unless `--run`). This is real, reusable prior art.
- The Kiro `metrics-on-stop` hook appends `.kiro/metrics.jsonl` — schema is **only**
  `{ts, sha, subject}` per agent turn that ends in a commit (commit cadence; no tokens/skills).
- "Org blocks" exist as **preventive config** (settings `permissions.deny`, sandbox policy,
  managed-MCP allowlist, gitleaks/CI gates) but none *log a block event*. Block **counts** come
  downstream from Claude Code's `tool_decision`/`code_edit_tool.decision` (`decision=reject`).
- ~~There is no `aih report` command today.~~ **Update (shipped):** `aih report` now exists
  (Tier 1) — local context-footprint digest by default + `--org <export>` enterprise digest, with
  `--format md|html`. `aih status` stays a pure presence inventory. See
  [analytics-report-plan.md](analytics-report-plan.md).

### Three real gaps in the current `telemetry` command

> **Update 2026-06-24 (verified vs. code):** **all three gaps are now fixed.**
> See [analytics-report-plan.md §4](analytics-report-plan.md) for the implementation track.

1. ~~**It exports nothing.**~~ **Fixed** — `otelEnvVars` now pins both `OTEL_METRICS_EXPORTER`
   and `OTEL_LOGS_EXPORTER` to `otlp` (`src/telemetry/templates.ts`), so the collector receives
   metrics/logs.
2. ~~**`EVENT_TYPES` is stale.**~~ **Fixed** — 23 types now listed, including `skill_activated`
   (the skills signal) (`src/telemetry/templates.ts`).
3. ~~**The fetcher only hits `usage_report/claude_code`.**~~ **Fixed** — `fetch-analytics.mjs` now
   also queries the **Skill Usage Analytics** endpoint (`/v1/organizations/analytics/skills`) and
   emits `{ usage_report, skills }` (`src/telemetry/templates.ts`).

## B. What each CLI exposes

| Tool | "Which skills used" (counts) | Token / cost |
|---|---|---|
| **Claude Code** | **Yes** — `skill.name` on metrics/events + `skill_activated` event + Skill Usage Admin API | **Yes** — full (per type/model/user/day) |
| ECC | Partial (schema only; recorder unwired) | Yes (session-level, no skill attribution) |
| Superpowers | No | No |
| Kiro | No | Yes (credits; per-user/model, single pool) |

**Claude Code specifics (verified vs. code.claude.com / platform.claude.com, June 2026):**
- **OTEL metrics** (need `OTEL_METRICS_EXPORTER=otlp`): `claude_code.token.usage`
  (`type=input|output|cacheRead|cacheCreation`, `model`, `query_source`, **`skill.name`**,
  `plugin.name`, `mcp_server.name`), `claude_code.cost.usage`, `…lines_of_code.count`,
  `…commit.count`, `…pull_request.count`, `…code_edit_tool.decision` (accept/reject + source),
  `…session.count`, `…active_time.total`. Standard attrs include `user.email`, `user.id`,
  `organization.id`, `session.id`.
- **OTEL events** (need `OTEL_LOGS_EXPORTER=otlp`): `claude_code.skill_activated`
  (`skill.name` — verbatim for built-in; redacted to `custom_skill` for user-defined **unless
  `OTEL_LOG_TOOL_DETAILS=1`**, which aih already sets), `user_prompt`, `api_request`,
  `tool_decision`/`tool_result`.
- **Admin API:** `usage_report/claude_code` → per actor/day: sessions, tokens by type/model,
  `estimated_cost`, `tool_actions.{edit,write,…}.{accepted,rejected}`, LOC, commits, PRs
  (**no skill breakdown**). `analytics/skills` → per skill: `skill_name`, `distinct_user_count`,
  per-surface session counts (**Enterprise plan; 3-day finalization lag; no per-skill cost**).

## C. Measuring "token consumption vs. savings" defensibly

- **Cache efficiency (measurable, defensible):** `cache_read / (cache_read + input)` from the
  token metric / Admin API `model_breakdown`. "X% of input served from cache, avoiding $Y at the
  uncached rate." This is the **one savings number you can actually defend.**
- **Acceptance / throughput (measurable, but it's productivity signal, not dollars):**
  accept-vs-reject ratio + LOC + commits/PRs per active hour.
- **Counterfactual "time/tokens saved vs. by hand" (NOT measurable):** no baseline exists; any
  figure is an assumption. The dashboard should refuse it or label it an estimate inline.

## D. Tiered options

| Tier | What | Infra | Privacy | Effort |
|---|---|---|---|---|
| **1 — Local `aih report`** | New command pulls the Admin API (usage + skills) → terminal + static HTML: top skills, tokens by type/model, cost, **cache-savings %**, accept/reject, commits/PRs, block-rate. Plus fix the 3 gaps above. | None (one admin key; first command that *optionally* calls out, gated like the fetcher's `--run`) | Key already scopes to the org; data stays local; aggregate-first | **Small** |
| **2 — Team rollup** | Devs export OTEL → shared **redacting collector** (already generated) → Prometheus/columnar store → Grafana/static HTML. Adds **per-skill cost** (only OTEL pairs `skill.name`+`token.usage`). | Self-hosted collector + Prometheus/Grafana | Sensitive: per-dev `user.email` flows to a shared store — **explicit opt-in**, drop email for aggregate views | **Medium** |
| **3 — Hosted edition** | Multi-tenant SaaS: auth'd OTLP gateway → store → web UI with SSO/RBAC + per-org Admin-API ingester. | Real SaaS + on-call | Data residency, PII minimization, DPA, retention, worker-monitoring legal review | **Large** |

**Recommendation: Tier 1.** It answers the entire stated ask for Claude Code orgs with no
per-developer setup, no hosted service, and no prompt/PII leakage — because the Admin API *is*
the published edition. Tier 2 is only for per-skill **cost** attribution across a team; Tier 3
only if aih is being commercialized as cross-org fleet analytics.

## E. Honest gaps & risks

- **Per-skill cost** is OTEL-only (not the daily Admin API) → needs Tier 2, not Tier 1.
- **Non-Claude tools contribute little/nothing** to a skills view (Superpowers: none; Kiro:
  single credit pool; ECC: unwired). If the org is Superpowers/Kiro-heavy, the skills panel is thin.
- **Skill Usage API** is Enterprise-only, with a 3-day lag and no real-time view.
- **OTEL metrics need each dev to enable the env**; the Admin API sidesteps this (org-side),
  which is why Tier 1 is robust and Tier 2 is fragile.
- **Vanity-metric traps:** LOC-added alone (AI inflates it; deletions can be more valuable),
  tokens-as-savings (tokens are cost), session count/active time (presence ≠ impact), accept-rate
  without context (auto-accept inflates it). Pair every number with its counter-signal.
- **Biggest blocker:** attribution + consent on per-developer data. The data leads most want is
  exactly the sensitive worker-monitoring data. The defensible path is **org-aggregate-first via
  the Admin API (Tier 1)**; per-developer drill-down (Tier 2/3) is a deliberate, consented step.
