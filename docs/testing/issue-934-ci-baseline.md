# Issue #934 CI baseline

Observed: 2026-09-02 UTC. This is a bounded pre-change sample, not a service-level target.

## Sample

The twelve most recent `ci.yml` runs at observation contained seven pull-request runs and five
protected-main runs. Four successful pull-request runs completed in 9m20s, 9m21s, 9m32s, and 9m35s
(median 9m26.5s). Successful protected-main examples completed in 9m22s and 13m57s. One protected-main
run waited about 17m15s before jobs started, demonstrating that queue time can dominate execution time.

Evidence:

- [PR run 33586125189](https://github.com/samartomar/ai-harness/actions/runs/33586125189)
- [PR run 33573323191](https://github.com/samartomar/ai-harness/actions/runs/33573323191)
- [main run 33617138515](https://github.com/samartomar/ai-harness/actions/runs/33617138515)
- [queued main run 33571635269](https://github.com/samartomar/ai-harness/actions/runs/33571635269)

The sampled release-documentation change ran the complete cross-platform PR matrix and then the
complete protected-main matrix after merge. That is the duplicated integration work #934 separates
from fast feedback. The new selector remains shadow-only, so this change does not yet claim measured
CI savings.

## Observed failure signatures

- [Run 33569930135](https://github.com/samartomar/ai-harness/actions/runs/33569930135) recorded five
  Ubuntu timeouts, including several 5-second DOM/policy tests and one 60-second surface-invariant
  test, while macOS and Windows completed many neighboring tests. Treat these as contention/flake
  candidates for replay evidence; do not silently waive them.
- [Run 33572836461](https://github.com/samartomar/ai-harness/actions/runs/33572836461) consistently
  rejected a capability catalog that still required Core `^0.4.0` after the 0.5.0 preparation. This
  was a concrete version-contract defect, not a flake.
- [Run 33576395897](https://github.com/samartomar/ai-harness/actions/runs/33576395897) consistently
  failed the same ECC hook-control assertion on Ubuntu, macOS, and Windows. This was a concrete test
  expectation defect, not a platform-only flake.

## Pilot measurements

Shadow receipts retain selector version, exact base/head SHAs, changed paths, matched rules, selected
tests, operating systems, risk class, the content-derived release-preparation signal, and fallback
reasons. A later review can compare them with the
authoritative complete runs for:

- missed failures and false negatives;
- full-suite fallback rate and unknown-path causes;
- selected-test precision and operating-system escalation;
- queue time, execution time, and time to first useful failure;
- cancellation and contention signatures.

No threshold or rollout date is inferred from this small baseline. Branch protection must not change
until representative live and replay evidence supports an explicit owner decision.
