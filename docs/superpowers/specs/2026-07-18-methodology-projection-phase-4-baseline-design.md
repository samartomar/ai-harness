# Methodology Projection Phase 4 Baseline Design

**Status:** Approved by Samar on 2026-07-18 through the authoritative Phase 4 reset.

**Base:** Reviewed Phase 3 commit
`f289ef35c4965351f9238fc60d4e6f0b1d3ad955`.

## Decision

Implement the baseline methodology projector as a project-scoped transactional
generation store for fresh host sessions. It provides deterministic materialization,
atomic activation, recovery, drift detection, and conservative cleanup within an
AIH-owned root.

The rejected Phase 4 and Phase 4A lineages are audit history only. This design is a
new implementation from the reviewed Phase 3 base; it does not repair, import, or
extend their native feasibility or transaction code.

## Security boundary

The baseline projector protects against:

- process crashes and interruption at every transaction boundary;
- multiple cooperating AIH processes;
- stale plans and changed admitted bytes;
- accidental external edits;
- static symbolic links, hard links, junctions, reparse points, and path escape;
- destination collisions, incomplete generations, and corrupt ownership records;
- malformed manifests and hostile provider bytes passed as inert data; and
- deletion of unknown, active, drifted, linked, or otherwise uncertain content.

The baseline projector does not protect against a malicious process already running
with the same OS identity and write authority over the projection root. Such a process
has the same filesystem authority as AIH and can race ordinary pathname operations or
modify descendants. The baseline is therefore transactionally contained and
tamper-evident within its documented boundary; it is not tamper-proof against a
compromised developer account.

The stronger guarantee belongs to a separately designed enterprise hardened
projector backed by a broker, protected mount, sandbox, dedicated service identity,
or equivalent authority separation. A native addon loaded into the ordinary AIH
process does not establish that separation and is not part of this phase.

## Non-goals

- No same-user malicious-race resistance or endpoint-isolation claim.
- No native addon, service, broker, protected mount, sandbox, or privileged helper.
- No provider checkout reader, provider fetch, provider execution, or source rewrite.
- No host mapping, host-native write, host launch, plugin, hook, MCP, or daemon.
- No package-manager activity from the projector.
- No live-session hot switching.
- No production apply or clean CLI wiring in Phase 4. The existing methodology CLI
  remains read-only/dry-run until later provider and host gates can supply real admitted
  bytes and consume a projection.
- No signing work, prototype-hook hardening campaign, historical Phase 0--3
  recertification, or archived Phase 4A repair.
- No writes to the AIH checkout, user home, global configuration, provider source, or
  host-native paths during tests. All mutation tests use disposable temporary project
  roots.

## Chosen architecture

Use immutable content-addressed generations plus a small atomic activation record.
The active generation is never modified in place. Applying a new plan constructs and
verifies a new generation, then atomically replaces only the activation record. A
fresh host session can later resolve that record to one exact immutable generation.

The alternatives are rejected:

1. Renaming a mutable `current/` directory to a backup and replacing it creates a
   multi-object rollback protocol, platform-specific exchange behavior, and a larger
   crash-recovery surface.
2. A symlink or junction named `current` reintroduces link/reparse ambiguity and
   host-specific resolution behavior.
3. A same-process native addon exposes more syscalls but does not establish a separate
   authority for the full tree. That is not the baseline architecture.

## Storage model

The store is rooted only at `<project>/.aih/methodology/v1`:

```text
.aih/methodology/v1/
  root.json
  active.json                         # absent before the first activation
  lock/                               # one fully formed cooperative lock claim
  lock-candidates/<token>/owner.json
  transactions/<transaction-id>.json
  staging/<transaction-id>/
    staging.json
    content/<canonical targets>
  generations/<manifest-digest>/
    incomplete.json                  # present only while materializing
    receipt.json                     # written only after exact verification
    content/<canonical targets>
  trash/<transaction-id>/            # interrupted cleanup quarantine
```

