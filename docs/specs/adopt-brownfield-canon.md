# SPEC — `aih adopt`: brownfield AI-canon migration

> Status: draft / roadmap headline. Author: adoption analysis 2026-06-27, grounded in real
> dry-runs against `eicp`, `syntegris`, `ai-os`, and the live `src/bootstrap-ai` + `src/scaffold`
> source. Nothing here is applied yet.

## 1. Problem

aih nails **greenfield** (`aih init` on `ai-harness` was all clean `[create]`). Against a repo that
**already has an AI-canon folder** — the common enterprise case — `aih bootstrap-ai` treats the
existing canon as *drift to overwrite*, not as *prior art to adopt*. The dry-runs proved it:

| Repo | What aih reported | Why |
| --- | --- | --- |
| `eicp` | `[overwrite] RULE_ROUTER.md`, `XX bootloader CLAUDE.md … drifted from the canonical block` | eicp's bootloader uses the **same** marker (`ai-canonical:shared`, == aih's `SHARED_MARKER`); only the **body** differs — and eicp folded an *EICP project extension* into that body. A blind overwrite destroys it. |
| `syntegris` | `XX bootloader CLAUDE.md … no managed canonical block found`; `[create] _shared-canonical-block.md` | syntegris predates the marker scheme (its `RULE_BOOTLOADER_MIGRATION.md` shows a `.cursorrules`/`.cursor` model). It has equivalent canon under a *different shape*. |
| `eicp` lint | flags `agent-behavior-core.md` soft-imperatives | aih **lints the human's behavioral core it is about to overwrite** — backwards. |

eicp/syntegris also already hand-rolled aih's exact pattern (`REGENERATION.md` +
`regenerate-adapters.ps1/.sh`, `archive-legacy-tool-rules.*`). Those copies have **already diverged
from each other** (eicp has an `antigravity` adapter + no archive script; syntegris has `gemini` +
an archive script + a migration doc). That divergence *is* the argument for a single versioned
generator — but only if aih can adopt what's there instead of bulldozing it.

## 2. Goal

A first-class **`aih adopt`** command (sibling to `init`) that takes a repo with existing canon and
converges it onto aih's managed model **without losing human work**, emitting a *migration diff* (not
an overwrite plan), preserving project extensions, and leaving the repo `bootstrap-ai --verify`-green
and idempotent. Plus an adopt-aware `SETUP-TASKS.md` so the post-migration flow is *completely usable*.

## 3. The three classes (detection contract)

`aih adopt` first classifies the repo. Detection is read-only and reported in the dry-run header.

1. **Greenfield** — no `RULE_ROUTER.md`, no bootloader marker, no regenerate script.
   → delegate to existing `init`/`bootstrap-ai` create path. (`ai-harness`, `ai-os/samar-ai-os` — *skipped per owner*.)
2. **Marker-compatible / body-divergent** — bootloader carries `<!-- BEGIN ai-canonical:shared … -->`
   but `extractManagedBlock(text, SHARED_MARKER) !== sharedCanonicalBlockBody(dir)`. (`eicp`.)
   → **reconcile body**: diff aih's canonical body vs on-disk; isolate human additions (the project
   extension) and re-attach them; rewrite the block; never touch the preamble.
3. **Foreign-scheme / equivalent canon** — has a `RULE_ROUTER.md` and/or a `regenerate-adapters.*`
   script and/or a migration doc, but **no** `ai-canonical:shared` block. (`syntegris`.)
   → **import + insert**: map existing rules into aih's `rules/`, insert the marker block into the
   bootloader, retire the foreign scheme.

Detection signals (all read-only, via existing `readIfExists` + `scanRepo`):
- `extractManagedBlock(bootloader, SHARED_MARKER)` present? → class 2 vs 3.
- `<contextDir>/RULE_ROUTER.md` exists? `<contextDir>/adapters/_shared-canonical-block.md` exists?
- prior-art scripts: `<contextDir>/scripts/regenerate-adapters.{ps1,sh}`, `archive-legacy-tool-rules.*`,
  `RULE_BOOTLOADER_MIGRATION.md`, hand `REGENERATION.md` whose body != `regenerationDoc(...)`.
- foreign markers: any `<!-- BEGIN … -->` whose id != `SHARED_MARKER` (e.g. a future-proofing scan).

