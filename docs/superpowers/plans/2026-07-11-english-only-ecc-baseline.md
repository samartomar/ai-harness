# English-only ECC baseline implementation plan

> Execute TDD-first on `fix/417-required-baseline-analyzers`. The governing design is
> `docs/superpowers/specs/2026-07-11-english-only-ecc-baseline-design.md`.

## Task 1: Lock the supported module contract in tests

**Files:**

- Modify: `tests/baseline-evidence/catalogs.test.ts`

1. Change the expected ECC module component count from 32 to 23.
2. Assert exact module order equals the pinned `full` profile order.
3. Assert no catalog component id starts with `module:docs-` and no component path starts
   with `docs/`.
4. Remove locale modules from the list expected to carry `skillContent`.
5. Run the focused test and record the RED mismatch before implementation.

## Task 2: Derive catalog modules from the pinned full profile

**Files:**

- Modify: `src/baseline-evidence/catalogs.ts`
- Test: `tests/baseline-evidence/catalogs.test.ts`

1. Import the pinned profile snapshot alongside the complete module snapshot.
2. Build an id-indexed module map; reject duplicate module ids.
3. Resolve `profiles.full.modules` in order; reject duplicate profile ids or references to
   modules absent from the snapshot.
4. Construct ECC module evidence components only from that resolved list.
5. Keep runtime, direct-skill, common-agent, and Superpowers components unchanged.
6. Run catalog, evidence-selection, analyzer-profile, and analyzer-gate tests GREEN.

## Task 3: Reconcile public and private canon

**Files:**

- Modify: `CHANGELOG.md`
- Modify: `docs/security/baseline-evidence.md`
- Modify: `docs/superpowers/specs/2026-07-11-v2-9-field-findings-design.md`
- Modify: `docs/superpowers/plans/2026-07-11-required-baseline-analyzers.md`
- Modify in private companion: `decisions/DECISION-LOG.md`, a dated `inbox/ideas/` source
  note, `CURRENT.md`, and `NEXT.md`

Document that English-only is a support boundary, not an analyzer waiver. Preserve the full
vendor snapshot and the later explicit-locale extension path. Run public docs lint and private
`tools/check-docs.ps1`.

## Task 4: Regenerate and verify evidence

**Files:**

- Modify: `src/baseline-evidence/vendor-lock.json`
- Modify if deterministic output changes: `src/baseline-evidence/ecc-install-preview.json`

1. Run `npm run baseline:vet` against
   `samartomar/ECC@16563d4a30f17d097cc4629f6d97e02adf823016` and
   `obra/Superpowers@d884ae04edebef577e82ff7c4e143debd0bbec99`.
2. Confirm the lock has 23 ECC module components, zero locale components, and complete
   analyzer receipts for every applicable supported component.
3. Run `npm run check:baseline-analyzers`, `npm run check:baseline-installable`, and
   `npm run baseline:check -- --ecc-root <exact> --superpowers-root <exact>`.
4. Run focused tests, `npm run verify`, built CLI smoke, `npm audit`, diff/security review,
   and refreshed code-review-graph impact.

## Task 5: Finalize #417 and resume the cut

1. Push the final branch and open one finalized PR referencing #417; do not request the
   independent review before the exact final head and CI are green.
2. Give Samar the Fable/max-reasoning review prompt focused on catalog/install parity,
   complete analyzer receipts, projection safety, detector exit handling, environment
   isolation, reproducible pins, generated evidence, and English-only scope enforcement.
3. Address findings, rerun gates, and merge on approval.
4. Refresh `release/v2.9.0` from main, regenerate native receipts as 2.9.0, and complete the
   release PR/publication flow only through the standing human gates.
