# Policy Workbench DOM hook contract

Purpose: this is the inventory of DOM hooks (element ids, `data-*` attributes,
ARIA roles/accessible names, asserted classes, and asserted literal text) that
the Policy Workbench test suite currently depends on. A restyle of the markup
produced by `src/org-policy/studio-template.ts` and
`src/org-policy/workbench/ui/**` may change layout, copy, and CSS freely, but
must keep every **BEHAVIOURAL** hook below (same id/attribute/role/name,
attached to an element with the same read/write semantics) or the jsdom unit
tests and Playwright specs will fail. **COSMETIC** hooks are exact-text or
markup assertions that a restyle is likely to break incidentally; they should
be re-pinned deliberately rather than preserved byte-for-byte.

Scanned: `tests/org-policy/studio-*.test.ts`, `tests/org-policy/workbench/**/*.test.ts`,
`tests/org-policy/workbench/browser/*.spec.ts`, `tests/org-policy/ui-server*.test.ts`
(no DOM-hook matches found in `ui-server*.test.ts` — it exercises the server, not rendered markup).

## Toolbar / global chrome

| Hook | Kind | Class. | Test | Source |
|---|---|---|---|---|
| `#validate` | id | BEHAVIOURAL | studio-custom-next-action.test.ts:73,84; generic-journeys.spec.ts:225,238,260-263 | studio-template.ts:917 |
| `#download` | id | BEHAVIOURAL | studio-custom-next-action.test.ts:73,84; journeys.spec.ts:118,130,151,277,348,471,525; artifact.spec.ts:238,347,525,647; developer-tools.spec.ts:121,169; compact-setup.spec.ts:66 | studio-template.ts:918 |
| `#policy-file` | id | BEHAVIOURAL (file input) | team-policy-delivery.spec.ts:64,174; journeys.spec.ts:107,205,212,266,328; artifact.spec.ts:29,566; developer-tools.spec.ts:84,147,194; generic-journeys.spec.ts:229,245; compact-setup.spec.ts:269,326 | studio-template.ts:922 |
| `#announcement` | id | BEHAVIOURAL (live-region text read after actions) | studio-custom-next-action.test.ts:76,87; journeys.spec.ts:210,217,271,517,595; artifact.spec.ts:34,571; generic-journeys.spec.ts:230,250,261,267; compact-setup.spec.ts:61,64,68,526 | studio-template.ts:927 |
| `#config-preview` (textarea, `readonly`, `aria-label="Authored policy actual schema fields"`) | id + role(textbox)/name | BEHAVIOURAL (canonical policy JSON read/write target for nearly every journey) | studio-bring-your-own-paths.test.ts:144,199; studio-custom-next-action.test.ts:171; virtually every browser spec (team-policy-delivery.spec.ts:87 etc.) | studio-template.ts:1089 |
| `#posture` (`<select>`) | id | BEHAVIOURAL | team-policy-delivery.spec.ts:99; journeys.spec.ts:544; artifact.spec.ts:641; compact-setup.spec.ts:517 | studio-template.ts:948 |
| `[data-sanctioned-cli="<cli>"]` | data | BEHAVIOURAL (toggle button) | team-policy-delivery.spec.ts:92,96; journeys.spec.ts:464,543; artifact.spec.ts:640; compact-setup.spec.ts:499 | studio-template.ts (sanctioned CLI row renderer) |
| `#managed-mcp-projection` (checkbox) | id | BEHAVIOURAL | artifact.spec.ts:642; compact-setup.spec.ts:508 | studio-template.ts |
| `[data-view-tab="compose"\|"author"]` | data | BEHAVIOURAL (tab switch) | team-policy-delivery.spec.ts:91; journeys.spec.ts:463,542,548 | studio-template.ts |
| `#supported-cli-note`, `#supported-cli-count`, `#supported-cli-info` | id | mix: `-note`/`-info` COSMETIC (help text), `-count` BEHAVIOURAL (reflects selection count) | compact-setup.spec.ts:465,500,567,568 | studio-template.ts |
| role `heading` name "Build your policy" (exact) | role+name | COSMETIC (heading copy) | compact-setup.spec.ts:373,457 | studio-template.ts |
| role `button` name "Switch to dark theme" / "Switch to light theme" (exact) + `html[data-theme]` | role+name / data | BEHAVIOURAL (theme toggle + resulting attribute value) | journeys.spec.ts:46-49 | studio-template.ts / browser-script.ts |

## Catalog inventory / source rail

