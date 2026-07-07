# Usage Metering — design (B)

Status: **implemented — gated green** · on `main` · 2026-06-29 · `src/usage/`
(events.ts, aggregate.ts, capture.ts, hooks.ts)
Decisions resolved (see **Decisions**); P1–P5 are implemented on main.
The checklist at the bottom records what landed.

## TL;DR

The usage-metering foundation shipped. It was **not** a new subsystem — it
finished the local recorder that already existed:

- **Foundation:** the event schema (`.aih/usage.jsonl`), the reader, the aggregator, the
  recorder script, the **universal git floor** hook, and the `aih usage` command.
- **Finished in this branch:** per-tool skill/MCP hook generators for targeted supported CLIs,
  v9 Usage-by-CLI / Heavy-lifters / Dormant panels, dormant detection (ECC-installed minus
  actually-invoked), and scan-on-demand cross-project rollup.

Those four landed, so the "usages" + cross-project feedback loop the report arc was for is LIVE — no new infrastructure invented.

## Goals / Non-goals

**Goals**
- Record which skills / agents / MCP servers actually **fire**, per CLI, over time — locally.
- Flip the three stubbed v9 panels to LIVE from real events (honest PREVIEW until data exists).
- Add **dormant detection**: ECC-installed-but-never-invoked = trim candidates (the killer panel).
- Aggregate across a developer's repos for the **over-the-period, cross-project** view.

**Non-goals**
- **No local dollar cost.** Cost is the uneven signal (real USD only from Claude; others give
  tokens or lock it cloud-only). The local sink may carry optional token/cache counters for cache
  economy, but usage still never claims dollars.
- **No version pinning / no aih-managed ECC** — consistent with the ECC-panel decision: honor the
  live machine install, just observe.
- No network. `.aih/usage.jsonl` is machine-local, gitignored, append-only.

## What already exists (do NOT rebuild)

| Piece | Where | State |
|---|---|---|
| Event schema `UsageEvent` (`commit`/`skill`/`mcp`/`session`/`tool`, `source: ecc\|canon\|user`) | `src/usage/events.ts` | ✅ |
| `readUsage(ctx)` | `src/usage/events.ts` | ✅ |
| `aggregateUsage(events)` → tools / commits / token/cache counters / skills{top, bySource} / mcp{servers,tools} | `src/usage/aggregate.ts` | ✅ |
| Recorder `.aih/usage-record.mjs` (`node … <tool> skill <name> <ecc\|canon\|user>`) | `src/usage/capture.ts` | ✅ |
| **Universal git floor** (`post-commit` hook → commit events for ANY tool + `aih track --apply`) | `aih usage --apply` | ✅ |
| Per-tool hook generators (`TOOL_HOOK`: claude PostToolUse, kiro `.kiro.hook`, codex, cursor, gemini, copilot, windsurf, opencode, kimi, antigravity) | `src/usage/hooks.ts` | ✅ |
| Zed `threads.db` importer (read-only SQLite → `.aih/usage.jsonl`) | `src/usage/zed.ts` | ✅ |
| Legacy report usage panel | `src/report/usage.ts` | ✅ |

So the schema, reader, aggregator, recorder, and git floor were the base; the per-tool hooks and v9 panels (below) are now built on top.

## P1 — generated per-tool skill/MCP hooks (the source)

`aih usage --apply` writes the git floor (commit usage + one deduped track sample per commit) to
the active repo-local hooks path (`.git/hooks` by default, `.githooks` when configured) and
generates each targeted CLI's hook from `TOOL_HOOK`. External/global `core.hooksPath` targets are
not mutated; the plan emits a chainable post-commit snippet instead.

Each generated hook calls the existing recorder:

```
node .aih/usage-record.mjs <tool> mcp  <tool-name> <server>
node .aih/usage-record.mjs <tool> skill <name> <ecc|canon|user>
```

- **claude** — merge a `PostToolUse` hook into `.claude/settings.json` (idempotent, additive to
  existing hooks). Fires on every tool call; captures `mcp__<server>__<tool>` (→ `kind:mcp`) and
  `Task`/subagent + Skill calls (→ `kind:skill`/`tool`). Highest-fidelity surface.
