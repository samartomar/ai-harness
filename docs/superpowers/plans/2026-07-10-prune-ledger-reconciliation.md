# Scoped ECC Prune Reconciliation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. The active session policy forbids subagent dispatch, so execute inline.

**Goal:** Make `aih prune` reconcile missing scoped-ECC project registrations, remove orphaned managed target operations, and commit target state plus the primary ledger fail-closed and ledger-last.

**Architecture:** Add a pure reconciliation layer that reduces the strict registration ledger and filters recorded ECC install operations through G1's materialization selector. A separate local Node transaction driver applies precomputed, hash-bound removals and state rewrites with rollback; `src/prune/index.ts` appends that driver after existing whole-target cleanup and before the digest.

**Tech Stack:** TypeScript, Zod, Node.js filesystem/crypto/path APIs, Vitest, the existing `Plan`/`ExecAction` model, ECC install-state v1 fixtures.

## Global Constraints

- `~/.aih/ecc/registration-ledger.json` remains the primary enrollment store and is written last.
- Missing roots alone retire a project; symlinks, non-directories, and filesystem errors fail closed.
- Never infer ownership from a filename. Only strict install-state operations with `ownership: "managed"` may mutate a target.
- Never add target content during prune; only retain or remove previously recorded operations.
- Preserve user content outside explicit JSON subsets and Codex managed markers.
- Dry-run performs no writes; apply is rollback-safe and rejects plan/apply hash drift.
- No real dev-seat HOME mutation. All integration tests use disposable roots.
- Existing stale-CLI prune behavior and flags remain compatible.

---

### Task 1: Pure live-ledger reconciliation

**Files:**
- Create: `src/ecc/reconcile.ts`
- Create: `tests/ecc/reconcile.test.ts`

**Interfaces:**
- Consumes: `RegistrationLedger`, `ProjectRegistration`, `machineRegistrationUnion()` from `src/ecc/registration.ts`.
- Produces: `reconcileEccRegistrationLedger(ledger, options): EccLedgerReconciliation` and `eccInstallStateCandidates(home, reconciliation): EccInstallStateCandidate[]`.

- [ ] **Step 1: Write the failing live-union tests**

```ts
it("retires only missing projects and filters each target to the live union", () => {
  const result = reconcileEccRegistrationLedger(ledger, {
    projectStatus: (root) => (root === cpp ? "missing" : "live"),
  });
  expect(result.retiredProjects).toEqual([cpp]);
  expect(result.desired.components).toEqual(["baseline:rules", "framework:react", "lang:typescript"]);
  expect(result.ledger.targets[0]?.components.map(({ id }) => id)).not.toContain("lang:cpp");
});

it("keeps shared components until their last live contributor is gone", () => {
  const result = reconcileEccRegistrationLedger(sharedLedger, {
    projectStatus: (root) => (root === first ? "missing" : "live"),
  });
  expect(result.desired.components).toContain("skill:coding-standards");
});

it("preserves existing target components while any live project has full scope", () => {
  expect(reconcileEccRegistrationLedger(fullLedger, liveOptions).full).toBe(true);
});
```

- [ ] **Step 2: Run the tests and verify RED**

Run: `npm test -- --run tests/ecc/reconcile.test.ts`

Expected: FAIL because `src/ecc/reconcile.ts` does not exist.

- [ ] **Step 3: Implement strict project classification and ledger reduction**

```ts
export type EccProjectStatus = "live" | "missing";

export interface EccLedgerReconciliation {
  prior: RegistrationLedger;
  ledger: RegistrationLedger;
  desired: RegistrationUnion;
  retiredProjects: string[];
  full: boolean;
  removedComponents: EccComponentId[];
  removedMcps: EccMcpComponentId[];
}

export function reconcileEccRegistrationLedger(
  ledger: RegistrationLedger,
  options: { projectStatus?: (root: string) => EccProjectStatus; droppedTargets?: readonly Cli[] } = {},
): EccLedgerReconciliation {
  // Classify every root first; any throw aborts before reduction.
  // Retain live projects, compute the union, and filter—never add—target records.
}
```

The default classifier uses `lstatSync`: `ENOENT` is missing; a symlink,
non-directory, or any other error throws `AihError("AIH_CONFIG")`.

- [ ] **Step 4: Add candidate-path and unsafe-root tests, then implement the closed target map**

```ts
expect(eccInstallStateCandidates(home, result)).toContainEqual({
  target: "codex",
  root: join(home, ".codex"),
  statePath: join(home, ".codex", "ecc-install-state.json"),
  scope: "home",
});
```

Candidate locations must match the design table exactly and must be returned in
stable target/root/path order. Project candidates are generated only for live
roots and target records present in the reconciled ledger.

- [ ] **Step 5: Run GREEN and commit**

Run: `npm test -- --run tests/ecc/reconcile.test.ts`

Expected: PASS.

Commit: `feat: compute live ECC registration union`

---

### Task 2: Strict install-state differential

