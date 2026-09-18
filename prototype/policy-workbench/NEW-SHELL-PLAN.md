# New shell plan — port the prototype into the product, retire the legacy runtime

Status: draft for owner review, 2026-09-18, HEAD 884c5277. Supersedes the restyle
route in `ADOPTION-PLAN.md` D3. Source of truth for look: `screens/admin-sources.html`;
for behaviour: product code and tests. Every anchor below was read at HEAD.

## 1. Architecture

**No framework.** `package.json:132-138` runtime deps are commander, jsonc-parser,
smol-toml, yaml, zod; nothing renders. Adding one costs bundle bytes (683,974 B today)
and re-opens the escaping discipline the tests pin (`studio-adoption-recipe.test.ts:253`
asserts hostile HTML stays text). Recommend the pattern `user-door.ts:24-45` already
uses: typed `el()`/`icon()` helpers, `textContent` for every model string, `innerHTML`
only for constant icon SVG from `icons.ts`. Tailwind classes stay literal strings so the
content scan in `tools/workbench-tailwind.config.cjs` finds them.

**Files (new, all under `src/org-policy/workbench/ui/`):**

| File | Owns |
|---|---|
| `shell/admin-shell.ts` | Header (44 px), sub-header strip, nav rail, ledger, main + inspector rail frame (`shell.js:1-25`, `WB.LEDGER`, `WB.MAIN`); theme toggle; `#announcement`/`#status` |
| `shell/screen-router.ts` | One `data-wb-screen` state (`sources`, `item`, `changes`, `scan`, `org`, `acme`); replaces `data-view-tab` + `body.dataset.view` (`workspace-shell.ts:40-47`); exposes `setScreen()` for `main.ts:238` |
| `shell/policy-session.ts` | The policy object, `commitPolicy` (`legacy-runtime.js:1119-1130`), `validateCurrentPolicy` (`:572`), serialization `R()` (`:101`), `aih-workbench-policy-change` dispatch, `window.__aihPolicyWorkbenchSession` (`workspace-shell.ts:184`) |
| `shell/policy-grammar.ts` | Pure extraction of `nt/Pe/et/ot`, `preparePolicyImport`, `Ye` (`:1105-1118`), `Qe` (`:2698`), `Ke` (`:616`), `A()` — policy semantics currently trapped in the closure |
| `shell/file-transfer.ts` | Imports (`:2500-2598`) and downloads (`:2647-2691`, protected `download-protected-*`, `download-artifact-intake`) — one `downloadBlob(name, bytes)` |
| `screens/sources.ts`, `screens/item.ts`, `screens/changes.ts`, `screens/scan.ts`, `screens/org.ts`, `screens/acme.ts` | One render module per prototype screen; each exports `mount(root, ctx)` returning `{ refresh, destroy }` like `MountedWorkbench` (`catalog-inventory.ts:60`) |

`studio-template.ts` shrinks to head + `<div id="wb-root" data-wb-shell>` + model +
script; the 950-line inline `<style>` (`:181-1093`) and the P3.0 bridge block in
`wb-tokens.css` go in the deletion slice. `main.ts` keeps its policy pipeline
(`:176-410`: `importWorkbenchPolicySelections` → `reduceWorkbenchAction` →
`projectWorkbenchPolicy` / `serializeWorkbenchRepairV1` → `session.restorePolicy`)
verbatim and only re-points roots.

**State flow (unchanged, named):** policy object in `policy-session.ts` is the single
truth. Selection state is *derived* per event by `importWorkbenchPolicySelections`
(`policy-import.ts`), mutated by `reduceWorkbenchAction` (`selection-engine.ts`),
written back by `projectWorkbenchPolicy` (`compile-policy.ts`). View models:
`catalogBrowse` (`catalog-browse.ts`), `catalogRowPresentation`/`assetDetailsPresentation`
(`catalog-presentation.ts`), `evidenceDisplayFor` (`evidence-display.ts`),
`selectionComparisonPresentation`, `buildKindLedgerViewModel` (`kind-ledger.ts`),
`inspectWorkbenchEvidenceCoverageV1` (`delivery-readiness.ts`),
`resolveDeveloperToolSelectionForOrgPolicyV1`, `userDoorViewModelV1`.

**Strangler — what can be called headless vs must be rewritten:**

