# CAPABILITIES — new data the v9 panels need

Four data capabilities. §1–§3 are net-new (their panels are PREVIEW until built). §4 (the
wins ledger) is mostly wireable from existing data today. Each is a read-only digest in the
`localPanels` family (`src/report/local.ts`), returns **undefined/empty when no data** (so its
panel gates honestly), and is **pure + deterministic** (Runner seam for git/fs; no wall-clock
in output). Add unit tests per the existing report-test conventions, and add the panel binding
in `v9.ts` only once the digest is real.

---

## §1 ECC-inventory scan  →  Guardrails+ECC card (03) and Skill ledger dormant (09)

**Goal:** know what an ECC install actually put on disk, so the report can show "what came
along" and detect **dormant** skills (installed but never invoked).

**Inputs (file-presence scan, like the adoption checks):** count ECC-managed content under the
known locations for the targeted CLIs — e.g. `.claude/agents/`, `.claude/skills/`,
`.kiro/agents/`, `.kiro/skills/`, `.kiro/steering/`, rules dirs, and hooks declared in
`.claude/settings.json` / Kiro settings. ECC installs these via its own installer
(`src/ecc/index.ts` — "curated agents/skills/steering/hooks/scripts/settings"); the stack
packs come from `eccLanguages(stack)`.

**Output digest** (`describe` "ECC harness"): `{ agents, skills, rules, hooks, packs: string[],
profile?: string }`. Counts are file counts (state honestly: "scanned from .claude/.kiro").

**Dormant set (for §09):** `dormant = installedSkills − invokedSkills`, where `invokedSkills`
comes from `aggregateUsage.skills` (`src/usage/aggregate.ts`). Requires the usage hooks for the
invoked side; until those are wired, the dormant card stays PREVIEW. Output: `{ dormant:
string[], tokensReclaimable?: number }`. Real example to preserve: ECC ships go/php/ruby/swift/
kotlin review packs that never fire in a TS repo → trim candidates.

**Tests:** given a temp repo with N agent/skill files, the scan reports N; dormant = installed
minus a supplied invoked set; empty repo → undefined (panel omits).

---

## §2 Cross-CLI coherence diff  →  Coherence matrix (04)

**Goal:** do all targeted CLIs load the *same* canon? (Today only single-CLI wiring + drift
exist; the agreement matrix is fabricated in the mockup — build it for real.)

**Inputs:** the per-CLI facts already in `scanCliCoverage` (`src/report/cli-coverage.ts`) +
`extractManagedBlock`/`bootloadersInSync` (`src/report/scorecard.ts`, already used for drift).
For each dimension (rules/router/mcp/loads), compare across targeted CLIs: same shared managed
block? same RULE_ROUTER pointer? same MCP server set? loadable?

**Output digest** (`describe` "Coherence"): `{ clis: string[], dims: string[], cells:
Record<cli, Record<dim, "ok"|"warn"|"bad">>, agreementPct }`. Agreement = % of cells where all
CLIs match the canonical expectation. Undefined when <2 CLIs targeted (no cross-CLI question).

**Tests:** 2 CLIs with identical managed blocks → 100%; one drifted block → that cell warn +
agreement drops; single CLI → undefined.

---

## §3 Outcome deltas / MTTR  →  Over-the-period panel (08)

**Goal:** the honest "did productivity improve over the period" measures (DORA-flavored),
derivable from git + the run ledger — not commit-count vanity.

**Inputs / outputs** (`describe` "Outcome deltas"):
- **Lead time** (commit→merge): from merge commits / first-commit-to-merge on the default
  branch via the git Runner seam. `{ leadTimeDays }`.
- **Rework / revert rate:** share of commits that are reverts/hotfixes (message + `git revert`
  detection) over the window. `{ reworkRatePct }`.
- **Time-to-green / MTTR:** how long a failing check stayed broken before a later run showed it
  green — computed from the **run ledger** `.aih/runs/` rows (each row has status + timestamp;
  see `src/commands/run.ts`). Compute per failure class (drift, external-check/heal). `{ mttr:
  { drift?: hours, externalCheck?: hours } }`.

Returns undefined until ≥2 ledger samples / sufficient git history exist → panel PREVIEW/empty.

**Tests:** synthetic ledger rows broken→green N hours apart → mttr = N; revert commits in a
fixture → reworkRate; <2 samples → undefined.

---

## §4 Wins / remediation ledger  →  "What aih unblocked" (✓)

**Goal:** surface aih's origin value — the host/enterprise runtime blockers it cleared. **Mostly
wireable today.**

**Inputs:**
- The `aih heal` checks (`src/heal/` — real step titles: **"certificate trust chain"** (certs),
  **"npm runtime"** (npm), **"PATH resolution"** (path), **"MCP pre-flight"** (mcp)). Each yields
  a verdict (broken/fixed/skip). Read the most recent heal result, or have `aih report` surface
  the last-known heal state. Decide: read a persisted heal-result file, or run heal's read-only
  probes inline (heal is read-only by default — diagnose without `--apply`).
- The **run ledger** `.aih/runs/` for the over-the-period cumulative (N blockers cleared across
  M runs since first run; "open blockers over time" trend).

**Output digest** (`describe` "Remediation"): `{ items: [{ name, scope, status: "fixed"|"broken"
|"na", when }], cleared, runs, since, openOverTime: number[] }`.

**Honesty:** show only what was actually probed/repaired; a never-broken item is "n/a (not
needed)", not a fake win. If heal has never run, the panel says "run `aih heal` to populate."

**Tests:** heal checks all fixed → 4 items fixed + "runtime green"; one broken → it shows broken
(and should also appear as a High action + an enterprise-support escalation if external).
