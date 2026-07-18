# Passive Methodology Projection Phase 4 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use test-driven-development and executing-plans to implement this plan task-by-task. Run the independent review lanes only after the implementation and required local gates are complete.

**Goal:** Test whether a bounded, deterministic apply/clean transaction library can satisfy the unchanged Phase 4 trust contract without depending on the Phase 4A native addon.

**Candidate architecture (rejected):** `transaction.ts` mints an opaque capability backed by closure-private metadata, a root descriptor where Node exposes one, a random in-memory authority key, and an exact root identity. Apply replans the supplied Phase 3 planner input, validates exact payload bytes, writes a projection through Node pathnames, and publishes the receipt last as a logical marker. Clean attempts to verify the capability, receipt authentication, managed tree, and ownership before pathname removal. Fixed scalar fault points exercise same-process exception handling. Independent review proved that these measures do not bind ancestor identity, deletion authority, crash recovery, or containment.

**Tech Stack:** TypeScript ESM, Node.js 22 built-ins, the existing Phase 3 planner contract, Vitest, Biome. No new dependency, native call, CLI integration, process launch, or network activity.

## Outcome

`PHASE_4_GATE_FAIL_CLOSED`. The implementation and repository gates completed, but the
candidate is rejected feasibility evidence and must not ship, merge, or become a Phase 5
base.

Independent correctness, security, and filesystem-specialist probes reproduced two decisive
containment failures under the unchanged same-UID substitution threat:

- apply followed a concurrently substituted ancestor into a sibling disposable root and
  could return `applied` after writing there; and
- clean could operate on a substituted tree or return `cleaned` after the authentic managed
  bytes had been moved outside the capability root.

The candidate also lacks identity-bound ancestor mutation, staged no-replace atomic
publication, parent-directory durability, restart-authenticatable recovery, exact-tree replay
validation, and device/volume binding. These are architectural failures, not missing green
tests. Passing would require weakening the locked trust rules, so no such fallback is made.

The experiment establishes that ordinary Node pathname APIs do not make the Phase 4A native
authority problem unnecessary. Phase 5 and Phase 6 remain blocked.

## Required Constraints

The following are the unchanged qualification constraints used to evaluate the candidate. The
outcome above records where the implementation failed them.

- Branch from exact reviewed Phase 4A public SHA `232cfd7ade01713461152e5303ceb919af54ecf7` and keep Phase 4 a separate review unit.
- Production changes are limited to `src/methodology/transaction.ts`; tests live in `tests/methodology/transaction.test.ts`. This plan and the dedicated three-OS evidence workflow are the only supporting additions.
- Writes are possible only through a live capability returned by `createSyntheticTransactionCapability()`; no API accepts an arbitrary root pathname.
- The capability root is created below the canonical OS temporary directory, is private on POSIX, and is identity-checked before and after every transaction boundary.
- Apply accepts only a Phase 3 input that independently replans to `state: "planned"`; it does not accept a caller-asserted digest or forged plan result.
- Exact UTF-8 payload bytes must bind one-to-one to the manifest entries and their SHA-256 content digests.
- Receipt authentication binds the capability, manifest digest, owner, canonical targets, exact content digests, byte lengths, transaction version, and false-only claims.
- Commit is logical receipt publication after all payloads and metadata are durable. Pre-receipt content is never described as committed.
- Clean is path-ownership revocation inside the capability root, not global byte erasure. It refuses observed links, identity drift, unexpected entries, and content drift.
- The unchanged trust contract includes concurrent same-UID substitution. The candidate failed
  that boundary and is rejected; absence of an isolation or concurrency claim does not weaken
  the containment requirement.
- No provider source read/fetch/execute, host activity, package-manager activity, CLI apply/clean, executor wiring, home/repository/host-native path, or Phase 5/6 work.
- Signing and public-key distribution are administrative provenance and are not inputs to the filesystem experiment or Phase 4 transaction decision.

---

### Task 1: Closed transaction contracts and opaque authority

**Files:**

- Create: `src/methodology/transaction.ts`
- Create: `tests/methodology/transaction.test.ts`

**Interfaces:**

