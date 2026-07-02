# aih Plan — per-CLI coverage matrix + loadability validation

_Generated 2026-06-26. Grounded in the live source: the coverage surfaces, the CLI registry, the scorecard, and the dashboard renderer were all read end-to-end before this was written. The plan replaces the global, Claude-shaped file-exists checks with a registry-driven, target-scoped, four-state per-CLI matrix, and adds a loadability tier that closes the **present ≠ loaded** gap so no CLI silently misses the mark._

> Companion: the capability registry lives in [src/internals/cli-registry.ts](../../src/internals/cli-registry.ts) and the scorecard in [src/report/scorecard.ts](../../src/report/scorecard.ts) — the REG/SCORE surfaces this plan builds on.
>
> **Reviewed 2026-06-26** (external review, code-grounded). Verdict: proceed — this fixes a product trust gap, not scope creep. The review endorsed the defaults for D0/D1/D3/D4/D5/D6/D7/D8 and added three deltas now folded in: a **target-source** field (§3), a **dual KPI** (structurally configured vs proven loadable, §5/D8), and a locked **Installed/Targeted/Wired vocabulary** (§2). D2 accepted (annotate). The review's "validate MCP content in Phase 1" note was already satisfied — the writable-MCP content check is Phase 1, not deferred.
>
> **✅ IMPLEMENTED 2026-06-26** — all phases shipped on branch `feat/cli-coverage-matrix` (4 commits; since merged to main — `src/report/cli-coverage.ts`, `src/report/cli-loadability.ts`). Phase 1: `cli-coverage.ts` matrix + dashboard + terminal. Phase 1.5: `cli-loadability.ts` (`loads`/`wontLoad`/`unverified`) + "Loads?" column + "proven loadable" KPI + fail-closed doctor probe. Phase 2: scorecard `harnessWiring` consumes the model (per-CLI, `wontLoad` fails). Phase 3: `status`/`configPanel` narrowed to repo-global. Tier-2 canary deferred per D6. Verified: typecheck + biome clean, 862 tests green (incl. new `cli-coverage`/`cli-loadability` suites + Phase-2 scorecard tests).

## Contents
1. The problem — what "AI CLI coverage" checks today
2. Root cause
3. Data model — per-CLI capability matrix
4. Loadability validation — present ≠ loaded
5. Visibility design — making each CLI clear on the report
6. Surfaces touched
7. Scorecard integration
8. Test plan
9. Build order / phases
10. **Decisions you need to take** ← the review checklist

---

# 1. The problem — what "AI CLI coverage" checks today

"AI CLI coverage" is not one check. It is four surfaces that answer different questions while all reading as "coverage":

| Surface | Code | What it actually checks |
|---|---|---|
| **Tooling** panel ("N of 11 AI CLIs configured here") | [`local.ts:46`](../../src/report/local.ts) → [`cli-detect.ts:62`](../../src/internals/cli-detect.ts) | Is the CLI **installed on this machine** (a `~/.claude`, `~/.cursor` home dir exists) |
| **Configuration** / "Adoption checklist" | [`local.ts:26`](../../src/report/local.ts) → [`status.ts:6`](../../src/status.ts) | Does a **fixed, hand-maintained artifact list** exist in the repo |
| **Harness maturity** scorecard (`harnessWiring` dim) | [`scorecard.ts:167`](../../src/report/scorecard.ts) | `bootloader-present` (any), `mcp-config` (`.mcp.json` exists), `claude-settings` (`.claude/settings.json` exists) |
| **doctor** "AI CLIs detected" | [`doctor.ts:109`](../../src/doctor.ts) | PATH / home-dir detection, fail-closed |

The per-CLI source of truth already exists — [`cli-registry.ts`](../../src/internals/cli-registry.ts) holds, per tool, its `bootloaders`, its `mcp` config path/key/format, and a `writable` flag. The coverage surfaces just **don't consume it per-tool**; they ask one global, Claude-shaped question.

### The divergence, along the three axes

**Axis 1 — Bootloader / context (the file each CLI auto-loads).** Every CLI loads a different file:

