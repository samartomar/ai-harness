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

## S4 — inspector rail (new shell)

- The catalog's item/draft/exposure inspector (`#workbench-detail-panel`) mounts in `#inspector-rail #wb-inspector-panel`; lookups and the delegated click handler cover the catalog root and the rail. Rail 390 px (prototype). At ≤1100 px the rail steps out of layout and the open inspector is the fixed, self-scrolling modal drawer (inert outside, scrim). Rail tabs Security / Policy JSON reveal the evidence sheet / advanced record. Opening an item reopens a closed rail.
- Moved to the new shell, assertions unchanged: compact-setup "keeps Back to catalog…", "closes the mobile inspector…", scrolling "keeps the mobile Workbench inspector…". Intentional change (orchestrator): scrolling "uses the document…" became "uses the main panel…" (wheel moves `#wb-main` / `#wb-inspector-panel`, document never scrolls; all other assertions kept).
- Stays on legacy: compact-setup "keeps the catalog anchored…" also reads `#deployment-readiness` (admin-org), so it waits for the org screen.
- Gate: build:workbench 714,898 B (+951 vs S3 713,947); `npx vitest run tests/org-policy` 167 files, 3997 passed / 1 skipped; typecheck clean; biome clean; `npm run test:workbench:ui` 39 passed. New-shell frame light/dark baselines regenerated (rail width and content).

## S5 — changes screen (new shell)

- `shell/changes-screen.ts` (prototype `admin-changes.html`): change count and selection counts, Copy JSON (clipboard; failure announced, never claimed), Review draft / Policy exposure open the inspector rail's views, and a Changes / Whole file switch. Whole file (default) is the S2 `#json-editor` with `#config-preview` / `#report-preview`, copy unchanged. Changes is a line diff (`shell/policy-diff.ts`, LCS over the differing middle, bounded fallback) of the draft against the serialised `initialPolicy`, three lines of context, gaps folded. All model text via `textContent`. Not built (no product data or behaviour): Reset to template, a second Download, the Publish footer, "Ready to publish" status.
- No legacy spec waited on S5.
- Gate: build:workbench 720,618 B (+5,720 vs S4); `npx vitest run tests/org-policy` 168 files, 4007 passed / 1 skipped; typecheck clean; biome clean; `npm run test:workbench:ui` 40 passed (clipboard write verified offline under the strict CSP).

## Scan screen (requested as the third slice "S6"; the plan numbers admin-scan S8, S6 is admin-org)

