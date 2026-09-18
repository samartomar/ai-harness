# Adoption log

## P0 baseline (2026-09-18)

Uncommitted owner edit present at baseline time (untouched, not stashed):
`git diff --stat -- src/org-policy/studio-template.ts` →
`src/org-policy/studio-template.ts | 5 ++++-` (1 file changed, 4 insertions(+), 1 deletion(-))

### 1. `npm run build:workbench`
- Exit: 0
- Output: `Workbench browser bundle: 663691 bytes`

### 2. `npx vitest run tests/org-policy/workbench` (non-browser)
- Exit: 0
- Test Files: 69 passed (69)
- Tests: 435 passed (435)
- Duration: 79.70s
- Failures: none

### 3. `npx vitest run tests/org-policy/studio-*.test.ts` (all studio-*.test.ts)
- Exit: 0
- Test Files: 17 passed (17)
- Tests: 87 passed (87)
- Duration: 24.84s
- Failures: none

### 4. `npx vitest run tests/org-policy/ui-server`
- Exit: 0
- Test Files: 2 passed (2)
- Tests: 10 passed (10)
- Duration: 16.35s
- Failures: none

### 5. `npm run test:workbench:ui` (Playwright: `npm run build && playwright test --config playwright.workbench.config.ts`)
- First attempt: exit 1 — all 27 tests failed immediately (~3-10ms each) with:
  `Error: browserType.launch: Executable doesn't exist at
  C:\Users\Administrator\AppData\Local\ms-playwright\chromium_headless_shell-1243\chrome-headless-shell-win64\chrome-headless-shell.exe`
  The failure output itself instructed running `npx playwright install`; ran that
  (repo/Playwright's own remediation, not an AIH command) to fetch Chromium +
  chrome-headless-shell (~310 MiB).
- Rerun after install: exit 0
- Tests: 27 passed (27), total duration ~1.5m
- Failures: none

### 6. `npm run typecheck` (`tsc --noEmit && npm run typecheck:workbench`, which runs
`tsc -p tsconfig.workbench.json && tsc -p tsconfig.workbench-browser-tests.json`)
- Exit: 0
- No errors reported

### Workbench bundle size
- `Workbench browser bundle: 663691 bytes` (from `build:workbench`, step 1 and 5)
- Compact offline Workbench fixture (built during `test:workbench:ui`): 1,118,456 bytes

Note: the baseline ran with the owner's `studio-template.ts` danger-zone edit in the tree; it was committed afterwards unchanged as `a5ee12ea`, so the baseline matches HEAD.

## Decisions (2026-09-18)

Recorded with evidence, cost and reopen bar in `ADOPTION-PLAN.md` §3. Owners: D1 (dependency) owner + Fable (detail); D2, D3, D8 Fable; D4, D5, D6 owner on Fable's recommendation; D7 decided earlier.

## Plan defects found by Fable (to fix in the plan)

1. The plan implies a product CSP; the server sends none (`ui-server.ts:330-338`). Only the Playwright test injects one.
2. Fonts row: `studio-template.ts:135` names Manrope/IBM Plex/EB Garamond; the product embeds Inter *Variable*, not static weights.
3. Tests row cites "explorer report"; replace with measured counts (107 id hooks, 34 in browser specs, 19 studio/ui-server files).
4. D8 framed as dark-first ignored the shipped light/dark toggle. Fixed in §3.
5. D5: no code combines a selection with the org policy today. Fixed in §3.
6. The uncommitted `studio-template.ts` edit is now committed (`a5ee12ea`).
7. README cites `src/config/posture.ts` for lookup order; the order lives in `schema.ts:1882`.

## Scope list

- P5a (server folder classification) moved before the end of P3 — size M.
- Font embedding as its own later slice (~93 KB, test CSP `font-src data:`) — size S, awaits owner.

## P1 — design foundation, offline (commit 25952efc)