| CLI(s) | Bootloader | In `inventory()` artifact list? |
|---|---|---|
| claude | `CLAUDE.md` | ✅ |
| codex, opencode, zed, kimi, antigravity | `AGENTS.md` | ✅ |
| cursor | `.cursor/rules/00-canon.mdc` | ✅ (`.cursor/rules`) |
| gemini / antigravity | `GEMINI.md` | ❌ **invisible** |
| windsurf | `.windsurfrules` | ❌ **invisible** |
| copilot | `.github/copilot-instructions.md` | ❌ **invisible** |
| kiro | `.kiro/steering/00-canon.md` | ❌ **invisible** |

`ARTIFACTS` in [`status.ts:6`](../../src/status.ts) knows only 3 of the 7 bootloader shapes → a repo correctly wired for Windsurf / Gemini / Copilot / Kiro **cannot show as covered** (false negative baked into the data model). Meanwhile the scorecard's `bootloader-present` is `present.length > 0` (*any* tool) → a `CLAUDE.md`-only repo scores "wired" even when you target Kiro (false positive).

**Axis 2 — MCP.** The registry splits tools by `writable`:
- **writable: true** (aih writes a project-relative `mcpServers` JSON): claude, cursor, kimi, kiro.
- **writable: false** (aih emits *guidance* only — [`mcp/index.ts:204`](../../src/mcp/index.ts)): codex (TOML, global `~/.codex/config.toml`), gemini (global), copilot (`.vscode/mcp.json`, `servers` key), windsurf (global), opencode (`mcp` key), zed (`context_servers`).

The coverage check is the single global `has("mcp")` = "does `.mcp.json` exist." That is the Claude/Cursor/Kimi/Kiro file. For the other six it is the *wrong file*, and for five it lives at a **global home path the repo scan can't even see**. So a Codex repo with MCP correctly in `config.toml` reports `mcp-config` **fail**; a Copilot repo with a stray `.mcp.json` reports **pass**. Even for writable tools, `has("mcp")` checks existence, not contents — a `{}` file passes.

**Axis 3 — Settings.** `claude-settings` (`.claude/settings.json`) is Claude-only, yet sits **unconditionally** in `harnessWiring`. A Cursor / Kiro / Codex repo is permanently docked for a file its tool doesn't use.

---

# 2. Root cause

> A "wired" capability is a **per-CLI, multi-dimensional** fact (bootloader file + MCP location/shape/writability + tool-native settings). The coverage layer collapses it into **global file-exists predicates keyed to the Claude shape**, so the check is true for tools that match that shape and lies for the rest.

Two structural conflations underneath:
1. **"installed on the machine" vs "this repo is wired for it"** are orthogonal but both presented as "coverage."
2. **Nothing is scoped to the targeted tools.** `doctor` reads `.aih-config.json` for the committed target set ([`doctor.ts:45`](../../src/doctor.ts)); `report` / scorecard don't — they grade against all 11 / the Claude shape regardless of intent.

### Vocabulary (three terms, used consistently, never blended)

The trust gap is partly a wording gap — the current surfaces blend these. Every panel/column below keeps them separate:

| Term | Means | Source |
|---|---|---|
| **Installed** | the CLI exists on this machine | `detectClisByConfig` (home config dir / PATH) — the "Machine tooling" panel |
| **Targeted** | this repo was configured for that CLI | `.aih-config.json` targets / `ctx.targets` / `--cli` / `--detect` |
| **Wired / Loadable** | required files+config exist **and** can be proven to load | `scanCliCoverage` (§3) + `cli-loadability` (§4) — the "AI CLI wiring" matrix |

Rule: never report **Wired** off an **Installed** signal, and never report **Wired** for a CLI that isn't **Targeted** (show it muted instead).

---

# 3. Data model — per-CLI capability matrix

New module `src/report/cli-coverage.ts` — pure fs reads, no spawn/network.

