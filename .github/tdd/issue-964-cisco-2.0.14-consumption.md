# Issue #964 — consume Cisco 2.0.14 Scanner publications

## Contract

- Core accepts only Cisco analyzer identity `2.0.14+uvlock.aaba1f326049`.
- Publication provenance is pinned to Scanner protected-main commit
  `ba0f0bfc46f2634da71e125bf3bbcefb3493389c`.
- Release lookup is collision-free across publisher epochs:
  `baseline-v1-<publisher-commit>-<request-sha256>`.
- Core consumes verified publication bytes without executing analyzers.

## RED

```text
npm exec vitest run -- tests/workflows/scanner-baseline-publication.test.ts tests/baseline-evidence/package.test.ts tests/baseline-evidence/analyzer-profile.test.ts tests/internals/external-pin-ledger.test.ts

Test Files  4 failed (4)
Tests       5 failed | 35 passed (40)
```

The old Core contract still required Cisco 2.0.13, the old Scanner publisher commit, the
request-only release tag, and the old wheel digest.

## GREEN

```text
npm exec vitest run -- tests/workflows/scanner-baseline-publication.test.ts tests/baseline-evidence/package.test.ts tests/baseline-evidence/analyzer-profile.test.ts tests/internals/external-pin-ledger.test.ts

Test Files  4 passed (4)
Tests       40 passed (40)
```

During real publication consumption, two additional red gates exposed gaps in the old
single-publication path:

```text
scanner-publication.test.ts: mutable or unexpected locator
scanner-publication.test.ts: publication freshness (subsecond consumer clock)
scanner-cli.test.ts: expected request, consume-publication, or assemble
```

The implementation now binds discovery to the publisher-qualified locator, floors only the
reported age after enforcing the exact millisecond freshness boundary, and consumes a closed,
contiguous set of independently attested batches. Focused proof:

```text
npm exec vitest run -- tests/workflows/scanner-baseline-publication.test.ts tests/baseline-evidence/package.test.ts tests/baseline-evidence/scanner-cli.test.ts tests/baseline-evidence/scanner-publication.test.ts tests/baseline-evidence/scanner-consumer.test.ts

Test Files  5 passed (5)
Tests       28 passed (28)

npm exec vitest run -- tests/trust/scan.test.ts tests/skill/vet.test.ts tests/trust/cisco-shards.test.ts tests/binding/scan-cache-tiers.test.ts tests/baseline-evidence/scanner-cli.test.ts

Test Files  5 passed (5)
Tests       233 passed (233)

npm run typecheck
tsc --noEmit (exit 0)
```

The protected Scanner run completed and Core consumed all five ECC publications plus the
Superpowers publication. The resulting vendor lock contains 411 ECC and 15 Superpowers
components; the regenerated ECC install preview is byte-identical to the committed preview.

Final modified-area proof:

```text
npx vitest run <14 modified-area files> --maxWorkers=1

Test Files  14 passed (14)
Tests       306 passed (306)

npm run check:baseline-analyzers
npm run check:native-identity
npm run check:baseline-pins

All three gates passed.
```

`npm run verify` reached the full coverage suite after every preceding gate passed. Under the
parallel Windows coverage load, 16 timeout-only failures remained across 11 stress/integration
files (`8647 passed`, `46 skipped`); the changed Scanner consumer file passes in the serial
modified-area run above. Cross-platform CI is the authoritative aggregate gate.
