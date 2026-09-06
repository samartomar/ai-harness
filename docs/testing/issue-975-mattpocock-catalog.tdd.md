# Issue #975 — Pinned Matt Pocock skills

Status: local Workbench and provider acceptance passed. Repository-wide and
hosted gate results are recorded in the linked PR.

## Boundary

The registered provider packages 25 skills and 23 required support files from
Matt Pocock skills v1.2.3, commit
`3cca18b368ae95cdbdebbff572ccafa662551015`, plus the MIT license. All 49
packaged blobs were compared with the exact, non-truncated upstream Git tree;
there were no missing paths or byte mismatches. The skill list matches the
upstream plugin manifest.

The neutral skill-only compiler validates plain JSON, canonical bytes, UTF-8,
file and collection hashes, source identity, paths, resource ownership, and YAML
frontmatter. The provider owns exact upstream pins and inventory. Its packaged
input is deeply frozen. No generic UI file or browser journey is added.

## Regression evidence

The first Core consumption run failed four tests with
`Missing packaged Matt TDD skill`. Registering the packaged provider input made
the source available through default catalog preparation. Final coverage proves
export/import and Core consumption, exact source/content rejection, no approval
or activation, and additive use beside ECC methodology.

Review also identified a missing diagnosing-bugs shell template, incomplete
support-inventory checking, shallow freezing, broad JSON ownership, and unresolved
YAML tags. Regressions cover these cases. The support inventory now binds exact
path-to-skill ownership, and JSON ownership requires both the reviewed path and
reachability through its provider's static imports.

## Local acceptance

| Command or scenario | Result |
| --- | --- |
| Focused compiler, provider, and Core consumption Vitest run | 15 tests passed in 3.54 s |
| `npm run test:workbench:pr` | 48.288 s; 87 pure tests, 262 retained tests, 7 Chromium journeys passed |
| Pure stage with coverage | 3.858 s; below 10 s |
| Peak summed resident memory in Workbench lane | 2,355,929,088 bytes; no heap override |
| `npm run test:workbench:providers` with the Matt ownership receipt | 75 tests and the existing packed smoke passed; all stages exit 0 |
| Packed HTML manual scenario | 25 Matt skills; zero initial rows; 956 initial DOM nodes; readable TDD metadata; exact pinned selection; no network requests or page errors |

The manual artifact is the one produced by the installed-package smoke. Its
`--ui` route and deterministic offline generation are covered by the existing
packed journey. No selected skill is executed during authoring, and Matt rows
show `evidence: none prepared`.