| Hook | Kind | Class. | Test | Source |
|---|---|---|---|---|
| `#framework-rows` | id | BEHAVIOURAL (container; also read as text for regression diffing) | journeys.spec.ts:264,273,334,346,355,362,537; generic-journeys.spec.ts:235; artifact.spec.ts:426; compact-setup.spec.ts:21,596 | studio-template.ts:963 |
| `#framework-rows .error` | id+class | BEHAVIOURAL (error text asserted with regex, e.g. `/stale/i`, `/missing\|unknown/i`) — content is dynamic but selector/class is load-bearing | journeys.spec.ts:125,334,346,355,362,402,410,537; generic-journeys.spec.ts:224-225 | studio-template.ts |
| `article[data-workbench-asset-id="<id>"]` | data | BEHAVIOURAL (per-asset row identity, click/read target) | fulfillment-affordance.test.ts:42; aih-mcp-requests.test.ts:62; journeys.spec.ts:87,133,138,149,167,170,189; artifact.spec.ts:420,432,493,494,504,604; generic-journeys.spec.ts:24,105,106,131,154,189,197,208,215,217,219 | studio-template.ts / ui/catalog-inventory.ts |
| `button[data-workbench-asset-id="<id>"]` | data | BEHAVIOURAL (select/add-to-draft action) | aih-mcp-requests.test.ts:62; journeys.spec.ts:105,343,358; artifact.spec.ts:497,504; generic-journeys.spec.ts:185,187,208,219 | ui/catalog-inventory.ts |
| `button[data-workbench-row-action]` (per row) | data | BEHAVIOURAL | artifact.spec.ts:344,497,504; compact-setup.spec.ts:71,218 | ui/catalog-inventory.ts |
| `button.workbench-row-title[data-workbench-expand-id="<id>"]` | class+data | BEHAVIOURAL (opens inspector) | scrolling.spec.ts:112,144; journeys.spec.ts:93,141,153,173; generic-journeys.spec.ts:68,88,136; compact-setup.spec.ts:141,146,349; artifact.spec.ts:321 | ui/catalog-inventory.ts |
| `[data-workbench-source-tab="source:<id>"]` | data | BEHAVIOURAL (source rail tab) | scrolling.spec.ts:35,84; journeys.spec.ts:90,130,341,356,453; artifact.spec.ts:173,225,317,441,491,580,588,601,676; generic-journeys.spec.ts:42,101,196,216,222; compact-setup.spec.ts:70,140,145,217,302,334 | studio-template.ts / ui/catalog-inventory.ts |
| `[data-workbench-source-rail]` | data | BEHAVIOURAL (container ref) | scrolling.spec.ts:88; compact-setup.spec.ts:22 | studio-template.ts |
| `[data-workbench-catalog-layout]`, `[data-workbench-catalog-register]` | data | BEHAVIOURAL (layout mode markers) | compact-setup.spec.ts:20,23 | studio-template.ts |
| `#workbench-source-filter option[value="source:<id>"]` | id+attr | BEHAVIOURAL | artifact.spec.ts:424 | studio-template.ts |
| role `combobox` name "Choose catalog source" | role+name | BEHAVIOURAL | scrolling.spec.ts:142; generic-journeys.spec.ts:38; compact-setup.spec.ts:348; artifact.spec.ts:673 | studio-template.ts (select element) |
| role `searchbox` name "Search catalog" | role+name | BEHAVIOURAL (filter input) | team-policy-delivery.spec.ts:101; journeys.spec.ts:131,342,357,454; artifact.spec.ts:431,440,492,502,532; generic-journeys.spec.ts:210; developer-tools.spec.ts:311 | studio-template.ts |
| role `button` name "Next 50" / "Previous 50" | role+name | BEHAVIOURAL (pagination) | generic-journeys.spec.ts:125,126 | ui/catalog-inventory.ts |
| section `aria-label="Catalog inventory"` | role+name | BEHAVIOURAL (landmark used to scope queries) | scrolling.spec.ts:89 | studio-template.ts |
| `.workbench-source-review`, `.workbench-source-review-cells p` | class | mix: container BEHAVIOURAL (scoping), text COSMETIC ("Reports included", "Needs review", "0 currently verified") | journeys.spec.ts:81,116,164; generic-journeys.spec.ts:51,52,206 | ui/catalog-presentation.ts |
| `.workbench-draft-counts` | class | BEHAVIOURAL/COSMETIC mix ("Controls 0" / "Requests 1" counts are state, but exact word "Controls"/"Requests" is copy) | aih-mcp-requests.test.ts:66; fulfillment-affordance.test.ts:54; journeys.spec.ts:136; generic-journeys.spec.ts:188 | ui/catalog-presentation.ts |
| `.workbench-draft-review > button[data-workbench-draft-open]` | class+data | BEHAVIOURAL | journeys.spec.ts:335; compact-setup.spec.ts:84; developer-tools.spec.ts:329 | ui/catalog-presentation.ts |
| `.workbench-draft-review-list`, `.workbench-draft-review-list [data-workbench-detail-id]` | class/data | BEHAVIOURAL | journeys.spec.ts:336,337; compact-setup.spec.ts:88,93 | ui/catalog-presentation.ts |
| `[data-workbench-repair-type="remove-root\|remove-request\|remove-exclusion"]` | data | BEHAVIOURAL | journeys.spec.ts:396,408,410 | ui/catalog-presentation.ts |
| `[aria-label="Saved selections needing review"] button` | role+name | BEHAVIOURAL (count assertion) | journeys.spec.ts:393,405 | studio-template.ts |
| `button[data-workbench-exclusion-id="<id>"]` | data | BEHAVIOURAL | team-policy-delivery.spec.ts:124,135 | ui/catalog-presentation.ts |
| `.workbench-starting-points` (`> summary`) | class | BEHAVIOURAL (disclosure toggle) | generic-journeys.spec.ts:241,278; artifact.spec.ts:433,582,587 | ui/catalog-presentation.ts |
| `[data-workbench-template-detail-id="<id>"]` | data | BEHAVIOURAL | generic-journeys.spec.ts:280,288; artifact.spec.ts:437 | ui/catalog-presentation.ts |
| `.workbench-template-preview` text "This preview adds" | class+text | COSMETIC | generic-journeys.spec.ts:283 | ui/catalog-presentation.ts |
| `#preset-select, #skill-rows, #agent-rows, #mcp-rows` (legacy ids, asserted absent) | id | BEHAVIOURAL (negative assertion — must stay absent) | artifact.spec.ts:443 | n/a (legacy markup removal check) |
| `#framework-rows` toHaveClass `/workbench-inventory/` | id+class | BEHAVIOURAL | generic-journeys.spec.ts:23 | studio-template.ts |

## Item inspector / detail panel

| Hook | Kind | Class. | Test | Source |
|---|---|---|---|---|
| `#workbench-detail-panel[data-workbench-detail]` | id+data | BEHAVIOURAL (panel container) | team-policy-delivery.spec.ts:90; scrolling.spec.ts:90,143; journeys.spec.ts:91; artifact.spec.ts:319,584; generic-journeys.spec.ts:25,239,276; compact-setup.spec.ts:24,139,195,351; developer-tools.spec.ts:252 | studio-template.ts |
| `#workbench-detail-title` | id | BEHAVIOURAL (title text reflects selected item; also focus target) | team-policy-delivery.spec.ts:110,132; scrolling.spec.ts:115; journeys.spec.ts:99,143,175; artifact.spec.ts:323; generic-journeys.spec.ts:73,141,207,244; compact-setup.spec.ts:112,355 | studio-template.ts |
| `.workbench-item-technical > summary` | class | BEHAVIOURAL (disclosure toggle for raw record) | team-policy-delivery.spec.ts:111,118,121,133; journeys.spec.ts:95,106,154; artifact.spec.ts:325; generic-journeys.spec.ts:70,90,138,192,206; compact-setup.spec.ts:115,153 | studio-template.ts |
| `button[data-workbench-detail-id="<id>"]` | data | BEHAVIOURAL | team-policy-delivery.spec.ts:112,114; journeys.spec.ts:96,155; artifact.spec.ts:326 | studio-template.ts |
| `.workbench-detail-advanced` (`> summary`, `pre`) | class | BEHAVIOURAL (toggle + raw JSON content asserted via `toContainText`) | journeys.spec.ts:158-159; artifact.spec.ts:327,328,330; generic-journeys.spec.ts:79,80,143,147,148,184,186-188,209,212,246 | studio-template.ts |
| `[data-workbench-panel-view="exposure"\|"item"\|"draft"]` | data | BEHAVIOURAL (view switcher) | team-policy-delivery.spec.ts:115; scrolling.spec.ts:99; compact-setup.spec.ts:158,160,178,197,314; journeys.spec.ts:340 | studio-template.ts |
| `[data-workbench-exposure-overview]` | data | BEHAVIOURAL | team-policy-delivery.spec.ts:116; compact-setup.spec.ts:27,211,212 | studio-template.ts |
| `[data-workbench-exposure-item-id]`, `[data-workbench-exposure-request-id="<id>"]`, `[data-workbench-exposure-inspect-id="<id>"]`, `[data-workbench-exposure-access]` | data | BEHAVIOURAL | compact-setup.spec.ts:211,212,229,289,311; developer-tools.spec.ts:339,342 | studio-template.ts |
| `[data-workbench-declaration]`, `[data-workbench-checks]` | data | BEHAVIOURAL (content asserted, e.g. exact posture text) | compact-setup.spec.ts:295,296; artifact.spec.ts:633,636,685,686; developer-tools.spec.ts:254,255,344,345 | studio-template.ts |
| role `button` name "Close details" (exact) | role+name | BEHAVIOURAL | scrolling.spec.ts:123; artifact.spec.ts:343; compact-setup.spec.ts:125,298 | studio-template.ts |
| `.workbench-evidence-sheet`, text "Reported result:" | class+text | mix: container BEHAVIOURAL, "Reported result:" COSMETIC | journeys.spec.ts:100,144,176; artifact.spec.ts:324 | ui/evidence-display.ts |
| `.workbench-report-analyzers li` | class | BEHAVIOURAL (list existence) | journeys.spec.ts:107 | ui/evidence-display.ts |
| `.workbench-inspector-selection` | class | BEHAVIOURAL | compact-setup.spec.ts:118 | studio-template.ts |
| role `heading` name "A policy is a shape of exposure" (exact) | role+name | COSMETIC | compact-setup.spec.ts:101,206 | studio-template.ts |
| role `button` name "Back to catalog" (exact) | role+name | BEHAVIOURAL | compact-setup.spec.ts:179 | studio-template.ts |