| Module | Verdict |
|---|---|
| `decision-json.ts`, `schema-validation.ts`, `policy-import.ts`, `developer-tool-policy.ts`, `artifact-intake-serialization.ts`, all `workbench/*.ts` view models | Headless; call as-is |
| `catalog-inventory.ts` (3,260 lines) | Keep the controller (state, dispatch, inspector modes `:337-360`, inert/focus `:454-527`, paging, evidence refresh `:1492`); rewrite the render functions to prototype markup: `renderRows:1549`, `renderDetails:961`, `renderExposureOverview:645`, `renderDraftReview:2907`, `renderSourceControls:2077`, `renderSourceSummary:2037`, `renderTemplates:2313`, `renderRepairs:2400`. Its hooks are already `data-workbench-*` |
| `legacy-runtime.js` (2,918 lines, one minified closure, `o(id)` lookups, `innerHTML` string builders at `:1112-1700`) | Rewrite. Nothing inside is importable; semantics are extracted first (S0) |
| `studio-protected-authority-runtime.js` (1,362 lines, `byId`) + `studio-protected-authority.ts` markup | Rewrite the DOM layer; its digest/Decision V2 computation is extracted headless with golden files |
| `artifact-intake-runtime.js` (127 long lines; validators `:11-30`, builds `#artifact-intake-review` at `:36`) | Validators → `artifact-intake-model.ts` (headless); DOM rewritten |
| `workspace-shell.ts`, `workspace-interactions.ts` | Delete; replaced by `screen-router.ts` |
| `user-door*.ts` | Stays; gets the shared header only |

## 2. Behaviour inventory

VM = pure view-model exists. Target = prototype screen. **Keep** = no prototype home,
must be placed. **Omit** = prototype element with no product data (D6: never fake).

| Panel / behaviour | Owner | VM | Target |
|---|---|---|---|
| **Toolbar** theme toggle (`html[data-theme]`) | `studio-template.ts:~967`, `browser-script` | – | shell header (`mode.js` slot) |
| Status line + `#announcement` live region | `legacy-runtime.js:p` `:57` | – | shell sub-header |
| Import policy / evidence / decision (`#policy-file` …) | `:2500-2598` | partly (`withLegacyPolicyCandidateDefaultsV1`) | header overflow menu; results on **admin-scan** |
| Validate (`#validate`, `check-failed`/`check-attention` classes) | `:2605` | `policySchemaErrors` + grammar (S0) | header "Check Policy" |
| Download policy (`#download`, `#policy-download-name`, filename regex) | `:2647`, `workspace-shell.ts:169-181` | – | header "Publish" (download; D7) |
| Export preview sheet (`#export`, `#config-preview`, `#report-preview`) | `:1667`, `:1843-1858` | – | **admin-changes** `#json-editor` region; `#config-preview` stays the readonly textarea hook |
| Clear policy (`#clear-policy`, danger zone) | `:~2860` | – | header (Keep) |
| GitHub link | `studio-template.ts:~972` | – | header (Keep) |
| Provenance lines, baseline evidence, `#evidence-delivery` drawer | `studio-template.ts:38-125` | – | sub-header strip + **admin-scan** "source update" card |
| **Deployment setup** posture `#posture` | `:1973-2008` | – | **admin-org** Vibe/Enterprise |
| Sanctioned CLI chips `[data-sanctioned-cli]`, `#supported-cli-count` | `:2028-2090` | – | **admin-org** AI tools |
| `#managed-mcp-projection`, `#deployment-readiness` | `:2009`, `Qf:2717` | `Qe` (S0) | **admin-org** |
| Developer tool setup (`#developer-tool-rows`, include/exclude buttons) | `developer-tool-selection.ts` | yes | **admin-org** |
| Adoption recipe drawer (`#adoption-recipe*`, `[data-adoption-role]`) | `adoption-recipe.ts` + `:~1240` | yes | **admin-org** "where it shows up" (Keep) |
| ECC hook controls (`[data-ecc-hook-*]`, profile/disable) | `Vf:1899-1972` | – | **admin-org** (Keep) |
| **Catalog** source rail, picker, search, kind tabs, paging | `catalog-inventory.ts:2077,2147` | `catalogBrowse` | **admin-sources** |
| Cards `article[data-workbench-asset-id]`, row actions, expand | `:1549`, `:1213` | `catalogRowPresentation` | **admin-sources** cards grid |
| Source review cells, previous report | `:117,150,2037` | `sourceEvidenceSummary` | **admin-sources** masthead |
| Templates / starting points, exclusions, repairs | `:2313,2400` | `templateDetailsPresentation` | **admin-sources** (Keep, below grid) |
| Draft counts, draft review list | `:2883-2907` | `workbenchSelectionCounts` | **admin-changes** |
| Kind ledger | `kind-ledger.ts` | yes | every admin screen |
| **Inspector** item details, technical record, evidence sheet, analyzers, advanced JSON | `:961`, `evidence-display.ts` | yes | **admin-item** Details / Security / Policy JSON tabs |
| Exposure view (`[data-workbench-exposure-*]`, declaration, checks) | `:645` | `inspectWorkbenchEvidenceCoverageV1` | **admin-changes** exposure |
| Comparison preview, Back to catalog, Close details, mobile drawer + inert | `:454-527,904` | `selectionComparisonPresentation` | inspector rail |
| Prepare approval → protected form | `main.ts:236-258` | – | **admin-acme** |
| **Authoring** external curation form + rows (`#curation-*`) | `:2091-2198` | – | **admin-acme** (Keep) |
| Custom MCP form + rows, remote custom MCP | `:2199-2330` | – | **admin-acme** |
| ECC MCP approval drawer (`#ecc-mcp-*`) | `:1776-1842` | – | **admin-acme** |
| Protected Enterprise policy form, bundle/evidence downloads | `studio-protected-authority*.{ts,js}` | – | **admin-acme** decide (later) step; Enterprise only |
| Artifact intake (add item, discovery parsers, queue, download) | `artifact-intake-runtime.js` | `canonicalJson` | **admin-acme** "say what it is / scan it" |
| **Imports** approval rows, receipt state, copy approvals | `:2599`, `:~1300` | – | **admin-scan** |
| Decision rows, `#decision-state`, download decision | `:2552,2674` | `stableDecisionJson`, `decisionProblems` | **admin-scan** per-finding decisions |
| Dispositionable findings, hard blockers | `:~1400` (`studio-finding-model.test.ts`) | – | **admin-scan** grouped findings |
| Chooser note / user door | `user-door.ts` | yes | entry / user (unchanged) |