**Files:**
- Modify: `src/ecc/materialize.ts`
- Modify: `src/ecc/reconcile.ts`
- Modify: `tests/ecc/materialize.test.ts`
- Modify: `tests/ecc/reconcile.test.ts`

**Interfaces:**
- Consumes: `EccComponentSelection`, `eccComponentInstallDescriptor()`.
- Produces: `eccManifestOperationSelected(operation, selection): boolean`, `parseEccInstallState(text, path): EccInstallState`, and `reconcileEccInstallState(state, selection): EccInstallStateReconciliation`.

- [ ] **Step 1: Write RED tests for the shared G1 selector**

```ts
expect(eccManifestOperationSelected(cppSkillOperation, reactSelection)).toBe(false);
expect(eccManifestOperationSelected(reactSkillOperation, reactSelection)).toBe(true);
expect(eccManifestOperationSelected(codexScopedSkillOperation, reactSelection)).toBe(true);
expect(eccManifestOperationSelected(anyOperation, fullSelection)).toBe(true);
```

Run: `npm test -- --run tests/ecc/materialize.test.ts`

Expected: FAIL because the predicate is not exported.

- [ ] **Step 2: Export the predicate and keep `filterEccManifestPlan` delegating to it**

```ts
export function eccManifestOperationSelected(
  operation: EccManifestOperation,
  selection: EccComponentSelection,
): boolean {
  if (selection.scope === "full") return true;
  return selectedOperation(operation, selectedInstallSurface(selection));
}
```

- [ ] **Step 3: Write RED state-schema and differential tests**

```ts
const result = reconcileEccInstallState(parseEccInstallState(stateText, statePath), selection);
expect(result.removed.map((op) => op.destinationPath)).toEqual([cppDestination]);
expect(result.state.operations.map((op) => op.destinationPath)).toContain(reactDestination);

expect(() => parseEccInstallState(malformed, statePath)).toThrow(/invalid ECC install state/i);
expect(() => reconcileEccInstallState(duplicateDestinationState, selection)).toThrow(/duplicate destination/i);
expect(() => reconcileEccInstallState(unsupportedState, selection)).toThrow(/unsupported/i);
```

- [ ] **Step 4: Implement the strict v1 parser and filter**

Validate `schemaVersion`, target identity/root/state path, request/source metadata,
and every operation's kind/module/source/destination/strategy/ownership/scaffold
fields. Preserve additional upstream operation rollback metadata in the returned
JSON object. Only `copy-file` and `merge-json` are accepted for scoped states.

Return:

```ts
export interface EccInstallStateReconciliation {
  priorText: string;
  state: EccInstallState;
  kept: EccInstallOperation[];
  removed: EccInstallOperation[];
  nextText: string;
}
```

- [ ] **Step 5: Run GREEN and commit**

Run: `npm test -- --run tests/ecc/materialize.test.ts tests/ecc/reconcile.test.ts`

Expected: PASS.

Commit: `feat: diff scoped ECC install states`

---

### Task 3: Hash-bound rollback transaction driver

**Files:**
- Create: `src/ecc/reconcile-driver.ts`
- Create: `tests/ecc/reconcile-driver.test.ts`

**Interfaces:**
- Consumes: precomputed `EccReconcileTransactionPayload` containing expected SHA-256 reads, safe roots, operation removals, target-state writes, optional Codex managed-surface intent, and final ledger bytes.
- Produces: `eccReconcileTransactionAction(ctx, payload): ExecAction`.

- [ ] **Step 1: Write a RED real-subprocess success test**

Create a disposable home with React/common/C++ managed files, strict state, Codex
managed blocks, and a two-project ledger. Build the transaction payload and spawn
the returned local Node action.

```ts
expect(result.status, result.stderr).toBe(0);
expect(existsSync(cppSkill)).toBe(false);
expect(readFileSync(reactSkill, "utf8")).toBe("react\n");
expect(JSON.parse(readFileSync(statePath, "utf8")).operations).toHaveLength(1);
expect(readRegistrationLedger(home).projects.map(({ root }) => root)).toEqual([react]);
```

Run: `npm test -- --run tests/ecc/reconcile-driver.test.ts`

Expected: FAIL because the driver does not exist.

- [ ] **Step 2: Implement payload validation, plan/apply hash checks, and path safety**

The embedded script must:

```js
const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
for (const expected of payload.reads) {
  const bytes = fs.readFileSync(expected.path);
  if (sha256(bytes) !== expected.sha256) throw new Error("ECC prune input changed after planning");
}
```

Reject symlink parents/destinations, paths outside each declared canonical root,
non-regular copy-file destinations, unsupported operations, and malformed marker
pairs before creating any backup.

- [ ] **Step 3: Implement reversible sibling backups and ledger-last commit**