```ts
type CellState = "wired" | "missing" | "manual" | "na"

interface CliCell {
  state: CellState
  path?: string        // the file this capability lives in (from registry)
  detail: string       // how the tool loads it / why manual / why n/a
  fix?: string         // exact `aih …` command when missing/manual
}

interface CliCoverageRow {
  cli: Cli
  label: string        // entry(cli).label
  targeted: boolean    // in the committed/resolved target set
  bootloader: CliCell
  mcp: CliCell
  settings: CliCell
  loads: LoadVerdict   // §4 — "loads" | "wontLoad" | "unverified"
}

interface CliCoverageModel {
  rows: CliCoverageRow[]      // targeted first, then other-detected, then rest
  targeted: Cli[]
  targetSource:               // WHERE the target set came from — surfaced to the user
    "marker" | "ctx" | "--cli" | "--detect" | "default-claude"
  score: number              // % of GRADEABLE cells wired (manual/na excluded)
  structurallyConfigured: number  // targeted CLIs with no `missing` cell (loadability ignored)
  provenLoadable: number          // of those, the ones with loads === "loads"
  totalTargeted: number
}

scanCliCoverage(ctx): CliCoverageModel
cliCoverageDigest(ctx): DigestAction     // describe prefix "AI CLI wiring"
```

**Cell rules** (inputs from [`cli-registry.ts`](../../src/internals/cli-registry.ts) — no second source):

| Column | Logic |
|---|---|
| **Bootloader** | For each `entry(cli).bootloaders`: file exists? then check it carries the in-sync `SHARED_MARKER` block AND points to `RULE_ROUTER.md` (reuse `bootloadersInSync` / `bootloadersPointToRouter` from [`scorecard.ts:85`](../../src/report/scorecard.ts), scoped to **this** CLI). `wired` if present+in-sync, else `missing`. |
| **MCP** | `mcp.support === "absent"` → `na`. `writable === true` → parse `configPath`, confirm `configKey` holds a **non-empty** server map → `wired`/`missing` (content check, closes the `{}` gap). `writable === false` → `manual` (guidance only; global/TOML/different shape). |
| **Settings** | new optional `settings` registry field (claude → `.claude/settings.json`). Absent on a tool → `na`; present-and-writable → `wired`/`missing`. |

