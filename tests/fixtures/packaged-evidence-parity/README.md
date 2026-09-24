# Packaged-evidence parity fixtures

Shared acceptance fixtures for `packaged-scanner-collection-evidence/v1` records (decision D25).
The same JSON files, byte-identical, live in `@aihq/catalog` at
`tests/fixtures/packaged-evidence-parity/`; change both copies together.

Each file names one case and its two expected outcomes:

- `structure`: the record's structural validation, which Core
  (`PackagedScannerCollectionEvidenceStructureV1Schema`) and Catalog
  (`parsePackagedScannerCollectionEvidenceV1`) apply identically.
- `coreAdmission`: Core's publisher admission on top of that (the reviewed publisher identity and
  commits, `PackagedScannerCollectionEvidenceRecordV1Schema`). Admission is Core's alone; Catalog
  is a carrier and never admits a record.

Core test: `tests/org-policy/workbench/packaged-evidence-parity.test.ts`.
