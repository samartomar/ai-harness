# Issue #955 — focused CI graduation evidence

## Decision and scope

The owner approved graduating the deterministic selector after asking that Core and Workbench changes
stop paying for unrelated test surfaces. This change preserves the existing protected context names
and their fail-closed behavior. It changes which underlying test job those contexts require:

- bounded changes run the exact selected domain on the receipt's operating systems;
- Workbench source changes run the complete 37-file Workbench project;
- global, unknown, selector-control, schema, fixture, dependency, and workflow inputs run the complete
  Ubuntu coverage, macOS, and sharded Windows fallback;
- static quality and build checks run for every change;
- protected-main pushes classify the merged delta again, preserving exact-SHA release qualification.

Workbench DOM test redesign is deliberately outside this PR. Graduation removes unrelated suites;
the later optimization reduces the cost inside the Workbench lane.

## RED and GREEN report

After installing the lockfile into the clean worktree, the RED command was:

```text
npx vitest run tests/internals/ci-impact.test.ts tests/release-readiness.test.ts tests/self-hosting/self-hosting.test.ts --maxWorkers=2 --testTimeout=15000
```

It failed five intended assertions: Workbench source still selected unrelated org-policy tests, the
authoritative selected job did not exist, complete jobs were unconditional, and the protected-context
fan-in still represented only Windows. The implemented contract then passed 70 tests across those
three files plus `tests/internals/ci-lane-gate.test.ts`. The executable lane-gate tests reject failed,
cancelled, skipped, missing, contradictory, and unsupported result combinations.

## Replay and live pilot

The current selector was replayed over the latest 25 first-parent merges using each adjacent commit
pair and the repository's tracked test inventory:

| Verdict | Merges | Selected files and operating systems |
|---|---:|---|
| complete fallback | 16 | 497 files on Ubuntu, macOS, and Windows |
| bounded cross-platform | 7 | 2–89 files on all three operating systems |
| focused Core | 2 | 8 or 37 files on Ubuntu |

The fail-closed majority reflects dependency, workflow, schema, fixture, tool, selector, and unknown
inputs. No replay produced an empty source-domain selection. The Workbench ownership assertion also
compares the selector result to the live Vitest project and proves all 37 files are selected with no
unrelated catalog test.

The live shadow pilot supplied both paths:

| Pull request | Selected evidence | Complete evidence |
|---|---:|---:|
| #953, bounded Core | Ubuntu 24s | Ubuntu 9m28s; macOS 6m16s; Windows 5m31s and 6m14s |
| #954, global fallback | setup/fallback 14–32s | Ubuntu 10m01s; macOS 10m08s; Windows 5m02s and 6m02s |

Both selected and complete observations were deterministic and green. Pull-request concurrency had
already proved that superseded revisions cancel rather than queue behind stale work.

## Coverage and remaining risk

The global coverage thresholds remain unchanged and execute before merge whenever classification
falls back to complete. The scheduled five-way nightly matrix still executes the complete suite, with
coverage on Ubuntu Node 22. A bounded lane does not claim a global percentage from a partial run; it
runs its complete selected ownership set instead. This removes no tests from the repository and does
not weaken any configured coverage threshold, but a selector defect could defer an unrelated missed
regression to nightly. The fail-closed path rules, exact 37-file Workbench ownership assertion, receipt
validation, and protected fan-in tests bound that risk.

The complete local coverage rerun used the authoritative two-worker envelope after the default
eight-worker Windows run reproduced the known filesystem-contention failure. It passed 494 files with
4 skipped and 8,660 tests with 46 skipped in 914.90 seconds. Coverage remained above every configured
floor: 90.55% statements, 83.44% branches, 96.38% functions, and 93.07% lines.