These classes cover the canonical `ai-coding/` shape + the three markdown bootloaders. A second,
orthogonal dimension — config a team already keeps at **CLI-native locations** (`.claude/`, `.cursor/`,
`.kiro/`, …) — is handled by §13, under the hard rule that aih never auto-modifies those locations.

## 4. Command surface

```
aih adopt [path] [--apply] [--verify] [--json] [--cli <list>|--all-tools|--detect]
          [--context-dir <name>] [--report <file>] [--keep-legacy]
```
- **dry-run default**: prints the *migration plan* (§6) — class, per-file action, and the body diff.
- `--apply`: executes with `.aih.bak` backups + transactional rollback (existing fsxn machinery).
- `--verify`: post-migration drift gate (== `bootstrap-ai --verify`) — must be green.
- `--keep-legacy`: do not move the retired hand artifacts (default retires them to `.aih/legacy/`).
- `--report <file>`: write the migration diff as a reviewable markdown artifact (consent = the path).

`init` gains a guard: if it detects class 2/3, it **stops and recommends `aih adopt`** instead of
planning `[overwrite]` (one-line redirect; no silent bulldoze).

## 5. Marker-migration algorithm (class 2 — the core)

The shared block today is regenerated wholesale. Adopt must split it into **canonical** vs
**project-extension** so the human part survives:

1. `onDisk = extractManagedBlock(bootloader, SHARED_MARKER)`; `canonical = sharedCanonicalBlockBody(dir)`.
2. Compute the **extension** = lines in `onDisk` not present in `canonical` (anchored diff; tolerate
   reordering and whitespace/EOL per the existing CRLF-aware merge). For eicp this is the "EICP project
   extension" paragraph in `agent-behavior-core` / the shared block.
3. Re-home the extension: write it to a **project-owned, never-regenerated** file
   `<contextDir>/rules/project-canon-extension.md`, and reference it from `RULE_ROUTER.md`'s
   project section (router is regenerated but the *reference* is a stable, generated line).
4. Regenerate the bootloader block from `canonical` (now clean) via `mergeManagedBlock` — extension is
   no longer inside the managed region, so future `--verify` stays green without re-flagging it.
5. If the on-disk body is byte-equal to canonical → **no-op** (already adopted; idempotent).

The same split applies to `agent-behavior-core.md`: aih owns §"core discipline"; any project §
("EICP project extension") is carved into `project-canon-extension.md` before the overwrite, and the
soft-imperative lint runs **only on aih's generated core**, never the carved-out human prose (fixes
the backwards-lint bug from §1).

## 6. Migration diff format (replaces `[overwrite]`)

Per file, the plan prints intent, not a flat overwrite:

```
Migration plan for adopt (class: marker-compatible/body-divergent — eicp)
  [adopt]   CLAUDE.md — managed block: 4 canonical lines updated; 1 project line preserved → rules/project-canon-extension.md
  [carve]   ai-coding/rules/agent-behavior-core.md — EICP extension §9 → rules/project-canon-extension.md, core regenerated
  [keep]    ai-coding/rules/gateway-enforcement.md — project rule, untouched
  [retire]  ai-coding/scripts/regenerate-adapters.ps1 → .aih/legacy/  (superseded by `aih bootstrap-ai`)
  [retire]  ai-coding/REGENERATION.md (hand) → regenerated by aih
  [create]  ai-coding/harness-update.md — update contract
  [converge] RULE_ROUTER.md — 3 sections match aih; project section re-referenced
```
`--json` carries `{ class, actions:[{path, op, canonicalDelta, preserved[]}], retired[], diff }`.

## 7. `SETUP-TASKS.md` in adopt mode (the "completely usable" piece)

Today `setupTasksDoc()` assumes **empty** skeletons ("fill architecture.md from the code"). For a
brownfield repo that already has rich `architecture`/`conventions`/`rules`, that's wrong — it tells the
agent to re-derive content that exists. Adopt generates a **reconciliation** variant instead:

- `setupTasksDoc(dir, stack, { mode: "adopt", existing })` →
  1. **Verify, don't re-derive**: "your repo already has `<contextDir>/rules/*` and
     `playbooks/*` — confirm each is still accurate vs the current code; update only stale lines."
  2. **Fold the carve-out**: "review `rules/project-canon-extension.md` (auto-extracted from your old
     shared block) — confirm it's complete and delete anything now covered by aih's canonical core."
  3. **Adopt the gates**: "your old `regenerate-adapters.*` is retired in `.aih/legacy/`; the new
     drift gate is `aih bootstrap-ai --verify` — wire it into CI in place of the old dirty-tree check."
  4. **Fill only true gaps**: any aih skeleton with no existing equivalent (e.g. `harness-update.md`
     context) — same as greenfield.
