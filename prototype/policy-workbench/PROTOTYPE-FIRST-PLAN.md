# Prototype-first plan: Policy Workbench (admin page and user page)

Status: proposed 2026-09-19, waiting for owner "go".
This replaces `NEW-SHELL-PLAN.md` for everything about markup, CSS and presentation.
The behaviour modules, golden files and test lanes built under that plan are kept.

## 1. Goal

The shipped Workbench **is** the prototype: the same HTML, classes, CSS and
presentational JS, showing real data and wired to real behaviour.

Order of work: **prototype in first, data second.** Each page, the CSS and the
prototype JS are handled once. Nothing is re-typed, restyled or redesigned in product code.

### Definition of done

| Gate | What it proves | How it is checked |
|---|---|---|
| G1 | The prototype running inside the product build is pixel-identical to the prototype | Playwright, every screen, 1440x900, dark and light, pixel diff <= 0.1 % |
| G2 | With real data the design is undisturbed | Same DOM skeleton (tag + class list per element; repeat counts may differ; approved fragments are the only additions), same computed styles on every bound element, masked pixel diff <= 0.1 % |
| G3 | No mock leftovers | No prototype sample string that the contract marks REAL, PLACEHOLDER or HIDDEN appears in a product render |
| G4 | Behaviour is intact | Download bytes equal the golden files; validation and import messages; hostile strings stay text; offline (no requests, CSP clean) |
| G5 | Nothing drifted | Prototype files and generated templates match the lock file |
| G6 | Owner has seen it | Checkpoint 1 (prototype inside the product) and the final side-by-side gallery |

G1 to G5 are run by scripts. No worker judges "close enough" by eye.

## 2. What went wrong last time, and what prevents it now

| Last time | Now |
|---|---|
| Screens were re-typed from the prototype into TypeScript DOM builders, so they drifted | Templates are generated mechanically from the prototype files (rule R2) |
| Old layout and label tests were treated as untouchable, so the design was bent to fit them | Behaviour tests stay; layout, label and structure tests are replaced by G1/G2 (rule R8) |
| The build differed from the prototype: Tailwind base styles off, no forms plugin, system fonts, SVG icons instead of the Material Symbols font | The build uses the prototype's own Tailwind config, both plugins, and the same three fonts, embedded (rule R3) |
| Elements were dropped as "no data" without asking, including ones that do have data (Vibe/Enterprise, "N of 11 AI tools") | Every element is classified in a contract the owner approves once (rule R6) |
| Parity was compared against our own screenshots | Parity is compared against the prototype, by script (G1, G2) |

## 3. Rules

- **R1. Frozen design source.** `prototype/policy-workbench/screens/*` is the only design truth. A lock test fails when any of it changes. Only the owner changes the design, in the prototype.
- **R2. No hand-typed markup.** Product templates are generated from the prototype files by a tool and never edited by hand. The only edit allowed in prototype HTML is adding inert attributes (`data-wb-*`, `id`, `aria-*`, `role`, `tabindex`). The prototype must render pixel-identically before and after.
- **R3. No product CSS for look.** CSS = the prototype's `tokens.css` + `wb.css` + Tailwind compiled from the prototype's own config (`darkMode: "class"`, base styles on, `forms` and `container-queries` plugins) + the embedded fonts. `wb-tokens.css` is retired.
- **R4. Prototype JS.** Blocks that are purely presentational (rail toggles, theme, modals, tabs) run verbatim. Blocks that fake data are replaced by the data layer. The contract records which is which.
- **R5. One data path.** Data enters through one binder that writes `textContent` and attributes only. Never `innerHTML` with model or imported data.
- **R6. Nothing dropped silently.** Every prototype element is REAL (with its source), PLACEHOLDER, HIDDEN or STATIC in the contract, approved by the owner.
- **R7. Prototype first for gaps too.** A product feature with no prototype home gets a static fragment built only from existing prototype components. The owner approves the fragment before it is wired.
- **R8. Tests never drive markup.** Behaviour tests (bytes, validation, imports, escaping, offline) are kept and re-pointed to `data-wb-*` hooks. Layout, label and structure tests of the old UI are replaced by G1/G2.
- **R9. One pass per screen.** Annotate, adapt, wire, gate. A screen is reopened only when a gate fails.
- **R10. Repo rules still hold.** Never run `aih`, `npx aih`, `src/cli.ts` or `dist/cli.js` against this checkout. Local only, no push. One commit per work order at green gates. No attribution lines, no `--no-verify`, no bare `git stash`. Never run Kimi's `/init` here (it rewrites `AGENTS.md`). Stop and ask on any schema, policy-semantics, dependency or security change beyond the ones in section 5.

