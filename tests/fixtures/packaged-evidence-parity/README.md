# Packaged-evidence parity fixtures

Shared acceptance fixtures for `packaged-scanner-collection-evidence/v1` records (decision D25).
The same JSON files, byte-identical, live in `@aihq/catalog` at
`tests/fixtures/packaged-evidence-parity/`; change both copies together.

Each file names one case and its two expected outcomes:

- `structure`: the record's structural validation, which Core
  (`PackagedScannerCollectionEvidenceStructureV1Schema` on a value,
  `readPackagedScannerCollectionEvidenceStructureV1` on sealed bytes) and Catalog
  (`parsePackagedScannerCollectionEvidenceV1`) apply identically.
- `coreAdmission`: Core's publisher admission on top of that (the reviewed publisher identity and
  commits, `PackagedScannerCollectionEvidenceRecordV1Schema`). Admission is Core's alone; Catalog
  is a carrier and never admits a record.

A file carries either `record`, a record value that each side's test seals as its canonical bytes,
or `bytes`, the exact sealed record text, for strict-JSON cases a value cannot express (a duplicate
key, a byte order mark, trailing data, number spellings, a raw lone surrogate, a `__proto__`
member, nesting past the shared bound of 32 levels).

Core test: `tests/org-policy/workbench/packaged-evidence-parity.test.ts`.