`root.json` is created exclusively and binds a random root identifier to schema
version 1. Existing roots are accepted only when the marker is valid and every
ancestor from the canonical project root to the store is an ordinary directory.
AIH never adopts an unmarked directory or repairs a malformed marker.

Generation names are the lowercase Phase 3 manifest digest. `content/` contains only
the exact regular-file targets named by that manifest. `receipt.json` is deterministic
for one store and binds its root identifier, the manifest digest, canonical manifest
entries, and every materialized content digest. Transaction identifiers and lock tokens
never influence the generation address or projected bytes. The same manifest reapplied
inside the same store produces byte-identical content, receipt, and activation records;
different project stores retain distinct ownership through their root identifiers.

The activation record is deterministic closed JSON containing only its schema version,
manifest digest, receipt digest, and canonical relative generation path. It contains
no absolute path, timestamp, process ID, or random transaction value.

## Phase 3 and exact-byte boundary

Phase 4 consumes:

- one `planned` result accepted by `ProjectionPlanResultSchema`;
- one own-data payload for every manifest artifact, identified by artifact ID; and
- the digest of the active generation observed when the plan was prepared, or `null`
  when no generation was active.

Payloads are in-memory byte arrays. Phase 4 neither locates nor reads provider source.
Before any write it rejects missing, duplicate, extra, accessor-backed, oversized, or
non-byte payloads and recomputes each SHA-256 digest. The recomputed digest must equal
the manifest entry's admitted content digest. Targets are revalidated as canonical
relative paths even though Phase 3 already validates them.

Apply is explicit at the library boundary. Planning and inspection remain read-only;
no default or implicit call path mutates the store.

## Component and API boundaries

The implementation has three focused internal units:

1. A generation-store contract validates the Phase 3 result, exact payload coverage,
   expected activation, and typed outcomes. It exports read-only inspection plus
   explicit apply, recovery, and exact-generation clean functions for later AIH
   integration; it is not added to the CLI in this phase.
2. A filesystem boundary owns canonical project/store path construction, link-safe
   walking, exclusive creation, syncing, atomic same-directory replacement, exact-tree
   verification, and bounded deletion. It accepts no provider-defined absolute path.
3. A transaction engine implements the lock, journal, staging, generation, activation,
   recovery, and quarantine state machines. Its production wrapper uses the real Node
   filesystem boundary; focused tests may inject failures through an internal dependency
   seam that is not exported from the package entry point.

The apply input contains `projectRoot`, the planned Phase 3 result, exact artifact byte
payloads, `expectedActiveDigest`, and the literal mode `apply`. Recovery contains only
`projectRoot`; clean additionally requires one exact inactive generation digest.
Inspection contains only `projectRoot` and never acquires the mutation lock.

No function accepts an arbitrary output root, destination pathname, recursive-clean
flag, force flag, repair flag, fallback generation, or executable callback.

## Resource bounds

Phase 4 retains Phase 3's maximum of 64 manifest entries and 240 bytes per canonical
target. It additionally enforces:

- at most 8 MiB for one payload and 64 MiB for all payloads;
- at most 32 target segments and 512 distinct generated directories;
- at most 1,024 filesystem entries and 64 MiB of regular-file content in any one
  verification walk;
- at most 128 transaction or quarantine records considered in one recovery call; and
- at most 1 MiB for any root, lock, journal, receipt, or activation record.

Limits are checked while walking and hashing rather than after unbounded collection.
Crossing a limit fails closed and does not trigger cleanup of the uncertain object.

## Containment and ownership

All derived paths use fixed internal segments, the manifest digest, transaction IDs
generated by AIH, or canonical Phase 3 targets. The projector rejects absolute paths,
empty/dot segments, separator aliases, reserved Windows names, case-folded target
collisions, and any resolution outside the canonical store root.

