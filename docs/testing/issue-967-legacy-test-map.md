# #967 legacy Studio test obligation map

This is an evidence map for the current worktree. It maps the Studio suites
deleted in the current diff to named tests that remain. A successor may replace
a semantic contract while deliberately retiring a source-specific layout or copy
assertion. Five fresh local `npm run test:workbench:pr` receipts passed; this
map does not certify full verification, Ubuntu CI, release, or publication.

## Current generic browser contract

The current browser suite has six named Workbench journeys and one installed
package smoke; those are the browser successors for generic UI behavior:

- `tests/org-policy/workbench/browser/generic-journeys.spec.ts`
  - `keeps startup DOM bounded while groups, search, details, and keyboard navigation work at scale`
  - `expands templates, rejects methodology conflicts atomically, and preserves other origins on removal`
  - `keeps requests and local draft bytes separate from controls and effective permission`
- `tests/org-policy/workbench/browser/journeys.spec.ts`
  - `opens offline and keeps exact prepared evidence separate from permission across expiry`
  - `imports legacy policy, rolls back invalid input, and downloads exact bytes`
  - `authors a protected decision through ordinary fields`
- `tests/org-policy/workbench/browser/packed.spec.ts`
  - `installed package generates a complete offline artifact with usable export`

The first generic journey is the replacement evidence for bounded group/search/
detail/navigation rendering. It uses synthetic 10, 1,000, and 10,000 asset
fixtures, asserts a bounded initial and expanded DOM, and records a DOM receipt.
Across the five local PR-lane receipts, all seven Chromium tests passed; the DOM
receipt recorded 920 initial nodes and 13 changed nodes at every synthetic size.
The timing and memory table is recorded in
`docs/testing/issue-967-workbench-authoring-core.tdd.md`; Ubuntu CI remains
pending.

## Deleted-suite successors

| Deleted legacy suite | Preserved obligation | Named current successor(s) | Mapping status |
| --- | --- | --- | --- |
| `studio-administrator-journey` | Generic survey, selection, import/export, and protected form authoring | The six browser journeys above; retained protected authoring set below; `tests/org-policy/workbench/compile-policy.test.ts` — `projects controls through Core bindings while preserving authority and custom entries` and `round-trips the compiled projection through consumption` | semantic behavior mapped. The retained protected-form set now includes the inherited non-NFC rejection. |
| `studio-drawer-explainability` | A generic detail affordance may expose prepared data without mutating policy | `generic-journeys.spec.ts` — `keeps startup DOM bounded while groups, search, details, and keyboard navigation work at scale`; `tests/org-policy/workbench/catalog-bundle.test.ts` — `normalizes pinned sources without giving source metadata projector authority` | generic detail behavior mapped. The deleted source-authored agent/skill/MCP narrative-copy assertions are intentionally not represented as source-specific DOM contracts; compiler data and safe generic detail rendering remain the relevant contract. |
| `studio-hook-registrar` | Hook projection, overlap, ownership, and process-spawn semantics | `tests/org-policy/hook-registrar.test.ts` — `names both owners for each of the three real overlaps`, `still projects every overlapping entry — no silent merging`, and `charges a source-disabled third-party hook a full process`; `tests/org-policy/governed-hook-wiring.test.ts` — `refuses two hook writers into the client destination rather than dropping one` | semantic Core coverage retained. The deleted inventory row/ticker presentation assertions have no generic-browser equivalent. |
| `studio-hook-transparency` | Pinned hook behavior and ownership must be accurate | `hook-registrar.test.ts` — `proves verbatim reproduction by hash against the pinned launcher` and `never parses, wraps or re-emits a third-party command`; `tests/org-policy/ecc-hook-controls.test.ts` — `binds all reviewed source files and the exact 43-row, 42-gated active-pin inventory` | semantic evidence retained; source-specific disclosure copy is retired. |
| `studio-inventory-selection` | Generic select/deselect, exact pins, request intent, and import validation | `generic-journeys.spec.ts` — `keeps startup DOM bounded while groups, search, details, and keyboard navigation work at scale`; `tests/org-policy/workbench/selection-engine.test.ts` — `records an exact request pin without selecting a control`, `rejects malformed saved state and unknown exclusion mutations`; `tests/org-policy/workbench/policy-import.test.ts` — `migrates exact legacy sources and requests without inventing template ownership` | mapped. Source-owned rows and per-framework controls are retired. |
| `studio-inventory-surface` | Generic catalog visibility, next actions, and prepared details | `generic-journeys.spec.ts` — `keeps startup DOM bounded while groups, search, details, and keyboard navigation work at scale`; `tests/org-policy/studio-catalog-inventory.test.ts` — `embeds a small valid Core-prepared catalog for generic inventory wiring` | mapped for generic inventory behavior; old row-by-row framework presentation is retired. |
| `studio-ledger-identity` | Read-only detail and exact prepared identity | `tests/org-policy/workbench/evidence-display.test.ts` — `requires an exact immutable subject`; `journeys.spec.ts` — `opens offline and keeps exact prepared evidence separate from permission across expiry` | semantic identity/detail mapping retained. The paper/ink/layout and compact-rail assertions are retired visual contracts. |
| `studio-navigation-mcp-sidebar` | One generic search/detail path and request intent without installation claim | `generic-journeys.spec.ts` — `keeps startup DOM bounded while groups, search, details, and keyboard navigation work at scale`; `tests/org-policy/studio-aih-mcp-requests.test.ts` — `records exact pinned intent without selecting, activating, or evaluating it` | mapped. The ECC-specific left rail is retired. |
| `studio-owner-ticker` | Requested-state feedback must follow a selection mutation | `generic-journeys.spec.ts` — `keeps startup DOM bounded while groups, search, details, and keyboard navigation work at scale` (asserts `1 requested` after the action) | mapped only for generic request feedback. Per-owner source counts and source focus are retired. |
| `studio-profile-composition` | Template composition, conflicts, exclusions, and idempotent generic intent | `generic-journeys.spec.ts` — `expands templates, rejects methodology conflicts atomically, and preserves other origins on removal`; `selection-engine.test.ts` — `applies template roots and exclusions transactionally`, `rolls back an indirect methodology conflict`; `compile-policy.test.ts` — `requires zero or one distinct methodology regardless of source ownership` | mapped. Vibe and one-framework source-specific prose is retired. |
| `studio-relations` | Exact closure, shared prerequisites/cycles, optional exclusions, and origin-aware removal | `selection-engine.test.ts` — `retains the captured dependency pin and diagnoses a changed prerequisite`, `suppresses an excluded optional member but rejects a required exclusion`, `keeps a shared prerequisite when one of two roots is removed, including a cycle`, and `removes one origin while preserving the other exact root`; `tests/org-policy/workbench/policy-import.test.ts` — `requires an exact template digest for stale template removal` | mapped. Rail-specific rider descriptions are retired. |
| `studio-selection-provenance` | Direct and template origins remain independently removable | `selection-engine.test.ts` — `removes one origin while preserving the other exact root`; `generic-journeys.spec.ts` — `expands templates, rejects methodology conflicts atomically, and preserves other origins on removal` | mapped. Row badge order is retired. |
| `studio-surface-invariants` | Generic action inversion, bounded rendering, and requested/effective distinction | `generic-journeys.spec.ts` — `keeps startup DOM bounded while groups, search, details, and keyboard navigation work at scale`; `generic-journeys.spec.ts` — `keeps requests and local draft bytes separate from controls and effective permission`; `tests/org-policy/workbench/policy-consumption.test.ts` — `reports pinned request intent separately from effective candidates` | mapped for semantic invariants. Exact source-card/row layout rules are retired. |

