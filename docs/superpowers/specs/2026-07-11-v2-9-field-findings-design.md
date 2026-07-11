# v2.9.0 Field-Findings Remediation Design

**Status:** Approved for implementation on 2026-07-10

**Issues:** #417, #418, #419, #420, #421, #422, #423, #424

## Goal

Resolve the eight findings from the v2.8.0 consumer-seat report without weakening
the locked trust model. The result must make the shipped default ECC baseline
install useful components at vibe, team, and enterprise posture from its own
signed evidence, preserve danger-class floors, keep the component registration
ledger truthful, and make release escalation acknowledgement attributable.

The expected cut is a semver-minor v2.9.0 release. Release policy still computes
and assigns the version at cut time from merged-PR labels.

## Non-goals

- Do not make every ECC component green. In particular, auto-executing hook
  components may remain held at enterprise posture.
- Do not add hooks-runtime to common-baseline v1.
- Do not add a second documentation-versus-instruction classifier.
- Do not make danger-class findings acknowledgeable.
- Do not describe the release escalation artifact as automation-proof.
- Do not allow a partially failed prune to advance the registration ledger.
- Do not mutate the real development-seat HOME in tests or release validation.
- Do not combine the eight issue contracts into one implementation PR.

## Delivery shape and dependency order

Each issue lands through one independently reviewed PR with its own red-to-green
tests and `[Unreleased]` CHANGELOG entry. #417 is opened first with the failing
v2.8.0-lock regression and merged last as the integration gate. It carries the
`release-blocker` label so the open issue mechanically blocks a premature cut.

The implementation and merge sequence is:

1. Open #417 in RED against the exact v2.8.0 vendor lock.
2. #422 pins legal-text posture behavior.
3. #419 fixes sandbox-smoke unavailability classification.
4. #418 improves detector precision and fingerprint strength.
5. #420 partitions component authorization and installs the passing subset.
6. #423 makes prune removal and ledger reconciliation one honest transaction.
7. #424 binds escalation acknowledgement to a GitHub comment artifact.
8. #421 closes cleanup, progress-channel, bounded-inventory, and dry-run gaps.
9. Rebase and finish #417: vet the selected ECC pin, regenerate signed evidence,
   and pass real fixture-HOME installs at all three postures.

#417 depends directly on #418, #419, #420, and #422. It merges after all other
slices so its release-gate fixture validates the final train behavior, not an
intermediate implementation.

## Trust verdict corrections

### #422: legal-text posture policy

The maintainer ruling is binding:

| Posture    | Unacknowledged legal-text detector finding | Exact fingerprint + reason         |
| ---------- | ------------------------------------------ | ---------------------------------- |
| vibe       | pass with warning                          | pass with acknowledgement evidence |
| team       | fail                                       | pass                               |
| enterprise | fail                                       | pass                               |

This is a legal-text-specific trust-origin policy. It must not change the handling
of other `TRUST_ORIGIN_CODES`, and it must not route any danger-class finding
through posture grading. The existing acknowledgement validator remains the
authority for exact fingerprint selection and the non-empty reason requirement.

Tests cover all three postures, missing reason, stale fingerprint, and unchanged
danger-class behavior. CLI and security documentation must describe the same
matrix.

### #419: sandbox-smoke capability gaps

`trust.sandbox-smoke-unavailable` describes the host, not the acquired content.
When the sandbox runtime or capability is absent, emit a recorded skip with a
warning detail at every posture. A skip is evidence and remains visible in human
and JSON output; it is not rewritten as a detector pass.

Only a smoke test that actually starts on a capable host and returns a failing
result emits a blocking failure. Tests distinguish unavailable, successful, and
failed execution at vibe, team, and enterprise.

### #418: instruction-surface authority and finding identity

Reuse `isStrictUnicodeSurface` from `src/trust/lint.ts`, the classifier shipped
with #375. All native and external-detector adapters must consult that authority;
no new documentation classifier or parallel path taxonomy is introduced.

On non-strict reviewable documentation surfaces, the visible-Unicode detector may
allow decorative emoji, arrows, and box-drawing characters. Bidi controls,
zero-width/default-ignorable characters, tag characters, and homoglyph
confusables remain strict on every surface. Instruction, agent, command, config,
and executable surfaces remain strict for every Unicode category.