Before each mutation phase, existing ancestors and managed leaves are inspected with
`lstat`. A symlink, junction, Node-observable reparse alias, non-directory ancestor,
unexpected realpath, or change in the root's captured `stat.dev` identity blocks the
transaction. On platforms where `stat.dev` does not distinguish a relevant volume
transition, realpath and link/type checks remain mandatory and the implementation makes
no stronger volume-identity claim. Managed regular files must have one link. Generation
verification rejects missing and extra descendants as well as byte, type, size, target,
and receipt drift.

These checks detect static links and accidental changes. They are not claimed to close
a verify-then-mutate race against a malicious same-user process, which is outside the
baseline threat model.

## Cooperative lock

Every mutating operation first creates a private candidate directory and a complete
`owner.json`, then renames that non-empty directory to `lock/`. Because cooperating AIH
processes use the same protocol, exactly one claim succeeds; contenders return a typed
blocked result without mutation.

The owner record contains a schema version, random token, PID, and transaction ID. A
lock with a live or indeterminate PID remains held. A well-formed lock whose PID is
definitively absent may be renamed to a unique stale-lock quarantine and recovered.
PID reuse can delay recovery but cannot authorize concurrent mutation. Malformed,
linked, or uncertain lock state fails closed and is left in place.

Release verifies that `lock/owner.json` still contains the caller's exact token before
removing it. Locking coordinates AIH processes only; it is not represented as an OS
security boundary against arbitrary same-user writers.

## Apply transaction

Under the cooperative lock, apply performs these ordered steps:

1. Re-read and verify the root marker, current activation, manifest, expected active
   digest, and every payload digest. Any mismatch is a stale-plan block before writes.
2. Write and sync a transaction journal in state `prepared`.
3. Create a private staging directory with restrictive permissions, materialize exact
   bytes using exclusive regular-file creation, and sync written files.
4. Walk staging without following links and prove the exact manifest tree, byte
   digests, sizes, file types, link counts, and absence of extra descendants.
5. Reserve `generations/<manifest-digest>` with exclusive directory creation. If it
   already exists, reuse it only when its deterministic receipt and complete tree
   verify exactly; otherwise report a collision and leave it untouched.
6. For a new generation, write `incomplete.json`, copy exact staged bytes into a
   newly created `content/`, verify the complete generation, write and sync the
   deterministic receipt, remove the incomplete marker, and verify again.
7. Write the deterministic next activation to a unique sibling temporary file, sync
   it, and atomically rename it over `active.json` within the same directory. A platform
   enters the supported Phase 4 matrix only after its local filesystem lane proves that
   readers observe the complete old or complete new regular-file record, never partial
   bytes.
8. Re-read the activation and referenced generation. Mark the journal committed only
   when both verify, then remove owned staging/journal remnants and release the lock.

No apply step edits or removes the previously active generation. A failure before the
activation rename leaves the old activation byte-for-byte unchanged. A process crash
at the rename boundary leaves either the complete old record or the complete new
record; recovery accepts only those two states.

Phase 4's crash guarantee covers process termination, interruption, and surfaced
filesystem errors. Files and activation temporaries are synced before publication;
parent directories are synced where the operating system supports it. Unsupported
directory syncing is recorded in platform evidence rather than silently claimed. The
phase does not claim survival from storage hardware that acknowledges and later loses
durable writes.

Applying the already active exact generation is an idempotent read/verify result and
performs no content rewrite.

## Recovery

Recovery runs only under the cooperative lock. It validates every journal and owned
marker before acting and handles one transaction independently:

- If `active.json` is still the recorded old activation, the transaction did not
  commit. Exact owned staging or incomplete generation objects may be quarantined and
  removed; anything drifted or uncertain remains with a finding.
- If `active.json` is the exact recorded new activation and the referenced generation
  verifies, the activation committed. Recovery completes bookkeeping and removes only
  exact owned remnants.
- If activation is missing, malformed, references an invalid generation, or is neither
  the recorded old nor new value, recovery fails closed without selecting a fallback.

There is no fallback to an older generation, provider source, or partially built
generation. Recovery is deterministic and idempotent.

## Inspection and drift detection

