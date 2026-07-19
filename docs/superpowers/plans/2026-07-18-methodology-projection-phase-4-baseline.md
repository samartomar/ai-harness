# Methodology Projection Phase 4 Baseline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** Build a project-scoped transactional methodology generation store that materializes exact admitted bytes, atomically activates verified content-addressed generations that the library never edits in place, recovers from interruption, detects drift, and conservatively cleans exact inactive generations.

**Architecture:** Phase 4 consumes the reviewed Phase 3 planned result plus exact in-memory payload bytes. A cooperative lock serializes AIH writers. Prepared journals are atomically created through bounded non-authoritative sibling temporaries. Staging and generation containers are built privately under `trash/<transaction-id>`, fully verified, and published by whole-directory rename; a same-directory regular-file rename leaves activation as complete old-or-new bytes. Inspection and clean use bounded Node-observable path/link/identity checks; uncertainty retains bytes and fails closed.

**Tech Stack:** TypeScript 7, Node.js 20+ synchronous filesystem APIs, existing SHA-256 and containment helpers, Zod 4 strict stored-record schemas, Vitest 4, and the existing Linux/Windows/macOS CI matrix.

## Global Constraints

- Work only on branch feature/methodology-projection-phase-4-baseline from reviewed Phase 3 f289ef35c4965351f9238fc60d4e6f0b1d3ad955.
- Treat docs/superpowers/specs/2026-07-18-methodology-projection-phase-4-baseline-design.md as the approved contract.
- Do not import, cherry-pick, repair, or adapt archived Phase 4 or Phase 4A implementation code.
- The baseline excludes a malicious process with the same OS identity and write authority over the projection root. Never claim same-user tamper resistance.
- Do not add native code, a native addon, broker, service, protected mount, sandbox, signing, or prototype-hook recertification.
- Do not add provider-source readers, provider/host execution, network access, package-manager execution, host mapping, host launch, or a production apply/clean CLI.
- All mutation tests use disposable operating-system temporary project roots. Never target the AIH checkout, user home, provider source, or host-native paths.
- The store root is exactly <project>/.aih/methodology/v1. No public function accepts an arbitrary output root.
- Retain Phase 3 maxima of 64 manifest entries and 240 target bytes. Phase 4 maxima are 8 MiB per payload, 64 MiB total payload bytes, 32 target segments, 512 generated directories, 1,024 walked entries, 64 MiB walked regular-file bytes, 128 recovery records, and 1 MiB per metadata record. Apply preflight and recovery share one aggregate entry/directory/byte budget across the active generation and all completed history; a new generation must fit the remaining capacity before writes begin.
- Mutation is explicit at the library boundary. The existing methodology CLI stays read-only/dry-run.
- Clean accepts one exact inactive generation digest. It never means recursive clean-all.
- Signing does not determine the filesystem gate. Use DCO sign-off and process-local commit.gpgsign=false for local commits.
- Every child process has a finite timeout of at least 30 seconds; enclosing Vitest cases that spawn multiple children use at least 60 seconds.
- Run npm run verify before completion. Do not suppress tests, relax coverage, add permissive fallback, or rewrite admitted bytes.

---

## File Structure

Create these focused production files:

- src/methodology/generation-store-contract.ts — closed input/stored-record/result types, exact finding vocabulary, canonical JSON, payload validation, and resource constants.
- src/methodology/generation-store-fs.ts — bounded AIH-root layout, safe regular-file I/O, exact-tree walking, Node-observable link/containment checks, atomic-create and replacement records, verified scratch-directory publication, quarantine, syncing, and bounded deletion.
- src/methodology/generation-store-lock.ts — cooperative PID-bound pending-candidate construction, complete candidate publication, stale-owner classification, exact-token release, and lock quarantine.
- src/methodology/generation-store.ts — read-only inspection plus explicit apply, recovery, and exact-generation clean state machines.

Create these test files:

- tests/methodology/generation-store-fixtures.ts — real Phase 3 plan and exact-byte fixture builders used by the Phase 4 suites.
- tests/methodology/generation-store-contract.test.ts — input, stored-record, result, deterministic JSON, and resource-bound tests.
- tests/methodology/generation-store-fs.test.ts — store-root, containment, exact-walk, link, collision, atomic-record, and deletion tests.
- tests/methodology/generation-store-lock.test.ts — lock contention, stale ownership, malformed state, and exact release tests.
- tests/methodology/generation-store.test.ts — inspection and apply behavior, determinism, idempotency, stale plans, and collisions.
- tests/methodology/generation-store-recovery.test.ts — injected failure and process-interruption recovery at every state boundary.
- tests/methodology/generation-store-platform.test.ts — cross-process lock/activation behavior plus platform-specific symlink, hard-link, and junction/reparse fixtures.
- tests/methodology/helpers/generation-store-child.ts — finite child-process driver used only by tests.

Modify these public truth homes after behavior is green:

- CHANGELOG.md
- SECURITY.md
- STABILITY.md
- docs/ARCHITECTURE.md
- docs/CONTROL_MATRIX.md
- docs/THREAT_MODEL.md
- docs/commands.md

Do not modify src/index.ts, src/program.ts, command registration, command-surface fixtures, package.json, package-lock.json, or CI workflows unless a test proves the approved design cannot be exercised through the existing three-OS matrix.

### Shared interfaces

The implementation must use these names consistently:

~~~ts
export type PlannedProjection = Extract<
  ReturnType<typeof planSyntheticProjection>,
  { state: "planned" }
>;

export type ProjectionPayload = Readonly<{
  artifactId: string;
  bytes: Uint8Array;
}>;

export type ApplyProjectionInput = Readonly<{
  mode: "apply";
  projectRoot: string;
  plan: unknown;
  payloads: readonly unknown[];
  expectedActiveDigest: string | null;
}>;

export type InspectProjectionInput = Readonly<{ projectRoot: string }>;
export type RecoverProjectionInput = Readonly<{ projectRoot: string }>;
export type CleanProjectionInput = Readonly<{
  projectRoot: string;
  generationDigest: string;
}>;

export function inspectProjectionStore(value: unknown): ProjectionInspectionResult;
export function applyProjection(value: unknown): ApplyProjectionResult;
export function recoverProjectionStore(value: unknown): RecoveryProjectionResult;
export function cleanProjectionGeneration(value: unknown): CleanProjectionResult;
~~~

The fixed finding codes are:

~~~ts
export const STORE_FINDING_CODES = [
  "METHODOLOGY_STORE_INPUT_INVALID",
  "METHODOLOGY_STORE_RESOURCE_LIMIT",
  "METHODOLOGY_STORE_PAYLOAD_COVERAGE",
  "METHODOLOGY_STORE_PAYLOAD_DIGEST",
  "METHODOLOGY_STORE_ROOT_UNOWNED",
  "METHODOLOGY_STORE_PATH_UNSAFE",
  "METHODOLOGY_STORE_LOCK_HELD",
  "METHODOLOGY_STORE_LOCK_INVALID",
  "METHODOLOGY_STORE_PLAN_STALE",
  "METHODOLOGY_STORE_DESTINATION_COLLISION",
  "METHODOLOGY_STORE_GENERATION_INCOMPLETE",
  "METHODOLOGY_STORE_GENERATION_DRIFT",
  "METHODOLOGY_STORE_ACTIVATION_INVALID",
  "METHODOLOGY_STORE_TRANSACTION_INVALID",
  "METHODOLOGY_STORE_CLEAN_ACTIVE",
  "METHODOLOGY_STORE_CLEAN_RETAINED",
  "METHODOLOGY_STORE_FILESYSTEM_FAILURE",
] as const;
~~~

Every result includes schemaVersion: 1, one fixed state, findings with only code and optional bounded subject, and one of these literal boundaries. Inspection is read-only; apply, recovery, and clean disclose their bounded write capability explicitly:

~~~ts
const GENERATION_STORE_COMMON_BOUNDARY = Object.freeze({
  providerRead: false,
  providerExecution: false,
  hostExecution: false,
  network: false,
  packageManager: false,
  cli: false,
});

export const GENERATION_STORE_READ_BOUNDARY = Object.freeze({
  ...GENERATION_STORE_COMMON_BOUNDARY,
  writeCapability: "none" as const,
});

export const GENERATION_STORE_MUTATION_BOUNDARY = Object.freeze({
  ...GENERATION_STORE_COMMON_BOUNDARY,
  writeCapability: "aih-owned-project-root" as const,
});

export type GenerationStoreBoundary =
  | typeof GENERATION_STORE_READ_BOUNDARY
  | typeof GENERATION_STORE_MUTATION_BOUNDARY;
~~~
The stored-record and result types are exact:

~~~ts
export type StoreFindingCode = (typeof STORE_FINDING_CODES)[number];

export type StoreFinding = Readonly<{
  code: StoreFindingCode;
  subject?: string;
}>;

export type RootRecord = Readonly<{
  schemaVersion: 1;
  rootId: string;
  rootDevice: string;
}>;

export type ReceiptEntry = Readonly<{
  artifactId: string;
  target: string;
  sourceLocator: string;
  contentDigest: string;
  bytes: number;
}>;

export type GenerationReceipt = Readonly<{
  schemaVersion: 1;
  rootId: string;
  manifestDigest: string;
  entries: readonly ReceiptEntry[];
}>;

export type ActivationRecord = Readonly<{
  schemaVersion: 1;
  manifestDigest: string;
  receiptDigest: string;
  generation: string;
}>;

export type IncompleteRecord = Readonly<{
  schemaVersion: 1;
  rootId: string;
  transactionId: string;
  manifestDigest: string;
}>;

export type StagingRecord = Readonly<{
  schemaVersion: 1;
  rootId: string;
  transactionId: string;
  manifestDigest: string;
}>;

export type LockOwnerRecord = Readonly<{
  schemaVersion: 1;
  rootId: string;
  token: string;
  pid: number;
  transactionId: string;
}>;

export type ApplyTransactionPhase =
  | "prepared"
  | "staged"
  | "generation-reserved"
  | "generation-verified"
  | "activation-committed"
  | "committed";

export type CleanTransactionPhase =
  | "prepared"
  | "quarantined"
  | "deleting"
  | "committed";

export type TransactionRecord =
  | Readonly<{
      schemaVersion: 1;
      operation: "apply";
      rootId: string;
      transactionId: string;
      phase: ApplyTransactionPhase;
      manifestDigest: string;
      oldActivation: ActivationRecord | null;
      newActivation: ActivationRecord;
      entries: readonly ReceiptEntry[];
    }>
  | Readonly<{
      schemaVersion: 1;
      operation: "clean";
      rootId: string;
      transactionId: string;
      phase: CleanTransactionPhase;
      generationDigest: string;
      oldActivation: ActivationRecord | null;
      entries: readonly ReceiptEntry[];
    }>;

type StoreResultBase = Readonly<{
  schemaVersion: 1;
  boundary: GenerationStoreBoundary;
  findings: readonly StoreFinding[];
}>;

export type ProjectionInspectionResult = StoreResultBase &
  Readonly<{
    state: "empty" | "verified" | "drifted" | "failed-closed";
    activeDigest: string | null;
  }>;

export type ApplyProjectionResult = StoreResultBase &
  Readonly<{
    state: "applied" | "already-active" | "blocked" | "failed-closed";
    previousActiveDigest: string | null;
    activeDigest: string | null;
  }>;

export type RecoveryProjectionResult = StoreResultBase &
  Readonly<{
    state: "recovered" | "nothing-to-recover" | "blocked" | "failed-closed";
    activeDigest: string | null;
  }>;

export type CleanProjectionResult = StoreResultBase &
  Readonly<{
    state: "cleaned" | "retained" | "blocked" | "failed-closed";
    generationDigest: string | null;
  }>;
~~~

`IncompleteRecord` remains a closed recognition type for unexpected existing residue.
The reset apply path never emits `incomplete.json`, never uses it as
publication authority, and never constructs a generation directly under its final
path. The `generation-reserved` phase name is retained in the implemented stored
journal schema as a state label; it does not mean the final generation directory has
been created.

Stored values and their path bindings are closed, not merely typed:

- rootId, transactionId, lock token, manifest digest, content digest, and receipt digest are lowercase 64-character hexadecimal strings;
- rootDevice is the canonical unsigned decimal string from bigint stat.dev and matches /^(0|[1-9][0-9]{0,19})$/;
- PID is a safe positive integer no greater than 4,294,967,295;
- transaction filenames are exactly <transactionId>.json, staging/trash directories are exactly <transactionId>, generation directories are exactly <manifestDigest>, and authoritative lock candidate names are exactly <token> or <token>.stale; candidate construction uses only non-authoritative <token>.pending.<pid> directories that are atomically published or conservatively retained/reaped by PID liveness;
- ActivationRecord.generation is exactly generations/<manifestDigest>/content with forward slashes and is derived, never trusted as a free path;
- every finding subject is own-data UTF-8 of at most MAX_FINDING_SUBJECT_BYTES and is never used as a path.

Reject separators, dot segments, reserved names, mixed-case hex, overlong values, unsafe PIDs, and filename-to-record mismatches before deriving a path.

The state/finding mapping is normative:

- inspection returns empty or verified only for fully classified state, drifted only for an owned generation whose expected tree is observably changed, and failed-closed for malformed ownership, unsafe paths/links, exceeded bounds, inaccessible state, invalid activation, or uncertain identity;
- apply returns blocked for invalid input, resource/payload/coverage/digest refusal, deterministic destination collision, live cooperative lock, or stale expected activation before mutation; it returns failed-closed for malformed/unsafe owned state, existing drift, invalid transaction state, or a filesystem failure that makes mutation state uncertain;
- recovery returns blocked only when a valid live cooperative lock prevents entry; it returns failed-closed for malformed, unbound, over-limit, or ambiguous pending state and never starts separate work;
- clean returns blocked for invalid input, a valid live lock, or an active requested digest; it returns retained for an exact requested inactive generation that is missing, incomplete, drifted, linked, unexpectedly populated, or cannot be deleted with certainty; it returns failed-closed for malformed root/activation/transaction ownership or unsafe containment.

Every non-success result carries at least one fixed finding, and success states carry no contradictory refusal finding.

### Task 1: Closed contract and real Phase 3 fixtures

**Files:**
- Create: src/methodology/generation-store-contract.ts
- Create: tests/methodology/generation-store-fixtures.ts
- Create: tests/methodology/generation-store-contract.test.ts

**Interfaces:**
- Consumes: ProjectionPlanResultSchema and planSyntheticProjection from src/methodology/projection-planner.ts.
- Produces: the shared interfaces above; validated apply/inspect/recover/clean inputs; RootRecord, ActivationRecord, GenerationReceipt, recognition-only IncompleteRecord, StagingRecord, LockOwnerRecord, TransactionRecord; canonicalRecordBytes; sha256Bytes; result builders.

- [ ] **Step 1: Write failing fixture and contract tests**

Build fixture content digests from the actual bytes instead of repeated fake hexadecimal characters:

~~~ts
export const ROOT_BYTES = Buffer.from("# root\n", "utf8");
export const DEPENDENCY_BYTES = Buffer.from("# dependency\n", "utf8");

export function plannedFixture() {
  return planSyntheticProjection({
    schemaVersion: 1,
    decisionVersion: "phase-3-decision-v1",
    classifierVersion: "phase-2-classifier-v1",
    policyVersion: "phase-3-policy-v1",
    manifestVersion: 1,
    owner: "aih-methodology",
    classifierInput: {
      schemaVersion: 1,
      requested: ["root"],
      declaredClosure: ["root", "dependency"],
      artifacts: [
        inertArtifact("root", ROOT_BYTES, ["dependency"]),
        inertArtifact("dependency", DEPENDENCY_BYTES, []),
      ],
      evidence: [
        inertEvidence("root", ROOT_BYTES),
        inertEvidence("dependency", DEPENDENCY_BYTES),
      ],
    },
    mappings: [
      { artifactId: "root", target: "rules/root.md" },
      { artifactId: "dependency", target: "rules/dependency.md" },
    ],
  });
}

export function payloadFixture(): ProjectionPayload[] {
  return [
    { artifactId: "root", bytes: ROOT_BYTES },
    { artifactId: "dependency", bytes: DEPENDENCY_BYTES },
  ];
}
~~~

Test one valid apply input and direct rejection of a blocked plan, missing/extra/duplicate payloads, a digest mismatch, 8 MiB plus one byte, 64 MiB plus one byte, 33 target segments, accessor-backed payload fields, malformed stored records, unknown finding codes, and unknown result keys. Directly test separators, dot segments, reserved names, overlong IDs, mixed-case digests, unsafe PIDs, root-device overflow, filename/record mismatch helpers, and finding-subject byte overflow. Assert canonical record bytes are identical across reversed object-key insertion, reversed receipt-entry input, and separately constructed equal records.

- [ ] **Step 2: Run the contract test and observe the missing module failure**

Run:

~~~sh
npm test -- --run tests/methodology/generation-store-contract.test.ts
~~~

Expected: nonzero exit with Cannot find module ../../src/methodology/generation-store-contract.js.

- [ ] **Step 3: Implement the closed contract**

Use strict Zod records only for AIH-owned JSON records and manual own-data descriptors for payload byte input. Parse the Phase 3 plan with ProjectionPlanResultSchema and require state planned. Copy every accepted Uint8Array with Buffer.from before hashing or storing it.

The constants must be literal:

~~~ts
export const STORE_SCHEMA_VERSION = 1 as const;
export const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;
export const MAX_MANIFEST_ENTRIES = 64;
export const MAX_TARGET_BYTES = 240;
export const MAX_TOTAL_PAYLOAD_BYTES = 64 * 1024 * 1024;
export const MAX_TARGET_SEGMENTS = 32;
export const MAX_GENERATED_DIRECTORIES = 512;
export const MAX_WALK_ENTRIES = 1024;
export const MAX_WALK_BYTES = 64 * 1024 * 1024;
export const MAX_RECOVERY_RECORDS = 128;
export const MAX_RECORD_BYTES = 1024 * 1024;
export const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
export const MAX_FINDING_SUBJECT_BYTES = 240;
export const STORE_ID_PATTERN = /^[0-9a-f]{64}$/;
export const ROOT_DEVICE_PATTERN = /^(0|[1-9][0-9]{0,19})$/;
export const MAX_PID = 4_294_967_295;
~~~

Canonical JSON is schema-specific, compact, newline terminated, and hashes the exact emitted bytes. It never serializes an arbitrary record in caller insertion order:

~~~ts
export type StoreRecordKind =
  | "root"
  | "receipt"
  | "activation"
  | "staging"
  | "incomplete"
  | "lock-owner"
  | "transaction";

export function canonicalRecordBytes(
  kind: StoreRecordKind,
  record: unknown,
): Buffer;

export function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
~~~

The implementation parses by kind and reconstructs a fresh object with fields in the order shown by the type definitions. Receipt entries include the complete Phase 3 materialization entry (artifactId, target, sourceLocator, contentDigest) plus byte length and are sorted by target then artifactId using an intrinsic-safe comparator. Transaction variants and phases have explicit field serializers. Tests pass semantically equal records with reversed key insertion and entry order and require byte-identical output.

RootRecord includes schemaVersion, rootId, and rootDevice. GenerationReceipt includes schemaVersion, rootId, manifestDigest, and canonical entries with artifactId, target, sourceLocator, contentDigest, and bytes. The full Phase 3 decision remains bound by manifestDigest; the receipt redundantly binds the exact materialization subset. ActivationRecord includes schemaVersion, manifestDigest, receiptDigest, and the canonical relative generation content path. TransactionRecord is a strict discriminated union for apply and clean phases; it records exact old/new activation records and canonical expected entries so recovery never consults provider source.

IncompleteRecord is parsed only to classify existing unexpected residue. New
apply code does not serialize it. All activation and transaction write temporaries are
non-authoritative filesystem residue: recovery may validate their bounded ordinary-file
shape and phase-bound filename, but never parses or adopts their contents.

- [ ] **Step 4: Run contract tests, typecheck, and lint**

Run:

~~~sh
npm test -- --run tests/methodology/generation-store-contract.test.ts
npm run typecheck
npm run lint
~~~