**Omit (no product data):** org switcher, org name/id/repo/people cards, avatar,
AI-tools count, Token Budget tile and per-card cost (D6), pass-badge toggle switch,
catalog tree / quick filters / sort beyond kind tabs, scanner grid, finding banner
allow-toggle, signing cards, named profiles, Publish-to-repo. Keep the tile slot empty
with a label, never a placeholder number. **Implementable without new data:** Copy JSON
(clipboard), Changes-vs-whole-file (diff current policy against `initialPolicy`).

## 3. Test migration strategy

- **Pure lanes untouched:** `tests/org-policy/workbench/*.test.ts` (view models,
  engines, contracts; `vitest.workbench-pure`/`-contracts` configs exclude `ui/**`).
- **DOM-hook tests to migrate:** 9 happy-dom studio tests that `document.write` the
  page and `eval` the bundle (`studio-custom-next-action.test.ts:17-27` pattern), plus
  10 Playwright specs (31 tests). `id-contract.md` is the ledger; add columns
  `new hook`, `migrated in slice`, `assertion unchanged (y/n + reason)`.
- **Hook convention:** existing behavioural ids/`data-workbench-*` hooks are *kept*
  where the element's read/write semantics survive (`#config-preview`, `#policy-file`,
  `#download`, `#validate`, `#announcement`, `#posture`, `[data-workbench-asset-id]`,
  `[data-workbench-exposure-*]`, `#protected-*`, `#artifact-*`). New elements use
  `data-wb-<screen>-<part>` (`data-wb-screen`, `data-wb-nav`, `data-wb-inspector-tab`).
  Legacy ids that only existed for the old layout (`data-view-tab`, `.bar`, `.grp`,
  `#panel-*`, `#byo-actions`) are retired and their tests re-pointed.
