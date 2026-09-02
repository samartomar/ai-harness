# Issue #934 enterprise delivery governance — TDD evidence

Date: 2026-09-02

Issue: [#934](https://github.com/samartomar/ai-harness/issues/934)

Classification: `semver:none`

The pre-change timing and failure sample is recorded in
[issue-934-ci-baseline.md](issue-934-ci-baseline.md).

## Red / green progression

1. CI impact selection began with `tests/internals/ci-impact.test.ts`. The red run failed because
   `src/internals/ci-impact.js` did not exist. The green run proved deterministic receipts,
   docs/focused selection, cross-platform escalation, and complete-suite fallback for unknown,
lockfile, workflow, schema, fixture, selector, and global-tooling changes.
2. Enterprise release governance began with `tests/release/delivery-governance.test.ts`. The red run
   failed because `src/internals/delivery-governance.js` did not exist. The green run proved complete
   release-surface disposition, evidence requirements, cumulative manifest chains, mechanical
   release-preparation limits, qualification matrices, exact owner authorization, candidate
   invalidation, exact public installed acceptance, and separate promotion authorization.
3. Staged feedback began with `tests/internals/staged-check.test.ts`. The red run failed because
   `src/internals/staged-check.js` did not exist. The green run proved that the hook excludes the
   complete suite and coverage, includes documentation checks when needed, uses bounded contract
   fallback for high-risk changes, and stops at the first failed gate.
4. Workflow topology assertions in `tests/release-readiness.test.ts` were changed before the workflow
   rewrite. The red run rejected the missing installed-acceptance workflow and the old tag-to-publish
   topology. The green run proved separate tag qualification, publication dispatch, exact installed
   acceptance, and read-only promotion authorization wiring.
5. Cumulative enterprise review was added test-first. The red run failed on a missing
   `buildCumulativeEnterpriseDelta`; the green run proved ordered multi-release aggregation and
   rejection of an incomplete version chain.
6. The first real staged execution exposed `spawn npm ENOENT` on Windows because the shared process
   runner intentionally does not invoke command-shell shims. A regression test now supplies paths
   containing spaces and proves every package command executes the absolute npm CLI through the
   absolute Node executable, with no `npm`, `npm.cmd`, `npx`, or `npx.cmd` spawn.
7. The first commit-hook execution exposed GNU tar treating the release-readiness fixture's absolute
   Windows archive path as a remote host. The fixture now emits the archive through a
   working-directory-relative portable path; the same hook path proves it before every commit.
8. External review exposed a branch-name-only release-preparation guard and an unbound tracker
   repository during candidate invalidation. Regression tests now require a content-derived release
   signal regardless of branch name and reject any manifest, qualification, authorization, or state
   lookup whose tracker differs from the repository executing the workflow.

## Focused green checkpoint

The combined focused checkpoint passed 47 tests across the four new or amended suites. After the
workflow and hook contract assertions were brought forward, the checkpoint passed 72 tests across
six suites. Review hardening added eight regression cases; the post-review focused checkpoint passed
80 tests across the same six suites. TypeScript completed with no errors after the hardening changes.

The complete 497-file coverage run passed 8,617 of 8,684 tests and exposed 21 failures. Two were
stale assertions for the intentionally changed release trigger and pre-commit hook and were corrected
test-first. The other 19 were filesystem or child-process timeouts in untouched suites under parallel
Windows load. Those 12 affected files completed 280 cases when rerun serially: 276 passed and four
existing cases were skipped. The three projected-runtime assertions used a verified temporary root
without an ancestor `node_modules`, as their isolation contract requires.

The post-review `npm run verify` passed every pre-coverage gate, including artifact checks,
self-hosting canon, documentation lint, packed-document links, typecheck, and CI lint. Its parallel
Windows coverage phase passed 8,638 tests, skipped 46, and timed out or encountered shared-temporary-
root contamination in nine cases across six untouched files. Rerunning only those six files with one
worker and a clean isolated temporary root passed all 170 tests in 112 seconds.

Build, published CLI and library checks, packed administrator-document verification, and the cold
packed organization-managed lifecycle all passed. The final dependency audit also discovered a new
high-severity advisory in the development-only `ajv` to `fast-uri` chain. The lock was narrowly
advanced from `fast-uri` 3.1.5 to 3.1.7, after which `npm ci` and `npm audit --audit-level=high`
reported zero vulnerabilities.

## Deliberate rollout hold

The impact selector is implemented and evidenced but remains shadow-only. Existing complete CI checks
remain authoritative until a later reviewed decision accepts representative replay evidence. This is
a fail-closed rollout boundary, not an incomplete test exemption.