Expected: all contract tests pass; typecheck and lint exit 0.

- [ ] **Step 5: Commit Task 1**

Run:

~~~sh
git add src/methodology/generation-store-contract.ts tests/methodology/generation-store-contract.test.ts tests/methodology/generation-store-fixtures.ts
git -c commit.gpgsign=false commit -s -m "feat(methodology): define generation store contracts"
~~~

Expected: one DCO-signed-off local commit containing only the three named files.

### Task 2: Bounded filesystem and exact-tree verification

**Files:**
- Create: src/methodology/generation-store-fs.ts
- Create: tests/methodology/generation-store-fs.test.ts
- Modify: tests/methodology/generation-store-fixtures.ts

**Interfaces:**
- Consumes: stored-record parsers, canonicalRecordBytes, and resource constants from Task 1; containedPath from src/internals/contained-path.ts; readRegularFileWithStats and retryTransient from src/internals/fsxn.ts.
- Produces: StoreLayout, openStoreForInspection, createOrOpenOwnedStore, writeExclusiveRegularFile, writeAtomicRecord, readStoreRecord, verifyExpectedTree, verifyPartialOwnedTree, publishVerifiedScratchDirectory, removeVerifiedScratchTree, removeBoundedRecoveryTemporary, quarantineExactDirectory, and removeVerifiedTree.

- [ ] **Step 1: Write failing root, I/O, and walk tests**

Create a disposable project root and sibling outside canary. Test:

- absent inspection performs zero writes;
- first apply-mode open creates only .aih/methodology/v1 and a valid root marker;
- existing valid root reopens with the same rootId and rootDevice;
- two cooperating first-open processes converge on one valid root marker or one blocks cleanly; neither adopts a partially initialized root;
- a relative project root, symlinked project root, non-canonical alias root, unmarked v1 directory, malformed root marker, symlinked .aih, symlinked methodology, symlinked v1, non-directory ancestor, changed realpath, or changed stat.dev is blocked;
- exclusive regular writes preserve NUL and non-UTF-8 bytes with mode 0600 on POSIX;
- record reads reject links, non-regular files, nlink greater than one, and records over 1 MiB;
- exact walk rejects missing, extra, linked, hard-linked, oversized, over-deep, over-entry, and outside-root content;
- partial owned walk accepts only missing expected leaves and rejects every unexpected descendant;
- atomic-create journal temporaries and phase-update/activation temporaries are recognized only by deterministic path/transaction/phase binding and stable private single-link ordinary-file identity, then discarded without parsing or adoption;
- linked, hard-linked, non-regular, permission-drifted, or identity-uncertain temporaries fail closed and remain;
- ordinary bounded transaction-bound unpublished scratch can be removed only after stable verification, while linked or uncertain scratch is retained; and
- same-directory activation replacement is observed as complete old or complete new JSON.

Use this fixture shape:

~~~ts
const root = makeTemporaryProject();
const outside = makeSiblingCanary(root);
const store = createOrOpenOwnedStore(root.projectRoot);
expect(store.layout.root).toBe(join(root.projectRoot, ".aih", "methodology", "v1"));
expect(readFileSync(outside.canary, "utf8")).toBe("outside-canary\n");
~~~

- [ ] **Step 2: Run the filesystem test and observe the missing module failure**

Run:

~~~sh
npm test -- --run tests/methodology/generation-store-fs.test.ts
~~~

Expected: nonzero exit with Cannot find module ../../src/methodology/generation-store-fs.js.

- [ ] **Step 3: Implement fixed layout and root ownership**

StoreLayout must derive every path from canonical projectRoot:

~~~ts
export type StoreLayout = Readonly<{
  projectRoot: string;
  projectDevice: string;
  root: string;
  rootRecord: string;
  active: string;
  lock: string;
  lockCandidates: string;
  transactions: string;
  staging: string;
  generations: string;
  trash: string;
}>;

export function layoutForCanonicalProject(
  canonicalProjectRoot: string,
  capturedProjectDevice: string,
): StoreLayout {
  const root = resolve(canonicalProjectRoot, ".aih", "methodology", "v1");
  return Object.freeze({
    projectRoot: canonicalProjectRoot,
    projectDevice: capturedProjectDevice,
    root,
    rootRecord: join(root, "root.json"),
    active: join(root, "active.json"),
    lock: join(root, "lock"),
    lockCandidates: join(root, "lock-candidates"),
    transactions: join(root, "transactions"),
    staging: join(root, "staging"),
    generations: join(root, "generations"),
    trash: join(root, "trash"),
  });
}
~~~

Before layout construction, require an absolute normalized projectRoot that already exists, lstat it as an ordinary non-linked directory, capture bigint stat.dev as the canonical decimal projectDevice, resolve realpath, and require realpath to equal the normalized input under the platform path comparison policy. Use only that captured canonical path thereafter. Create .aih, methodology, and v1 one segment at a time. After every create or reuse, lstat the segment, reject links/non-directories, realpath it, require containment beneath canonical projectRoot, and require the captured project device. Create root.json with flag wx and mode 0600. Never adopt an existing unmarked v1 directory or repair a missing/malformed root marker. If bootstrap is interrupted after v1 exists but before a valid marker is durable, every later Phase 4 open remains fail-closed; this plan authorizes no automatic removal or bootstrap-repair path.

- [ ] **Step 4: Implement bounded exact I/O and walking**

Use descriptor-based readRegularFileWithStats for discovered files. Require stats.isFile(), stats.nlink === 1, bounded size, and matching expected digest. Directory enumeration uses readdirSync with Dirent, sorts names lexically, never calls stat on a symlink, and increments entry/byte/directory counters before descent.

writeExclusiveRegularFile opens with O_CREAT | O_EXCL | O_WRONLY plus O_NOFOLLOW where available, writes the exact Buffer, fsyncs, closes, and reopens through the safe reader to verify digest and size. writeAtomicRecord requires a deterministic transaction-bound temporary path supplied by its caller: .active.<transactionId>.tmp beside active.json, or .<transactionId>.<nextPhase>.tmp beside a journal. It creates that exact sibling exclusively, fsyncs it, calls retryTransient around same-directory renameSync, re-reads the target, and syncs the parent directory when supported. Initial apply and clean journals use mode create: the prepared record is written to .<transactionId>.prepared.tmp and renamed only while the final journal path remains absent.

Every temporary is non-authoritative. Recovery never parses its bytes, derives state from it, or adopts it as an activation/journal fallback. A temporary is discardable only when its deterministic location, transaction/phase relationship, private permissions, single-link regular-file type, bounded size, stable identity, and containment are proven. Linked, hard-linked, non-regular, permission-drifted, identity-uncertain, unexpected, or unbound temporaries fail closed and remain. The same distinction applies to unpublished trash/<transactionId> scratch: an ordinary bounded transaction-bound tree can be verified and removed without becoming authority, while linked, unexpectedly populated, or uncertain scratch is retained.