- **Rule:** every migrated test keeps the same behavioural assertion; only the locator
  changes. Cosmetic exact-text assertions (id-contract "COSMETIC") are re-pinned to
  the new copy in the same commit, one ledger row each. A test may be deleted only
  when its behaviour is covered by a named replacement in the ledger.
- **Two shells during migration:** model field `shell: "legacy" | "new"` set by
  `runPolicyWorkbenchUi` from `AIH_WORKBENCH_SHELL` (fixture-only env, like
  `AIH_WORKBENCH_DATA` in `browser/setup.ts:11`) and by `?shell=` for local runs;
  `main.ts` branches on it; `studio-template.ts` emits `data-wb-shell`. Playwright
  fixture (`fixture.ts:16`) gains a `shell` option; migrated specs run on `new`,
  unmigrated on `legacy`; `visual-shell.spec.ts` snapshots both. Flip slice changes
  the default and deletes the option; deletion slice removes the flag.

## 4. Slices

Gate for every slice: `npm run build:workbench`; `npx vitest run tests/org-policy/workbench
tests/org-policy/studio tests/org-policy/ui-server tests/org-policy/workbench-door.test.ts
tests/org-policy/project-policy.test.ts`; `npm run typecheck`; `npx biome ci src tests
tools --diagnostic-level=error`; `npm run test:workbench:ui` (offline, zero CSP
violations, both shells); visual baselines for the touched screen at 1440×900 light/dark
and 375. Bundle delta reported.