- Worker: Sonnet in a worktree. Reviewer fixes: Tailwind colours pointed at `--color-*` while tokens are `--wb-color-*` (light mode would never apply) — fixed.
- Fable adversarial review: no blocking findings. Packed `--ui` smoke from the tarball served the page with the CSS. Advisory items applied: content globs now resolve relative to the config (were cwd-relative, silent tokens-only output from another cwd); font families use the D2 system stacks; `workbenchIcon()` fails closed on unknown names (test added); the packed-artifact check now requires `dist/css.generated.cjs`.
- Gate (worktree, after fixes): `npm run build:workbench` → bundle 663,691 B (unchanged); `npx vitest run tests/org-policy/workbench tests/org-policy/studio tests/org-policy/ui-server` → 89 files, 536/536 passed; `npm run typecheck` → clean; `npx biome ci src tests --diagnostic-level=error` → no errors; `npm run test:workbench:ui` → 27 passed (1.4m), zero CSP violations.
- Size: rendered page +7.4 KB (tokens; no utility classes in use yet).
- Open: `--wb-color-on-tertiary-container` has no token (falls back to the dark hex); Tailwind `filter`/`blur` utilities will no-op until the `--tw-*` defaults are emitted (preflight off) — handle when first used; `policy` and `verified_user` icons are identical.
- Screenshots: none — P1 changes no visible markup.

## P5a — launch folder classification (commit 10227bf2)

- Worker: Sonnet in a worktree; committed from the main checkout because worktrees lack `node_modules/tsx`, which a ui-server subprocess test needs (environmental, not a regression).
- Reviewer fix: removed a `sha256` of `.aih-config.json` presented as if it were the bound policy's digest.
- Gate (main): `npx vitest run tests/org-policy/ui-server tests/org-policy/workbench-door.test.ts tests/org-policy/generate.test.ts tests/org-policy/admin-catalog-cli-route.test.ts` → 5 files, 49/49 passed; the pre-commit hook lanes passed.
- Setup slip found: `build:workbench` had not been re-run in the main checkout after merging P1, so `css.generated.cjs` was missing and 11 tests failed; after the rebuild they pass.
- Docs to update in P6: `docs/workbench-catalog-providers.md:164` says `--ui` consumes only package-owned data; it now also reads the launch folder, read-only, to pick a door.

## P2 — admin shell: header + kind ledger (this commit)