## Retained source-specific tests that still carry obligations

The following files are not deleted in the current diff. They remain direct
coverage rather than replacement evidence:

- `tests/org-policy/studio-artifact-intake.test.ts`
  - `adds exact scanner bytes as a generic imported-evidence draft without browser verification`
  - `treats a forged verified scanner payload as opaque data and never grants approval`
  - `rejects authority and target claims at the non-authoritative intake boundary`
- `tests/org-policy/workbench/browser/generic-journeys.spec.ts` — `keeps requests and local draft bytes separate from controls and effective permission` preserves and re-exports imported evidence bytes, leaves organization approvals empty, hides the artifact approval action, and does not display the forged `Verified preflight` claim.
- `tests/org-policy/workbench/core/verified-evidence.test.ts`
  - `derives bounded scan facts from checked artifacts, with no qualification or organization permission`
  - `does not accept serialized custody, packaged provenance, or a verifier without bounded signing facts`
  - `fails closed on source, revision and content pin drift and never lends upstream scans to derived assets`
  - `expires fresh/cache summaries at the original download deadline without promoting old pass or qualification`

## V3 declaration and evidence custody successors

`authoringSources` is a separate exact organization-manifest transport, not a
browser draft and not scanner evidence. Its current direct coverage is
`tests/org-policy/workbench/authoring-sources.test.ts`:

- `carries only inputs referenced by pinned selections and removes them with the final root`
- `rejects missing, duplicate, unreferenced, mismatched-revision, and changed-byte inputs transactionally`
- `preserves stale source inputs through exact subtraction until the source has no remaining pins`
- `checks total source input capacity before reading nested envelopes`

The administrator routes are distinct: `tests/org-policy/generate.test.ts` has
`prepares one offline organization manifest before writing the portable
workbench`, `requires an applied administrator route and exact paired files for
fresh organization preparation`, and `runs a fresh organization manifest through
the production runner witness and emits exact evidence`. The optional offline
`--organization-manifest` route is declaration preparation only. Fresh
`--fresh-organization-manifest` plus `--fresh-artifact-intake` is the paired
applied scan route. Neither route treats saved raw scan bytes or opaque drafts as trusted evidence
or authority, and no public `aih policy author` command exists.

## Retained protected authoring set

`tests/org-policy/studio-protected-forms.test.ts` supplies eight current
protected-form regressions:

1. `authors an organization-qualified protected decision through fields accepted by Core`
2. `authors the exact AIH-supported qualification binding required by a signed receipt`
3. `refuses incomplete AIH-supported catalog binding without emitting a bundle`
4. `refuses inherited non-NFC custom source text without emitting a protected bundle`
5. `refuses protected authority while the ordinary posture remains Vibe`
6. `refuses a protected decision whose validity window exceeds 90 days`
7. `authors exact npm, PyPI, OCI, and remote provider identities`
8. `records distinct tool, skill, agent, MCP, and package decisions then revokes one`

The browser journey `authors a protected decision through ordinary fields` is an
additional generic form-to-preview check. It is not a substitute for the eight
unit regressions above.

## Deliberately unclaimed gap

- No named current test reproduces the deleted drawer suite's exact
  source-authored agent/skill/MCP narrative copy. That presentation contract is
  retired; any future generic-detail requirement should name the precise safe
  projection it needs rather than reintroduce source-specific DOM wording.