publishVerifiedScratchDirectory revalidates a complete staging or receipt container under trash/<transactionId>, requires the destination to be the container-bound absent staging/generation path, renames the whole verified directory, and verifies the moved identity and bytes. Normal construction never creates children directly under generations/<manifestDigest>.

removeVerifiedTree accepts only a precomputed verified relative entry list. Immediately before each leaf unlink it revalidates bounded size, digest, regular-file type, link count, device, and captured identity; before each directory removal it requires exact emptiness and ordinary-directory identity. It removes bottom-up, retains the remainder on uncertainty, and never uses rmSync with recursive true.

Expose one assertOwnedStorePhase function and call it immediately before journal, staging, generation, activation, quarantine, recovery, and deletion mutation phases. It revalidates canonical containment, ordinary ancestor types, realpaths, rootId, and device. Fault-boundary tests substitute a static link, type, realpath, or device between phases and require detection before the next write. These boundary checks detect accidental change; they do not claim resistance to a continuously racing same-user adversary.

- [ ] **Step 5: Run filesystem tests and the existing fsxn regression suite**

Run:

~~~sh
npm test -- --run tests/methodology/generation-store-fs.test.ts tests/internals/fsxn.test.ts
npm run typecheck
npm run lint
~~~

Expected: all named tests pass; typecheck and lint exit 0.

- [ ] **Step 6: Commit Task 2**

Run:

~~~sh
git add src/methodology/generation-store-fs.ts tests/methodology/generation-store-fs.test.ts tests/methodology/generation-store-fixtures.ts
git -c commit.gpgsign=false commit -s -m "feat(methodology): add bounded generation filesystem"
~~~

### Task 3: Cooperative AIH lock

**Files:**
- Create: src/methodology/generation-store-lock.ts
- Create: tests/methodology/generation-store-lock.test.ts

**Interfaces:**
- Consumes: StoreLayout, owned record I/O, root identity, and retryTransient.
- Produces: acquireStoreLock and releaseStoreLock plus an internal LockRuntime seam containing pid, token generation, and pidState.

- [ ] **Step 1: Write failing lock tests**

Test PID-bound pending-candidate construction before a complete claim, two sequential contenders, exact-token release, wrong-token refusal, live PID block, EPERM/indeterminate PID block, dead PID quarantine and reacquire, PID-reuse conservative block, malformed owner retention, linked owner retention, empty lock retention, token/filename mismatch, invalid identifier alphabets and lengths, a 129th candidate fail-closed, dead pending-candidate cleanup, live/indeterminate pending retention, and unsafe pending retention.

The runtime seam is data-only except for the internal liveness function:

~~~ts
export type PidState = "alive" | "absent" | "indeterminate";

export type LockRuntime = Readonly<{
  pid: number;
  randomToken: () => string;
  pidState: (pid: number) => PidState;
}>;
~~~

Public generation-store functions construct the production runtime internally; user input never supplies callbacks.

- [ ] **Step 2: Run the lock test and observe the missing module failure**

Run:

~~~sh
npm test -- --run tests/methodology/generation-store-lock.test.ts
~~~

Expected: nonzero exit with Cannot find module ../../src/methodology/generation-store-lock.js.

- [ ] **Step 3: Implement the candidate-lock protocol**

Lexically inventory lock-candidates before mutation and fail closed upon observing the 129th entry. Create the non-authoritative private lock-candidates/<token>.pending.<pid>, write and sync owner.json completely, verify its identity, then atomically rename the whole directory to authoritative lock-candidates/<token>. Only that complete candidate may be renamed to lock. Treat EEXIST, ENOTEMPTY, and EACCES from an already valid live lock as METHODOLOGY_STORE_LOCK_HELD. Do not delete or replace a live, indeterminate, malformed, linked, over-limit, or uncertain lock.

A pending candidate never proves a claim. Reap it only when its PID is definitively absent and it remains a private bounded ordinary directory containing zero or one bounded private single-link ordinary file. Do not parse or adopt that file. Retain live/indeterminate pending candidates; retain and fail closed on unsafe or identity-uncertain pending state.

For a strictly parsed owner with an absent PID, rename lock to the deterministic quarantine lock-candidates/<token>.stale only when that path is absent. PID reuse yields alive and therefore blocks. After a contender owns the new lock, it may remove that stale directory only after re-reading the exact owner and confirming rootId/token/PID/transactionId binding and absent PID; every other candidate/quarantine remains. Release re-reads owner.json and removes only when rootId, token, PID, and transactionId all equal the held claim.

- [ ] **Step 4: Run lock tests and focused methodology tests**

Run:

~~~sh
npm test -- --run tests/methodology/generation-store-lock.test.ts tests/methodology/projection-planner.test.ts
npm run typecheck
npm run lint
~~~

Expected: all named tests pass.

- [ ] **Step 5: Commit Task 3**

Run:

~~~sh
git add src/methodology/generation-store-lock.ts tests/methodology/generation-store-lock.test.ts
git -c commit.gpgsign=false commit -s -m "feat(methodology): serialize generation mutations"
~~~

### Task 4: Read-only store inspection and drift detection

**Files:**
- Create: src/methodology/generation-store.ts
- Create: tests/methodology/generation-store.test.ts
- Modify: tests/methodology/generation-store-fixtures.ts

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces: inspectProjectionStore and internal inspectOwnedGeneration used by apply, recovery, and clean.

- [ ] **Step 1: Write failing inspection tests**

Construct owned fixture stores directly with deterministic helpers and test states empty, verified, drifted, and failed-closed. Cover malformed root marker, malformed activation, activation outside generations, missing receipt, receipt-root mismatch, receipt digest mismatch, missing content, extra content, byte drift, symlink, hard link, incomplete marker, and orphan generation reporting.

Assert inspection creates no files, does not acquire lock, leaves mtimes unchanged, and always returns boundary providerRead/providerExecution/hostExecution/network/packageManager/cli false with writeCapability none.

- [ ] **Step 2: Run the inspection test and observe the missing export**

Run:

~~~sh
npm test -- --run tests/methodology/generation-store.test.ts -t "inspection"
~~~

Expected: nonzero exit because inspectProjectionStore is not exported.

- [ ] **Step 3: Implement inspection**

Use openStoreForInspection. An absent .aih/methodology/v1 returns state empty. A valid activation must parse through the strict schema, have generation equal generations/<manifestDigest>/content, bind a receipt whose exact bytes hash to receiptDigest, and reference a generation whose complete tree equals the receipt.

Return drifted for owned but changed state; return failed-closed for unsafe containment, malformed ownership, links, inaccessible state, or exceeded bounds. Never select another generation as fallback.

- [ ] **Step 4: Run inspection, methodology, typecheck, and lint**

Run:

~~~sh
npm test -- --run tests/methodology/generation-store.test.ts
npm test -- --run tests/methodology
npm run typecheck
npm run lint
~~~

Expected: all named tests pass.

- [ ] **Step 5: Commit Task 4**

Run:

~~~sh
git add src/methodology/generation-store.ts tests/methodology/generation-store.test.ts tests/methodology/generation-store-fixtures.ts
git -c commit.gpgsign=false commit -s -m "feat(methodology): inspect generation store drift"
~~~

### Task 5: Explicit apply, deterministic generations, and atomic activation

**Files:**
- Modify: src/methodology/generation-store.ts
- Modify: tests/methodology/generation-store.test.ts
- Modify: tests/methodology/generation-store-fixtures.ts

**Interfaces:**
- Consumes: validated ApplyProjectionInput, owned store, lock, exact I/O, and inspection.
- Produces: applyProjection and internal applyProjectionWithRuntime used by failure tests.

- [ ] **Step 1: Write failing happy-path and refusal tests**

Add tests for:

- first explicit apply writes exact NUL/non-UTF-8 payload bytes to canonical targets;
- staging and generated content use private/non-executable permissions where POSIX exposes modes;
- receipt, generation path, and activation are byte-identical across two stores with a fixed rootId fixture and across input payload order;
- exact reapply returns already-active and performs no content rewrite;
- a second plan creates a second content-addressed generation without editing the first and changes only active.json;
- the old generation remains exact after activation;
- the active plus all completed inactive generations consume one shared persistent-history budget, a candidate fitting the exact remaining capacity passes, and one entry/directory/byte beyond it blocks before journal or scratch creation;
- stale expectedActiveDigest blocks before staging;
- blocked Phase 3 result, digest drift, payload coverage failure, resource overflow, destination collision, incomplete existing generation, malformed existing root, and active drift all fail before activation;
- no write reaches the outside canary;
- every apply result reports writeCapability aih-owned-project-root; no result implies provider, host, network, package-manager, or CLI capability; and
- exact pending apply/clean work is recovered before a new transaction, while uncertain pending state prevents all new mutation.

- [ ] **Step 2: Run apply tests and observe the missing behavior**

Run:

~~~sh
npm test -- --run tests/methodology/generation-store.test.ts -t "apply"
~~~

Expected: failing assertions because applyProjection has no applied path.

- [ ] **Step 3: Implement the apply journal and staging**

The internal fault-point union is fixed and is not part of public input:

~~~ts
export type ApplyFaultPoint =
  | "after-journal-prepared"
  | "after-stage-created"
  | "after-stage-verified"
  | "after-generation-reserved"
  | "after-generation-content"
  | "after-receipt-written"
  | "before-activation-rename"
  | "after-activation-rename"
  | "after-journal-committed";

type GenerationStoreRuntime = Readonly<{
  onFaultPoint: (point: ApplyFaultPoint | CleanFaultPoint) => void;
  lockRuntime: LockRuntime;
}>;
~~~

Production uses a frozen no-op onFaultPoint. Tests import the internal function directly; src/index.ts does not export it.

Apply validates all input before opening apply mode, acquires the lock, and invokes recoverPendingTransactionsUnderLock. Recovery must classify and finish every exact pending apply/clean record and its bound remnants; any blocked, failed-closed, over-limit, unjournaled, or residual state returns without starting a new transaction. Only a clean inventory permits re-reading expected activation, verifying active plus complete history through one shared persistent budget, proving the candidate fits the remaining capacity, atomically creating the prepared journal through its bounded non-authoritative sibling temporary, and materializing private scratch.

- [ ] **Step 4: Implement content-addressed materialization and activation**

Build staging first under private trash/<transactionId> scratch: write staging.json and exact content exclusively, verify the whole container, then atomically rename the complete directory to staging/<transactionId>. If generations/<manifestDigest> already exists, reuse only an exact complete owned generation. Otherwise recreate private trash/<transactionId> scratch, copy only revalidated staged bytes, write receipt.json, verify the whole generation container, and atomically rename the complete directory to the absent generations/<manifestDigest>. Never create incomplete.json in the reset flow and never create content or receipt children directly under the final generation directory. The retained journal phase name generation-reserved is a state-machine label only.

Construct active.json from the manifest digest, deterministic receipt digest, and generations/<digest>/content. Write it only through the bound .active.<transactionId>.tmp path and call writeAtomicRecord. Journal phase updates similarly use the exact derived next-phase temporary. These temporaries are non-authoritative and recovery never parses or adopts their contents: it may discard only a deterministically path/phase/transaction-bound, stable private single-link ordinary temporary, recognize the authoritative already-renamed final record, or fail closed and retain uncertainty. Re-read activation and generation before marking the journal committed. Do not edit or remove the prior active generation. Before the activation rename the old selection is unchanged; at or after it, readers may observe complete old or complete new selection bytes while the prior generation bytes remain intact.

- [ ] **Step 5: Run apply tests and existing methodology tests**

Run:

~~~sh
npm test -- --run tests/methodology/generation-store.test.ts
npm test -- --run tests/methodology
npm run typecheck
npm run lint
~~~

Expected: all named tests pass.

- [ ] **Step 6: Commit Task 5**

Run:

~~~sh
git add src/methodology/generation-store.ts tests/methodology/generation-store.test.ts tests/methodology/generation-store-fixtures.ts
git -c commit.gpgsign=false commit -s -m "feat(methodology): apply immutable generations"
~~~

### Task 6: Crash recovery and failure injection

**Files:**
- Modify: src/methodology/generation-store.ts
- Create: tests/methodology/generation-store-recovery.test.ts
- Create: tests/methodology/helpers/generation-store-child.ts
- Modify: tests/methodology/generation-store-fixtures.ts

**Interfaces:**
- Consumes: apply journal/fault points from Task 5.
- Produces: recoverProjectionStore and finite child actions apply, recover, hold-lock, read-activation, and crash-at.

- [ ] **Step 1: Write failing in-process failure tests**

For every ApplyFaultPoint, throw a fixed injected error. Assert:

- before activation rename, the old activation and old generation remain exact;
- after activation rename, active.json is complete old or complete new, never malformed;
- uncertain/malformed remnants remain and produce fixed findings;
- exact owned staging and ordinary bounded transaction-bound unpublished scratch remnants are removed only through recovery;
- recovery is idempotent and never reads provider bytes;
- aggregate persistent history at the exact shared budget recovers, while one entry/directory/byte beyond it fails closed before any pending cleanup;
- no fallback generation is selected;
- a lexically earlier 129th pending/quarantine entry fails closed before any cleanup; and
- unjournaled staging/trash, unsafe or uncertain scratch, unexpected recognition-only incomplete-generation residue, linked/hard-linked/type/permission/identity-uncertain temporaries, or filename/record mismatches remain untouched and fail closed.

