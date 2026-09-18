# Adopting the prototype UI in @aihq/core — plan

Status: draft for owner review, 2026-09-18. Source of truth for the look: `prototype/policy-workbench/screens/admin-sources.html` and its shared files. Source of truth for behaviour: the product code and tests, never this plan.

## 1. Where the product is today (verified in source)

| Area | Today | Evidence |
|---|---|---|
| Entry | `npx @aihq/core --ui` (exact argv) → `runPolicyWorkbenchUi` | `src/program.ts:25,44`, `src/cli.ts:18-22`, `src/org-policy/ui-server.ts:382` |
| Server | Loopback `127.0.0.1`, random port, token in URL hash, opens the default browser | `ui-server.ts:11,207,344,356` |
| Page | ONE inline HTML document: inline `<style>`, inline model JSON, inline esbuild bundle | `src/org-policy/studio-template.ts:120-1098`, `tools/build-workbench.mjs` |
| Routes | `/` → HTML; two token-guarded POSTs for GitHub Skill intake; nothing else | `ui-server.ts:211-339` |
| Writes | None server-side. Policy, decision, bundle and evidence leave as **browser downloads** (`aih-org-policy.json` default name) | `ui/legacy-runtime.js:2647-2691`, `ui/artifact-intake-runtime.js:96` |
| Offline | Must work offline. Playwright injects `default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:` and fails on any violation | `tests/org-policy/workbench/browser/journeys.spec.ts:8-26,118-120` |
| Fonts | Named only (Manrope, IBM Plex Mono); no web fonts loaded. The product embeds Inter + JetBrains Mono in reports | `studio-template.ts:135`, `src/report/fonts.ts` |
| Audience | Admin only. No user page, no folder-based routing | `studio-template.ts` |
| Policy lookup | `--policy` → `AIH_ORG_POLICY` → `<root>/aih-org-policy.json` | `src/org-policy/schema.ts:1882-1894`, `src/commands/run.ts:255` |
| Selections | Stored inside the policy (`authoringSelections`); no per-project selection file | `docs/commands.md:945` |
| Token cost | No per-item data. Rough estimators exist elsewhere | `src/report/bloat.ts:5-9`, `src/binding/hosts/claude/context-cost.ts` |
| Tests | vitest string tests on ids/text (`tests/org-policy/studio-*.test.ts`), pure view-model tests (`tests/org-policy/workbench/*.test.ts`), Playwright journeys by DOM id (`tests/org-policy/workbench/browser/*.spec.ts`), server tests (`tests/org-policy/ui-server*.test.ts`) | explorer report |

Docs to respect: `docs/ARCHITECTURE.md:59-64`, `docs/commands.md:849-1085`, `docs/workbench-catalog-providers.md`, `docs/testing/issue-957-*.md`, `docs/testing/issue-967-*.md`, `docs/testing/issue-971-*.md`.

## 2. What the prototype assumes that the product cannot ship as-is

| Prototype | Conflict | Direction (decision owner) |
|---|---|---|
| Tailwind **CDN** runtime | Offline + CSP `default-src 'none'` | Compile CSS at build time, inline it into the one document (D1) |
| Google Fonts Inter / JetBrains Mono | No network; CSP has no `font-src` | Inline the fonts the product already embeds, or fall back to system fonts (D2) |
| Material Symbols font | Same | Inline SVG icons for the ~45 glyphs used (D2) |
| Several HTML files + `document.write` shells | One document, one bundle | Port screens to render functions/templates inside the existing bundle and `studio-template.ts` |
| Admin and user pages chosen by folder | `--ui` takes no args, no user page exists | New product scope, gated (D4) |
| `aih-project-policy.json` | No such file or schema; selections live in the policy | New schema + consumption, gated (D5) |
| Token budget, per-item token cost | No measured data | Measurement engine first; never estimate in the UI (D6) |
| Save writes to disk | Product only downloads | Keep downloads, or add a token-guarded write route (D7) |

## 3. Decisions to take before or during the work (critical thinking owner: Fable 5.1)