Agent role-definition language may be excluded from prompt-injection findings only
on a non-strict surface and only for the narrow role-assignment pattern. Classic
instruction override, secret-exfiltration, and jailbreak patterns remain blocking.
The field fixtures must pass while seeded malicious phrases still fail.

Finding fingerprints become content-bound and retain the complete 64-hex SHA-256
digest. The identity binds code, normalized safe path, detector/rule identity,
exact finding text or line content, and a stable occurrence index when identical
findings repeat in one file. Line number remains advisory display metadata and is
not part of acknowledgement identity, so a change to the finding invalidates an
old acknowledgement while an unrelated line insertion does not. External SARIF
adapters use the same identity builder after URI sanitization.

## #420: partial component authorization and install

### Partitioned gate result

Baseline verification returns a stable partition instead of throwing on the first
failed component:

- `authorized`: component plus its vendor/org authorization receipt;
- `held`: component ID plus every blocking finding code and remediation detail;
- `checks`: the complete ordered evidence stream, including skips and warnings.

Unknown components, invalid catalogs, invalid signatures, vendor-lock hash drift,
source-root safety failures, or evidence schema failures remain whole-request
failures because the partition itself cannot be trusted. Ordinary component
verdict failures hold only those components.

If no requested component is authorized, the command exits non-zero with a stable
held-component report and plans no install action. If at least one component is
authorized, the install phase receives only that subset and reports the held set
without hiding it.

### Runtime authorization

`runtime:ecc-installer` is executable content, not trusted plumbing. No
`install-apply.js`, installer library, package install, or equivalent upstream
runtime step may run unless `runtime:ecc-installer` has a valid authorization for
the exact pinned source. The Kiro runtime has the corresponding
`runtime:ecc-kiro` rule.

When an authorized runtime applies content, the materialization selection is
intersected with authorized component IDs before operations are constructed.
Held modules, skills, and agents never reach the upstream driver. Targets that can
be materialized by aih directly follow the same intersection and may not use a
held helper runtime as an implementation shortcut.

### Ledger and output

The registration ledger records only components actually installed on each
target, including the exact evidence-tier receipt already defined by v2.8.0. The
project registration may retain its desired contribution so a later authorized
reconcile can complete it, but target records are the truthful installed surface.
Held component IDs and codes appear in the human digest and structured JSON.

Prune and reconcile operate from the partial target records. A mixed fixture must
install the authorized baseline, hold hooks-runtime at enterprise, prune an
orphaned authorized component correctly, and never claim the held hook component
was installed.

## #423: prune transaction and explicit divergence

All aih-owned per-target removal writes move into the existing rollback-safe,
ledger-last reconciliation driver. Planning still validates every target and
computes all next bytes before mutation. Apply then:

1. verifies ledger, target-state, and managed-file preflight hashes;
2. creates recovery material for every aih-owned mutation;
3. performs aih-owned removals and managed-block rewrites;
4. runs any unavoidable upstream target uninstall;
5. writes reconciled target state;
6. replaces the registration ledger last.

Failures in aih-owned mutations roll back completely. If an upstream uninstall is
not transactional and mutates before returning failure, the command returns an
explicit divergence error naming the target and affected paths/state. It does not
write the next ledger or imply rollback succeeded. A subsequent prune can use that
target-named evidence for recovery; no silent mismatch is acceptable.

Multi-target failure tests assert either byte-identical rollback or the explicit
divergence result, and always assert that the ledger was not advanced.

## #424: attributable release-escalation artifact

The existing deterministic token remains bound to candidate SHA, declared intent,
and computed bump. An upward escalation additionally requires a public comment on
the release tracker containing that exact token.

Release preflight resolves and validates the comment through GitHub using the
repository and tracker already established by release policy. The accepted
artifact must bind and record:

- repository and release-tracker issue;
- comment URL and immutable comment identifier;
- comment author and the authority used to accept that author;
- comment creation timestamp;
- full candidate SHA, declared intent, computed bump, and exact token.