- [ ] **Step 2: Write failing child-process interruption tests**

The helper reads one bounded JSON request from a test-owned file, invokes only Phase 4 internal APIs, writes READY to stdout, and exits or kills itself at the named fault point. It rejects any project root outside the OS temporary directory.

Spawn it with:

~~~ts
const child = spawnSync(
  process.execPath,
  ["--import", "tsx", helperPath, requestPath],
  {
    encoding: "utf8",
    timeout: 30_000,
    windowsHide: true,
  },
);
~~~

Each enclosing test uses a 60_000 ms timeout. Exercise termination at every apply fault point, then invoke recovery in a fresh process and assert the old/new activation rules and outside canary.

- [ ] **Step 3: Run recovery tests and observe failures**

Run:

~~~sh
npm test -- --run tests/methodology/generation-store-recovery.test.ts
~~~

Expected: nonzero exit because recoverProjectionStore and child actions are incomplete.

- [ ] **Step 4: Implement deterministic recovery**

Under the lock, lexically stream one combined pending-state inventory across transaction records, staging directories, trash directories, lock candidates/stale quarantines, unexpected recognition-only generation incomplete markers, and transaction-bound temporary records. Increment before collection and stop at the 129th item with failed-closed before mutation. Parse strict authoritative names and records, but never parse temporary contents. Bind authoritative objects to rootId, transactionId/token/manifestDigest, exact filename, operation, and journal. An unjournaled or mismatched staging/trash/incomplete object is uncertain: retain it and fail closed. A lock candidate is handled only by the separate strict owner/PID protocol.

Before removing any pending state, inspect the active and every completed inactive generation using one shared StoreWalkBudget. Do not reset the budget per generation. Over-limit persistent history fails closed without mutation.

For apply records:

- old activation exact means uncommitted; remove only exact owned staging and ordinary bounded journal-bound unpublished scratch. Recognition-only incomplete residue may be removed only when the existing journal and strict record bind it exactly; it is never adopted or published;
- new activation exact plus verified referenced generation means committed; complete bookkeeping;
- any other activation or invalid generation fails closed and leaves all uncertain objects.

For clean records, bind trash/<transactionId> and its expected receipt entries before resuming exact subset deletion; active or ambiguous identity retains everything. Deterministic .active.<transactionId>.tmp and journal next-phase temporaries are non-authoritative debris. Recovery uses only their deterministic path/phase/transaction relationship plus stable private single-link ordinary-file identity to decide whether they are discardable; it never parses them, derives state from their bytes, or chooses a temporary as a fallback source of truth. Linked, hard-linked, non-regular, permission-drifted, identity-uncertain, unexpected, or unbound temporaries remain and fail closed.

For partial cleanup verification, missing expected leaves are allowed, but every remaining descendant must be an expected regular file/directory with matching digest, size, device, identity, type, link count, and no extras. Remove exact journals, staging, transaction-bound scratch/trash, recognition-only incomplete residue, or bounded non-authoritative temporaries only after their state is classified under the rules above. Re-run the inventory after recovery; any residual pending object blocks starting later work.

- [ ] **Step 5: Run recovery, methodology, typecheck, and lint**

Run:

~~~sh
npm test -- --run tests/methodology/generation-store-recovery.test.ts
npm test -- --run tests/methodology
npm run typecheck
npm run lint
~~~

Expected: all named tests pass and every child process finishes within its bound.

- [ ] **Step 6: Commit Task 6**

Run:

~~~sh
git add src/methodology/generation-store.ts tests/methodology/generation-store-recovery.test.ts tests/methodology/helpers/generation-store-child.ts tests/methodology/generation-store-fixtures.ts
git -c commit.gpgsign=false commit -s -m "feat(methodology): recover interrupted projection"
~~~

### Task 7: Fail-closed exact-generation clean

**Files:**
- Modify: src/methodology/generation-store.ts
- Modify: tests/methodology/generation-store-recovery.test.ts
- Modify: tests/methodology/helpers/generation-store-child.ts
- Create: tests/methodology/generation-store-platform.test.ts

**Interfaces:**
- Consumes: inspection, lock, transaction records, exact/partial walks, and bounded deletion.
- Produces: cleanProjectionGeneration and clean recovery phases.

- [ ] **Step 1: Write failing clean and drift tests**

Test exact inactive clean, active-generation refusal, unknown generation retention, malformed receipt retention, byte drift retention, missing content retention, extra descendant retention, symlink retention, hard-link retention, junction/reparse retention on Windows, outside-root realpath retention, deletion error quarantine, interruption after quarantine, partial-delete recovery, repeated clean, and outside canary preservation.

The clean fault points are exact:

~~~ts
export type CleanFaultPoint =
  | "after-clean-journal-prepared"
  | "before-clean-quarantine"
  | "after-clean-quarantine"
  | "during-clean-delete"
  | "after-clean-delete";
~~~

- [ ] **Step 2: Run clean tests and observe failures**

Run:

~~~sh
npm test -- --run tests/methodology/generation-store-platform.test.ts -t "clean"
~~~

Expected: failing assertions because cleanProjectionGeneration has no cleaned path.

- [ ] **Step 3: Implement exact clean and quarantine recovery**

Acquire the lock, invoke recoverPendingTransactionsUnderLock, require an empty post-recovery inventory, and then verify the requested digest, current activation, root ownership, deterministic receipt, and complete generation tree. If pending work, drift, or any uncertainty exists, return retained or failed-closed according to the normative mapping without renaming or deleting the generation.

For an exact inactive generation, atomically create the prepared clean journal through .<transactionId>.prepared.tmp in create mode; the bounded temporary remains non-authoritative and is never parsed or adopted. Rename the generation to trash/<transactionId>, update the journal, then delete only the verified relative entries bottom-up. If deletion fails, retain the trash remainder and journal. Recovery continues only when every remaining descendant is an expected subset with matching identity and bytes; otherwise it leaves the remainder.

- [ ] **Step 4: Add static platform attack fixtures**

Use Node APIs only:

- POSIX and Windows symbolic link to a sibling canary;
- regular-file hard link with nlink greater than one;
- Windows directory junction created with symlinkSync(target, link, "junction");
- case-folded destination collisions;
- a concurrent activation reader that accepts only complete old/new records.

Skip only the fixture a platform cannot create, with an explicit reason. The complementary CI lane must execute each platform-specific fixture.

- [ ] **Step 5: Run platform, recovery, methodology, typecheck, and lint**

Run:

~~~sh
npm test -- --run tests/methodology/generation-store-platform.test.ts tests/methodology/generation-store-recovery.test.ts
npm test -- --run tests/methodology
npm run typecheck
npm run lint
~~~

Expected on Linux: all portable and Linux cases pass; Windows junction cases report explicit platform skips. Windows and macOS CI must supply complementary results before the phase gate passes.

- [ ] **Step 6: Commit Task 7**