The read-only inspection boundary validates the root marker, activation record,
referenced receipt, and exact generation tree. It reports typed findings for malformed
ownership, incomplete transactions, missing or extra content, digest drift, links,
containment failure, and orphan generations. It does not repair or recover.

An invalid active generation is `drifted` or fail-closed; it is never reported active,
installed, isolated, switchable, concurrent, or conflict-free. Later host work may use
only a generation that passes this inspection immediately before a fresh session.

## Fail-closed clean

Clean is explicit and accepts one exact generation digest. It never means "remove
everything" and never removes the generation named by the current activation record.

Under the lock, clean verifies the root, activation, requested generation name,
deterministic receipt, complete descendant set, bytes, file types, link counts, and
containment. Missing ownership, drift, an unexpected descendant, a link/reparse object,
an incomplete marker, or any uncertainty returns `retained` without touching the
generation.

An exact inactive generation is atomically renamed to a unique owned `trash/`
quarantine before bounded bottom-up deletion. A crash or deletion error leaves the
quarantined remainder for deterministic recovery; clean never broadens its target or
uses pathname fallback. Recovery removes a trash remainder only while its marker and
remaining tree are consistent with the recorded clean transaction. Ambiguity leaves it
in place.

## Result vocabulary

Mutation APIs return closed typed results rather than throwing expected findings:

- apply: `applied`, `already-active`, `blocked`, or `failed-closed`;
- recovery: `recovered`, `nothing-to-recover`, `blocked`, or `failed-closed`;
- clean: `cleaned`, `retained`, `blocked`, or `failed-closed`; and
- inspection: `empty`, `verified`, `drifted`, or `failed-closed`.

Unexpected operating-system errors are captured as fixed finding codes with bounded
details. Results state only what was observed; they do not claim provider or host use.

## Test design

Implementation is test-first. All filesystem tests create a disposable project root
under the operating system's temporary directory and place outside-root canaries in a
sibling temporary directory.

Focused tests cover:

- exact payload coverage, raw byte preservation, digest validation, size/resource
  limits, target aliases, and deterministic generation/activation bytes;
- initial apply, replacement apply, exact replay, idempotency, and stale active-plan
  rejection;
- two cooperating child processes contending for the lock, stale-lock recovery, PID
  reuse fail-closed behavior, and malformed lock retention;
- injected failure before and after every journal, staging, verification, generation,
  receipt, activation, and cleanup boundary;
- child-process termination at every externally visible transaction state followed by
  deterministic recovery;
- existing destination collisions, incomplete generations, corrupt journals, and
  invalid activation records;
- static symlink, hard-link, Windows junction/reparse, non-regular-file, realpath,
  and outside-root attacks without following or deleting the hostile object;
- accidental mutation, deletion, and extra content after apply, with inspection
  reporting drift and clean retaining the generation;
- exact inactive clean, interrupted clean quarantine, active-generation refusal, and
  repeated recovery; and
- proof that no provider/host code, network operation, package manager, executable
  provider byte, checkout path, home path, or host-native path is read or executed by
  the projector.

The same behavioral suite runs on Linux, Windows, and macOS. Platform-only link/reparse
fixtures are explicit complementary lanes rather than silently skipped evidence.
Subprocesses have finite generous timeouts. Full completion requires the focused
methodology suite, typecheck, lint, documentation lint, `npm run verify`, package build,
and `git diff --check`.

## Gate and documentation outcome

`PHASE_4_GATE_PASS` requires all transaction, recovery, containment, drift, cleanup,
three-platform, repository, correctness, security, filesystem-specialist, and
unsupported-claim reviews to pass with no unresolved actionable finding. Phase 5
remains blocked until that exact reviewed Phase 4 SHA passes.

Public architecture, security, stability, control-matrix, command, and changelog text
must distinguish the baseline local transactional projector from the future enterprise
hardened projector. Baseline claims are limited to transactional integrity,
containment, deterministic verification, and tamper detection inside the stated threat
model. No document may imply same-user tamper resistance, live-session switching,
provider execution, host execution, installation, activation by a host, isolation, or
conflict freedom.