For each changed path, rename the original to an exclusive UUID sibling backup.
Write replacements via exclusive `0600` temp files and bounded transient rename
retry. Leave removals backed up until all state files are replaced. Replace the
ledger only after all other mutations succeed. On any throw, restore paths in
reverse order and rethrow. Remove backups only after ledger success.

- [ ] **Step 4: Add RED/GREEN rollback, retry, JSON-subset, and idempotency tests**

Use `NODE_OPTIONS=--require=<preload>` to inject a non-transient `EIO` after one
mutation and a one-shot transient `EPERM` rename. Assert complete byte restoration
for the failure, success for transient retry, user JSON keys retained, and a second
apply byte-identical with no leftover transaction files.

Run: `npm test -- --run tests/ecc/reconcile-driver.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

Commit: `feat: apply ECC prune reconciliation atomically`

---

### Task 4: Plan builder and `aih prune` integration

**Files:**
- Modify: `src/ecc/reconcile.ts`
- Modify: `src/prune/index.ts`
- Modify: `tests/prune/command.test.ts`
- Modify: `tests/ecc/reconcile.test.ts`

**Interfaces:**
- Produces: `eccPruneReconciliationActions(ctx, droppedTargets): Action[]`.
- Integration point: `prunePlan()` appends reconciliation actions after existing whole-target cleanup actions and before the final digest.

- [ ] **Step 1: Write RED dry-run command tests**

```ts
const result = await command.plan(ctx({ HOME: home }));
expect(result.actions).toContainEqual(expect.objectContaining({
  kind: "digest",
  describe: "ECC component registration reconciliation",
}));
expect(result.actions).toContainEqual(expect.objectContaining({
  kind: "exec",
  describe: expect.stringContaining("ledger-last"),
}));
expect(readFileSync(ledgerPath, "utf8")).toBe(before);
```

Also pin absence/no-op behavior, malformed ledger failure, stable sorted digest,
and dropped-target de-duplication.

- [ ] **Step 2: Build selections and transaction payloads from existing state**

For each target, derive a selection only from its reconciled ledger record:

```ts
const selection: EccComponentSelection = {
  scope: reconciliation.full ? "full" : "scoped",
  components: target.components.map(({ id }) => id),
  mcps: target.mcps,
  recommendations: [],
};
```

Read existing candidates with one regular-file read, validate target/root/path
identity, compute state differentials, group JSON subset removals by destination,
and hash every planned input. Add Codex upstream state and
`ecc-aih-install-state.json` as separate hash-bound records.

- [ ] **Step 3: Wire the action after existing target cleanup**

```ts
actions.push(...eccPruneReconciliationActions(ctx, set.dropped));
actions.push(digest(headline, contextBody(...), set));
```

When `set.dropped` includes a target, omit component mutation for that target and
remove its aggregate target record from the final ledger because existing prune
already performs the whole-target uninstall.

- [ ] **Step 4: Run prune/ECC regression tests and commit**

Run: `npm test -- --run tests/prune tests/ecc`

Expected: PASS.

Commit: `feat: reconcile ECC ledger during prune`

---

### Task 5: Public contract and verification

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `README.md`
- Modify: `STABILITY.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/CONTROL_MATRIX.md`
- Modify: `docs/commands.md`
- Modify: `docs/security/baseline-evidence.md`
- Modify: `tests/contract/command-surface.json` only if help text changes

**Interfaces:**
- Public contract: dry-run/apply semantics, ledger primary-store carve-out, fail-closed ownership proof, and ledger-last transaction.

- [ ] **Step 1: Update `[Unreleased]` and command/help documentation**

Add an explicit #409 changelog entry. Remove G1 wording that says the ledger is
only a future prune input. Document missing-root classification, retained shared
components, strict state ownership, dry-run digest, and apply rollback.

- [ ] **Step 2: Update architecture, stability, security, and control evidence**

Add exact test names to `CONTROL_MATRIX.md`; do not claim a published version.

- [ ] **Step 3: Run focused documentation and contract gates**

Run:

```bash
npm run docs:lint
npm test -- --run tests/contract tests/prune tests/ecc
npm run typecheck
npm run lint
```

Expected: all pass.

- [ ] **Step 4: Run security and graph review**

Review every new path mutation, argv payload, marker parser, JSON subset removal,
and rollback branch. Refresh:

```bash
code-review-graph update --repo . --base b5bdafbfb59613567c601c4630e15c62fdfbce4d --brief
```

- [ ] **Step 5: Run the authoritative gate**

Run:

```bash
npm run verify
npm audit --audit-level=high
```

Expected: all checks pass and 0 vulnerabilities.

- [ ] **Step 6: Commit docs, open PR, and merge green**

Commit: `docs: explain scoped ECC prune reconciliation`

Push `feat/409-prune-ledger-reconciliation`; open a ready PR that closes #409,
uses milestone `scoped-ecc-baselines`, and carries exactly `semver:minor` plus
`contract:additive`. Record TDD, rollback, cross-platform, security, and graph
evidence. Inspect every failed check before correction. Merge only after the
current head is fully green.