Run:

~~~sh
git add src/methodology/generation-store.ts tests/methodology/generation-store-recovery.test.ts tests/methodology/generation-store-platform.test.ts tests/methodology/helpers/generation-store-child.ts
git -c commit.gpgsign=false commit -s -m "feat(methodology): clean exact inactive generations"
~~~

### Task 8: Public boundary documentation and claim mapping

**Files:**
- Modify: CHANGELOG.md
- Modify: SECURITY.md
- Modify: STABILITY.md
- Modify: docs/ARCHITECTURE.md
- Modify: docs/CONTROL_MATRIX.md
- Modify: docs/THREAT_MODEL.md
- Modify: docs/commands.md

**Interfaces:**
- Consumes: the exact passing behavior and named tests from Tasks 1–7.
- Produces: public-safe baseline claims and one control-matrix row mapped to existing named tests.

- [ ] **Step 1: Write the documentation changes**

Add one Unreleased changelog entry that calls the generation store internal/unwired and does not claim shipped provider or host switching.

Add an architecture component/data-boundary paragraph for .aih/methodology/v1 content-addressed generations that the library never edits in place, whole-directory publication, and old/new activation. Add the owned layout to STABILITY.md with schemaVersion 1.

Add the baseline threat inclusion/exclusion verbatim to SECURITY.md and docs/THREAT_MODEL.md. State that same-user malicious writers require a separate authority-bound enterprise projector and that a same-process native addon is insufficient.

Add CM-27 to docs/CONTROL_MATRIX.md. Cite only exact named tests that exist after Tasks 1–7, including deterministic exact-byte apply, old/new activation, crash recovery, drift retention, active-clean refusal, outside canary, cooperative contention, and static link/junction cases.

Update docs/commands.md to keep methodology project dry-run and to explain that Phase 4 is an internal transaction boundary with no apply/clean CLI until later provider and host gates.

- [ ] **Step 2: Run docs lint and claim mapping**

Run:

~~~sh
npm run docs:lint
~~~

Expected: scanned Markdown files report 1 passed, 0 failed, 0 skipped. Every CM-27 test name resolves.

- [ ] **Step 3: Run command-surface regression**

Run:

~~~sh
npm test -- --run tests/contract/command-surface.test.ts tests/docs/readme-assets.test.ts
~~~

Expected: all tests pass and tests/contract/command-surface.json remains byte-identical.

- [ ] **Step 4: Commit Task 8**

Run:

~~~sh
git add CHANGELOG.md SECURITY.md STABILITY.md docs/ARCHITECTURE.md docs/CONTROL_MATRIX.md docs/THREAT_MODEL.md docs/commands.md
git -c commit.gpgsign=false commit -s -m "docs(methodology): define baseline projector boundary"
~~~

### Task 9: Completion gates, three-platform evidence, and independent review

**Files:**
- Modify only files identified by failing gates or actionable review findings.

**Interfaces:**
- Consumes: all prior tasks.
- Produces: one exact reviewed Phase 4 candidate and PHASE_4_GATE_PASS, or an honest fail-closed/platform-limited verdict.

- [ ] **Step 1: Run focused and repository gates**

Run in this order and retain full exit/output evidence:

~~~sh
npm test -- --run tests/methodology/generation-store-contract.test.ts tests/methodology/generation-store-fs.test.ts tests/methodology/generation-store-lock.test.ts tests/methodology/generation-store.test.ts tests/methodology/generation-store-recovery.test.ts tests/methodology/generation-store-platform.test.ts
npm test -- --run tests/methodology
npm run typecheck
npm run lint
npm run docs:lint
npm run verify
npm run build
git diff --check f289ef35c4965351f9238fc60d4e6f0b1d3ad955...HEAD
~~~

Expected: every command exits 0. Do not call the phase passed if any command is red.

- [ ] **Step 2: Verify boundary and scope mechanically**

Run:

~~~sh
git diff --name-status f289ef35c4965351f9238fc60d4e6f0b1d3ad955...HEAD
rg -n "child_process|execFile|spawn\(|fetch\(|https?://|node-gyp|\.node|host-launch|providerExecution: true|hostExecution: true" src/methodology/generation-store*.ts
git status --short
~~~

Expected: only planned source/tests/docs plus the approved design/plan; no forbidden production import or positive execution claim; clean worktree.

- [ ] **Step 3: Obtain same-SHA Linux, Windows, and macOS evidence**

Use the existing .github/workflows/ci.yml matrix. Do not add a native build, artifact upload, signing gate, or archived Phase 4A workflow. Each OS must run the exact candidate SHA. Record focused platform results and full CI outcome separately; no local Linux result substitutes for Windows/macOS.

A push or pull request is an external action and is not authorized by this plan document. Use an already granted active-conversation authorization or request one before exposing the candidate or triggering the pull-request matrix.

- [ ] **Step 4: Run four independent post-implementation reviews**

Run separate correctness, security/trust-boundary, filesystem/transaction specialist, and documentation/unsupported-claim reviews against the exact candidate SHA.

The security review must explicitly verify the documented exclusion and must not reintroduce malicious same-user race resistance as a baseline pass condition. It must still review path/link/reparse aliases observable through the bounded Node checks, path escape, stale plans, collision behavior, outside-root writes, and hostile bytes.

The filesystem specialist must review old/new activation atomicity, PID-bound non-authoritative pending candidates, lock cooperation, crash states, atomic-create journals, non-authoritative temporary discard rules, verified scratch-directory publication, recognition-only incomplete residue, shared persistent-history/recovery budgets, exact-tree drift, clean quarantine, bootstrap fail-closed behavior, and all three OS results.

The documentation reviewer must reject tamper-proof, installed, host-active, isolated, switchable, concurrent, conflict-free, live-session, provider-qualified, or host-qualified claims.

- [ ] **Step 5: Resolve every actionable finding test-first**

For each valid finding, first add or strengthen the reproducing test, run it red, make the smallest implementation correction, rerun affected gates, and repeat the relevant review. Do not weaken the threat model, suppress a test, or broaden mutation authority to obtain a pass.

- [ ] **Step 6: Commit final review corrections**

Stage only explicit changed paths and use:

~~~sh
git -c commit.gpgsign=false commit -s -m "fix(methodology): close phase four review findings"
~~~

Skip this commit only when no review correction exists.

- [ ] **Step 7: Issue the gate verdict**

Issue PHASE_4_GATE_PASS only when all local gates, same-SHA three-OS CI, four independent reviews, and public documentation pass with no unresolved actionable finding.

If an operating system cannot provide complete old/new activation or bounded baseline semantics under the approved cooperative threat model, return a precise platform-limited decision. If the baseline cannot preserve containment, intact previously selected generation bytes during apply failure, and complete old-or-new activation without reintroducing the rejected stronger contract, return fail-closed and stop before Phase 5.