## Adoption recipe drawer

| Hook | Kind | Class. | Test | Source |
|---|---|---|---|---|
| `#adoption-recipe` | id | BEHAVIOURAL (panel root; also read as innerHTML target for XSS-escaping assertion) | studio-adoption-recipe.test.ts:244,253 | studio-template.ts:936 |
| `#adoption-recipe-toggle` | id | BEHAVIOURAL | journeys.spec.ts:51,62; compact-setup.spec.ts:391,392,407,413 | studio-template.ts:937 |
| `#adoption-recipe-panel` | id | BEHAVIOURAL | journeys.spec.ts:50,55; compact-setup.spec.ts:409 | studio-template.ts:938 |
| `[data-adoption-role="<id>"]` | data | BEHAVIOURAL | studio-adoption-recipe.test.ts:256 | studio-template.ts (role renderer) |
| role `button` name "Close adoption recipe" (exact) | role+name | BEHAVIOURAL | journeys.spec.ts:57; compact-setup.spec.ts:410 | studio-template.ts:939 |
| Literal `<img src=x onerror=...> hostile` asserted present as escaped text | text | BEHAVIOURAL (security assertion: HTML must remain escaped, not markup) | studio-adoption-recipe.test.ts:253 | studio-template.ts |

## Evidence & versions / adoption chip row

| Hook | Kind | Class. | Test | Source |
|---|---|---|---|---|
| `#evidence-delivery` (`<details>`, `summary`) | id | BEHAVIOURAL | studio-template-data.test.ts:34; compact-setup.spec.ts:390,391,393,396,397,401,403,561,562,563 | studio-template.ts (details block) |
| `summary` exact text "Evidence & versions" | text | COSMETIC | compact-setup.spec.ts:396 | studio-template.ts |
| role `button` name "Close evidence and versions" (exact) | role+name | BEHAVIOURAL | compact-setup.spec.ts:401,563 | studio-template.ts |
| `.bar` (toolbar element, used for layout bounding-box checks) | class | COSMETIC (pure layout geometry, not state) | compact-setup.spec.ts:378,591 | studio-template.ts |
| `.reference-shelf` | class | BEHAVIOURAL (existence/count 0 assertion) | compact-setup.spec.ts:370,602 | studio-template.ts |

## Developer tool selection

| Hook | Kind | Class. | Test | Source |
|---|---|---|---|---|
| `#developer-tool-selection` (`details`, `summary`) | id | BEHAVIOURAL | compact-setup.spec.ts:372,414,429,476,477,486,495; developer-tools.spec.ts:68,71,245,246 | studio-template.ts:953 |
| `#developer-tool-rows` | id | BEHAVIOURAL | compact-setup.spec.ts:377,416,420 | studio-template.ts:958 |
| `[data-developer-tool-id="<tool>"]` | data | BEHAVIOURAL | compact-setup.spec.ts:374,478; developer-tools.spec.ts:73,101,247,248 | ui/developer-tool-catalog.ts |
| `[data-developer-tool-details-id="<tool>"]` | data | BEHAVIOURAL | developer-tools.spec.ts:251 | ui/developer-tool-catalog.ts |
| `.developer-tool-copy`, `.developer-tool-actions` | class | BEHAVIOURAL (layout bounding boxes) / structural | compact-setup.spec.ts:543,544,550 | ui/developer-tool-catalog.ts |
| role `button` name e.g. "Exclude MarkItDown CLI from setup" / "Include MarkItDown CLI in setup" / "Exclude Playwright from setup" (exact, tool-specific) | role+name | BEHAVIOURAL — but name string is generated from tool label, so copy template ("Exclude {label} from setup") is COSMETIC-adjacent; changing the template breaks all these | compact-setup.spec.ts:484,496,556,559; developer-tools.spec.ts:105,157,161,259 | ui/developer-tool-selection.ts |
| `summary` text "all default tools selected" (regex, case-insensitive), "N selected", "N excluded" | text | mix: counts BEHAVIOURAL, wording COSMETIC | compact-setup.spec.ts:376,487,488; developer-tools.spec.ts:70,139,155,187,200 | ui/developer-tool-selection.ts |
| `#developer-tool-help`, `#deployment-setup-help` | id | COSMETIC (help copy, exact `toHaveText`) | compact-setup.spec.ts:431,435 | studio-template.ts |
| `#deployment-readiness` | id | mix: container BEHAVIOURAL, phrases "Draft is ready to export.", "disabled in Vibe", "Enterprise posture" COSMETIC | compact-setup.spec.ts:58,504,507,510,511,518,534 | studio-template.ts |
| `[data-workbench-setup-pin-remove-id="<id>"]` | data | BEHAVIOURAL | developer-tools.spec.ts:332 | ui/catalog-presentation.ts |

## Custom / protected forms, BYO paths, artifact intake