- Produces: `SyntheticTransactionCapability`, `createSyntheticTransactionCapability()`, `ApplySyntheticTransactionRequestSchema`, `CleanSyntheticTransactionRequestSchema`, `SyntheticTransactionReceiptSchema`, and `SyntheticTransactionResultSchema`.
- The schema facade exposes synchronous `parse` and `safeParse`; it snapshots own data properties into hook-resistant closed records and rejects proxies, accessors, custom prototypes, unknown keys, sparse arrays, cycles, and oversized input.
- The capability surface is exactly `{ root, dispose }`, frozen, and accepted only when its object identity exists in the module-private `WeakMap`.

- [x] **Step 1: Write failing schema and authority tests**

```ts
it("rejects forged, disposed, accessor-backed, proxy, and unknown-key capability inputs", () => {
  const capability = createSyntheticTransactionCapability();
  expect(() => applySyntheticTransaction({ ...validRequest, capability: { ...capability } })).not.toSucceed();
  capability.dispose();
  expect(() => applySyntheticTransaction({ ...validRequest, capability })).not.toSucceed();
});
```

- [x] **Step 2: Run the focused file and witness RED**

Run: `npm test -- tests/methodology/transaction.test.ts`

Expected: failure because `src/methodology/transaction.ts` and its exports do not exist.

- [x] **Step 3: Implement only the closed schemas, bounded snapshot, and capability mint/revoke path**

The capability root is created with `mkdtempSync(join(realpathSync(tmpdir()), "aih-methodology-transaction-"))`. Store `{ root, tempRoot, descriptor, identity, authorityKey, disposed }` only in private module state. `dispose()` revokes authority and closes its descriptor; it performs no pathname cleanup.

- [x] **Step 4: Run the focused tests and witness GREEN**

Run: `npm test -- tests/methodology/transaction.test.ts`

Expected: schema/authority tests pass and no out-of-root path exists.

### Task 2: Exact-byte apply and receipt-last commit

**Files:**

- Modify: `src/methodology/transaction.ts`
- Modify: `tests/methodology/transaction.test.ts`

**Interfaces:**

```ts
export type ApplySyntheticTransactionRequest = {
  schemaVersion: 1;
  capability: SyntheticTransactionCapability;
  plannerInput: unknown;
  payloads: ReadonlyArray<{ artifactId: string; target: string; content: string }>;
};

export function applySyntheticTransaction(
  value: unknown,
  options?: Readonly<{ faultAt?: ApplyFaultPoint }>,
): SyntheticTransactionResult;
```

- Replan `plannerInput`; require `planned` and every boundary flag false.
- Require one payload for every manifest entry, exact artifact/target equality, bounded UTF-8 bytes, and matching SHA-256.
- Acquire `.aih-methodology.lock` exclusively, create `.aih-methodology-projection` exclusively, create target parents component-by-component, and write each file through `O_CREAT | O_EXCL | O_NOFOLLOW` where available.
- Validate descriptor/path identity, regular-file type, link count `1`, size, and digest before proceeding.
- Write and sync `.aih-methodology-receipt.json` last; its presence and successful validation is the only committed state.

- [x] **Step 1: Add failing apply tests** for exact bytes, deterministic receipt, reordered request determinism, digest mismatch, missing/duplicate/extra payloads, aliases, pre-existing entries, root drift, symlink/reparse point, hard link, and idempotent replay.
- [x] **Step 2: Run and witness RED** with `npm test -- tests/methodology/transaction.test.ts`.
- [x] **Step 3: Implement minimal apply behavior** with no native-feasibility import and no recursive/glob writer.
- [x] **Step 4: Run and witness GREEN** with the same command.

### Task 3: Apply rollback and deterministic recovery

**Files:**

- Modify: `src/methodology/transaction.ts`
- Modify: `tests/methodology/transaction.test.ts`

**Interfaces:**

```ts
export type ApplyFaultPoint =
  | "after-root-validation"
  | "after-lock"
  | "after-projection-create"
  | "after-entry-write"
  | "after-metadata-validation"
  | "before-commit"
  | "after-commit"
  | "during-rollback"
  | "during-recovery";
```

- Options are a closed scalar record. No callback, thenable, custom error, or caller code executes.
- Before commit, rollback removes only identities created by the current attempt, in reverse order. If any owned identity cannot be proved, retain the lock and write an authenticated `.aih-methodology-recovery.json` record.
- A later apply with the same live capability and exact request either validates the committed receipt idempotently or completes the recorded rollback before starting again.