- **D1 Styling pipeline. Decided 2026-09-18 (owner approved the devDependency; detail by Fable):** Tailwind **v3.4** through the PostCSS JS API inside `tools/build-workbench.mjs` (`:30-59`), `preflight: false` (the legacy hand CSS at `studio-template.ts:134-1093` uses element selectors such as `button{}` at `:157`), content globs `src/org-policy/workbench/ui/**/*.{ts,js}` + `studio-template.ts`, `tw-config.js` ported as `theme.extend`, compiled CSS inlined in a `<style>` block (keeps `style-src 'unsafe-inline'`, `journeys.spec.ts:16`). v4 rejected: it drops the JS config shape the prototype uses. Cost: +1 devDependency, a second generated file. Reopen if v3 loses Node 20 support or compiled CSS exceeds 60 KB.
- **D2 Fonts and icons offline. Decided 2026-09-18 (Fable):** inline SVG icons (55 glyphs; the product already inlines SVG, `studio-template.ts:913-919`); **system font stacks** first. The product server sets **no CSP header** (`ui-server.ts:330-338`); the only CSP is the Playwright one (`journeys.spec.ts:14-18`), so embedding Inter/JetBrains Mono (~93 KB, `src/report/fonts.ts`) later needs only `font-src data:` in the test CSP. Reopen as its own slice when the owner accepts that size.
- **D3 Migration shape. Decided 2026-09-18 (Fable, by blast radius):** keep every DOM id and test hook (see `id-contract.md`), replace the shell and CSS first, then restyle panel by panel; `legacy-runtime.js` behaviour untouched until its panel is ported. Reopen if more than 20% of the id hooks must change anyway.
- **D4 User door. Decided 2026-09-18 (owner): in this release**, admin and user pages both tested locally. Split P5: **P5a server** (pass `process.cwd()` into `runPolicyWorkbenchUi`, classify the folder as policy repo / project / neither, inject `{door, policySource}` into the model; keep `--ui` exact, `program.ts:44`) runs before P3 ends; **P5b user page** after P3. Fixture roots only.
- **D5 Project selection file. Decided 2026-09-18 (owner, Fable recommended): Option A, `aih-project-policy.json`**, a new narrow-only file: `cutFrom` pin (policy id, version, digest), `items[] {assetId, origin, use: required|optional}` reusing `workbench-selection/v1` shapes (`contracts.ts:709-716`); unlisted items are skipped; never carries allow, risk or security fields. Option B (org-policy format) does not work out of the box: the lookup (`schema.ts:1882-1894`) resolves one policy path and treats it as the authority, so a cut would replace the org policy or be unread; no narrowing or combining code exists today. Cost: one small schema and one reader in `init/apply` (new product work). Reopen if a real narrowing routine appears in `src/org-policy`.
- **D6 Context cost. Decided 2026-09-18 (owner, Fable recommended): not shown this release.** Only heuristics exist (`src/report/bloat.ts:5-6`, Claude-only `context-cost.ts`); show kind counts and keep the tile slots. Reopen when a per-tool measurement engine produces per-item numbers.
- **D7 Save. Decided 2026-09-18: browser downloads for this release**, for the admin's policy and the user's selection alike. Why: `--ui` runs without a target root (`docs/commands.md:953`), the server has no write route today, and the Workbench promises no install or execution (`docs/commands.md:1066`); a write route is a new disk-write authority needing root confinement, token and same-origin checks, and overwrite confirmation. Cost: the user moves the downloaded file into the project themselves. Reopen when D4's folder routing gives the server a known root: then one token-guarded "write into this root" route, confined to that root, with overwrite confirmation.
- **D8 Light mode. Decided 2026-09-18 (Fable): both, from P1.** The product already ships a tested light/dark toggle (`studio-template.ts:128`, `journeys.spec.ts:47-49`); dark-only would regress it. Default stays light.

Each decision is recorded with options, the choice, cost, evidence and a reopen bar in the session's decision log, and the owner confirms D1, D4 and D5 before code depends on them (D7 is decided above).

## 4. Phases

Every phase ends with its gate green and a short report: commands run with output, what changed, what is unverified.

**P0 — Baseline and guardrails**
- Run and record: `npm run build:workbench`, the workbench vitest lanes, `npm run test:workbench:ui`, `tests/org-policy/ui-server*.test.ts`. Diff later failures against this baseline (known flaky full-suite baseline exists).
- Inventory every DOM id / text the tests assert on → `id-contract.md` (the hooks the new markup must keep).
- Gate: baseline recorded, id contract written.

**P1 — Design foundation, offline**
- Port `tokens.css` (dark first, light per D8) into the workbench styles.
- Implement D1 and D2: build step produces inline CSS; icon SVG set; fonts per D2.
- Extend the Playwright offline test only if D2 needs `font-src data:`.
- Gate: a style-only page renders offline with zero CSP violations; bundle size delta reported.

**P2 — Admin shell**
- Header (identity, org, Vibe/Enterprise, AI tools, Review Changes, Check Policy, Publish, mode toggle), provenance strip with panel toggles, nav rail (Workbench, catalog scopes), six-tile kind ledger with bars — matching admin-sources.
- Wire to the existing model; no behaviour change.
- Gate: id contract intact, string tests updated only where text legitimately changed, Playwright journeys green.

**P3 — Admin panels**
- In order, each its own slice with tests: source masthead + filters + card grid; item inspector (Details / Security / Policy JSON); changes-as-JSON review; scan review; organization dialog; Acme additions (only as far as product supports).
- Gate per slice: its vitest + Playwright journeys green, screenshot compared to the prototype screen.

**P4 — Test modernisation**
- Replace brittle markup-text assertions with id/role/view-model assertions where they now fail for cosmetic reasons (never weaken a behavioural assertion).
- Add Playwright screenshot checks for the shell and ledger at 1440×900, dark and light.
- Gate: all lanes green; no assertion deleted without a replacement that covers the same behaviour.

**P5 — User door (only after D4–D7)**
- Entry routing by folder, user-start, user-trim with cascade, policy-source chip backed by the real lookup, save per D5/D7, context cost per D6.
- Gate: fixture-root tests for each lookup case; never run against this checkout.

**P6 — Hardening and docs**
- Accessibility pass (keyboard, contrast, aria-pressed), performance (bundle size, first paint), docs in `docs/commands.md` and the testing docs, changelog entry.
- Gate: full lanes green vs baseline; docs checks pass.

## 5. Out of scope unless the owner adds it
Pushing, PRs, releases, publishing to npm, changing policy semantics, running aih against this checkout.