- `shell/scan-screen.ts` (prototype `admin-scan.html`): Import evidence / Import decision (open the S2 file inputs), preserved receipt rows `#approval-rows` + `.receipt-details`, `#receipt-state`, disabled `#copy-approvals`, `#decision-state` / `#decision-rows` / `#decision-export` (`stableDecisionJson`), finding model with counts from `model.findings`. Semantics copied from `legacy-runtime.js` `ly`/`zs` (text identical); rows via `textContent`. `policy-session.ts` `setReceipt`/`setDecision` now call the render hook (rendering only; no policy semantics).
- Moved to the new shell, assertions unchanged: generate.test.ts "keeps standalone decision import strict…", "keeps decision import deterministic…"; studio-finding-model "renders each finding partition…". The receipt half of generate.test.ts "keeps curation and preserved evidence detail…" is repeated in new-shell-scan.test.ts; that test stays on legacy for its curation half (acme).
- Not built (no product data): grouped findings, per-finding decisions, scanner list, result-meaning and source-update cards.
- Gate: build:workbench 726,892 B (+6,274 vs S5; +12,945 over S3, +42,918 over the plan's 683,974 B, inside the 120 KB stop); `npx vitest run tests/org-policy` 169 files, 4011 passed / 1 skipped; typecheck clean; biome clean after an import sort (bundle bytes unchanged); `npm run test:workbench:ui` 41 passed.

## S6 — organization screen (new shell)

- `shell/org-screen.ts` (prototype `admin-org.html`): Deployment setup (posture, allowed CLI chips, managed MCP projection, readiness, information tooltips), developer tool setup (the shared `developer-tool-selection.ts`, now mounted from `main.ts` for both shells through one `mountDeveloperTools`), the adoption recipe drawer, the Evidence & versions drawer and the ECC hook controls (collapsed by default, owner decision 2 of the plan). Policy rules copied unchanged from `legacy-runtime.js` (`Xe`, `Jf`, `Qf`, `py`, `uy`, `ri`, `Vf`, the posture / managed-MCP / sanctioned-CLI / ECC hook handlers); every model string through `textContent`.
- `policy-session.ts` gains `edit` (the legacy `b()` edit + `commitPolicy`, or a refusal that restores the prior policy) and `setManagedMcpOptIn`. No policy semantics change.
- Evidence & versions: the rows moved to `src/org-policy/evidence-delivery-rows.ts` (pure; the legacy template renders the same bytes). The new shell page embeds them as inert JSON (`<script type="application/json" id="wb-evidence-delivery">`, `safeScriptJson`) only when the model has evidence delivery, so the bundle carries none of the row text (studio-template-data.test pins the absence of rows that do not apply). `StudioEvidenceDelivery` is the same type, moved so the browser build can name it.
- Moved to the new shell, assertions unchanged: studio-ecc-hook-profile, studio-adoption-recipe "renders a separate escaped, inert panel…", compact-setup "unifies references…", "opens setup explanations…", "keeps compact controls usable…" (screen navigation added), developer-tools.spec.ts (all 4; pages opened with `?shell=new`), team-policy-delivery.spec.ts. Re-pointed (ledger rows S6): compact-setup "keeps the catalog anchored…" and "keeps every tab dense…" measure against `#wb-main` instead of the document and `.bar`; the COSMETIC `.bar` / "Build your policy" anchors become the screen title and the section after setup.
- Gate: build:workbench 749,900 B (+23,008 vs scan 726,892; +65,926 over the plan's 683,974 B, inside the 120 KB stop); `npx vitest run tests/org-policy` 170 files, 4016 passed / 1 skipped; typecheck clean; biome clean; `npm run test:workbench:ui` 41 passed (1.5m).

## S7 — additions screen (new shell)

- `shell/acme-screen.ts` (prototype `admin-acme.html`): organization artifact intake (`#open-artifacts`, `#panel-artifacts`; `artifact-intake-runtime.js` mounts unchanged, its injected `<style>` replaced by the same rules in `wb-tokens.css`), the protected Enterprise policy file in full (constant markup cloned from `<template id="wb-protected-policy">`; `studio-protected-authority-runtime.js` mounts unchanged and reads the session policy), framework curation (form and rows built in TS; `Es`, `Cy`, add / edit / cancel / remove copied unchanged), and pending custom and remote MCP (`studio-custom-mcp.ts`, markup shared with the legacy template, which renders byte-identical; `oy`, `m`, `$f`, both submit handlers and the row actions copied unchanged). "Prepare approval" fills the protected form as the legacy shell does. Legacy view names route to screens (`window.setWorkbenchView`, `__aihSetWorkbenchView`).
- Protected evidence envelope: unchanged and pinned — `evidenceEnvelope` is always null, so `#download-protected-evidence` stays disabled and the preview empty (owner decision pending).
- Byte gate: the protected bundle comes from the form's submit button and `#download-protected-bundle`, the artifact intake from its file-import control and `#download-artifact-intake`; both equal the S0 goldens byte for byte, in happy-dom (new-shell-download-compat) and in Chromium under the strict CSP with zero violations (new-shell.spec "builds and downloads…", fixture `new-shell/golden-downloads.html` = the S0 model). The two golden round-trip tests are gone, replaced by these. The intake golden has per-item owner and clarification that the Add form cannot enter, so the import control is its builder.
- Moved to the new shell, assertions unchanged: studio-protected-forms (12), studio-artifact-intake (15), studio-custom-next-action (8), studio-bring-your-own-paths (2 of 3), generate.test (7: curation, field recovery, custom refinements, imports), supported-cli-subsets (all but one), generic-journeys "keeps requests and local draft bytes…", artifact.spec.ts (5; packed page copied with the model's `shell` set to `"new"`, later CLI pages opened with `?shell=new`), journeys.spec.ts (3; view tabs became nav-rail steps).
- Still on legacy (ledger): BYO left-navigation test and one supported-cli-subsets check (ECC MCP approval drawer and custom-hook note not moved), generate "has semantic controls…" (`main#workbench`, `section.group`), legacy template/string tests, legacy visual baselines, the S0 characterization.
- Gate: build:workbench 769,662 B (+19,762 vs S6 749,900; +85,688 over the plan's 683,974 B, inside the 120 KB stop); `npx vitest run tests/org-policy` 170 files, 4016 passed / 1 skipped; typecheck clean; biome clean; `npm run test:workbench:ui` 42 passed (1.5m).

## A — ECC MCP approval and custom-hook note (new shell)

- `shell/acme-screen.ts`: a "Bring Your Own" card (`#byo-actions`: `#open-artifacts`, `#open-custom-hook-info`) with the custom-hook note as an inline region `#wb-acme-hook-info` (legacy `iy` text), and an "ECC MCP approval" card (`#ecc-mcp-actions`: `#open-ecc-mcp`) with the legacy drawer's form as an inline region `#ecc-mcp-sidebar` (same field ids). Legacy `sy` (options, approval rows), `Py` (`[data-ecc-mcp-approval]` preselect) and the approval remove handler copied unchanged; rows via `textContent`.
- Found, not fixed (policy semantics, owner): `#save-ecc-mcp-approval` has no handler in the legacy runtime; the new shell keeps the button without one. ECC MCP approvals are only preserved from imports and removable.
- Moved to the new shell, assertions unchanged (locators re-pointed, ledger rows A): studio-bring-your-own-paths "separates organization-owned intake…", supported-cli-subsets "requires explicit managed MCP opt-in…". `new-shell-frame` no longer lists `#byo-actions` as retired. New: `new-shell-acme.test.ts` (3, including a hostile-HTML approval).
- Gate: build:workbench 775,748 B (+6,086 vs S7); `npx vitest run tests/org-policy` 171 files, 4019 passed / 1 skipped (after the frame fix); typecheck clean; biome clean; `npm run test:workbench:ui` 42 passed (1.5m); docs:lint exit 0.

## B — new shell is the default; switch removed

- `policyStudioHtml` renders the new shell for every admin page, so `policy generate`, the packed page and `ui-server` all serve it. Removed: `AIH_WORKBENCH_SHELL` (ui-server), `?shell=` and `resolveWorkbenchShell` (screens.ts), the model's `shell` field, `main.ts`'s legacy branches (legacy runtime no longer imported), the Playwright `shell` option, the `new-shell/` fixture copies and artifact.spec's packed-page copy. The legacy template survives as the unrouted `legacyPolicyStudioHtml` until C.
- Ported so no behaviour is lost: the catalog and baseline evidence provenance lines (same server-escaped bytes, `<template id="wb-provenance">` → `[data-wb-provenance]` strip); a global `summary { cursor: pointer }` rule.
- Order change (recorded): the legacy-page string tests had to move with the flip, not in C, because the flip leaves nothing legacy to read; the legacy visual baselines went too (nothing renders the legacy header). Ledger rows B list every re-pointed and retired test with its replacement.
- Gate: build:workbench 722,506 B (−53,242 vs A; the legacy runtime is out of the bundle); `npx vitest run tests/org-policy` 171 files, 4016 passed / 1 skipped; typecheck clean; biome clean; `npm run test:workbench:ui` 40 passed (1.5m); docs:lint exit 0.

## C — legacy shell deleted

- Deleted: `legacy-runtime.js` (+ `.d.ts`), the legacy template and its 950-line inline CSS (`studio-template.ts`), `workspace-shell.ts`, `workspace-interactions.ts`, the catalog's `shell` option and legacy render branches (`catalog-inventory.ts`), the legacy-page fallback in `new-workbench.ts`, and in `wb-tokens.css` the P3.0 bridge plus every rule whose selector names only legacy markup (a script checked each class/id against the live sources, allowing the dynamic `wb-primitive-*` style prefixes). `src/` diff vs B: 30 insertions, 3,631 deletions; vs S7: 307 insertions, 3,755 deletions.
- Kept (orchestrator decision, recorded in the plan §7): `studio-protected-authority-runtime.js` and `artifact-intake-runtime.js`, the behaviour layer the new shell mounts. A typed rewrite is a follow-up.
- S0 characterization: runs on the new shell; every golden under `goldens/` and every snapshot unchanged (no file written).
- Gate: build:workbench 722,211 B (−295 vs B; −61,763 under the plan's 683,974 + 120 KB stop, 38,237 over 683,974); `npx vitest run tests/org-policy` 171 files, 4016 passed / 1 skipped; typecheck clean; biome clean; `npm run test:workbench:ui` 40 passed (1.4m), zero CSP violations (strict-CSP specs green); `npm run build` exit 0; docs:lint exit 0.
- `npm run test:workbench:pr`: stops at the "pure" 10 s budget (29.3 s). Pre-existing on this branch: the same stage takes 27.1 s at S7 (`0535c1ce`, measured in a temporary worktree) and 8.5 s on `main`; the branch's happy-dom new-shell tests live under `tests/org-policy/workbench/`, which the pure lane includes. Its acceptance stage run directly (`node tools/run-workbench-acceptance-projects.mjs`): 25 failed | 2551 passed, the 25 are the known machine-local receipt failures ("Workbench local verification receipt unavailable or invalid", same count as `main`), and the Playwright project 40 passed.

## D — S9 visual baselines: organization and additions

- `visual-shell.spec.ts` "new shell screens": org and acme at 1440×900 light and dark and at 375 light, opened from the nav rail, `#status` masked, `maxDiffPixelRatio` 0.01, win32 only (as the other baselines). Six PNGs written with `--update-snapshots=missing` (existing baselines untouched), then two clean runs: 10 passed each.
- Not yet baselined (plan S9): sources beyond the frame, item, changes, scan screens; linux/darwin baselines.
- Gate: build:workbench 722,211 B (unchanged); `npx vitest run tests/org-policy` 171 files, 4016 passed / 1 skipped; typecheck clean; biome clean; `npm run test:workbench:ui` 46 passed (1.6m); docs:lint exit 0.

## Fidelity port — item inspector (admin-item.html, admin-sources.html Details)

- Method as `88b76a06`: the prototype's inspector markup and classes (`p-2.5 … space-y-2` head, `text-[10px] font-mono uppercase` section labels, `p-2 rounded bg-surface-container-low border` rows, the tertiary finding callout, the mono evidence box, the `Reset Item` / `Apply` footer) rebuilt with `tw()` in `catalog-inventory.ts`; every model string through `textContent`. The P3.2 inspector CSS and the P3.3 draft/exposure CSS that fought the utilities are deleted; nested report text takes zero-specificity `:where()` rules.
- Head: status dot (evidence tone), mono name, source-revision chip, kind · source · draft state, findings count, then the rail's tabs and chevron (adopted from the shell). Details: the draft-state line, Publisher overview (purpose), Declared capabilities (declared access, policy targets, consequence), Upstream provenance (source, origin locator, revision, digest, bundled component), Checks, technical details. Security Scan and Policy JSON narrow to their section. Exposure and Review draft views use the same head, labels, tiles and cards; the draft reason textarea takes the prototype's field style.
- Empty state: "Item details" with the hint, the draft's Controls / Selections / Requests and the catalog size, and what each tab shows.
- Not built (no product data): the Allow toggle, "What it can reach" grid, per-finding decision radios, Previous / Next, the Policy JSON delta of the whole policy (Policy JSON shows the item's own prepared record). The "View" row (Item / Draft / Exposure) is product-only and kept.
- Screenshots (1440×900 dark, light; 375 dark): `screenshots/fidelity-item-{proto,product}-*` (Security Scan tab, admin-item.html), `fidelity-item-details-{proto,product}-*` (Details tab, admin-sources.html), `fidelity-item-empty-product-*` (no prototype counterpart). The prototype is not responsive at 375; the product's 375 shot is the drawer. Product fixture: `synthetic-evidence.html`, item `inspect-item`.
- Functional walk (Playwright, `aih-policy-workbench.html`, 1440 then 375), 35 checks, all passed: file menu opens, Escape closes it and returns focus to the toggle; import policy valid (draft unchanged) and invalid ("Policy import rejected: invalid JSON", draft unchanged); import evidence and decision (malformed: reported, draft unchanged); Check Policy ("Schema and policy-grammar validation passed…"); Publish downloads `aih-org-policy.json` equal to `#config-preview`; card Add to draft / remove; title opens the inspector with the heading focused and the tabs in its head; Security Scan narrows to Checks, Policy JSON shows the opened technical record, Details shows all; footer primary adds and removes; Escape closes and returns focus to the card title; the chevron collapses the rail and closes the item, opening an item reopens it; Read details opens the full record and its JSON; Close details; View Exposure (4 tiles) and Draft; Back to catalog; draft reason saved into the policy; at 375 the item is the fixed drawer with visible tabs, Back to catalog closes it, no horizontal scroll; zero page errors, zero CSP violations, zero network requests.