- `validationDoc()` gains an adopt check: "**No canon regressions** — every rule/playbook that existed
  pre-adopt still exists (diff against `.aih/legacy/`), and `bootstrap-ai --verify` is green."

This makes the migration land as a *reviewed convergence* the agent can finish, not a pile of empty
skeletons next to the human's real canon.

## 8. Retirement of redundant hand artifacts

Moved (not deleted) to `.aih/legacy/<path>` with a one-line `.aih/legacy/README.md` deprecation note:
`regenerate-adapters.{ps1,sh}`, `archive-legacy-tool-rules.{ps1,sh}`, `RULE_BOOTLOADER_MIGRATION.md`,
hand `REGENERATION.md`. `--keep-legacy` leaves them in place but still annotates the migration diff.
`.aih/legacy/` is gitignored like the rest of `.aih/`.

## 9. Idempotency & verify contract

- `aih adopt` run twice = byte-identical (class becomes "already adopted" → all `[keep]`/no-op).
- After `--apply`, `aih bootstrap-ai --verify` MUST pass (router present, every bootloader in sync, lint
  clean on generated canon). The adopt run ends by invoking that verify and surfacing the result.
- Writes `.aih-config.json` (`AihConfig`: contextDir + targets) so re-runs/doctor read intent — same as init.

## 10. Implementation surface (grounded in current code)

- **New** `src/adopt/index.ts` (CommandSpec `adopt`) + `src/adopt/classify.ts` (the §3 detector) +
  `src/adopt/reconcile.ts` (the §5 block/extension split).
- **Reuse**: `internals/markers.ts` (`extractManagedBlock`/`mergeManagedBlock` — add a
  `splitManagedBody(onDisk, canonical) → {canonical, extension}` helper), `bootstrap-ai/canon.ts`
  (all doc generators + `SHARED_MARKER`), `internals/fsxn.ts` (backups/rollback/`.aih/legacy` moves),
  `profile/scan.ts` (`scanRepo`), `config/marker.ts` (`AihConfig`).
- **Modify**: `scaffold/templates.ts` `setupTasksDoc`/`validationDoc` to accept a `mode` +
  `existing` summary (§7); `init/index.ts` to add the class-2/3 redirect guard; `lint/run.ts`
  callers so the soft-imperative lint never runs on carved human prose.
- **Doctor**: add an "adoptable canon detected — run `aih adopt`" advisory finding (support taxonomy)
  when class 2/3 is seen without an `.aih-config.json`.

## 11. Phased delivery

1. **Detector + dry-run diff only** (`classify.ts`, migration-diff printer, `--json`, doctor advisory).
   Ship read-only first — zero write risk, immediately useful on all four repos.
2. **`splitManagedBody` + class-2 reconcile** (`--apply` for eicp): carve extension, regenerate block,
   verify green. Prove end-to-end on an eicp throwaway branch.
3. **Class-3 import + insert** (syntegris): map foreign scheme, insert marker, retire artifacts.
4. **Adopt-mode `SETUP-TASKS`/`VALIDATION`** (§7) + `init` redirect guard + lint-scope fix.

## 12. Test plan

- Fixtures from the **real** divergent canons (copy eicp's + syntegris's `ai-coding/` + bootloaders into
  `tests/fixtures/adopt/{marker-divergent,foreign-scheme}`); the prior Windows lesson applies — exercise
  the real classify/reconcile, not mocks, since marker/EOL handling is the failure surface.
- Cases: idempotent re-run (no-op); extension preserved (assert the project line survives in
  `project-canon-extension.md` and is gone from the managed block); `--verify` green post-apply;
  retirement moves the right files; greenfield still routes to `init`; CRLF repo stays CRLF.

## 13. CLI-native config — discover, surface, opt-in migrate (never auto-modify)

§3 looks at the canonical `ai-coding/` shape. But a team already using a specific CLI keeps
rules/agents/memory at **tool-native locations aih does not own**. Two real shapes in the portfolio:

- `ai-os-product/.cursorrules` is a **thin pointer** ("Active rules live under `ai-coding/` … read
  `RULE_ROUTER.md`") → already wired; leave it alone.
- `syntegris/.claude/` holds **rich, un-migrated content**: 5 agents (`agents/*.md`), rules
  (`rules/00-index.mdc`, `canonical-platform-rules.md`), 7 memory files (`memory/*.md`) — none
  referenced from the canon.

**Hard rule (owner-stated): aih NEVER auto-modifies a CLI-native location.** The default path is
*discover → surface → guide*. Converting a tool-native file is opt-in only, and even then the content
move is **agent-performed**, not an aih write into the tool's dir.

### 13.1 Inventory (read-only)

A new read-only `cliFootprint(root)` enumerates known tool-native locations and what each holds:

| CLI | Locations inventoried |
| --- | --- |
| Claude | `.claude/{agents,commands,skills,rules,memory}`, `.claude/settings*.json`, root `CLAUDE.md` |
| Cursor | `.cursor/rules/*.mdc`, `.cursorrules` |
| Kiro | `.kiro/steering`, `.kiro/hooks`, `.kiro/specs` |
| Codex | `AGENTS.md`, `.codex/` |
| Windsurf | `.windsurfrules`, `.windsurf/` |
| Copilot | `.github/copilot-instructions.md`, `.github/instructions`, `.github/prompts` |
| Gemini | `GEMINI.md`, `.gemini/` |

User-level dirs (`~/.claude`, `~/.codex`, …) are reported as **out-of-repo / global** — named so the
user knows they exist, never touched.

### 13.2 Per-artifact status

- **`pointer`** — the file references the canon / carries the aih marker → ✅ wired, leave alone
  (ai-os-product `.cursorrules`).
- **`tool-owned-content`** — rich content, no canon reference → ⚠️ *import candidate*
  (syntegris `.claude/{agents,rules,memory}`).
- **`runtime-config`** — `settings.json` / `launch.json` / `.kiro/hooks` → tool runtime, not canon;
  reported, left as-is (aih's `bootstrap-ai --cli kiro` already owns Kiro hooks).

### 13.3 Surface (so the user *knows*)

adopt's digest, `aih status`, and `aih report` gain a **"CLI-native footprint"** panel, e.g.:
"Detected Claude config at `.claude/` (5 agents, 3 rules, 7 memory files) — aih will NOT modify it.
2 rules look importable into `ai-coding/rules/`; run `aih adopt --plan-cli` for the migration map."
A `canon.cli-native-unmigrated` advisory (skip — never fails a run) routes it via support like every
other finding.

### 13.4 Opt-in full migration (agent-performed)

When the user wants their whole CLI-native set folded into the canonical pattern, aih provides the
**map + playbook**, not the CLI-native writes. Source → canonical destination:

- `.claude/rules/*`, `.cursor/rules/*.mdc`, `.windsurfrules`, `.kiro/steering/*` → `ai-coding/rules/*`
- `.claude/agents/*` → `ai-coding/agents/*` (tool-neutralized; referenced from the router)
- `.claude/memory/*` → reconciled against `ai-coding/rules/memory-use-protocol.md` — content stays the
  user's; surfaced, not force-moved
- `.github/copilot-instructions.md`, `GEMINI.md`, `AGENTS.md` → thin bootloaders pointing at `RULE_ROUTER.md`

The migration runs through **adopt-mode `SETUP-TASKS.md` (§7)**: aih writes the playbook (the map above +
"verify, don't re-derive"), the user's **AI agent performs the content adaptation into the canon** (which
aih owns), and ONLY under an explicit `--migrate-cli` flag does aih convert a now-redundant tool-native
file into a thin pointer — backed up to `.aih/legacy/`, never silently.

**Content-verified ordering (owner safety requirement).** Pointer-conversion is a SEPARATE, LATER step
that must never run ahead of the content move — otherwise a half-finished migration silently strips a
user's active setup. So `--migrate-cli`:

1. **Skips (with a warning) any tool-native file whose content is not yet confirmed present in the
   canon** — a per-artifact check (the imported rule/agent exists under `ai-coding/`). Conversion is
   per-artifact, not all-or-nothing: ready artifacts convert, un-imported ones are **skipped and
   reported** ("skipped: import incomplete — content not found in the canon"), and the run still exits 0
   (a skip never fails — consistent with the rest of the harness). It is NOT a hard error that aborts the
   whole command; the user re-runs after finishing the import and the remaining artifacts convert then.
2. **Backs up** every converted file to `.aih/legacy/` first (recoverable even on mistake).
3. Is **surfaced in `SETUP-TASKS.md`**: the playbook tells the agent (a) there is *scope to improve* the
   tool-native content as it lands in the canon, and (b) a hard warning — do NOT run `--migrate-cli`
   until `VALIDATION.md` confirms each artifact's content is in the canon, or the tool will stop seeing
   its rules. A `VALIDATION.md` check asserts "no tool-native file was pointer-converted without its
   content present in the canon."

Absent `--migrate-cli`, every tool-native file stays exactly as it is and the agent merely adds canon
references — zero risk to the existing setup.

### 13.5 Why this is safe

The default path mutates nothing tool-native (mirrors aih's existing "guidance-not-writes for non-owned
formats" posture). The user always learns what exists and where; the agent always gets an actionable map;
full migration is deliberate, reversible, and opt-in — never a bulldoze.

### 13.6 Idempotency & the team-pollution guard

A team runs `adopt` repeatedly (each developer, plus CI). Every developer's CLI keeps writing to its
native location, and **each dev has their own style — that is fine and must NOT be pulled into the shared
canon**. So the footprint must not become a nag loop, and it must never pressure one person's practice
into the team's canon. Re-running `adopt` therefore sorts tool-native content into four dispositions, and
**only one is ever an import candidate**:

- **`[wired]`** — references the canon → leave alone (§13.2).
- **`[personal]`** — **not committed** (untracked or gitignored) → one developer's local/style config.
  Shown for awareness, **never** an import candidate, never nagged. Uses aih's existing tracked-file seam
  (`git ls-files`, the same gitignore-honoring mechanism `aih report`'s footprint uses); when the root
  isn't a git repo, the signal is unavailable and aih falls back to treating content as shared.
- **`[kept]`** — committed, but the team has **acknowledged** it as intentionally tool-native (recorded in
  the committed `.aih-config.json` under `adopt.acknowledged: [paths]`). Shown, never a candidate.
- **`[import]`** — committed, tool-owned, and **not** acknowledged → the ONLY disposition counted as an
  import candidate and the only one that raises `canon.cli-native-unmigrated`.

The shared-vs-personal signal is **committed (tracked)**, not merely "exists on disk": a file a developer
hasn't committed (untracked) — or has gitignored — is theirs, and stays `[personal]`. Only content the
team chose to commit is a shared concern.

This makes adopt **idempotent for a team**: personal rules are silent; once the team acknowledges the
shared tool-native content it intends to keep, re-runs go quiet; and only genuinely NEW committed shared
content surfaces — once — for a deliberate decision. Nothing is ever auto-pulled into the canon, so an
individual's practice cannot pollute the shared setup by default. Acknowledging is a tiny opt-in write to
the committed `.aih-config.json` (`aih adopt --ack <path>`, Phase 2); promotion into the canon stays the
opt-in `--migrate-cli` act (§13.4). The read-only disposition sort (gitignore-honoring + reading an
existing `acknowledged` list) ships in the Phase-1 footprint — so the loop is broken before any writer exists.

## 14. Open questions (need owner input)

1. **Extension detection fidelity** — line-anchored diff vs a marked sub-region. Should aih ask repos to
   wrap project additions in a `<!-- project-extension -->` sub-marker going forward, so future carves
   are exact instead of diff-inferred?
2. **`adopt` vs `init --adopt`** — standalone command (clearer) vs a flag on init (fewer verbs). Spec
   assumes standalone; the `init` redirect guard makes either ergonomic.
3. **Retire vs archive-in-place** — default to `.aih/legacy/` move, or leave legacy files and only
   annotate? Spec defaults to move; `--keep-legacy` opts out.
4. **Class-3 rule import** — auto-map foreign rule files into `rules/`, or leave them in place and only
   add the marker block + router references? (Lower-risk = leave in place, reference them.)
5. **`--migrate-cli` end state (§13.4)** — RESOLVED (2026-06-27): pointer-convert behind the
   `--migrate-cli` flag, but **content-verified** — aih refuses to convert any artifact whose content
   isn't already in the canon (so a half-done migration can't strip the user's active setup), backs up
   every conversion to `.aih/legacy/`, and `SETUP-TASKS.md` surfaces both the "scope to improve" and the
   "don't convert before VALIDATION confirms import" warning. Sub-question RESOLVED (2026-06-27):
   un-imported artifacts are **skip-with-warning** (per-artifact, run still exits 0), NOT a hard error —
   ready artifacts convert, the rest are reported and convert on a later re-run.