- [x] **Step 1: Add one failing test per fault point**, including rollback interruption, root/entry substitution, and exact recovery-record binding.
- [x] **Step 2: Run and witness RED**.
- [x] **Step 3: Implement bounded rollback/recovery** without an intentional pathname fallback for an unverified entry. Independent review later proved the Node pathname architecture itself remains substitutable.
- [x] **Step 4: Run and witness GREEN**.

### Task 4: Bound clean to the authenticated receipt

**Files:**

- Modify: `src/methodology/transaction.ts`
- Modify: `tests/methodology/transaction.test.ts`

**Interfaces:**

```ts
export type CleanSyntheticTransactionRequest = {
  schemaVersion: 1;
  capability: SyntheticTransactionCapability;
  receipt: SyntheticTransactionReceipt;
};

export function cleanSyntheticTransaction(
  value: unknown,
  options?: Readonly<{ faultAt?: CleanFaultPoint }>,
): SyntheticTransactionResult;
```

```ts
export type CleanFaultPoint =
  | "after-root-validation"
  | "after-lock"
  | "after-recovery-record"
  | "after-receipt-revoke"
  | "during-entry-remove"
  | "during-directory-remove"
  | "before-recovery-remove"
  | "during-recovery";
```

- Validate the returned receipt authentication and exact on-disk receipt/tree before mutation.
- Publish authenticated clean recovery state, unlink the commit receipt first to revoke the logical projection, then remove only the receipt-listed regular files and now-empty managed directories.
- Unexpected content, identity drift, links, locked files, or a failed boundary returns `recovery-required` and preserves ownership/recovery evidence. Replaying exact clean resumes; a different receipt blocks.

- [x] **Step 1: Add failing clean and fault tests** for success, idempotency, stale/forged receipt, drift, unexpected content, symlink/reparse point, hard link, root substitution, and every clean fault. The independent review found that concurrent substitution and Windows locked-file coverage remained incomplete.
- [x] **Step 2: Run and witness RED**.
- [x] **Step 3: Implement minimal clean/recovery behavior**.
- [x] **Step 4: Run and witness GREEN**.

### Task 5: Boundary evaluation and completion gates

**Files:**

- Modify: `tests/methodology/transaction.test.ts`
- Create: `.github/workflows/methodology-phase-4-transactions.yml`

**Interfaces:**

- Static import proof: `transaction.ts` may import Node `crypto`, `fs`, `os`, `path`, `util/types`, and `./projection-planner.js`; it must not import `native-fs-feasibility`, child processes, network, CLI, executor, provider, host, package manager, or Phase 5/6 code.
- Dynamic containment proof: snapshot the checkout, home marker, sibling temporary root, and capability root; only the capability root may change.
- Claim evaluation: every result keeps the listed runtime and external-capability claims false.
  The candidate's `temporaryRootOnly: true` field was disproved by concurrent substitution and
  is an additional reason the candidate is rejected.

- [x] **Step 1: Add failing static/dynamic boundary tests** including module purity and zero native invocation.
- [x] **Step 2: Run focused transaction and methodology suites**:

```bash
npm test -- tests/methodology/transaction.test.ts
npm test -- tests/methodology
```

- [x] **Step 3: Run completion gates**:

```bash
npm run typecheck
npm run lint
npm run docs:lint
npm run verify
git diff --check 232cfd7ade01713461152e5303ceb919af54ecf7...HEAD
```

- [x] **Step 4: Run independent post-implementation reviews**: correctness/code, security/trust-boundary, filesystem/transaction specialist including Windows/macOS/Linux semantics, and documentation/unsupported-claim review. The reviews fail closed on architectural findings that cannot be repaired with Node pathname operations without weakening the locked trust rules. `PHASE_4_GATE_PASS` is not issued.

## Explicit Exclusions

- No CLI command or flag.
- No import or call into the Phase 4A native addon.
- No production transaction runtime may launch native builds, prebuilt binaries, runtime
  installers, package managers, subprocesses, workers, plugins, hooks, MCP, daemons,
  providers, or hosts. Development validation uses the repository's package scripts and the
  inherited explicit Phase 4A source build.
- No repository, home, global, provider-source, host-native, or caller-selected path mutation.
- No source rewriting or fallback projection.
- No installed, active, isolated, switchable, concurrent, conflict-free, secure-erasure, provider-qualified, or host-qualified claim.
- No Phase 5 mapping and no Phase 6 provider work.
