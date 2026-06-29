# Usage Metering — design (B)

Status: **approved — building** · branch `feat/local-report-v9` · 2026-06-29
Decisions resolved (see **Decisions**); P1 started (recorder `--from claude`, commit `e48a35c`).
Implementer checklist at the bottom — ready to hand to Codex.

## TL;DR

The usage-metering foundation already exists. This work is **not** a new subsystem — it
**finishes** the one that's there:

- **Built today:** the event schema (`.aih/usage.jsonl`), the reader, the aggregator, the
  recorder script, the **universal git floor** hook, and the `aih usage` command.
- **The gap:** (1) the per-tool **skill/MCP hooks are only _documented_, not generated**; (2) the
  v9 dashboard panels that should consume usage (`Usage by CLI`, `Heavy lifters`, `Dormant`) are
  still PREVIEW; (3) **dormant detection** (ECC-installed minus actually-invoked) isn't wired;
  (4) **cross-project rollup** reads one repo only.

Finish those four and the "usages" + cross-project feedback loop the whole report arc was for
goes LIVE — without inventing new infrastructure.

## Goals / Non-goals

**Goals**
- Record which skills / agents / MCP servers actually **fire**, per CLI, over time — locally.
- Flip the three stubbed v9 panels to LIVE from real events (honest PREVIEW until data exists).
- Add **dormant detection**: ECC-installed-but-never-invoked = trim candidates (the killer panel).
- Aggregate across a developer's repos for the **over-the-period, cross-project** view.

**Non-goals**
- **No cost / token economy.** Cost is the one uneven signal (real USD only from Claude; others
  give tokens or lock it cloud-only). Usage = **activity counts**, never dollars. (Already the
  documented stance in `src/usage/index.ts`.)
- **No version pinning / no aih-managed ECC** — consistent with the ECC-panel decision: honor the
  live machine install, just observe.
- No network. `.aih/usage.jsonl` is machine-local, gitignored, append-only.

## What already exists (do NOT rebuild)

| Piece | Where | State |
|---|---|---|
| Event schema `UsageEvent` (`commit`/`skill`/`mcp`/`session`/`tool`, `source: ecc\|canon\|user`) | `src/usage/events.ts` | ✅ |
| `readUsage(ctx)` | `src/usage/events.ts` | ✅ |
| `aggregateUsage(events)` → tools / commits / skills{top, bySource} / mcp{servers,tools} | `src/usage/aggregate.ts` | ✅ |
| Recorder `.aih/usage-record.mjs` (`node … <tool> skill <name> <ecc\|canon\|user>`) | `src/usage/capture.ts` | ✅ |
| **Universal git floor** (`post-commit` hook → commit events for ANY tool) | `aih usage --apply` | ✅ |
| Per-tool hook **mechanisms documented** (`TOOL_HOOK`: claude PostToolUse, kiro `.kiro.hook`, codex, cursor, gemini, copilot, windsurf, opencode, kimi, antigravity) | `src/usage/index.ts` | 📄 doc only |
| Legacy report usage panel | `src/report/usage.ts` | ✅ |

So the schema, reader, aggregator, recorder, and git floor are done. The next two layers are the gap.

## Gap 1 — generate the per-tool skill/MCP hooks (the source)

Today `aih usage` writes the git floor and **documents** each CLI's hook in `TOOL_HOOK`, with a
note: *"the next slice auto-generates them."* This is that slice.

Add a generator per CLI that writes the real hook config, each calling the existing recorder:

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
  `TOOL_HOOK` map; wire **only targeted/installed** CLIs (detection-gated), claude + kiro first.
- **zed** — no hooks (parse `threads.db`); deferred, documented.

Design choices:
- **Idempotent + additive:** never clobber a user's existing hooks; merge our command in, marked.
- **Gated:** only wire CLIs in the resolved target set (same precedence the report uses).
- **Attribution source:** the recorder already takes `<ecc|canon|user>`; the claude hook infers
  `ecc` when the skill/agent name is in the machine ECC set (we now read that namespace), else
  `canon`/`user`.

## Gap 2 — wire the v9 panels (the consumption)

All three already have a home in the v9 view-model; today they render demo data behind a PREVIEW
ribbon. Point them at `aggregateUsage(readUsage(ctx))`:

- **`Usage by CLI`** ← `summary.tools` (per-tool event share). Flips PREVIEW→LIVE once any event exists.
- **`Heavy lifters`** ← `summary.skills.top` (most-invoked skills/agents, 30d window).
- **`Dormant`** ← **Gap 3**.

