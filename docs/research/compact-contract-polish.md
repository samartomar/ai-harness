# Compact-contract polish — generator improvements from the fuse-angular delivery review

_Generated 2026-06-29 on `feat/repo-contract-v1`. A weight-review of the COMPACT contract aih generated for a real repo (the local `fuse-angular` checkout — Angular 14 browser SPA, 1208 files, 5 CLI targets) surfaced these. **Every fix is generator-side** — a re-`aih init` regenerates the output, so editing the generated `ai-coding/` would be thrown away. Apply these in `aih`, then Samar re-runs setup and hands the cleaner output to another AI._

> Companion: `repo-contract-v1-plan.md` (the v1 spec these refine). This is post-delivery polish, not new scope.

## Delivery-review verdict

The contract **CORE is delivery-ready and honest**: all 4 commands map to real `package.json` scripts → correctly `detected` (no invention, strict-omit respected); `scale: large/1208` right; `sensitivePaths:[]` + `knownGaps:[]` are ACCURATE (verified: no `.env`/`secrets/`/`src/environments/` in the repo); bootloader chain intact (`CLAUDE.md`/`AGENTS.md`/`GEMINI.md` + `.githooks`/`.gitleaks.toml`/`.pre-commit-config.yaml` all present and referenced correctly); the §6 fold landed (anti-attestation + tool-selection in floor + core, immutability dropped); `project.md` is correctly facts-only.

**The weight problem is the periphery.** Of ~533 lines of generated markdown, **~305 (57%) is the 5 adapters + 2 guardrails prose docs** vs ~228 for the contract+canon core. The compact contract isn't yet as compact as its thesis.

## HIGH — the weight wins

### P1. Guardrails PROSE docs → `--canon legacy` (biggest single win, −185 lines)
- **Where:** `src/guardrails/index.ts`. The two emissions that WRITE files: `doc("Golden Paths…", taxonomyDoc(), taxonomyPath(ctx))` (lines 123-127 → `guardrails-taxonomy.md`, 56 lines) and `doc("Command-policy lexicon…", commandPolicyDoc(), commandPolicyPath(ctx))` (lines 131-135 → `command-policy.md`, 129 lines).
- **Change:** gate BOTH behind `canonMode(ctx) === "legacy"` (import from `src/internals/canon-mode.ts`). `ctx.options.canon` already flows to the guardrails phase under `aih init` (init threads options); also add `CANON_OPTION` to `guardrails` `command.options` so standalone `aih guardrails --canon legacy` works.
- **KEEP always (the teeth):** `.gitleaks.toml`, `.pre-commit-config.yaml`, `.github/workflows/sca.yml`, `risk-gates.json`, the `claudeBashPermissions()` projection into `.claude/settings.json`, and the advisory `ciNote`/`riskGatesDoc` docs (those have no path → no file). Only the two path-docs become files.
- **Why:** generic platform-engineering prose (Golden Paths/Guardrails/Safety Nets philosophy; the full deny/ask/safe lexicon as markdown) is low agent-leverage — the enforcement already lives in `.claude/settings.json` + the configs. This is exactly the "documentation garden" the compact redesign exists to cut.
- **Effort:** S. **Test:** compact guardrails plan omits the 2 `.md` writes; `--canon legacy` includes them byte-identical.

### P2. Trim the per-adapter `Boundaries` paragraph (−~40 lines; kills a 5×-duplicated rule)
- **Where:** `src/bootstrap-ai/canon.ts` `adapterNote(cli, dir)`, the `## Boundaries` section ("may propose/implement/review; must not push/merge/bypass CI without approval").
- **Change:** replace the paragraph with a one-line pointer: `Boundaries: see RULE_ROUTER.md § External action boundary (push / PR / merge need explicit human approval).`
- **Why:** the external-action boundary is already in the floor (`_shared-canonical-block.md`) AND RULE_ROUTER. Restating it in all 5 adapters is 5 redundant copies — pure token tax with zero added leverage.
- **Effort:** S. **Test:** adapter note no longer contains the full boundary paragraph; update existing adapter tests.