- Workers: P2a header, P2b kind ledger (Sonnet, worktrees). A first P2 worker delegated and stopped without output; relaunched as two narrow slices.
- Fable adversarial review, blocking findings, all fixed with tests:
  - B1 header fixed `h-14` overflowed below ~1000 px → `min-h-14`; a mobile regression that followed (sticky 141 px header covering content at 375×360, caught by `scrolling.spec.ts`) fixed with `max-md:static`.
  - B2 ledger counted assets the catalog hides (MCP 0/3 beside a 1-item catalog) → uses `browseBundle.assets`.
  - B3 light-mode label contrast 2.0–3.7:1 → labels neutral, colour only on icon and bar.
  - B4 opacity modifiers on `var()` colours generate no CSS (empty bar track, missing hover) → removed; tests forbid them.
  - Advisory applied: ledger mount takes free width, labels carry `title`; dead `bg-primary` classes on Export removed (the owner's red Export stays).
- Gate (main): `npm run build:workbench` → 670,857 B (+7.2 KB vs 663,691); `npx vitest run tests/org-policy/workbench tests/org-policy/studio tests/org-policy/ui-server tests/org-policy/workbench-door.test.ts` → 92 files, 569/569; `npm run typecheck` → clean; `npx biome ci src tests --diagnostic-level=error` → clean; `npm run test:workbench:ui` → 27 passed (1.5m).
- Screenshots: `screenshots/p2a-*`, `p2b-*` (taken before the review fixes). Prototype elements omitted because the product has no data or behaviour for them: org switcher, Vibe/Enterprise header switch, AI-tools count, Review Changes / Check Policy / Publish, user avatar, Token Budget tile (D6).
- Open: ledger "selected" counts the resolved closure (includes dependencies), a third count definition beside Selections/Requests — label or align in P3; ledger sits in the footer, the prototype puts it at the top — revisit with the P3 source masthead; no Playwright viewport below 1280 except `scrolling.spec.ts` mobile case — P4 adds screenshot checks.

## P3.0 — legacy token bridge (commit 7ad4da48)

- New route (reviewer's call after a Sonnet worker stalled on the full P3.1 restyle): map the legacy `--paper/--surface/--rule/--fill/--ink/--sans/--mono` variables onto `--wb-*` in `wb-tokens.css`. Every legacy panel takes the prototype palette in both themes with zero markup or hook changes (plan D3: CSS first).
- Contrast: faintest text `--ink-3` → `--wb-color-outline`, 4.6:1 light on white, ~5.6:1 dark.
- Finding: the earlier P2 dark screenshots showing light buttons were an artefact of capturing mid `transition-colors`; screenshots now wait 600 ms after a theme switch.
- Gate: `npx vitest run tests/org-policy/workbench tests/org-policy/studio tests/org-policy/ui-server tests/org-policy/workbench-door.test.ts tests/org-policy/project-policy.test.ts` → 93 files, 578/578; typecheck clean; biome clean; `npm run test:workbench:ui` → 27 passed.
- Screenshots: `screenshots/p3-bridge-light.png`, `p3-bridge-dark.png`.
- Open: primary action buttons still use the legacy green accent; the prototype uses blue.

## D5 schema (commit a1557c02)

- `src/org-policy/project-policy.ts`: strict `ProjectPolicyV1Schema`, `parseProjectPolicyV1`, pure `checkProjectPolicyNarrowsV1`. Not wired into any command.
- Owner questions (policy semantics — stop condition, not built on):
  1. The org policy has no identity or version string of its own; only `schemaVersion` (2|3). `cutFrom` pins `{schemaVersion, sha256}`. Is the digest alone an acceptable pin?
  2. `authoringSelections` has no flat allowed-asset list. The check uses the most conservative reading (resolved roots + requests, minus any excluded assetId, ignoring origin). Is that the right definition of "allowed", or must exclusions be origin-scoped?
- Gate: `npx vitest run tests/org-policy/project-policy.test.ts tests/org-policy/workbench-door.test.ts` → 17/17 (worker); full lanes above include it.

## P3 primary colour (commit fc2357c1)

- `.btn.primary` and the draft-review summary used the `--pass` status green; now `--wb-color-primary-container` with white text (5.19:1 light, 5.17:1 dark; plain dark primary would be 3.68:1). Dark hover `#1d4ed8` (6.7:1) because `primary-bright` would be ~2.5:1.
- Gate: vitest 93 files 578/578; biome clean; `npm run test:workbench:ui` 27 passed. Screenshots `p3-primary-*.png`.
- Open: active tab underline and selected source edge still green.

## P4 — visual checks (commit e7cc0e6e)

- `tests/org-policy/workbench/browser/visual-shell.spec.ts`: header + kind ledger screenshots, light and dark, 1440×900, transitions disabled, `#status` masked, `maxDiffPixelRatio` 0.01; header height = scrollHeight at 1440 and 375.
- Reviewer change: baselines are `-win32` only and CI runs this lane on ubuntu/macos/windows, so the spec skips off win32 with a stated reason. New scope (S): generate linux/darwin baselines on CI runners — needs a push, so owner.
- Gate: `npm run test:workbench:ui` → 29 passed (worker ran twice, both green; reviewer re-ran after the skip: 29 passed); typecheck clean; biome clean.

## P5b — user door page (commit 8a3ca3c1)

- Worker: Opus in a worktree (Sonnet stalled twice on large slices; model choice recorded here).
- Gate (main): `npm run build:workbench` → 683,974 B (+13.1 KB, includes the project-policy zod schema); `npx vitest run tests/org-policy/workbench tests/org-policy/studio tests/org-policy/ui-server tests/org-policy/workbench-door.test.ts tests/org-policy/project-policy.test.ts` → 94 files, 589/589; typecheck clean; biome clean; `npm run test:workbench:ui` → 31 passed (1.6m).
- Fable adversarial review: fail-closed holds, admin output byte-identical apart from model data, no XSS, single zod copy, no cycles. Blocking for P5c: B1 `/prepare` could re-render the user page with another policy while keeping the bound digest; B2 fixture digests an in-memory object, not file bytes. Advisory: radiogroup semantics, `aria-describedby` on Save, `required` on the name field; empty `items` is a valid "skip everything" file.
- Screenshots: `p5b-user-1440-light/dark.png`, `p5b-user-375-light.png`, `p5b-user-invalid-1440-light.png`, prototype `p5b-prototype-user-trim-1440.png`.
- Owner questions added (policy semantics, not built on): AI tools offered = org `governance.supportedClis` when set, else every supported tool; no cascade via `requires` relations.
- P5c in progress: the server reads the bound policy with the product's own binding reader and digest check, sends it as `initialPolicy`, refuses `/prepare` for the user door, and the fixture digests real file bytes.

## P5c — bound policy to the user door (this commit)

- Worker: Opus in a worktree. Refactor: `binding.ts` (`readBoundSource`, `assertBindingActiveAtRoot`, new export `readCurrentPolicyBindingSource`) and `schema.ts` (new export `parseOrgPolicyContents`), both behaviour-identical per Fable (check order, messages, error classes unchanged; digest and parsed bytes from one read).
- Fable adversarial review: no blocking. Applied advisory: the user door now refuses `/resolve` (outbound GitHub fetch) as well as `/prepare`; test extended.
- Gate (main): `npx vitest run tests/org-policy tests/config` → 168 files, 3998 passed, 1 skipped; typecheck clean; `npx biome ci src tests tools --diagnostic-level=error` → clean; `npm run test:workbench:ui` → 31 passed (1.5m).
- Open (advisory): failure chip shows the marker path, success shows the policy path; a bound v3 policy with unsatisfiable `authoringSelections` pins fails server startup (fail-closed, untested); `readPolicyBinding` reads the marker unbounded (pre-existing).

## Verification against main (2026-09-18)

- `npm run verify:local -- --base main --head HEAD` failed twice in `test:workbench:pr`: once on the "pure" 10 s budget (11.4 s, machine loaded), once with 25 source-data receipt failures ("Workbench local verification receipt unavailable or invalid").
- Baseline, same machine, clean `main` worktree `C:\dev\aih-main-baseline`: `npm run test:workbench:pr` → the same 25 receipt failures (Tests 25 failed | 2546 passed). Pre-existing and machine-specific, not caused by this branch. `npm run test:cov` on main: 649 files passed, 12,135 tests passed.
- Branch, the 9 failing files alone and together: 29/29 passed.
- Branch `test:workbench:pr` rerun stopped on the "pure" budget again (10.7 s) while a worker ran in parallel — timing, not a test failure. Still unverified: a clean, unloaded full `verify:local` pass on this machine; CI remains the authority.

## P3.1 — catalog card grid (this commit)

- Worker: Opus in a worktree. CSS-first (new block in `wb-tokens.css`, every rule scoped `html[data-theme]`), one added `span.workbench-row-icon` per card (aria-hidden, fixed glyph), `catalogKindIcon()` in `kind-ledger.ts`. No hook renamed or removed.
- Reviewer changes: ledger visual test pins `[data-kind-ledger]` to 44 px (its real height, 43.5 px, is unchanged; the image size flipped with sub-pixel offset) and the two ledger baselines were regenerated once (Fable: visually equivalent); footer ledger static below 768 px (it wrapped to ~240 px and covered phone screens); card footer spans the card so the kind chip no longer inherits the actions' column width; chip truncates at 20ch.
- Fable adversarial review: no blocking. Contrast of every new text pair ≥ 5.48:1 light / ≥ 9.60:1 dark. Advisory left: empty methodology row keeps its gap; ledger y is still fractional (fix tile line-height to let the baseline exercise product CSS); 768–1000 px the sticky ledger is ~102 px.
- Gate (main): `npx vitest run tests/org-policy/workbench tests/org-policy/studio tests/org-policy/ui-server tests/org-policy/workbench-door.test.ts` → 94 files, 590/590; typecheck clean; biome clean; `npm run test:workbench:ui` → 31 passed (run 3 times).
- Screenshots: `p3-1-*.png` (worker, light/dark/375, synthetic 1000-item page, before/after, prototype) and `p3-1-final-*.png`.
- Not built (no product data): source masthead with profile/provenance chips, quick filters, catalog tree, sort, pass badge + toggle switch, token-cost chip (D6).

## P3.2 — item inspector (this commit)

- Worker: Opus in a worktree. CSS only (P3.2 block in `wb-tokens.css`); no markup, hook or view-logic change, so no vitest added or re-pinned. Legacy hard-coded evidence-sheet divider and drawer shadow now tokens (dark mode).
- Contrast (computed): neutral text ≥ 5.85 light / ≥ 10.04 dark; accent on selected tile 5.88 / 6.43.
- Gate (main): vitest 94 files 590/590; biome clean; `npm run test:workbench:ui` → 31 passed (visual baselines unchanged). Worker: typecheck clean; no horizontal scroll at 375.
- Screenshots: `p3-2-*.png` (before/after light, dark, inspector, 375 drawer, prototype).
- Not built (no product data): Details/Security/Policy JSON tabs, finding banner, scanner grid, evidence excerpt, reach grid, allow toggle and per-finding decision, prev/next footer, status dot and version chip.

## P3.3–P3.5 — changes review, scan review, organization (uncommitted)

- Worker: Opus in a worktree. CSS only: three blocks appended to `wb-tokens.css`, every rule `html[data-theme]`. No markup, hook, text or view-logic change, so no vitest added or re-pinned; visual-shell baselines unchanged.
- P3.3 (`admin-changes.html`): draft summary bar (mono title, mono counts), inspector Review draft view (entry cards, mono category chip), Policy exposure view (count tiles, tone bar on items from `data-workbench-evidence-tone`), Approval / evidence group (mono labels, code wells). Not built (no product data): JSON delta, Reset / Copy / Download, Changes / Whole file, Publish.
- P3.4 (`admin-scan.html`): rail source evidence summary as tiles (warning = tertiary bar; legacy `#9a6619` / dark `#ebc788` number colour now neutral), Evidence & versions drawer (mono labels, `--wb-panel-shadow` replaces `#0002`), Imports panel (command in a code well). Not built: grouped findings, per-finding decisions, scanner list, result-meaning and source-update cards.
- P3.5 (`admin-org.html`): Deployment setup (mono labels, accent on pressed CLI chips, neutral developer-tool state text with a tone dot), adoption recipe drawer (`#0002` shadow → token), protected-policy form (mono uppercase labels, 34 px inputs, code-well previews). Not built: first-time steps, organization name / id / repo / people, where-it-shows-up, signing cards.
- Contrast (computed from rendered styles), light / dark minimum per slice: P3.3 5.48 / 9.60 (category chip on surface-container); P3.4 5.85 / 10.04; P3.5 4.55 (placeholder, outline on white) / 5.37 (developer-tool status, outline on card). Accent: pressed chip 5.88 / 6.43.
- Gate (worktree): vitest 94 files, 589/590 (only the known worktree `ui-server` tsx failure); typecheck clean; biome clean; `npm run test:workbench:ui` 31 passed after each slice. 375 px: no horizontal scroll.
- Screenshots: `p3-3-*`, `p3-4-*`, `p3-5-*` (before/after light, dark, 375, prototype).