- **kiro** — `.kiro/hooks/*.kiro.hook` Run Command (aih already generates Kiro hooks elsewhere —
  reuse that path).
- **codex / cursor / gemini / opencode / windsurf / copilot / kimi / antigravity** — per the
  `TOOL_HOOK` map; wire **only targeted/installed** CLIs (detection-gated), using each tool's
  repo-local hook surface (`.github/hooks/*.json` for Copilot, `.agents/hooks.json` for
  Antigravity, `.kimi/config.toml` for Kimi, etc.).
- **zed** — no hooks. `aih usage --apply --cli zed` reads local `threads.db` rows read-only
  (auto-located or via `--zed-threads-db <path>`), maps cumulative/request token counters and
  derivable `ToolUse` identities, skips rows without matching repo folder metadata, and upserts
  deterministic Zed `UsageEvent`s by stable local event id. It is best-effort on the active Node
  runtime: missing built-in SQLite or zstd support skips the import without failing hook setup.

Design choices:
- **Idempotent + additive:** never clobber a user's existing hooks; merge our command in, marked.
- **Gated:** only wire CLIs in the resolved target set (same precedence the report uses).
- **Attribution source:** the recorder already takes `<ecc|canon|user>`; the claude hook infers
  `ecc` when the skill/agent name is in the machine ECC set (we now read that namespace), else
  `canon`/`user`.

## P2 — v9 panels (the consumption)

The v9 panels consume `aggregateUsage(readUsage(ctx))`:

- **`Usage by CLI`** ← `summary.tools` (per-tool event share). Flips PREVIEW→LIVE once any event exists.
- **`Cache economy`** ← `summary.tokens` when local token/cache samples exist; empty stays a stub
  pointing at `aih report --org`.
- **`Heavy lifters`** ← `summary.skills.top` (most-invoked skills/agents, 30d window).
- **`Dormant`** ← **Gap 3**.

Honesty: each panel stays empty/preview until the relevant local sample exists
(cache/token counters for cache economy, skill rows for the skill ledger). Empty states point at
`aih report --org` instead of showing demo data as real activity.

## P3 — dormant detection = ECC ∩ usage (the killer panel)

We read the **live ECC skill set** (the `~/.claude/skills/ecc/` namespace and
the current `~/.claude/ecc/.agents/skills/` layout) in the ECC panel. Dormant
trim-candidates =

```
dormant = stack-relevant ECC-installed skills  −  skills that fired (summary.skills.bySource.ecc)  (over window)
```

i.e. "of the stack-relevant ECC skills you carry, only a handful fired in 30d; **the rest are
dormant** — candidates to trim from the rolling install." The initial all-ECC-minus-fired set was
too noisy for broad ECC installs, so v9 scopes dormant candidates through the detected ECC stack
packs before subtracting fired skills. This is the first panel that needs *both* the ECC inventory
(done) and usage (Gaps 1–2). Same idea for agents.

## P5 — cross-project rollup

`aggregateUsage` already folds an event list — so cross-project is "read N repos' `.aih/usage.jsonl`,
concat, aggregate." Per the **no-local-cache** decision, this is **scan-on-demand**, not a daemon:

- `aih usage --rollup <dir...>` (or extend `aih report --org`) reads each repo's log, tags events
  with their repo, and aggregates: which ECC skills fire **across** projects (adoption), which are
  dormant **everywhere** (trim from ECC with confidence), per-project breakdown.
- Output: an org-level digest the report can render — the true "over the period, across projects".

## Privacy / determinism / honesty

- `.aih/usage.jsonl` holds **counts + names + optional token/cache counters only** — no prompt
  content, no args, no secrets; machine-local; gitignored; never sent anywhere.
- It's **live data**, not a byte-stable artifact (like `.aih/history.jsonl`) — excluded from the
  report's determinism guarantee by design.
- Opt-in: hooks are written only when the operator runs `aih usage --apply`.
- Panels render only from real local events; empty stubs point at `aih report --org`. **Local
  dollar cost stays out, permanently.**

## Phasing

1. **P1 — per-tool hook generators for ALL targeted CLIs** in `aih usage --apply` + tests that assert
   each written hook calls the recorder. Sequence within P1: claude `settings.json` merge (recorder
   side done) → kiro (reuse generator) → codex/gemini/opencode (schema verified first).