### P3. Finish the §6 router de-dup (compact branch only)
- **Where:** `src/bootstrap-ai/canon.ts` `ruleRouterDoc(...)`, the COMPACT branch (1C mode-branched this; legacy is frozen — DO NOT touch it). The compact router still re-spells the secrets rule (`### Security / secrets` → "Do not open `.env*`/`secrets/**`; use `aih secrets --verify`") and the code-review-graph rule (`### Implementation` + `## Tooling failure recovery`).
- **Change:** keep the task-routing STRUCTURE (which file to load per task) but stop re-spelling the secrets command + graph rule verbatim — point at `rules/agent-behavior-core.md` § Invariants / the shared block instead. The §6 decision was "router POINTS, doesn't re-spell" (currently 3× each across router/floor/core).
- **Effort:** S-M. **Test:** compact router contains a pointer not the verbatim lines; drift check stays green (router isn't the drift-checked shared block).

## MEDIUM

### P4. Browser-test (Karma) headless caveat — the one real agent-trap
- **Symptom:** `setup.md` says "Run the tests: `npm test`" with no caveat; for fuse-angular `npm test` → `ng test` → Karma launches Chrome and **HANGS in a headless/agent context.** Honest as a contract fact (`detected`), but it's the move most likely to fail the next agent first try.
- **Where:** `setupDoc` (`src/contract/templates.ts:104`) renders PURELY from the contract object (no re-scan, by the seam), so the caveat must travel through the contract. Cleanest channel = a `knownGap` (renders in both `project.md` "Known gaps" and `setup.md` "Close the known gaps").
- **Change:** `src/profile/scan.ts` — detect a browser test runner (a `karma.conf.{js,ts}` file, or a `karma`/`cypress`/`@playwright/test`/`@web/test-runner` dep) → expose e.g. `stack.browserTest: boolean`. `src/contract/synth.ts` `deriveKnownGaps` — when `browserTest`, push: ``runs in a browser (`<test cmd>`) — in CI/agent contexts run headless (e.g. `--watch=false --browsers=ChromeHeadless`)``. Keep it general (not Angular-specific).
- **Effort:** M (scan + synth + tests). **Test:** a fixture with `karma.conf.js` yields the knownGap; a node-test fixture doesn't.

### P5. Browser-vs-Node language label
- **Where:** `src/profile/scan.ts:447` — `pushFront(languages, isTs ? "TypeScript/Node.js" : "JavaScript/Node.js")`.
- **Change:** when a browser SPA framework is detected (frameworks ∋ Angular/React/Vue/Svelte/SolidJS/Preact), emit `"TypeScript"` (not `"TypeScript/Node.js"`) — a browser app doesn't run on Node and "Node.js" nudges a weak agent toward server assumptions. Keep `"TypeScript/Node.js"` for actual Node projects (Express/Nest/no browser framework).
- **Effort:** S. **Caveat:** confirm nothing branches on the exact `"TypeScript/Node.js"` string (RULE_ROUTER renders it but doesn't switch on it).

### P6. RULE_ROUTER recovery line should name `aih contract`
- **Where:** `src/bootstrap-ai/canon.ts` `ruleRouterDoc` "Tooling failure recovery" (compact branch).
- **Change:** "Re-run `aih bootstrap-ai` to regenerate this canon" → "Re-run `aih bootstrap-ai` (router/bootloaders) and `aih contract` (`project.json`/`project.md`)" — the contract files come from `aih contract`, not bootstrap-ai, so the current line is incomplete.
- **Effort:** S.

## POLISH (optional)
- `agent-behavior-core.md` §2 says "nothing speculative" twice (section intro + first bullet) — drop the bullet echo. `src/bootstrap-ai/canon.ts` `agentBehaviorCoreDoc`.
- `risk-gates.json` ships all 7 categories regardless of stack; several (payment_logic, destructive_migration, public_api_break) are inert for a frontend template. Optional: scope categories to the detected stack — or leave generic (defensible as safety nets).

## Validate after applying
Re-run on fuse-angular (or a scratch Angular clone) and confirm: file count under `ai-coding/` drops (the 2 guardrails `.md` gone in compact; adapters trimmed not removed); `project.md`/`setup.md` carry the Karma headless gap; `languages` no longer says "Node.js" for the SPA; the router no longer re-spells secrets/graph; gates green (typecheck / `biome ci` / vitest / build); `--canon legacy` still reproduces the full family byte-identical.

## Expected net
Compact `ai-coding/` for a 5-target repo drops from ~14 files / ~533 md-lines to ~12 files / ~310 md-lines (−2 guardrails docs, −~80 lines of adapter/router duplication), with the one real agent-trap (Karma) now surfaced — without losing any enforcement teeth.