## 4. Architecture

```
prototype/policy-workbench/screens/
  *.html  shell.js  user-shell.js  mode.js  tokens.css  wb.css  tw-config.js
        |
        |  tools/wb-capture.mjs   (Node vm evaluates the document.write strings of
        |                          WB.top/nav/ledger/main and WBU.top/files; splits
        |                          frame, screen bodies, presentational scripts;
        |                          records the SHA-256 of every source file)
        v
src/org-policy/workbench/ui/proto/templates.generated.ts     (never hand-edited)
        |
        |  tools/build-workbench.mjs: Tailwind over the prototype files with the
        |  prototype config + tokens.css + wb.css + embedded fonts
        v
one offline HTML document
  router   : mounts the frame and one screen template; intercepts the nav links
  scripts  : runs that screen's presentational script
  binder   : fills [data-wb-text], [data-wb-attr-*], [data-wb-each], [data-wb-if]
  adapters : pure functions, real view model -> binder data (one file per screen)
  actions  : behaviour modules attach to [data-wb-action] hooks
```

**Kept from the current branch:**

- `policy-session`
- `policy-grammar`
- `download-format`
- the logic of `file-transfer`
- the catalog controller state (selection, filter, search, paging)
- `user-door-model`
- `schema3-reprojection`
- the two form runtimes (`studio-protected-authority-runtime.js`, `artifact-intake-runtime.js`), which mount on approved fragments that keep their ids
- all golden files
- the door classifier and server

**Retired in phase 3:**

- `shell/*-screen.ts`
- the markup in `admin-shell.ts` and `user-door.ts`
- the ledger renderer
- the hand-written look rules in `wb-tokens.css`
- `icons.ts` (the icon font replaces it)

## 5. Owner decisions

Reply "go" to accept all defaults.

| # | Decision | Default | Why |
|---|---|---|---|
| 1 | Embed Inter, JetBrains Mono and a Material Symbols subset (about 56 icons) in the offline page. Estimated +0.3 MB on a 3.9 MB fixture page, measured in WO-K1. Licences: OFL 1.1 and Apache-2.0. Adds `font-src data:` to the offline CSP string used by the tests. | Yes | Without the prototype's fonts and icon font the product can never match it |
| 2 | Add two build-time devDependencies: `@tailwindcss/forms`, `@tailwindcss/container-queries` | Yes | The prototype loads both; `forms` is what styles every input and select |
| 3 | Add inert attributes to the prototype HTML (R2) | Yes | Makes binding exact and work orders unambiguous; proven invisible by pixel diff |
| 4 | Replace old layout, label and structure tests with G1/G2; keep behaviour tests | Yes | This is the conflict that damaged the design |
| 5 | One contract review at checkpoint 0 (about 15 minutes): no-data elements, gap fragments, card toggle meaning | Yes | One review now instead of surprises later |

Defaults inside the contract, which the owner can flip per row at checkpoint 0:

- **Default theme.** It stays light (D8).
- **Narrow widths.** They follow the prototype, since this is a desktop tool.
- **Contrast.** The contrast tweaks made earlier revert to the prototype's values.
- **Token budget.** The tile and the cost chips stay in place showing "not measured" (D6 hides the numbers, not the layout).
- **Card toggle.** On means "record requested intent". Gates show as the status pill and a route in the inspector (owner decision 2026-09-04).

## 6. Working with Kimi and Opus (about 50/50)

Facts, checked on this machine on 2026-09-19:

- Kimi Code 2.0.0, model K3, 1M context, thinking "high".
- `kimi -p "<prompt>"` runs unattended in the current directory. It edited a file and ran a shell command without asking, in 26 s. The latency floor is about 20 s per call.
- `-p` cannot be combined with `--auto` or `--yolo`.
- `kimi -C` continues the last session in that directory.
- `--output-format stream-json` gives structured events.
- `/effort off|low|high|max` sets thinking depth.

Kimi is slow when it has to explore or decide. Every Kimi job therefore removes both.

**Work order (WO) format**: one Markdown file, at most about 120 lines:

1. Goal, one sentence.
2. Files you may create or edit (exact paths). Everything else is read-only.
3. Context pasted inline: the types, the template excerpt with its `data-wb-*` fields, a sample input JSON and the expected output JSON.
4. Steps, numbered, imperative, no choices.
5. One verification command and the expected tail of its output.
6. Stop rule: if anything is unclear, write `QUESTION.md` and stop. Never guess.
7. Report: five lines.

**Runner**: `tools/wb-run-wo.sh <WO-id> <kimi|opus>`

1. Creates a git worktree from the integration branch and junctions `node_modules`.
2. Runs the worker with the WO (`kimi -p "$(cat WO.md)"`).
3. Runs the WO's gate, the lock test, and an "only allowed files changed" check (`git diff --name-only` against the allow-list). A violation rejects the result automatically.
4. Writes `.aih-scratch/wo/<id>/result.json` (pass or fail, gate tail, diffstat).

The orchestrator reads only `result.json` and the diffstat, never transcripts.

**Escalation**: fail -> one fix round with the gate output appended (`kimi -C`). Second fail -> the same WO goes to Opus. WOs are model-agnostic, so if the Opus allowance runs out, Kimi takes the remaining ones.

**Pilot**: WO-K1 (fonts) and WO-K2 (lock test) run first. They are timed at thinking high and low, and WO size is tuned to at most 30 minutes of Kimi time and about 200 changed lines.

**Who does what**

| Kimi (clear, mechanical, high volume) | Opus (glue where precision matters) |
|---|---|
| Fonts fetch + subset + licences | Capture tool and generated templates |
| Lock test, parity harness G1/G2/G3 from a written spec | CSS pipeline parity |
| Annotating templates from the contract tables | Router and door selection |
| One adapter per screen with golden JSON tests | Binder core |
| Static gap fragments from existing components | Behaviour wiring per screen |
| Porting behaviour tests to the new hooks, docs, ledger | Retiring the hand-built shell, final adversarial review |

Fable (orchestrator): the contract, the work orders, merges, reading gate results, and the final click-through. Up to two Kimi and two Opus workers run at once, always on disjoint files.

## 7. Phases and work orders

Admin and user tracks run in parallel from phase 2. The contract (phase 0) and the binder (O5) are built while phase 1 runs.

### Phase 0: contract (about 1.5 h, overlaps phase 1)

| WO | Who | Output |
|---|---|---|
| F0 | Fable (script) | `parity-contract.json` skeleton: ids, repeated blocks, script blocks, icons and text nodes per screen |
| O0a | Opus | Admin screens: each element -> REAL(source) / PLACEHOLDER / HIDDEN / STATIC; each script block -> presentational / data |
| O0b | Opus | The same for the user screens (parallel with O0a) |
| F1 | Fable | Gap list with proposed placements; test list split into behaviour (keep) and presentation (replace) |

**Checkpoint 0 (owner, about 15 min):** tick the contract tables and the gap placements.

### Phase 1: the prototype inside the product, mock content, pixel-identical (about 4 h)

| WO | Who | Output | Gate |
|---|---|---|---|
| K1 | Kimi | Fonts fetched once, subset, licences, `@font-face` data URIs, measured size | Offline render shows all 56 icons |
| K2 | Kimi | `prototype.lock.json` + lock test + generated-template freshness test | G5 |
| O1 | Opus | `tools/wb-capture.mjs` -> `templates.generated.ts` | Freshness test |
| O2 | Opus | CSS pipeline: prototype config, base styles on, both plugins, tokens.css, wb.css, fonts | G1 on one screen |
| O3 | Opus | Router: single document, screen swap, admin/user door, presentational scripts | G1 on all screens |
| K3 | Kimi | Parity harness: pixel diff + skeleton diff + computed-style diff, prototype vs product | Harness self-test |

