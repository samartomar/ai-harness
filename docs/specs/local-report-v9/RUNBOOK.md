# RUNBOOK — building v9

## 0. Environment
- Repo: this worktree (`D:\dev\ai-harness-codex` on Windows). Node ≥ 20.
- Branch: **`feat/local-report-v9`** (already created off `feat/local-report-v4-phase0`).
  Create child branches off it if you like; never branch work onto `main`.
- Windows shells: PowerShell or Git-Bash. Note: aih's own execFile runner can't spawn
  `.cmd` shims (npm/npx) directly on Windows — tests mock this; if you hit it in real runs,
  route via `cmd /c`. (Your dev commands like `npm run …` in the shell are fine.)

## 1. Build order

### Phase A — scaffold + LIVE panels (no new capabilities)
1. Read the reuse set first (README "Reuse what's proven"): `src/report/v4.ts`,
   `tests/report/v4*.test.ts`, `src/report/index.ts`, `biome.json`, and
   `docs/specs/local-report-v9/reference-v9.html`.
2. Create `src/report/v9.ts`: `AihDataV9` types, `buildAihDataV9(digests)`, `reportHtmlV9(...)`.
   Embed the v9 shell (CSS + chart JS from the reference), inject `AIH_DATA`, hydrate, gate.
3. Wire `--v9` into `src/report/index.ts` (model on `--v4`: forces html, routes to `reportHtmlV9`).
4. Bind the 🟢 LIVE panels (SPEC §3): hero (wiring score + radar), ★ action board, 01 context+
   per-turn, 02 activity (heatmap+LOC+repo; usage-by-CLI partial), 03 quality+guardrail
   enforcement (ECC card PREVIEW), 04 drift (coherence PREVIEW), 05 MCP+egress, 06 adoption,
   07 enterprise support, ✓ wins (heal + run ledger — see CAPABILITIES §4).
5. Demo dataset (DEMO-DATA.md) for `--demo` + as PREVIEW fill. Honesty gating (live/preview/empty).
6. Tests: `tests/report/v9.test.ts` (data mapping + gating) and `tests/report/v9-dom.test.ts`
   (happy-dom — run the hydrate, assert real bindings + PREVIEW marks + empty states).
7. **Gate + commit** (Phase A green before Phase B).

### Phase B — the new capabilities (SPEC panels go PREVIEW → LIVE)
For each of CAPABILITIES §1 ECC-inventory scan, §2 coherence diff, §3 outcome/MTTR (and finish
§4 wins if not fully wired): add the digest in the `localPanels` family with unit tests, then
flip its v9 panel from PREVIEW to LIVE and bind it. One capability per commit, each green.

### Phase C — verify, redact, hand back
1. Whole-report redaction pass (SPEC §4). 2. Full gate run. 3. Generate live + demo + a
   `--refresh` smoke. 4. Prepare the review packet / draft PR (see §4). **Do not merge.**

## 2. Commands (gate on exit codes, not piped tails)
```
npm run typecheck                       # tsc --noEmit  → must be 0
npm run lint:fix && npx @biomejs/biome ci src tests   # CI-equivalent → 0
npm test                                # vitest run (full suite) → 0
npm run build                           # tsup → 0
node dist/cli.js report --v9 --apply --out <scratch>/v9.html   # live generation smoke → 0
```
Always check the real exit code (`echo "EXIT=$?"` / `$LASTEXITCODE`); a `cmd | tail && commit`
masks failures. Run the full suite, not just your new tests.

## 3. Commit discipline
- Conventional commits (`feat(report): …`). Small, green, one logical step each.
- **No attribution / Co-Authored-By line** (disabled by the user's global git settings).
- Never `--no-verify`, never skip hooks. Keep the legacy report + `--v4` behavior unchanged
  (existing tests must stay green).
- The big embedded shell/template gets excluded from biome like `v4-template.ts` (see `biome.json`).

## 4. Hand back (do NOT merge to main)
When Definition of Done (TEST-CRITERIA.md) is met:
1. Push the branch (`git push -u origin feat/local-report-v9`) and open a **DRAFT PR targeting
   `main`** — do not mark ready, do not merge.
2. Write `docs/specs/local-report-v9/HANDBACK.md`: what's LIVE vs PREVIEW, gate results (paste
   exit codes + test counts), any deviations from SPEC + why, screenshots or the generated
   `--demo` HTML path, and open questions for the reviewer.
3. Stop and notify for review. The original session/human reviews; only they decide on merge.

## 5. Guardrails recap
- main is off-limits. · live-or-don't-render. · no cost/forecast. · determinism (byte-stable).
- If a panel can't be made real or honestly previewed, leave it omitted and note it in HANDBACK.
- If SPEC and the reference HTML disagree, SPEC wins for data/behavior; reference wins for look.