2. **P2 — wire v9 `Usage by CLI` + `Heavy lifters`** to `aggregateUsage`; PREVIEW fallback intact.
3. **P3 — dormant detection** (ECC ∩ usage) → `Dormant` panel LIVE.
4. **P4 — folded into P1** (the "all targeted CLIs" decision pulls the remaining generators forward).
5. **P5 — cross-project rollup** (`--rollup` / `--org`).

Each phase shipped independently and left the report honest (PREVIEW where data is absent).

## Test criteria

- Hook generators: written config is valid + idempotent (re-run = no dup) + calls the recorder with
  the right args; existing user hooks preserved.
- Panels: LIVE only with ≥1 event; PREVIEW otherwise; demo never renders as real.
- Dormant: `stack-relevant ECC − fired` math correct over the window; 0 ECC or 0 usage → PREVIEW, not a false 0.
- Determinism: report stays byte-stable for a fixed event log; usage log itself is excluded.
- Gate: typecheck / biome ci / full vitest / build, as with every slice.

## Decisions (resolved 2026-06-29, owner)

1. **Hook install** — generate per-tool hooks inside `aih usage --apply`, wiring **ALL targeted CLIs**
   (the `resolveTargets` set), gated + idempotent. (Not claude+kiro-only.)
2. **Attribution depth** — ship at **mcp + subagent + tool** granularity (solid); **skill identity
   best-effort** (named when the hook payload exposes it, else counted as a tool).
3. **Dormant baseline** *(resolved in P3/#253)* — broad installs made **all** ECC-installed skills
   minus fired too noisy, so dormant trim candidates use stack-relevant ECC skills minus fired.
4. **Cross-project scope** *(deferred to P5)* — **scan-on-demand** over a passed list of repo dirs
   (honors the no-cache decision); no registry/daemon.

## Current state

- ✅ Recorder gained a `--from <cli>` stdin mode and maps real hook payload shapes from Claude,
  Codex, Cursor, Gemini, Copilot, Windsurf, OpenCode, Kimi, Kiro, and Antigravity into local
  `skill` / `mcp` / `tool` rows when the source payload exposes enough identity. Zed has no
  hook surface, so its usage path imports `threads.db` instead.
- ✅ This slice — `aih usage --apply` generates the targeted per-tool hooks, v9 usage + skills
  panels go LIVE from real events, dormant = stack-relevant live ECC skills minus fired ECC skills,
  and `aih usage --rollup <dirs>` emits a scan-on-demand digest.
- ✅ Post-implementation doc check — Gemini's project `.gemini/settings.json` `AfterTool` hook shape
  is current; Codex's project hook path stays `.codex/hooks.json` (plugin bundles may use
  `hooks/hooks.json`), resolves the recorder from the git root, and notes that project `.codex`
  must be trusted/reviewed before command hooks run.

## Implementer checklist

- [x] **P1** — extend `fromHookPayload(cli, payload)` per targeted CLI **and** generate each hook
      (runs `node .aih/usage-record.mjs --from <cli>`); wire into `aih usage --apply` over
      `resolveTargets`, idempotent + additive (never clobber existing hooks), gated. Order: claude
      `.claude/settings.json` merge (recorder side done) → kiro (reuse `src/kiro/content.ts`) →
      **verify per-CLI hook schemas vs current docs before writing them**.
- [x] **P2** — `Usage by CLI` ← `aggregateUsage(readUsage(ctx)).tools`; `Heavy lifters` ←
      `.skills.top`. PREVIEW until ≥1 real event.
- [x] **P3** — `Dormant` = stack-relevant live ECC skills (`~/.claude/skills/ecc/` and
      `~/.claude/ecc/.agents/skills/`, via `eccInventoryDigest` + detected ECC packs) − fired
      (`.skills.bySource.ecc`) over the window. 0 ECC or 0 usage → PREVIEW, not a false 0.
- [x] **P5** — `aih usage --rollup <dir…>` (or extend `aih report --org`) → aggregate the union of
      repos' `.aih/usage.jsonl`, tagged by repo.
- [x] Gate green each phase (lint/biome ci/typecheck/vitest/build); **no cost**; `usage.jsonl`
      gitignored + excluded from the byte-stable report; demo never renders as real.