**Gate G1, then checkpoint 1 (owner, about 10 min):** open the built page. It must be the prototype, running offline from one file.

### Phase 2: fill data (about 7 h wall, admin and user in parallel)

| WO | Who | Output | Gate |
|---|---|---|---|
| O5 | Opus | Binder core + hostile-string tests (can start during phase 1) | Unit tests |
| **User track** | | | |
| K-U1 | Kimi | Annotate `user-trim.html`, `user-start.html`, `user-shell.js` fragments | Prototype pixel diff = 0 |
| K-U2 | Kimi | `adapters/user-page.ts` from `user-door-model` + golden JSON | Unit tests |
| O-U3 | Opus | Wire: Required / Optional / Skip, set all, reset, name and "for", AI tools popover, save (bytes = golden), invalid and unbound state -> the no-policy block of `user-start.html` | G2 G3 G4 |
| **Admin track** | | | |
| K-A0 / O-A0 | Kimi + Opus | Frame: header (Check Policy, Publish, Review Changes badge, Vibe/Enterprise, AI tools), versions strip, nav and catalog scopes tree, ledger | G2 G3 G4 |
| K-A1 / O-A1 | Kimi + Opus | Sources and the inspector details: masthead, filters, card grid, toggle, search, paging, open/close, Escape and focus | G2 G3 G4 |
| K-A3 / O-A3 | Kimi + Opus | Changes and Scan (parallel with A1) | G2 G3 G4 |
| K-A2 / O-A2 | Kimi + Opus | Item: Security Scan and Policy JSON tabs | G2 G3 G4 |
| K-A5 / O-A5 | Kimi + Opus | Organization (parallel with A2) | G2 G3 G4 |
| K-A6 / O-A6 | Kimi + Opus | Additions and approvals: approved fragments for the protected policy form, artifact intake, curation, custom and remote MCP; runtimes mounted with ids kept; bundle and intake bytes = golden | G2 G3 G4 |

Each pair works the same way. Kimi annotates and writes the adapter first. Opus wires on top of it.

### Phase 3: retire the hand-built shell (about 1.5 h)

Opus deletes the DOM builders, the look rules in `wb-tokens.css` and `icons.ts`. Kimi re-points the remaining behaviour tests, removes the replaced presentation tests (each listed in the ledger with the gate that replaces it), and updates docs and the changelog.

### Phase 4: acceptance (about 1.5 h)

- Fable clicks through every flow in the built product on a temporary folder: imports, selection, Check Policy, Publish, each form with its errors, downloads, both doors.
- One Opus adversarial pass on escaping, bytes and offline.
- The owner gets a single side-by-side gallery page.

### Time

- First proof (checkpoint 1): about 5 h after "go".
- User page complete: about 4 h after checkpoint 1.
- Admin complete: about 8 h after checkpoint 1.
- Total machine time: about 15 h, plus three short owner checkpoints.
- The estimate is restated after the Kimi pilot and after G1, because Kimi's real throughput is the main unknown.

## 8. Risks

| Risk | Handling |
|---|---|
| Kimi is slower or less reliable than planned | Pilot first; small WOs; two-strike escalation to Opus |
| The Opus allowance runs out | Opus does the four foundation WOs first; every WO is model-agnostic so Kimi can take over |
| Compiled Tailwind differs from the CDN build | Same major version, same config and plugins; G1 catches any pixel difference on day one |
| 10,000-item catalogs | Keep the existing paging (50 per page); the pager is a gap fragment |
| Accessibility hooks missing in prototype markup | Added as inert attributes (R2); the skip link is a visually hidden fragment; keyboard handling lives in the action layer |
| Owner changes the prototype mid-way | Re-run capture, update the lock with an explicit flag; adapters and wiring are untouched unless a bound field moved |

## 9. Branching

Work continues from `feat/workbench-prototype-adoption` on an integration branch `feat/workbench-prototype-first`. The current shell keeps working until phase 3. The prototype-based page is rendered only by the fixture tool and the parity harness until it becomes the default at the end of phase 2. There is no user-facing switch.