| Hook | Kind | Class. | Test | Source |
|---|---|---|---|---|
| `#custom-form` | id | BEHAVIOURAL | studio-bring-your-own-paths.test.ts:174,182; studio-custom-next-action.test.ts:40; studio-protected-forms.test.ts:445 | studio-template.ts:1015 |
| `#custom-rows` | id | BEHAVIOURAL | studio-custom-next-action.test.ts:46,137 | studio-template.ts |
| `#custom-owner`, `aria-invalid` attribute | id+attr | BEHAVIOURAL (validation state) | studio-bring-your-own-paths.test.ts:176 | studio-template.ts |
| `#add-curation` | id | BEHAVIOURAL | studio-bring-your-own-paths.test.ts:196 | studio-template.ts |
| `#curation-purpose` | id | COSMETIC help text (`toContain` on fixed sentences about "framework curation") | studio-bring-your-own-paths.test.ts:73,76 | studio-template.ts:997 |
| `#curation-owner` `.closest("label")` textContent | id+DOM relation | COSMETIC (label wording) | studio-bring-your-own-paths.test.ts:80 | studio-template.ts |
| `#byo-actions`, `#ecc-mcp-actions` | id | BEHAVIOURAL | studio-bring-your-own-paths.test.ts:46,57 | studio-template.ts |
| `#open-artifacts` | id | BEHAVIOURAL | studio-bring-your-own-paths.test.ts:61,97; studio-artifact-intake.test.ts:267 | studio-template.ts |
| `#authoring-sidebar` `.hidden` | id+prop | BEHAVIOURAL | studio-bring-your-own-paths.test.ts:63 | studio-template.ts |
| `#artifact-intake-review` | id | BEHAVIOURAL (workspace text asserted) | studio-bring-your-own-paths.test.ts:69,99; studio-artifact-intake.test.ts:123 | studio-template.ts |
| `#artifact-source-guide` | id | COSMETIC (guide copy varies by source type; `not.toContain` / `toContain` on prose) | studio-bring-your-own-paths.test.ts:111,114,121,129,137,155 | studio-template.ts |
| `#artifact-source-type` | id | BEHAVIOURAL (select value) | studio-bring-your-own-paths.test.ts:150; studio-artifact-intake.test.ts:289 | studio-template.ts |
| `#open-custom-hook-info`, `#drawer`, `#drawer-detail` | id | BEHAVIOURAL (drawer open) / COSMETIC (drawer-detail exact prose) | studio-bring-your-own-paths.test.ts:83,85,87,90 | studio-template.ts:987 |
| `#config-preview` (BYO context) | id | BEHAVIOURAL | studio-bring-your-own-paths.test.ts:144,199 | studio-template.ts:1089 |
| `#policy-download-name`, `#download` | id | BEHAVIOURAL | studio-custom-next-action.test.ts:55,73,84 | studio-template.ts |
| `#import-policy`, `#import-evidence` exact text "replaces current" / "inspection only" | id+text | COSMETIC | studio-custom-next-action.test.ts:145,146 | studio-template.ts |
| `#artifact-evidence-file`, `#artifact-intake-message` | id | BEHAVIOURAL | studio-custom-next-action.test.ts:148,163,176; studio-artifact-intake.test.ts:130 | studio-template.ts |
| `#artifact-intake-items` | id | BEHAVIOURAL | studio-artifact-intake.test.ts:155,275 | studio-template.ts |
| `#artifact-item-id`, `#artifact-item-kind`, `#artifact-source-path`, `#artifact-github-repository`, `#artifact-github-commit`, `#add-artifact-item` | id | BEHAVIOURAL (form fields driven by discovery parsing) | studio-artifact-intake.test.ts:286,289,306,315-597 (many) | studio-template.ts |
| `#parse-mcp-discovery`, `#parse-skill-discovery`, `#artifact-mcp-discovery-message`, `#artifact-skill-discovery-message` | id | BEHAVIOURAL | studio-artifact-intake.test.ts:284,292,315,324,358,390,394,455,552,584 | studio-template.ts |
| `import-artifact-evidence` text "..." | id+text | COSMETIC | studio-artifact-intake.test.ts:131 | studio-template.ts |
| `article[data-workbench-asset-id]` / `button[data-workbench-asset-id]` (aih-mcp-requests, fulfillment-affordance) | data | BEHAVIOURAL | studio-aih-mcp-requests.test.ts:62; studio-fulfillment-affordance.test.ts:42,59,64,69 | ui/catalog-inventory.ts |
| `.workbench-draft-counts` textContent | class | mix (see above) | studio-aih-mcp-requests.test.ts:66; studio-fulfillment-affordance.test.ts:54 | ui/catalog-presentation.ts |

## Protected forms (findings / consent)

| Hook | Kind | Class. | Test | Source |
|---|---|---|---|---|
| `#protected-form` | id | BEHAVIOURAL | studio-protected-forms.test.ts:108,318,359,423,458,474; journeys.spec.ts:574 | studio-template.ts |
| `#protected-effects` `placeholder` attribute | id+attr | COSMETIC (placeholder copy) | studio-protected-forms.test.ts:162 | studio-template.ts |
| `[data-protected-revoke="0"]` | data | BEHAVIOURAL | studio-protected-forms.test.ts:184,562 | studio-template.ts |
| `#protected-accepted-findings` | id | BEHAVIOURAL | studio-protected-forms.test.ts:368 | studio-template.ts |
| `#protected-bundle-preview` | id | BEHAVIOURAL | journeys.spec.ts:575,576 | studio-template.ts |
| `#protected-form button[type=submit]` | id+attr selector | BEHAVIOURAL | journeys.spec.ts:574 | studio-template.ts |
| `#dispositionable-findings`, `#hard-blockers` | id | BEHAVIOURAL (exact textContent equality, driven by data) | studio-finding-model.test.ts:42,45 | studio-template.ts |

## ECC hook profile / vet verdicts

| Hook | Kind | Class. | Test | Source |
|---|---|---|---|---|
| `#config-preview`, `#ecc-hook-controls`, `#surface-ecc-hooks` | id | BEHAVIOURAL | studio-ecc-hook-profile.test.ts:49,67,69 | studio-template.ts:1089, 968 |
| `[data-ecc-hook-disable="<id>"]` | data | BEHAVIOURAL | studio-ecc-hook-profile.test.ts:58 | studio-template.ts |
| `[data-ecc-hook-id="<id>"]` (row) | data | BEHAVIOURAL | studio-ecc-hook-profile.test.ts:135 | studio-template.ts |
| `#clear-policy` | id | BEHAVIOURAL | studio-ecc-hook-profile.test.ts:184 | studio-template.ts |
| `data-vet="blocked"` / `data-vet="pass"` | data | BEHAVIOURAL (attribute value is the assertion) | studio-vet-verdicts.test.ts:95,96 | studio-template.ts |

## Generic journeys / scrolling / keyboard focus

