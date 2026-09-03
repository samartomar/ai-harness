# Issue #952 — Scanner/Core baseline refresh separation

## Source and journeys

The journeys were derived during the TDD run for issue #952 and the measured
follow-up recorded on issue #919.

- As a maintainer, I want Scanner to be the only supported baseline refresh
  executor so execution custody has one implementation.
- As a Core contributor, I want catalog policy, signed-result verification,
  interpretation, and install authorization to remain in Core.
- As a release operator, I want the existing request/execute/consume/assemble
  workflow to remain fail-closed while obsolete Core orchestration is removed.
- As a reviewer, I want the ownership correction distinguished from the larger
  immutable-publication work in #919 and from the primary CI-speed work in #950.

## RED and GREEN report

The RED checkpoint added `does not retain a second baseline refresh executor
inside Core` to `tests/baseline-evidence/package.test.ts`. Running
`npx vitest run tests/baseline-evidence/package.test.ts --maxWorkers=2
--testTimeout=15000` produced the intended failure because Core still contained
`generate.ts`, `shard.ts`, and `ecc-preflight-receipt.ts`. The repository's
pre-commit hook correctly refused to record that known-red state.

The GREEN checkpoint is commit `dad4fd84` (`refactor(baseline): retire Core
refresh orchestration`). It deletes only the unreferenced Core refresh, shard,
and transport-preflight implementation and their executor-only tests. Scanner
request authoring, signed batch consumption, Core policy interpretation, ECC
preview authorization, the local compatibility vet command, and runtime
authorization remain.

## Test specification

| # | What is guaranteed | Test or command | Type | Result | Evidence |
|---|---|---|---|---|---|
| 1 | Core cannot silently regain a second refresh or shard executor | `tests/baseline-evidence/package.test.ts` | architecture contract | PASS | The three retired source paths must be absent |
| 2 | Core still authors exact bounded requests and verifies signed Scanner batches before interpretation | `tests/baseline-evidence/scanner-consumer.test.ts` | unit/security | PASS | Included in the 5-file replacement-boundary run |
| 3 | The request/consume/assemble CLI bridge retains custody checks and the authorized preview boundary | `tests/baseline-evidence/scanner-cli.test.ts` and `tests/baseline-evidence/ecc-preview-boundary.test.ts` | unit/integration | PASS | 5 files, 49 tests passed in 10.71s |
| 4 | The complete remaining baseline evidence domain stays green | `npx vitest run tests/baseline-evidence --maxWorkers=2 --testTimeout=15000` | domain regression | PASS | 28 files; 308 passed and 2 skipped in 22.64s |
| 5 | Removing dead execution code creates no Core coverage gap | `npm run test:core:cov -- --maxWorkers=2 --testTimeout=15000` with a 4 GiB Node heap | coverage | PASS | 454 files passed and 4 skipped; 8,256 tests passed and 46 skipped; 706.07s; statements 90.40%, branches 83.26%, functions 96.21%, lines 92.92% |
| 6 | The remaining module graph and release build compile | `npm run typecheck` and `npm run build` | static/build | PASS | Both commands exited 0 |
| 7 | Code and current control documentation remain valid | `npm run lint:ci`, `npm run docs:lint`, and `git diff --check` | quality/docs | PASS | Lint exited 0 with 33 pre-existing warnings; docs lint and diff check exited 0 |

## Scope and remaining work

This change removes 1,858 obsolete lines but is not presented as the main CI
speed improvement. Before deletion, the entire baseline-evidence slice measured
about 32 seconds under coverage; Workbench DOM execution and the full Core suite
remain the material costs.

Issue #919 remains open for independent immutable Scanner evidence publication,
discovery, and Core consumption. The public `aih evidence vet-baseline` command
also remains until an equivalent cross-platform Scanner delegation can replace
it without breaking compatibility.