Honesty: each panel stays PREVIEW until `readUsage` returns ≥1 real event (live-or-don't-render).

## Gap 3 — dormant detection = ECC ∩ usage (the killer panel)

We now read the **live ECC skill set** (the `~/.claude/skills/ecc/` namespace — 146 on this box)
in the ECC panel. Dormant trim-candidates =

```
dormant = ECC-installed skills  −  skills that fired (summary.skills.bySource.ecc)  (over window)
```

i.e. "you carry 146 ECC skills; 12 fired in 30d; **134 are dormant** — candidates to trim from the
rolling install." This is the first panel that needs *both* the ECC inventory (done) and usage
(Gaps 1–2). Same idea for agents.

## Gap 4 — cross-project rollup

`aggregateUsage` already folds an event list — so cross-project is "read N repos' `.aih/usage.jsonl`,
concat, aggregate." Per the **no-local-cache** decision, this is **scan-on-demand**, not a daemon:

- `aih usage --rollup <dir...>` (or extend `aih report --org`) reads each repo's log, tags events
  with their repo, and aggregates: which ECC skills fire **across** projects (adoption), which are
  dormant **everywhere** (trim from ECC with confidence), per-project breakdown.
- Output: an org-level digest the report can render — the true "over the period, across projects".

## Privacy / determinism / honesty

- `.aih/usage.jsonl` holds **counts + names only** — no prompt content, no args, no secrets;
  machine-local; gitignored; never sent anywhere.
- It's **live data**, not a byte-stable artifact (like `.aih/history.jsonl`) — excluded from the
  report's determinism guarantee by design.
- Opt-in: hooks are written only when the operator runs `aih usage --apply`.
- Panels render PREVIEW until real events exist; **cost stays out, permanently.**

## Phasing

1. **P1 — per-tool hook generators for ALL targeted CLIs** in `aih usage --apply` + tests that assert
   each written hook calls the recorder. Sequence within P1: claude `settings.json` merge (recorder
   side done) → kiro (reuse generator) → codex/gemini/opencode (schema verified first).
2. **P2 — wire v9 `Usage by CLI` + `Heavy lifters`** to `aggregateUsage`; PREVIEW fallback intact.
3. **P3 — dormant detection** (ECC ∩ usage) → `Dormant` panel LIVE.
4. **P4 — folded into P1** (the "all targeted CLIs" decision pulls the remaining generators forward).
5. **P5 — cross-project rollup** (`--rollup` / `--org`).

Each phase is independently shippable and leaves the report honest (PREVIEW where data is absent).

## Test criteria

- Hook generators: written config is valid + idempotent (re-run = no dup) + calls the recorder with
  the right args; existing user hooks preserved.
- Panels: LIVE only with ≥1 event; PREVIEW otherwise; demo never renders as real.
- Dormant: `ECC − fired` math correct over the window; 0 ECC or 0 usage → PREVIEW, not a false 0.
- Determinism: report stays byte-stable for a fixed event log; usage log itself is excluded.
- Gate: typecheck / biome ci / full vitest / build, as with every slice.

## Decisions (resolved 2026-06-29, owner)

1. **Hook install** — generate per-tool hooks inside `aih usage --apply`, wiring **ALL targeted CLIs**
   (the `resolveTargets` set), gated + idempotent. (Not claude+kiro-only.)
2. **Attribution depth** — ship at **mcp + subagent + tool** granularity (solid); **skill identity
   best-effort** (named when the hook payload exposes it, else counted as a tool).
3. **Dormant baseline** *(deferred to P3)* — default = **all** ECC-installed skills minus fired;
   revisit "stack-relevant only" if the all-set proves noisy.
4. **Cross-project scope** *(deferred to P5)* — **scan-on-demand** over a passed list of repo dirs
   (honors the no-cache decision); no registry/daemon.

## Current state (branch `feat/local-report-v9`)

- ✅ `e48a35c` — recorder gained a `--from <cli>` stdin mode; **claude payload mapping is done**
  (`mcp__server__tool`→mcp, `Task`→subagent, `Skill`→skill best-effort, else tool). Other CLIs return
  `undefined` from `fromHookPayload` until wired.
- ⏳ Remaining = the checklist below (claude `settings.json` merge + other CLI hooks + panel wiring +
  dormant + rollup).

## Implementer checklist

- [ ] **P1** — extend `fromHookPayload(cli, payload)` per targeted CLI **and** generate each hook
      (runs `node .aih/usage-record.mjs --from <cli>`); wire into `aih usage --apply` over
      `resolveTargets`, idempotent + additive (never clobber existing hooks), gated. Order: claude
      `.claude/settings.json` merge (recorder side done) → kiro (reuse `src/kiro/content.ts`) →
      **verify codex/gemini/opencode schemas vs current docs before writing them**.
- [ ] **P2** — `Usage by CLI` ← `aggregateUsage(readUsage(ctx)).tools`; `Heavy lifters` ←
      `.skills.top`. PREVIEW until ≥1 real event.
- [ ] **P3** — `Dormant` = live ECC skills (`~/.claude/skills/ecc/`, via `eccInventoryDigest`) −
      fired (`.skills.bySource.ecc`) over the window. 0 ECC or 0 usage → PREVIEW, not a false 0.
- [ ] **P5** — `aih usage --rollup <dir…>` (or extend `aih report --org`) → aggregate the union of
      repos' `.aih/usage.jsonl`, tagged by repo.
- [ ] Gate green each phase (lint/biome ci/typecheck/vitest/build); **no cost**; `usage.jsonl`
      gitignored + excluded from the byte-stable report; demo never renders as real.
