# Issue #957 — Workbench DOM amplification evidence

## Goal and boundary

The 37-file Workbench project is an authoritative focused CI lane, but one catalog-wide DOM test
made that lane too slow for useful iteration. This change reduces the test algorithm's cost without
changing product source, removing a catalog assertion, raising a timeout, shrinking the Workbench
project, or lowering its independent coverage thresholds.

`tests/org-policy/studio-surface-invariants.test.ts` previously rediscovered a detail button by
querying every matching element for each of roughly 726 catalog narration checks. It also repeated
the same host and capability event-handler round trip for every catalog entry. The replacement:

- indexes the stable detail controls once per rendered window;
- proves every narrated catalog identity resolves to a detail control;
- proves the authored policy contains every narrated selected asset;
- exercises baseline and selected narration once for every distinct asset kind; and
- compares every host, control, composition part, and capability DOM identity to the complete model,
  then round-trips representative values through each generic event handler.

The assertions therefore remain catalog-wide where data can differ and representative where the
same handler and branches were being rerun with a different string identity.

## Same-PC before and after

Measurements used Node 22 and Vitest 4.1.11 on the same Windows PC with a 4 GiB Node heap. The
untouched baseline came from commit `7b04ba71`; the optimized branch was rebased onto #956 before
final verification.

| Command or test | Before | After | Result |
|---|---:|---:|---:|
| `studio-surface-invariants.test.ts` | 47.95 s | 18.86 s | 60.7% faster |
| catalog narration assertion | 24.87 s | 2.35 s | 90.6% faster |
| complete `npm run test:workbench` | 75.13 s | 63.49 s | 15.5% faster |
| complete `npm run test:workbench:cov` | 94.34 s | 78.19 s | 17.1% faster |

Both complete runs passed all 37 files and all 375 tests. Wall time gains are smaller than the
isolated-file gain because Vitest runs other DOM-heavy files concurrently; after this correction,
those files form more of the critical path.

## Coverage proof

The untouched baseline and optimized branch produced the exact same production coverage counts:

| Metric | Before | After | Required floor |
|---|---:|---:|---:|
| Statements | 89.54% (274/306) | 89.54% (274/306) | 89% |
| Branches | 80.64% (225/279) | 80.64% (225/279) | 80% |
| Functions | 94.44% (68/72) | 94.44% (68/72) | 94% |
| Lines | 92.44% (257/278) | 92.44% (257/278) | 92% |

This is exact no-loss evidence, not merely a pass against unchanged thresholds.

## Residual cost

The next measured bottleneck is no longer the 426-item narration loop. In the post-change verbose
run, the single `supported-cli-subsets.test.ts` DOM assertion that authors single-, two-, and all-CLI
policies took 10.66 seconds. `studio-relations.test.ts`, `studio-dependency-closure.test.ts`, and
`generate.test.ts` also accumulate many one-to-four-second whole-window interactions. Those are
separate optimization candidates: they should be reduced only after proving their pure policy/model
contracts cover the removed repetition and after repeating this same exact coverage comparison.
