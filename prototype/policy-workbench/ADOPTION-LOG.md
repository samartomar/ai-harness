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