| # | Slice | Size | Hours | Parallel | Fable |
|---|---|---|---|---|---|
| S0 | Characterization: extract `policy-grammar.ts`, decision/protected digest logic, artifact validators headless; golden files for every download (policy `aih-org-policy.json`, `aih-governance-decision.json`, protected bundle + evidence, artifact intake, `aih-project-policy.json`) captured from the legacy runtime | L | 16 | – | yes (semantics) |
| S1 | Shell frame: `admin-shell.ts`, `screen-router.ts`, flag plumbing, header, sub-header, nav rail, ledger, inspector frame, theme | M | 10 | with S0 | – |
| S2 | `policy-session.ts` + `file-transfer.ts` (imports, downloads) against S0 goldens | M | 10 | after S0 | yes (byte compat) |
| S3 | admin-sources: catalog controller re-render | L | 20 | after S1,S2 | – |
| S4 | admin-item inspector | M | 12 | with S3 (same file: sequence after S3's render split) | – |
| S5 | admin-changes: drafts, exposure, JSON editor, changes-vs-whole | M | 12 | with S6 | – |
| S6 | admin-org: posture, CLIs, managed MCP, readiness, developer tools, ECC hooks, adoption recipe, evidence & versions | L | 16 | with S3 | – |
| S7 | admin-acme: curation, custom/remote MCP, ECC MCP approval, artifact intake, protected form | L | 24 | with S5/S8 | yes (escaping, validation, downloads) |
| S8 | admin-scan: imports, approvals, decisions, findings, receipt | M | 12 | with S7 | yes |
| S9 | Ledger close-out: every id-contract row migrated; visual baselines for all six screens | M | 8 | after S3–S8 | – |
| S10 | Flip default to `new`; legacy runs only under the flag | S | 4 | – | yes (full adversarial) |
| S11 | Delete legacy: `legacy-runtime.js`, `artifact-intake-runtime.js`, `studio-protected-authority-runtime.js`, `workspace-shell.ts`, `workspace-interactions.ts`, inline CSS `studio-template.ts:181-1093`, P3.0 bridge in `wb-tokens.css`, flag, legacy fixture lane | M | 8 | – | – |
| S12 | Docs (`docs/commands.md:849-1085`, `docs/testing/issue-*`, changelog), a11y pass, bundle size report | S | 6 | – | – |

Total ≈ 158 h (range 140–180). Critical path S0→S2→S3→S4→S9→S10→S11 ≈ 78 h;
S5/S6/S7/S8 run beside it with two workers.

## 5. Risks and stop conditions

- **Policy semantics** live in the closure (`nt/Pe/et/ot`, `preparePolicyImport`, `Ye`,
  `Qe`, `A()`); any behavioural difference in S0's characterization tests is a stop —
  ask the owner, never "fix" it in passing.
- **Public schema:** no change to `contracts.ts`, `schema.ts`, `project-policy.ts`.
  A screen that needs a new field is a stop (already true for org name/people).
- **Byte-identical downloads:** policy = `JSON.stringify(policy, null, 2) + "\n"`
  (`legacy-runtime.js:101`); decision = `stableDecisionJson + "\n"` (`:2679`);
  protected bundle = `JSON.stringify(bundle, null, 2) + "
"`, not `canonicalJson`
  (`studio-protected-authority-runtime.js:1018,1174`); the protected evidence
  download `aih-organization-evidence.json` (`:1203`) has no golden yet. The S7 gate
  must produce the protected bundle through the real bundle builder and compare
  those bytes, not round-trip a golden through the serializer; artifact intake = `JSON.stringify(intake, null, 2) + "\n"` (`artifact-intake-runtime.js:126`, pinned by golden). S0 golden tests
  are missing today (only `journeys.spec.ts:282` checks policy bytes) and are the gate
  for S2/S7/S8. Filename regex `^[A-Za-z0-9][A-Za-z0-9._-]{0,126}\.json$` unchanged.
- **Security headers / CSP:** server headers (`ui-server.ts:73-79,357-363`) untouched;
  test CSP stays `default-src 'none'` (`journeys.spec.ts:17`); `design-foundation.test.ts`
  forbids http(s) URLs and `@font-face`. No `innerHTML` with model strings; keep the
  hostile-HTML assertion (`studio-adoption-recipe.test.ts:253`) and add one per screen.
- **Loopback/token routes** (`/prepare`, `/resolve`, user-door refusals from P5c) unchanged.
- **Bundle growth:** stop and report if the page grows more than 120 KB over 683,974 B
  before S11 reclaims the legacy code.
- **Flaky baseline:** the 25 receipt failures in `test:workbench:pr` are pre-existing
  (ADOPTION-LOG "Verification against main"); diff against that, never absorb.

## 6. Decisions needed from the owner

1. **Header actions naming.** Prototype "Check Policy / Review Changes / Publish" vs
   product Validate / Export / Download. Recommend: adopt the prototype labels, keep the
   ids; "Publish" downloads (D7) and says so in its tooltip.
2. **ECC hook controls and adoption recipe placement.** No prototype home. Recommend
   admin-org (organization-level intent), collapsed by default.
3. **Protected Enterprise form.** Keep in full on admin-acme (Enterprise only), or hide
   behind a "decide (later)" step? Recommend keep in full; it has 13 tests and no
   replacement.
4. **Legacy lane runtime.** Running Playwright twice during S3–S9 roughly doubles the
   1.5-minute lane. Recommend accept; drop at S10.
5. **Copy JSON / Changes-vs-whole-file.** Cheap and data-free; include in S5 or defer?
   Recommend include (S, ~2 h inside S5).

## 7. Status after the flip and deletion (2026-09-18)

- **Done.** A: ECC MCP approval panel and custom-hook note on the additions screen.
  B (S10): the new shell is the only admin page; `AIH_WORKBENCH_SHELL`, `?shell=`, the
  model's `shell` field and the fixture option are gone. C (S11): `legacy-runtime.js`,
  the legacy template and its inline CSS, `workspace-shell.ts`,
  `workspace-interactions.ts`, the catalog's legacy render branches, the P3.0 bridge and
  every `wb-tokens.css` rule whose selector names only legacy markup are deleted.
- **Changed from §1 and S11 (orchestrator decision).** `studio-protected-authority-runtime.js`
  and `artifact-intake-runtime.js` are **kept**, not rewritten: they are the behaviour
  layer the new shell mounts (on the cloned protected-policy markup and on
  `#panel-artifacts`), and their downloads are pinned byte for byte by the S0 goldens.
- **Follow-up (not scheduled).** Rewrite those two runtimes as typed modules: headless
  digest and validation logic (already partly in `protected-digest.ts` and
  `artifact-intake-model.ts`) plus a textContent-only DOM layer, against the same
  goldens. Also still open: `#save-ecc-mcp-approval` has no handler (it had none in the
  legacy runtime either; recording a new approval is policy semantics for the owner);
  linux/darwin visual baselines; the `test:workbench:pr` "pure" budget (10 s), which the
  branch's DOM tests exceed (27 s at S7, 29 s now; 8.5 s on `main`).