| Hook | Kind | Class. | Test | Source |
|---|---|---|---|---|
| `[data-group]:visible`, `[id="<bodyId>"]`, `aria-expanded` | data/id/attr | BEHAVIOURAL (disclosure state) | journeys.spec.ts:63-78 | studio-template.ts |
| `#curation-editor` (`summary`) | id | BEHAVIOURAL | journeys.spec.ts:83,84,86 | studio-template.ts |
| role `button` name "Compose" (exact) | role+name | BEHAVIOURAL | journeys.spec.ts:88 | studio-template.ts |
| `.workbench-row-title` toBeFocused, `:scope > summary` toBeFocused | class | BEHAVIOURAL (keyboard focus regression) | journeys.spec.ts:166; compact-setup.spec.ts:355,403,413 | ui/catalog-inventory.ts |
| `page.locator("*").count()` before/after inspector open (no DOM leak) | n/a | BEHAVIOURAL (structural leak check, not tied to a specific hook) | generic-journeys.spec.ts:65 | n/a |

## Cosmetic assertions likely to break on restyle

- `#curation-purpose` / `#artifact-source-guide` prose about "framework curation, not an organization-owned source and not MCP" and per-source-type guidance sentences — `tests/org-policy/studio-bring-your-own-paths.test.ts:73,76,111,114,121,129,137,155`.
- `#drawer-detail` exact custom-hook-support copy — `tests/org-policy/studio-bring-your-own-paths.test.ts:87,90`.
- `#import-policy` / `#import-evidence` exact phrases "replaces current" / "inspection only" — `tests/org-policy/studio-custom-next-action.test.ts:145,146`.
- `summary` exact text "Evidence & versions" on `#evidence-delivery` — `tests/org-policy/workbench/browser/compact-setup.spec.ts:396`.
- `#developer-tool-help` / `#deployment-setup-help` exact `toHaveText` help copy — `tests/org-policy/workbench/browser/compact-setup.spec.ts:435`.
- `#deployment-readiness` exact phrases "Draft is ready to export.", "disabled in Vibe", "Enterprise posture" — `tests/org-policy/workbench/browser/compact-setup.spec.ts:507,510,511,518`.
- Tool-specific accessible names templated as "Exclude {label} from setup" / "Include {label} in setup" / "Remove {label} from selection" — any wording-template change breaks every developer-tool spec at once — `tests/org-policy/workbench/browser/compact-setup.spec.ts:484,496,556,559`, `tests/org-policy/workbench/browser/developer-tools.spec.ts:105,157,161,259`.
- `role=heading name="A policy is a shape of exposure"` / `role=heading name="Build your policy"` exact headings — `tests/org-policy/workbench/browser/compact-setup.spec.ts:101,206,373,457`.
- `.workbench-evidence-sheet` literal "Reported result:" prefix — `tests/org-policy/workbench/browser/journeys.spec.ts:100`, `artifact.spec.ts:324`.
- `.workbench-source-review` literal phrases "Reports included", "Needs review", "0 currently verified" — `tests/org-policy/workbench/browser/journeys.spec.ts:81,116,164`, `generic-journeys.spec.ts:51,52`.
- `.workbench-draft-counts` literal words "Controls"/"Requests" ahead of counts — `tests/org-policy/studio-aih-mcp-requests.test.ts:66`, `tests/org-policy/studio-fulfillment-affordance.test.ts:54`, `tests/org-policy/workbench/browser/journeys.spec.ts:136`, `generic-journeys.spec.ts:188`.
- disclosure summary regex wording "all default tools selected" / "N selected" / "N excluded" — `tests/org-policy/workbench/browser/compact-setup.spec.ts:376,487,488`, `developer-tools.spec.ts:70,139,155,187,200`.

## New shell migration ledger (NEW-SHELL-PLAN.md §3)

Rows added per slice. Columns follow the plan: the hook, its new-shell hook,
the slice that migrated it, and whether the behavioural assertion is unchanged.
A new-shell-only hook has no legacy row; its test is named instead.

