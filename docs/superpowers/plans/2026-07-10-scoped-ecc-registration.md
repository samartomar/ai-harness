# Scoped ECC Registration Implementation Plan

> **For Codex:** Execute this plan with the `executing-plans`, `test-driven-development`,
> `security-review`, `requesting-code-review`, and `verification-before-completion`
> skills. Keep every production change behind a witnessed RED test and commit the
> RED checkpoint before implementing GREEN.

**Goal:** Close #408 by making `aih ecc` install the additive union of the locked
common baseline, detected project riders, and repeatable `--with` declarations,
then persist the successful per-project contribution and per-target installed
union in a machine-scoped component ledger.

**Architecture:** Keep the evidence-gated, exact-pinned ECC acquisition and
single sequential installer introduced by #407. Derive a typed component
selection from `scanRepo`, posture, and advance declarations; request evidence
for each selected leaf or its signed containing module; materialize ECC's pinned
manifest plan; filter both its operations and state preview to that selection;
and write the versioned ledger atomically only after every target install exits
successfully. `--profile full` is the only full-install path. Unsupported targets
remain guidance-only.

**Tech stack:** TypeScript, Zod, Commander, Vitest, the existing `scanRepo`,
baseline-evidence authorization receipts, pinned ECC `createManifestInstallPlan`,
and the existing fail-closed verified install driver.

---

## Locked behavior carried into code

- Every posture defaults to common + project-required + validated MCP; an empty
  repo receives common plus explicit declarations, never full.
- The common baseline is the locked four modules, four leaf skills, and sixteen
  leaf agents. Stack riders add matching language/framework skills and reviewer
  or build-resolver agents; web riders add `e2e-runner` and
  `a11y-architect`.
- Security is default-on only at enterprise, recommended guidance at team, and
  opt-in at vibe. Hooks, vertical packs, continuous learning, and full are never
  automatic.
- MCP defaults are local `sequential-thinking`, repo-declared
  `code-review-graph`/`codebase-memory-mcp`, and `github` at team/enterprise.
  Egress MCPs such as Context7 and Exa never default on.
- `scanRepo` and repeatable `--with <component>` are co-equal writers. Re-running
  for another project adds to the machine union; it never removes another
  project's contribution.
- The primary ledger lives at `~/.aih/ecc/registration-ledger.json`. It records
  components rather than modules, carries #407 authorization provenance, is
  deterministic and versioned, and is written by atomic rename only after all
  installs succeed.
- An installed leaf is authorized by its own #407 receipt or a receipt for the
  signed module that contains its exact path. Missing or mismatched coverage
  preserves the existing posture rules and danger-class floor.

## Task 1: Repeatable command option contract

**Files:**

- Modify: `src/internals/plan.ts`
- Modify: `src/commands/index.ts`
- Modify: `src/ecc/index.ts`
- Modify: `tests/ecc/command.test.ts`
- Modify: `tests/contract/command-surface.json`

1. Add a failing command test that invokes `aih ecc --with tdd-workflow --with
   security-review` and proves `ctx.options.with` preserves both values in
   declaration order.
2. Add a failing registration test proving ordinary scalar/defaulted command
   options are unchanged and the command-surface fixture includes
   `--with <component>`.
3. Run `npx vitest run tests/ecc/command.test.ts
   tests/contract/command-surface.test.ts` and witness RED.
4. Commit the RED checkpoint with DCO signoff.
5. Add an explicit repeatable-value field to `CommandOption` and a Commander
   collector in `addOptionsForSpec`; register `--with <component>` on `ecc`.
6. Regenerate the additive command contract fixture with its existing helper and
   run the focused tests GREEN.

## Task 2: Pure component catalog and scoped selection

**Files:**

- Create: `src/ecc/components.ts`
- Modify: `src/ecc/select.ts`
- Create: `tests/ecc/components.test.ts`
- Modify: `tests/ecc/ecc.test.ts`

1. Add RED table tests for the exact common modules, four skills, sixteen
   agents, posture-modulated security, validated MCP defaults, React/TypeScript
   riders, a C++ repo with no invented language pack, an empty repo, stable
   ordering, duplicate declarations, unknown declarations, and explicit full.
2. Prove repeatable declarations and detected riders are additive, and prove an
   empty repo no longer sets `installEverything`.
3. Run `npx vitest run tests/ecc/components.test.ts tests/ecc/ecc.test.ts` and
   witness RED; commit the RED checkpoint.
4. Implement typed component IDs, the locked catalog/mappings, canonical name
   normalization, deterministic union selection, and actionable rejection of
   unknown declarations.
5. Replace the empty-repo full behavior in `eccLanguages` and run focused tests
   GREEN.

## Task 3: Versioned machine registration ledger

**Files:**

- Create: `src/ecc/registration.ts`
- Create: `tests/ecc/registration.test.ts`

1. Add RED tests for schema v1, canonical project-root identity, per-project
   contributions, additive machine union, per-target installed components,
   authorization provenance, deterministic serialization, and idempotent reruns.
2. Add RED security tests for malformed JSON, unknown schema versions, duplicate
   component records, symlinked ledger/parent paths, unsafe project roots,
   partial temporary files, and atomic replacement that preserves the previous
   valid ledger on failure.
3. Run `npx vitest run tests/ecc/registration.test.ts` and witness RED; commit
   the RED checkpoint.
4. Implement strict Zod parsing, safe path resolution under the selected home,
   pure merge/union functions, and same-directory temp-write + rename with mode
   `0600` where supported.
5. Run the ledger tests GREEN and refactor only while they remain green.

## Task 4: Evidence projection and manifest-operation filtering