A token pasted on another issue, another repository, by an unauthorized identity,
or for different release inputs is rejected. The validated artifact is written to
the release-preflight manifest so the cut evidence remains reviewable after the
command exits.

The docs must state the residual risk: a fully credentialed runner can still post
the comment. This control creates a public, timestamped, attributable audit
artifact and prevents an invisible self-acknowledgement flag; it is not
automation-proof.

Tests use a stubbed GitHub boundary and cover missing comments, mismatched tokens,
wrong repositories/issues, unauthorized authors, changed SHA/intent/bump, and a
valid artifact.

## #421: field hygiene and observable long scans

### Quarantine cleanup

Quarantine ownership lives at the command boundary. A command-level `finally`
removes every owned `aih-quarantine-*` directory after success, block, throw, or
interrupted plan completion. `--keep-quarantine` is the only retention path and
must print the retained path. Cleanup failure is reported without masking the
primary trust failure.

### Progress and JSON channels

Long trust scans emit bounded progress records to stderr. Machine-readable JSON is
emitted only on stdout and remains one valid command result with no progress
contamination. The scanner reuses one bounded file inventory and processes files
incrementally; it must not retain full file contents or duplicate whole-tree
inventories. Memory therefore scales with findings plus bounded worker state, not
source-file count times detector count.

Tests use a large fixture and a slow runner to prove early stderr progress, clean
stdout JSON, completion, and bounded inventory reuse. They do not assert wall-clock
performance.

### ECC dry-run

Dry-run reads the source manifest/catalog and renders deterministic install-phase
operations without fetching or mutating. These operations are explicitly marked
`contingent on evidence authorization`; they do not claim the gate has passed.
Paths, target, operation kind, and owning component are shown so writes into user
homes are reviewable before apply.

## #417: release-gate integration

The release workflow gets a dedicated installable-baseline job. Its first test
fixture is the exact v2.8.0 ECC lock at
`4130457d674d2180c5af2c5f634f3cae4cbc6c4f`; that fixture must reproduce the
zero-installable enterprise failure.

After the trust and partial-install slices land, the maintainer CI flow vets the
selected exact ECC commit once, signs per-component evidence with the existing
vendor-evidence mechanism, updates the source registry and vendor lock together,
and verifies their hashes/signatures before committing either. Pin selection is
evidence-driven: use the exact upstream commit vetted by the job, never a moving
branch or tag.

For each posture—vibe, team, and enterprise—the job creates a fresh fixture HOME,
uses the package code and shipped vendor lock to run a real scoped ECC install,
and inspects the resulting target state and registration ledger. Each posture must
install at least one component, every installed file must be covered by an
authorized component hash, every held component must be named with its codes, and
no user-side analyzer runtime may be required for the covered pin.

Enterprise is expected to install the authorized common/project baseline while
holding auto-exec hook components. That partial result is success and must not be
made fully green by weakening the detector or adding hooks-runtime to the common
baseline. A posture with zero installed components, an unauthorized runtime, a
ledger/install mismatch, or source/evidence drift fails the job and blocks the
release.

The job runs in the release gate and in the ordinary verification path used by
PRs that modify baseline sources, catalogs, evidence, trust grading, ECC install,
or registration. Fixture paths and HOME variables are isolated on Linux, Windows,
and macOS where the existing matrix supports the flow.

## Test and review contract

Every slice starts with a focused failing test and ends with its focused suite plus
`npm run verify` green. Trust, release, installer, and prune slices receive a
security/domain review and an independent code review. The reviewer record is
captured on the PR before the authorized merge; zero-review self-merges are not
allowed.

Each PR has exactly one authoritative `semver:*` label and one `[Unreleased]`
CHANGELOG entry. Verdict-behavior changes remain `semver:minor`; they are not
reclassified as patch work to force a smaller version.

## Release contract

After all eight issues close and #417 passes from the swept milestone, prepare the
release through the existing cut-time intent checkpoint. Publication still pauses
at both human gates: an exact full-SHA authorization sentence for the computed
version and the npm-publish environment approval click. Merge authorization does
not substitute for either publication gate. Final verification requires the
GitHub release, npm exact version, release workflow, and `aih verify-release` 3/3.
