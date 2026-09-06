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
input is prepared on first use and deeply frozen. A private compiled snapshot is
reused only for that sealed input; callers receive detached copies. Explicit
inputs still undergo full validation. The YAML parser is loaded only when actual
skill frontmatter is compiled. No generic UI file or browser journey is added.

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

A later cache-isolation regression verifies that caller mutations cannot change
subsequent compiled output and that explicit input compilation produces identical
bytes. Import-time snapshot validation and YAML loading were removed after hosted
acceptance exceeded the unchanged 60-second lane budget. Final hosted timing is
recorded in the PR.

## Local acceptance

| Command or scenario | Result |
| --- | --- |
| Focused compiler, provider, and Core consumption Vitest run | 16 tests passed |
| `npm run test:workbench:pr` | 51.691 s; 87 pure tests, 263 retained tests, 7 Chromium journeys passed |
| Pure stage with coverage | 3.837 s; below 10 s |
| Peak summed resident memory in Workbench lane | 2,849,751,040 bytes; no heap override |
| `npm run test:workbench:providers` with the Matt ownership receipt | 75 tests and the existing packed smoke passed; all stages exit 0 |
| Packed HTML manual scenario | 25 Matt skills; zero initial rows; 956 initial DOM nodes; readable TDD metadata; exact pinned selection; no network requests or page errors |

The manual artifact is the one produced by the installed-package smoke. Its
`--ui` route and deterministic offline generation are covered by the existing
packed journey. No selected skill is executed during authoring, and Matt rows
show `evidence: none prepared`.

Repository-wide `npm run verify` at `8e988b4` passed: 8,710 tests passed, 46
skipped, with packed documentation and cold installed-package lifecycle proofs.
The subsequent preparation optimization is covered by the final focused and
complete Workbench results above; current-head hosted gates are recorded in the PR.

The lane now overlaps pure coverage with package build, measuring both under one
process tree. Each child retains its command, exit status, and wall time; failed
preparation blocks browser acceptance. The packed journey prepares its cold
consumer before acquiring a browser page and records pack/install/UI/generation
timings. All seven journeys and the 10/60-second limits remain unchanged.

The later local full-suite run at `4d0eaed` passed 8,710 tests with one 15-second
continuity-record timeout. The exact failed test passed alone (9.77 s), and all
hosted Ubuntu, macOS, and Windows test jobs at that revision passed. This does not
represent a clean local full-suite invocation; final hosted checks govern merge.