| Hook | New hook | Migrated in slice | Assertion unchanged | Test |
|---|---|---|---|---|
| `[data-view-tab]`, `body.dataset.view` | `#wb-root[data-wb-screen]`, `[data-wb-nav]`, `[data-wb-screen-panel]` | S1 (new shell only; legacy tests keep `data-view-tab` until S3–S8) | n/a (new hook) | new-shell-frame.test.ts; browser/new-shell.spec.ts |
| role `button` "Switch to dark theme" / "Switch to light theme" + `html[data-theme]` | same (`#theme-toggle`) | S1 | y | new-shell-frame.test.ts; browser/new-shell.spec.ts |
| `#status`, `#announcement` (`aria-live="polite"`) | same | S1 | y | new-shell-frame.test.ts |
| `[data-kind-ledger-tile="<kind>"]` | same, inside `[data-wb-ledger]` | S1 | y (per-kind selected/total) | new-shell-frame.test.ts |
| — | `#nav-rail`, `#toggle-nav-btn`, `#inspector-rail[data-wb-inspector]`, `#btn-toggle-inspector`, `[data-wb-inspector-tab]`, `[data-close-inspector]` | S1 | n/a (new hook) | new-shell-frame.test.ts; browser/new-shell.spec.ts |
| visual baselines `shell-header-*`, `shell-kind-ledger-*` (legacy) | `new-shell-frame-{light,dark}`, `new-shell-frame-375-light` | S1 (both shells snapshotted) | legacy baselines unchanged | browser/visual-shell.spec.ts |
| `#validate` (`check-failed` / `check-attention`) | same, header "Check Policy" | S2 | y | new-shell-download-compat.test.ts; browser/new-shell.spec.ts |
| `#validate` title / accessible name "Validate" | "Check Policy" | S2 | COSMETIC (copy re-pinned: "Validate" became "Check Policy") | new-shell-download-compat.test.ts; browser/new-shell.spec.ts |
| `#download`, `#policy-download-name`, `#policy-file-help`, `#policy-file-command` | same; `#download` is header "Publish", the filename lives in the `#wb-file-menu` group | S2 | y (goldens byte-equal) | new-shell-download-compat.test.ts; browser/new-shell.spec.ts |
| `#policy-file`, `#evidence-file`, `#decision-file`, `#import-policy`, `#import-evidence`, `#import-decision`, `#download-decision`, `#export`, `#clear-policy` | same, in `#wb-file-menu` | S2 | y (messages equal the legacy shell's) | new-shell-download-compat.test.ts |
| `#config-preview`, `#report-preview` | same, in the changes screen `#json-editor` | S2 | y | new-shell-download-compat.test.ts; browser/new-shell.spec.ts |
| `window.__aihPolicyWorkbenchSession` | same (policy-session.ts) | S2 | y | new-shell-download-compat.test.ts |
| `#framework-rows` (`.workbench-inventory`, `.error`), `article[data-workbench-asset-id]`, `button[data-workbench-asset-id]`, `button[data-workbench-row-action]`, `button.workbench-row-title[data-workbench-expand-id]`, `[data-workbench-source-tab]`, `[data-workbench-source-rail]`, `[data-workbench-catalog-layout]`, `[data-workbench-catalog-register]`, `#workbench-source-filter`, role combobox "Choose catalog source", role searchbox "Search catalog", "Next 50" / "Previous 50", `section[aria-label="Catalog inventory"]`, `.workbench-source-review`, `.workbench-starting-points`, `[data-workbench-template-detail-id]`, `[data-workbench-repair-type]`, `[aria-label="Saved selections needing review"]` | same, in `[data-wb-screen-panel="sources"]`; cards in `[data-wb-sources-cards]`, source review in `[data-wb-sources-masthead]` | S3 | y | new-shell-sources.test.ts; studio-fulfillment-affordance.test.ts, studio-aih-mcp-requests.test.ts (moved to the new shell); browser/generic-journeys.spec.ts "keeps startup DOM bounded…", "expands templates…"; browser/compact-setup.spec.ts "keeps the latest full item detail…", "keeps policy exposure view-only…" (moved to the new shell) |
| "effective: not evaluated — needs a target repository" (legacy `.ledger .eff`) | `[data-wb-effective]` in the sub-header | S3 | y | new-shell-sources.test.ts; studio-aih-mcp-requests.test.ts |
| `#framework-rows` absent from the new shell (S1/S2 assertion) | re-pointed: `[data-view-tab]` absent and `#framework-rows` inside the sources panel | S3 | n: the catalog root is now the new shell's; absence of legacy markup is still asserted | new-shell-frame.test.ts; new-shell-download-compat.test.ts; browser/new-shell.spec.ts |
| `#workbench-detail-panel[data-workbench-detail]`, `#workbench-detail-title`, `[data-workbench-panel-view]`, `[data-workbench-exposure-*]`, `.workbench-item-technical`, `.workbench-detail-advanced`, `.workbench-evidence-sheet`, role button "Close details" / "Back to catalog", `[data-workbench-inspector-open]`, scrim + `inert` modal drawer at ≤1100 px | same, mounted in the inspector rail `#inspector-rail #wb-inspector-panel` (outside `#framework-rows`); the rail's Details / Security / Policy JSON tabs move to the item, its evidence sheet and its advanced record | S4 | y | new-shell-inspector.test.ts; browser/compact-setup.spec.ts "keeps Back to catalog available…", "closes the mobile inspector…"; browser/scrolling.spec.ts "keeps the mobile Workbench inspector…" (moved to the new shell) |
| scrolling.spec.ts "uses the document for desktop and narrow Workbench scrolling" | "uses the main panel for desktop and narrow Workbench scrolling": the wheel over the source rail and catalog moves `#wb-main`, over the inspector moves `#wb-inspector-panel`; the panes never consume it, the document never scrolls, every other assertion (no pane self-scroll, heading and restored row inside the viewport, policy unchanged, 900 px) kept | S4 | n — INTENTIONAL (orchestrator decision): the new shell scrolls its main panel, not the document; same intent (all content reachable by scrolling, nothing clipped) | browser/scrolling.spec.ts |
| `#json-editor`, `#config-preview`, `#report-preview` (S2) | same, inside the changes screen `[data-wb-changes]`; shown by the "Whole file" view (default) | S5 | y | new-shell-changes.test.ts; browser/new-shell.spec.ts |
| — | `[data-wb-changes-count]`, `[data-wb-changes-selections]`, `[data-wb-changes-view="changes"\|"whole"]` (`aria-pressed`), `[data-wb-changes-diff]` (region "Changes from the starting policy", `[data-wb-diff-line="added"\|"removed"\|"same"]`, `[data-wb-diff-gap]`), `[data-wb-changes-copy]` (Copy JSON), `[data-wb-changes-open="draft"\|"exposure"]` | S5 | n/a (new hook; diff baseline = the model's `initialPolicy` serialised) | new-shell-changes.test.ts; browser/new-shell.spec.ts "shows the draft's changes…" |
| `#approval-rows` (rows `[data-row]`, `.receipt-details`), `#receipt-state`, `#copy-approvals` (disabled; click announces the inert-draft notice), `#decision-state`, `#decision-rows`, `#decision-export`, `#dispositionable-findings`, `#hard-blockers`, finding-model summary | same ids, in the scan screen `[data-wb-screen-panel="scan"] [data-wb-scan]`; summary `[data-wb-scan-finding-model] > summary` counts from the model; `[data-wb-scan-import="evidence"\|"decision"]` open `#evidence-file` / `#decision-file` | scan (requested as S6; plan S8) | y | generate.test.ts "keeps standalone decision import strict…", "keeps decision import deterministic…" (moved to the new shell); studio-finding-model.test.ts "renders each finding partition…" (moved); new-shell-scan.test.ts; browser/new-shell.spec.ts "inspects imported evidence…" |
| generate.test.ts "keeps curation and preserved evidence detail…" receipt half | its receipt assertions repeated on the new shell in new-shell-scan.test.ts; the test itself stays on legacy (its curation half, `#curation-rows`, is acme / S7) | scan | y (receipt assertions duplicated, not moved) | new-shell-scan.test.ts |
| "Finding model: 8 administrator-dispositionable, 6 hard blockers" in the legacy page HTML (studio-finding-model "stops claiming…") | legacy template text; the new shell computes the same string from `model.findings` | scan | legacy test unchanged; new-shell twin "states the partition counts…" | studio-finding-model.test.ts |
| `#policy-settings`, `#posture`, `[data-sanctioned-cli]` (`#supported-cli-hosts`), `#supported-cli-count`, `#supported-cli-info` / `#supported-cli-note`, `#managed-mcp-projection` / `#managed-mcp-info` / `#managed-mcp-help`, `#deployment-setup-info` / `#deployment-setup-help`, `#deployment-readiness`, `#developer-tool-selection` (`#developer-tool-selection-summary`, `-status`, `#developer-tool-rows`, `#developer-tool-info` / `#developer-tool-help`, `[data-developer-tool-*]`), `#adoption-recipe` (`-toggle`, `-panel`, `-close`, `-roles`, `[data-adoption-role]`), `#evidence-delivery` (`summary`, `#evidence-delivery-close`), `#surface-ecc-hooks` (`data-open`, `[data-group]`), `#ecc-hook-controls`, `[data-ecc-hook-group]`, `[data-ecc-hook-id]`, `[data-ecc-hook-profile]`, `[data-ecc-hook-disable]` | same, in the organization screen `[data-wb-screen-panel="org"] [data-wb-org]` | S6 | y | new-shell-org.test.ts; studio-ecc-hook-profile.test.ts, studio-adoption-recipe.test.ts "renders a separate escaped, inert panel…" (moved); browser/compact-setup.spec.ts "unifies references…", "opens setup explanations…", "keeps compact controls usable…" (moved); browser/developer-tools.spec.ts (all 4, moved, pages opened with `?shell=new`); browser/team-policy-delivery.spec.ts (moved, `?shell=new`) |
| `.bar` layout box (COSMETIC) and heading "Build your policy" (COSMETIC) in compact-setup "unifies references…" / "opens setup explanations…" | the organization screen title `#wb-screen-title-org` (setup starts ≤ 24 px below it), the section after setup `#surface-ecc-hooks` (starts below setup, < 300 px into `#wb-main`), and the heading "Organization" as the click-away target | S6 | COSMETIC re-pin: the new shell has no toolbar above the setup card and "Build your policy" is the sources screen's draft heading; every size, order and focus bound kept | browser/compact-setup.spec.ts |
| compact-setup "keeps the catalog anchored…": layout / `#framework-rows` width ≥ viewport − 48, inspector right edge ≤ layout right edge | width ≥ `#wb-main` width − 48; inspector (now in the inspector rail, outside the layout) right edge ≤ viewport | S6 | n — re-pointed: the catalog fills the main panel, not the document, and the inspector rail sits beside it (same intent: nothing narrower, nothing clipped); every other assertion kept | browser/compact-setup.spec.ts |
| compact-setup "keeps every tab dense…": `data-view-tab` Compose / Artifacts / Authoring / Imports, `#panel-*` ≤ 24 px under `.bar`, width ≥ viewport − 48 | every nav-rail screen (sources, scan, changes, org, acme), `[data-wb-screen-panel]` ≤ 24 px under the top of `#wb-main`, width ≥ `#wb-main` width − 48 | S6 | n — re-pointed to the new frame (legacy tabs and `.bar` retired, plan §3); it now visits five screens instead of four | browser/compact-setup.spec.ts |
| `#curation-editor`, `#curation-purpose`, `#curation-framework` / `-label`, `#curation-asset`, `#curation-kind`, `#curation-id`, `#curation-owner`, `#curation-repository`, `#curation-commit`, `#curation-path`, `#audit-record`, `#audit-digest`, `#curation-note`, `#add-curation`, `#cancel-curation-edit`, `#curation-rows`, `[data-workbench-action][data-workbench-kind][data-workbench-id]` (curation / custom / remote rows), field errors `#<id>-error` + `aria-invalid` | same, in the additions screen `[data-wb-screen-panel="acme"] [data-wb-acme]` (the curation editor is inline, not a drawer) | S7 | y | studio-bring-your-own-paths.test.ts "guides npm and GitHub discovery…", "binds accountable owner email…" (moved); generate.test.ts "provides field recovery…", "keeps curation and preserved evidence detail…", and five import / custom-refinement tests (moved); browser/journeys.spec.ts (all 3, moved) |
| `#custom-form`, `#custom-*`, `#custom-rows`, `#remote-custom-form`, `#remote-custom-*`, `#open-protected-mcp` | same constant markup (`studio-custom-mcp.ts`, shared with the legacy template, which renders byte-identical), cloned from `<template id="wb-custom-mcp">` | S7 | y | studio-custom-next-action.test.ts (all 8, moved); studio-protected-forms "refuses inherited non-NFC custom source text…" (moved) |
| `#protected-form` and every `#protected-*` field, `#protected-bundle-preview`, `#protected-evidence-preview`, `#download-protected-bundle`, `#download-protected-evidence`, `[data-protected-revoke]`, `#protected-accepted-findings` | same constant markup (`studio-protected-authority.ts`), cloned from `<template id="wb-protected-policy">`; `studio-protected-authority-runtime.js` mounts on it unchanged, reading the session policy | S7 | y (evidenceEnvelope stays null: evidence download disabled, preview empty — pinned, not fixed) | studio-protected-forms.test.ts (all 12, moved); browser/journeys.spec.ts "authors a protected decision…" (moved); new-shell-download-compat.test.ts and browser/new-shell.spec.ts "builds and downloads the protected bundle and the artifact intake byte for byte" |
| `#open-artifacts`, `#panel-artifacts`, `#artifact-intake-review` and every `#artifact-*` / `#download-artifact-intake` / `#import-artifact-*` hook | same; `#panel-artifacts` sits in the additions screen and `artifact-intake-runtime.js` mounts on it unchanged (`window.setWorkbenchView` / `__aihSetWorkbenchView` route legacy view names to screens) | S7 | y | studio-artifact-intake.test.ts (all 15, moved); generic-journeys "keeps requests and local draft bytes…" (moved) |
| new-shell-download-compat "serializes the protected policy bundle…" / "serializes the artifact intake…" (golden round-trip through the serializer) | "downloads … byte-for-byte": the protected form's submit button builds the bundle and `#download-protected-bundle` writes it; the intake's file input reads it and `#download-artifact-intake` writes it; both equal the S0 goldens | S7 | n — replaced by a stronger end-to-end check (owner byte gate); the Playwright twin runs under the strict CSP | new-shell-download-compat.test.ts; browser/new-shell.spec.ts |
| artifact.spec.ts packed page | `packed-policy-workbench.html` with the model's `shell` field set to `"new"` (fixture copy of the installed package's page); pages the packed CLI generates later open with `?shell=new` | S7 | y (the packed copy has no `<template>` / evidence JSON, so its additions screen lacks the protected and custom forms; artifact.spec does not use them) | browser/artifact.spec.ts (all 5, moved) |
| `#byo-actions` (`.pop-row` × 2: `#open-artifacts`, `#open-custom-hook-info`), `#ecc-mcp-actions` (`.pop-row` `#open-ecc-mcp`) | same ids, in the additions screen's "Bring Your Own" and "ECC MCP approval" cards | A (after S7) | y | studio-bring-your-own-paths "separates organization-owned intake…" (moved); supported-cli-subsets "requires explicit managed MCP opt-in…" (moved) |
| `#ecc-mcp-scrim` + `aside#ecc-mcp-sidebar` drawer, `#ecc-mcp-close`, `#ecc-mcp-editor`, `#ecc-mcp-id`, `#ecc-mcp-state`, `#ecc-mcp-approved-by`, `#ecc-mcp-authentication-mode`, `#ecc-mcp-data-classes`, `#save-ecc-mcp-approval`, `#ecc-mcp-approval-rows`, `[data-ecc-mcp-approval-remove]`, `[data-ecc-mcp-approval]` routes | same ids; `#ecc-mcp-sidebar` is an inline region (`hidden` until opened), no scrim; options and rows via `textContent` | A | y (legacy `sy`, `Py` and the remove handler copied; `#save-ecc-mcp-approval` had no handler in the legacy runtime and still has none — see ADOPTION-LOG) | new-shell-acme.test.ts |
| `#drawer` / `#drawer-detail` (custom-hook note) | `#wb-acme-hook-info` (inline region, `hidden` until `#open-custom-hook-info`), `#wb-acme-hook-info-close` | A | y (locator only; prose unchanged) | studio-bring-your-own-paths "separates organization-owned intake…"; new-shell-acme.test.ts |
| `#authoring-sidebar` hidden after `#open-artifacts`; `body.dataset.view === "artifacts"` | `#curation-editor` stays closed (the curation editor is inline); `#wb-root[data-wb-screen="acme"]` | A | y (locator only) | studio-bring-your-own-paths "separates organization-owned intake…" |
| supported-cli-subsets: `body.dataset.view === "compose"`, `#policy-settings` in `#workbench`, `#open-ecc-mcp` in `#panel-author` | `#wb-root[data-wb-screen="sources"]`, `#policy-settings` in `#wb-main`, `#open-ecc-mcp` in `[data-wb-screen-panel="acme"]` | A | y (locator only) | supported-cli-subsets.test.ts |
| `AIH_WORKBENCH_SHELL`, `?shell=`, model field `shell`, Playwright fixture option `shell`, `new-shell/` fixture copies, artifact.spec packed-page copy (`"shell":"new"` injected) | removed: `policyStudioHtml` renders the new shell for every admin page (`policy generate`, the packed page, `ui-server`) | B | n/a (switch retired) | ui-server.test "serves the new admin shell and has no shell switch" (a stale `AIH_WORKBENCH_SHELL` is ignored); new-shell-frame "emits the new shell's lean root…", "ignores a ?shell= query…" |
| new-shell-frame "keeps the legacy shell as the default…", "emits data-wb-shell on both pages…", "renders the legacy workspace by default"; new-shell.spec "renders the same frame from a legacy page opened with ?shell=new" | RETIRED — they asserted the switch itself. Behaviour now covered by: new-shell-frame "emits the new shell's lean root and no legacy markup", "ignores a ?shell= query: the new shell is the only admin page" (same frame assertions: one `#wb-root`, sources screen, catalog in the sources panel, only `#wb-styles`) | B | n/a | new-shell-frame.test.ts |
| visual baselines `shell-header-{light,dark}`, `shell-kind-ledger-{light,dark}` (legacy header / footer ledger screenshots) + their header-overflow check | RETIRED (legacy-only cosmetic pixels). The overflow check moved to visual-shell "admin shell header does not overflow at 1440 and 375 px" (`[data-wb-header]`); the new header and ledger pixels are in `new-shell-frame-{light,dark,375-light}` | B | overflow y; pixels n (cosmetic) | browser/visual-shell.spec.ts |
| `#catalog-provenance`, `#baseline-evidence-provenance` (legacy lines under the toolbar) | same ids and bytes (server-escaped as before) in `<template id="wb-provenance">`, cloned into the shell's `[data-wb-provenance]` strip above `#announcement` | B | y | admin-catalog-cli-route.test.ts (unchanged); studio-template-data "embeds only bounded baseline evidence provenance fields" (now also asserts the rendered strip) |
| studio-template-data "distinguishes preparation pins…": `id="evidence-delivery"` and `<dt><strong>…</strong></dt><dd …>` bytes in the page HTML; `fixture/core&lt;script&gt;` | the rendered `#evidence-delivery` on the organization screen: dt → dd map, text, no element inside any `dd`; the page HTML still never contains raw `fixture/core<script>` | B | y (locator only; the escaping assertion is now a DOM one: model text renders as text) | studio-template-data.test.ts |
| studio-vet-verdicts "renders blocked components as visually distinct…": `data-vet="blocked"` / `data-vet="pass"` strings (legacy CSS + runtime string builders) and the finding code in the HTML | the blocked asset's card carries `[data-workbench-evidence-tone="warning"]` while a clean one is `neutral`, and opening it shows `trust.permission-risk` in `#wb-inspector-panel` | B | y (same behaviour, real rendered hook instead of a CSS string) | studio-vet-verdicts.test.ts |
| studio-finding-model "stops claiming…": strings in the page HTML | the same strings in the rendered page's text | B | y | studio-finding-model.test.ts |
| header-restyle: each contract id `id="…"` exactly once in the HTML; GitHub link `href`; clear-policy after export by string index; no opacity modifiers in `<header class="bar">` | each id exactly once in the rendered DOM; the GitHub link (`rel="noopener noreferrer"`) inside `[data-wb-header]`; `#clear-policy` follows `#export` in document order; no opacity modifier on any `[data-wb-header]` element | B | y | header-restyle.test.ts |
| header-restyle "lets the header grow when its controls wrap" (`min-h-14`, no `h-14` on `.bar`) | RETIRED (legacy cosmetic class). The new header does not wrap; no-overflow is covered by visual-shell "admin shell header does not overflow at 1440 and 375 px" and new-shell.spec "renders the frame offline…" (header `scrollWidth` = `clientWidth` at 375) | B | n/a | browser/visual-shell.spec.ts; browser/new-shell.spec.ts |
| generate "derives catalog data…": `aria-live="polite"`, `role="tooltip"` in the HTML; COSMETIC `summary{cursor:pointer` and `min-height:28px` | live region and tooltip read from the rendered DOM; `summary` cursor re-pinned to the compiled rule `html[data-wb-shell="new"] summary { cursor: pointer; }` (added to `wb-tokens.css`: several new-shell summaries lacked it); `min-height: 28px` in the compiled CSS | B | y / COSMETIC re-pin | generate.test.ts |
| generate "has semantic controls…": `main#workbench`, `section.group` ≥ 4 | `main#wb-main` (tabindex −1), `main#wb-main section` ≥ 4; every other assertion unchanged | B | y (landmarks re-pointed) | generate.test.ts |
| design-foundation, catalog-card-icon | unchanged; they read `policyStudioHtml`, which is now the new shell | B | y | design-foundation.test.ts; catalog-card-icon.test.ts |
| S0 characterization "pins the validate outcome…": `#validate` full `className` and `title` "Validate" | the check-state classes (`check-failed` / `check-attention`) only; the styling and the "Check Policy" label are cosmetic (S2 row). Messages and readiness text unchanged; every download golden unchanged | B | y (goldens byte-equal on the new shell) | legacy-download-characterization.test.ts |
| Still on the legacy shell after S7 | — | none after A and B: the BYO and managed-MCP checks moved in A; the legacy template/string tests, `generate` "has semantic controls…", the legacy visual baselines and the S0 characterization moved or retired in B (rows above) | n/a | — |
| `legacy-runtime.js`, legacy template markup and inline CSS, `workspace-shell.ts`, `workspace-interactions.ts`, catalog `shell` option and legacy render branches, `wb-tokens.css` P3.0 bridge and legacy-only rules | DELETED | C | n/a (no test read them after B; the full org-policy vitest, the UI lane and every S0 golden and snapshot pass unchanged) | legacy-download-characterization.test.ts (S0, now on the new shell, goldens byte-equal) |
