# Issue #950 — Core and Workbench CI lane evidence

## Source and journeys

The journeys were derived during the TDD run for issue #950.

- As a Core contributor, I want Workbench-only changes classified separately so unrelated Core tests are not implied by the change.
- As a Workbench contributor, I want the complete Workbench behavior and its own coverage ratchet retained in one bounded lane.
- As a maintainer, I want ambiguous or global changes to fail closed to the complete matrix.
- As a reviewer, I want selected-test replay to remain advisory until hosted evidence supports graduation.

## RED and GREEN report

The RED checkpoint is commit `02b405cc` (`test: define CI test lane ownership`).
Running `npx vitest run tests/internals/ci-impact.test.ts` executed the new contract and produced 17 intended failures because the receipt did not yet contain a test-lane decision.

The implementation checkpoint is commit `25fe600e` (`feat(ci): classify Core and Workbench test lanes`). The coverage-project checkpoint is commit `d46a335a` (`test(ci): establish Core and Workbench coverage lanes`), followed by the fail-closed configuration checkpoint `5a32bbe2` (`fix(ci): treat lane configs as global inputs`).

`npx vitest run tests/config/coverage-policy.test.ts tests/internals/ci-impact.test.ts tests/internals/staged-check.test.ts` passed 33 tests after implementation. `npm run typecheck` also passed.

## Test specification

| # | What is guaranteed | Test or command | Type | Result | Evidence |
|---|---|---|---|---|---|
| 1 | Workbench-only, Core-only, shared, documentation, and full-fallback changes produce the declared lane | `tests/internals/ci-impact.test.ts` | unit/contract | PASS | Focused regression run, 33 total tests across the three focused files |
| 2 | Core and Workbench test-file selections contain all 498 tests with no overlap | Vitest list comparison for both lane configs | configuration | PASS | Core 461 files; Workbench 37 files; overlap 0 |
| 3 | Workbench source coverage has an independent non-zero ratchet | `npm run test:workbench:cov -- --maxWorkers=2 --testTimeout=15000` | coverage | PASS | 37 files, 375 tests, 246.80s; statements 89.54%, branches 80.64%, functions 94.44%, lines 92.44% |
| 4 | Non-Workbench Core coverage has an independent non-zero ratchet | `npm run test:core:cov -- --maxWorkers=2 --testTimeout=15000` with a 4 GiB Node heap | coverage | PASS | 457 files passed and 4 skipped; 8,299 tests passed and 46 skipped; 721.63s; statements 90.31%, branches 83.21%, functions 96.17%, lines 92.83% |
| 5 | Lane configuration and selector changes cannot select their own reduced gate | `tests/internals/ci-impact.test.ts` | fail-closed contract | PASS | Both lane configs and selector-control paths return the full lane |
| 6 | Advisory selected-test replay cannot fail the required PR fan-in | `tests/release-readiness.test.ts` and workflow inspection | workflow contract | PASS | Shadow job is continue-on-error and absent from `pr_gate.needs` |
| 7 | A newer pull-request revision cancels the superseded CI run | workflow contract tests | workflow contract | PASS | Pull-request concurrency is declared with cancel-in-progress enabled only for pull requests |

## Coverage, timing, and known gaps

The two lane coverage runs preserve more than 80% for every metric. The Workbench lane needs a 4 GiB Node heap on the measured Windows host; its first default-heap run exhausted memory, which is why the existing authoritative CI heap remains unchanged.

The Core measurement used two workers after an eight-worker experiment caused unrelated filesystem-heavy tests to cross fixed timeouts. That experiment was rejected rather than weakening global timeouts.

The required CI jobs still run the complete suite. This change creates a measured, auditable shadow contract; it does not graduate selected lanes into branch protection. Hosted Ubuntu/macOS/Windows observations and the follow-up baseline/other-Core cost investigation remain required before graduation.

Scanner ownership and immutable baseline-evidence publication are tracked separately in issue #919. The Core baseline-evidence slice measured 31.96 seconds under coverage, so it is a useful ownership cleanup but cannot explain most of the 721.63-second Core lane.