**Files:**

- Create: `src/ecc/materialize.ts`
- Modify: `src/ecc/evidence.ts`
- Modify: `src/baseline-evidence/catalogs.ts`
- Create: `tests/ecc/materialize.test.ts`
- Modify: `tests/ecc/evidence.test.ts`
- Modify: `tests/baseline-evidence/catalogs.test.ts`

1. Build a pinned ECC fixture plan and add RED tests that retain only selected
   `skills/<name>/**`, `agents/<name>.md`, and corresponding
   `.agents/skills/<name>/**` operations while preserving required target
   scaffolding and excluding unselected agents/skills.
2. Prove the filter updates both `plan.operations` and
   `plan.statePreview.operations`, rejects unsupported operation shapes, and
   produces identical results on a second run.
3. Add RED authorization tests for a leaf receipt, containing-module receipt,
   missing coverage, wrong path/module, and evidence provenance projection into
   installed component records.
4. Run `npx vitest run tests/ecc/materialize.test.ts tests/ecc/evidence.test.ts
   tests/baseline-evidence/catalogs.test.ts` and witness RED; commit the RED
   checkpoint.
5. Add any missing leaf catalog entries, implement component-to-path/module
   coverage, and expose a serialized filter payload consumed by the pinned ECC
   installer helper.
6. Run the focused tests GREEN.

## Task 5: Fail-closed pipeline integration and post-success ledger commit

**Files:**

- Modify: `src/ecc/pipeline.ts`
- Modify: `src/ecc/verified.ts`
- Modify: `src/ecc/index.ts`
- Modify: `src/ecc/install.ts`
- Modify: `tests/ecc/pipeline.test.ts`
- Modify: `tests/ecc/verified.test.ts`
- Modify: `tests/ecc/ecc.test.ts`

1. Add RED pipeline tests proving selection happens before evidence lookup,
   every installed leaf has acceptable evidence coverage, and an evidence
   failure neither constructs install operations nor creates a ledger.
2. Add RED driver tests proving each supported target runs the filtered
   `createManifestInstallPlan`, unselected MCPs are passed through
   `ECC_DISABLED_MCPS`, and unsupported targets remain consult guidance.
3. Add RED failure-order tests: dependency failure, first-target failure,
   later-target failure, filter failure, and ledger rename failure. In every
   install failure case the old ledger is byte-identical and no new registration
   is claimed; only complete success commits the new ledger.
4. Add RED idempotency and two-project tests proving the second run retains the
   first project's machine contribution and installs the computed union.
5. Run `npx vitest run tests/ecc/pipeline.test.ts tests/ecc/verified.test.ts
   tests/ecc/ecc.test.ts` and witness RED; commit the RED checkpoint.
6. Thread the typed selection, existing ledger, filter payload, MCP disable set,
   and authorization projection through `VerifiedEccRequest`.
7. Extend the existing sequential driver payload with per-step environment and
   one final atomic-ledger operation; never add the ledger as an ordinary plan
   write because executor write ordering cannot express this guarantee.
8. Run the focused tests GREEN.

## Task 6: Built-CLI sandbox and product documentation

**Files:**

- Modify: `tests/ecc/command.test.ts`
- Modify: `README.md`
- Modify: `docs/commands.md`
- Modify: `docs/ARCHITECTURE.md`
- Modify: `docs/CONTROL_MATRIX.md`
- Modify: `docs/security/baseline-evidence.md`
- Modify: `STABILITY.md`
- Modify: `CHANGELOG.md`

1. Add a RED real-CLI sandbox test that builds `aih`, uses fixture repo/home/ECC
   source paths, runs `aih ecc --apply --with ...` twice, and proves scoped files,
   filtered agents, MCP defaults, content hashes, the atomic ledger, and
   idempotency without touching the operator's real home.
2. Add a second fixture project and prove the installed machine union is
   additive. Corrupt one evidence/input hash and prove the command fails closed
   without changing the prior ledger.
3. Run the built-CLI test and witness RED; commit the RED checkpoint.
4. Make the minimum integration corrections for GREEN.
5. Document default scope, repeatable declarations, full opt-in, posture/MCP
   behavior, ledger location/schema ownership, evidence provenance, rerun
   semantics, and #409 as the explicit inverse.
6. Add the missing `[Unreleased]` changelog entry and update stability/control
   surfaces for the additive command option and primary-store carve-out.

## Task 7: Verification, review, and PR integration

**Files:**

- Review all files changed since `origin/main`

1. Run `/home/test/.local/bin/code-review-graph update --brief`, then inspect
   change impact and confirm the graph remains populated at the branch commit.
2. Run focused ECC tests, `npm run typecheck`, `npm run lint:ci`,
   `npm run baseline:check`, and the real built-CLI sandbox.
3. Run `npm run verify`; this is the merge gate.
4. Run the required code-review, security, and TypeScript/domain review lenses.
   Resolve every actionable finding with a new RED regression test where
   applicable, then rerun `npm run verify` after the final code change.
5. Inspect `git diff --check`, the full diff, tracked artifacts, command contract,
   and `[Unreleased]` changelog entry. Confirm no temporary fixture, quarantine,
   evidence, or ledger bytes are tracked.
6. Commit with DCO signoff, push `feat/408-scoped-ecc-registration`, open a PR
   that closes #408 with exactly `semver:minor` and `contract:additive`, monitor
   CI, address failures, and merge once all required checks and reviews are green.
7. Re-ground public `main`, rebuild/update code-review-graph there, reconcile the
   merged SHA and G2 transition in the private canonical docs, run
   `tools/check-docs.ps1`, then commit and push the authorized internal update.