**Scope rule** (mirror doctor's marker-authoritative logic, [`doctor.ts:45`](../../src/doctor.ts)): `targeted = readAihConfig(root)?.targets ?? ctx.targets ?? detected ?? ["claude"]`. Non-targeted-but-installed CLIs (from `detectClisByConfig`) render as a muted "also on this machine" group, so nothing is hidden. **`targetSource` records which arm of that precedence won** and is shown in the panel header — so when a row reads "Claude missing," the user can tell whether Claude was actually targeted or just the assumed `default-claude` fallback. (A `missing` cell for a `default-claude` source is informational, not a real gap.)

**Scoring rule:** denominator = gradeable cells only (`wired` + `missing`); `manual` and `na` never count against the score. A Kiro-only repo with Kiro fully wired = 100%, not docked for Claude/Codex files.

---

# 4. Loadability validation — present ≠ loaded

The matrix in §3 asks "is the file there and in sync?" It does **not** ask "will the tool actually load it every turn, route all the way to canon, without truncation, and is our knowledge of how this tool loads still current?" That is the silent-failure surface. The codebase already has this instinct once: [`status.ts:44`](../../src/status.ts) distinguishes "config present" from "git hook active" for pre-commit. This generalizes it to context: **bootloader present ≠ context loaded.**

### Silent-failure modes

1. **Activation frontmatter wrong** — Cursor `.mdc` without `alwaysApply: true` is agent-requested, not always-on; Kiro steering without `inclusion: always` is manual. File present + in-sync + never auto-loaded. ([`canon.ts:500`](../../src/bootstrap-ai/canon.ts), [`:453`](../../src/bootstrap-ai/canon.ts) write these; nothing verifies them after.)
2. **Broken pointer chain** — thin bootloader points at `RULE_ROUTER.md`, but the router (or the `agent-behavior-core.md` / `INDEX.md` it points to) is missing. Current check confirms the *string* is present ([`scorecard.ts:95`](../../src/report/scorecard.ts)), not that the target resolves.
3. **Silent truncation** — always-loaded bundle exceeds the tool's char/context cap and the tail is dropped (Antigravity `.agents/rules/` "≤12k chars each", noted at [`canon.ts:250`](../../src/bootstrap-ai/canon.ts)). `loadgroups.ts` measures tokens vs a generic budget, not per-tool caps.
4. **Frontmatter byte hygiene** — a UTF-8 BOM or blank line before `---` makes YAML frontmatter not parse → loads as plain prose or not at all. Real on this Windows-primary repo (CRLF/BOM).
5. **Shadowing** — a pre-existing `.windsurfrules` / higher-priority `.mdc` out-ranks the canon file; the matrix validates the canon file, not whether something overrides it.
6. **Convention drift** — a CLI ships a new rules mechanism, aih keeps writing the old path, the file is "wired" by aih's own definition and the tool ignores it. Not locally detectable.

### Tier 1 — Static loadability contract (deterministic, default-on)

New module `src/report/cli-loadability.ts`. Per targeted CLI, verify the file *would be loaded*. Becomes a per-row **"Loads?"** verdict in the matrix and a **fail-closed `doctor` probe**.

| Check | Verifies | Registry input |
|---|---|---|
| **Activation** | Cursor `alwaysApply: true`; Kiro `inclusion: always`; AGENTS/CLAUDE/GEMINI inherently always-on | new `activation: { key, value }` per entry |
| **Pointer resolution** | bootloader → `RULE_ROUTER.md` → `agent-behavior-core.md` + `INDEX.md` all exist (transitive) | none |
| **Size cap** | this tool's always-loaded bundle ≤ documented cap | new `contextCap?` per entry; extends `scanLoadGroups` |
| **Byte hygiene** | no BOM before `---`, frontmatter parses, valid UTF-8, consistent EOL | none |
| **No shadow** | no sibling always-on file lacking the `SHARED_MARKER` block | reuse `extractManagedBlock` |

Each failure carries the fix verbatim (`→ cursor: .mdc has alwaysApply:false — won't auto-load; run aih bootstrap-ai --cli cursor`).

### Tier 2 — Runtime canary + freshness (opt-in, best-effort, honest)

aih is **not** an agent runtime — it cannot generically run every CLI and observe what loaded. Two honest mechanisms:

- **Registry freshness** — each entry carries `lastVerified` (date) + `verifiedVersion` (tool version the path/frontmatter was confirmed against). `doctor` warns when stale or when the installed tool's `--version` is newer than `verifiedVersion`. Turns silent drift (#6) into a visible "re-verify" warning — the only defense against convention drift.
- **Canary probe** — embed a sentinel token in `RULE_ROUTER.md`; for CLIs that expose a non-interactive "print resolved context" / dry-run mode, run it via the `ctx.run` seam and grep for the sentinel → proof of actual load. Gated behind a per-entry `dryRunProbe?` flag. Most tools don't support it today, so those emit a one-line manual check instead.

**Honesty rule:** three load verdicts — `loads` (proven structurally), `wontLoad` (proven broken), `unverified` (can't prove from a repo scan). Never collapse `unverified` into `loads`. The validator must not itself silently claim success it cannot prove.

---

# 5. Visibility design — making each CLI clear on the report

The panel is a **rows × capabilities grid**, not a chip cloud:

```
┌─ AI CLI wiring ─ targets: .aih-config.json ─ [ 3/3 configured · 2/3 loadable ] ─┐
│  legend: ✓ wired  ✗ missing  ◐ manual  — n/a   ·   loads: ✓ proven  ✗ won't  — unverified │
│                                                                │
│  TARGETED          Bootloader        MCP           Settings  Loads? │
│  ● Claude Code     ✓ CLAUDE.md       ✓ .mcp.json   ✓         ✓ loads│
│  ● Kiro            ✗ .kiro/steering  ✓ settings/mcp — n/a    ✗ won't│
│  ● Codex           ✓ AGENTS.md       ◐ config.toml — n/a     ✓ loads│
│                                                                │
│  ALSO ON THIS MACHINE (not targeted)                           │
│  ○ Cursor          ✗ .cursor/rules   ✗ .cursor/mcp — n/a     — unver│
└────────────────────────────────────────────────────────────────┘
```

Seven visibility mechanisms:

1. **Every targeted CLI gets its own row** — kills structural invisibility; Gemini/Windsurf/Copilot/Kiro can show wired.
2. **Per-capability cells** — you see *which* dimension is the gap, not one collapsed verdict.
3. **Four-state colour + legend** — green / red / amber / muted, with a header legend; `manual` and `na` are visually distinct from a real `missing`, so amber MCP cells don't read as failures.
4. **Cell tooltip = file path + how it loads + fix command** — hovering shows `entry(cli).bootloaders` / `mcp.configPath`, the `CLI_META.loads` sentence ([`canon.ts:232`](../../src/bootstrap-ai/canon.ts)), and the exact `aih …` command. Reuses `TOOL_HINTS` install strings ([`artifact.ts:209`](../../src/report/artifact.ts)) for absent tools.
5. **Targeted vs machine-detected split** — emphasised committed targets above a muted "also installed" group; answers both "wired for my chosen tools?" and "what else is here?" without conflating them.
6. **Terminal + dual-KPI parity** — same matrix as ASCII in `aih report` text output; **two** top KPI tiles — "N/M structurally configured" and "K/M proven loadable" — never one collapsed "fully wired" number (so a wall of `unverified` doesn't read as "broken"); per-CLI remediation lines in the scorecard failing list.
7. **Target-source banner** — the panel header names where the target set came from (`.aih-config.json`, `--cli`, `--detect`, or `default-claude`); a `missing` cell under `default-claude` is shown informational, not as a failure.

The new **"Loads?"** column is the key visibility for your concern: a row can be all-green on artifacts and still flag `✗ won't load` — surfacing the silent miss instead of hiding it behind a present file.

---

# 6. Surfaces touched

| File | Change | Phase |
|---|---|---|
| `src/report/cli-coverage.ts` | **new** — model + digest (§3) | 1 |
| `src/report/cli-loadability.ts` | **new** — Tier-1 loadability checks (§4) | 1.5 |
| [`cli-registry.ts`](../../src/internals/cli-registry.ts) | add optional `settings`, `activation`, `contextCap`, `lastVerified`/`verifiedVersion`; add `expectedArtifacts(cli)` helper | 1 / 1.5 / 2 |
| [`local.ts`](../../src/report/local.ts) | add `cliCoverageDigest` to `localPanels`; relabel `toolingPanel` describe to "Machine tooling" (it's detection) | 1 |
| [`render.ts`](../../src/report/render.ts) | terminal ASCII matrix for the digest body | 1 |
| [`artifact.ts`](../../src/report/artifact.ts) | new `cliMatrixPanel`; route in `panelFor` ([`:409`](../../src/report/artifact.ts)); add `"AI CLI wiring"` to "Harness adoption" `CATEGORIES` ([`:445`](../../src/report/artifact.ts)); change the "AI CLIs here" KPI tile ([`:676`](../../src/report/artifact.ts)) to "N/M targeted tools wired" | 1 |
| [`loadgroups.ts`](../../src/report/loadgroups.ts) | per-group `cap` from registry; flag overflow (Tier-1 size check) | 1.5 |
| [`demo.ts`](../../src/report/demo.ts) | sample "AI CLI wiring" digest so demo showcases it | 1 |
| [`scorecard.ts`](../../src/report/scorecard.ts) | `harnessWiring` consumes `scanCliCoverage`: per-targeted bootloader, MCP only-when-writable, settings only-when-claude-targeted; add Tier-1 loadability as fail-closed | 2 |
| [`doctor.ts`](../../src/doctor.ts) | per-CLI loadability probes (Tier 1 fail-closed) + freshness warnings (Tier 2) | 1.5 / 2 |
| [`status.ts`](../../src/status.ts) | split `ARTIFACTS` into repo-global vs per-CLI (registry-derived); `configPanel` narrows to global | 3 |
| `tests/report/cli-coverage.test.ts` + loadability + dashboard + scorecard tests | §8 | each |

---

# 7. Scorecard integration

`harnessWiring` stops asking three global questions and folds the matrix: one `bootloader` check per targeted CLI, MCP graded only for `writable` targets (manual reported but not scored), settings only when claude is targeted, plus Tier-1 loadability as fail-closed. Single source — report and scorecard read the same `scanCliCoverage`, exactly how `inventory()` is shared today.

---

# 8. Test plan (TDD — write first)

- **Windsurf-only repo** with `.windsurfrules` present → Windsurf bootloader `wired`, score 100% (false-negative fixed).
- **`CLAUDE.md` present, targets = `[kiro]`** → claude row not counted; kiro bootloader `missing`; score reflects kiro only (false-positive fixed).
- **`.mcp.json` = `{}`** → MCP `missing`, not `wired` (content check).
- **Codex target** → MCP cell `manual`, excluded from denominator.
- **Settings** → `na` for non-claude; not docked.
- **Loadability — Cursor `.mdc` with `alwaysApply: false`** → bootloader `wired` but `loads === "wontLoad"`.
- **Loadability — broken pointer** (`RULE_ROUTER.md` missing) → `wontLoad` with the dangling target named.
- **Loadability — BOM before frontmatter** → `wontLoad` (byte hygiene).
- **Loadability — bundle over `contextCap`** → `wontLoad` (truncation risk).
- **Unprobeable tool** → `loads === "unverified"`, never silently `loads`.
- Dashboard: matrix renders all four states + the Loads? column + KPI tile. Scorecard: target-scoped wiring + loadability fail-closed.

---

# 9. Build order / phases

- **Phase 1 (core, additive, highest value):** `cli-coverage.ts` model + report matrix panel + terminal + dual KPI + demo. Includes the **writable-MCP content check** (parse the file, require a non-empty `configKey` map — not deferred to 1.5) and the **target-source** field. Disturbs nothing existing; immediately fixes visibility.
- **Phase 1.5 (loadability):** `cli-loadability.ts` Tier-1 checks + `loadgroups` cap + doctor probes + registry `activation`/`contextCap`. Closes every structurally detectable silent miss.
- **Phase 2 (scorecard + freshness):** scorecard consumes the model; Tier-2 `lastVerified`/`verifiedVersion` freshness warnings. Fixes the maturity false +/-, surfaces convention drift.
- **Phase 3 (cleanup, optional):** de-dup `configPanel`/`inventory` to global-only so per-CLI lives in one place; flows into `aih status`.
- **Deferred:** Tier-2 canary / dry-run probes (per-tool, low coverage today).

---

# 10. Decisions you need to take

Status legend: **RESOLVED** = default accepted (endorsed by the 2026-06-26 review); **OPEN** = still your call. Override any RESOLVED row by noting it.

| # | Decision | Recommended default | Status |
|---|---|---|---|
| **D1** | `configPanel` fate: (a) narrow to repo-global artifacts, matrix owns per-CLI (Phase 3); (b) leave alongside (more redundancy) | **(a)** — one source per fact | **RESOLVED** — review endorsed the Phase 3 split |
| **D2** | `manual` MCP weak-signal: for the 2 repo-relative manual tools (Copilot `.vscode/mcp.json`, OpenCode `opencode.json`) annotate the `manual` cell with file-present, or keep purely `manual` | **annotate** (file-present as a hint, still `manual`) | **OPEN** ← the only decision the review left open |
| **D3** | `aih status` scope: fold the matrix into `status` (Phase 3), or keep this report/scorecard-only for now | **report/scorecard-only now**, status in Phase 3 | **RESOLVED** — matches review's Phase 3 |
| **D4** | Tier-1 loadability surface: `doctor` + matrix only, or also gate `aih bootstrap-ai --verify` | **doctor + matrix now**; `--verify` later | **RESOLVED** — review agreed |
| **D5** | YAML frontmatter: add a dep, or hand-parse the `---` block | **hand-parse** (no new dep) | **RESOLVED** — review agreed |
| **D6** | Tier-2 scope: freshness now + defer canary, or both now | **freshness now, canary deferred** | **RESOLVED** — review agreed |
| **D7** | Loadability score weight: `wontLoad` a hard score fail, or doctor-only | **doctor fail + score fail** — a tool that won't load is not "wired" | **RESOLVED** — review agreed (note: existing repos may see grades drop) |
| **D8** | Wired KPI definition | **dual KPI**: count "structurally configured" (cells `wired`, loadability ignored) AND "proven loadable" (`loads === "loads"`) separately; `unverified` counts toward configured, never toward loadable | **RESOLVED (refined)** — review added the softer "configured" number alongside the strict "loadable" one |

**Cross-cutting principle (D0):** the validator never reports a state it cannot prove — `unverified` is a first-class verdict, distinct from both `wired` and `wontLoad`. Everything above assumes this holds. **RESOLVED — review called this the most important principle; KEEP.**

---

_All phases shipped 2026-06-26 (see banner). D2 (annotate the two manual-MCP cells) was the only open call and blocks nothing — revisit only if the MCP column needs the file-present hint._
