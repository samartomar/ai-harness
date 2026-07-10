# Baseline Installer Evidence Implementation Plan

> **For Codex:** Execute this plan with the `executing-plans`, `tdd-workflow`,
> `security-review`, and `verification-before-completion` skills. Keep every
> production change behind a witnessed RED test and checkpoint the RED state
> before implementing GREEN.

**Goal:** Close #407 by making every aih-controlled ECC or Superpowers install
depend on content-addressed vendor or org evidence, while preserving the
posture rules: missing/mismatched coverage warns at vibe and fails at
team/enterprise; danger-class findings fail at every posture.

**Architecture:** Add one baseline-evidence subsystem that owns component
catalogs, deterministic tree hashes, evidence schemas, vendor-lock validation,
org-bundle verification, and evidence-tier provenance. Both baseline commands
use a two-phase runner: acquire inert pinned bytes into quarantine, verify the
selected components, then and only then build/execute install actions from the
same quarantined tree. Vendor evidence is committed in the npm payload and is
therefore covered by the release checksum/provenance/cosign envelope. Org
evidence is produced by the same vetter, packaged by `aih evidence build --sign
gh`, and activated by an attributable org-policy entry. #408 will persist the
returned provenance into the component registration ledger; #407 must expose
that provenance without inventing the ledger early.

**Tech stack:** TypeScript, Zod, Commander, Vitest, the existing plan/executor,
trust scanners, quarantined GitHub tarball fetcher, evidence-bundle layout, and
GitHub attestations.

---

## Locked safety decisions carried into code

- Evidence attaches to exact component paths at an exact 40-character source
  commit. Source reputation never substitutes for a hash match.
- A component tree hash commits to sorted POSIX relative paths, file bytes, and
  entry type. Symlinks, hard links, path escapes, duplicate normalized paths,
  unreadable files, and unsupported entry types fail closed.
- `trust.auto-exec-hook`, `trust.prompt-injection`,
  `trust.hidden-unicode`, `trust.secret`, and every existing danger-class code
  remain non-acknowledgeable. An org bundle may cover newer bytes; it may not
  suppress a danger verdict.
- Vendor locks may honestly contain `blocked` entries. A signed blocked verdict
  is evidence that installation must stop, not permission to install.
- Covered vendor entries require no analyzer on the user seat. Analyzer names
  and versions are receipts from the vet-once job.
- Org override v1 uses a GitHub-attested evidence bundle whose allowed signing
  repository is named in `aih-org-policy.json`; checksum-only or un-attributed
  bundles do not authorize an install.
- Acquired source bytes are never executed before the evidence gate clears.
  Dependency installation uses `npm ci --ignore-scripts` only after the pinned
  lockfile and installer runtime are covered.
- Separate exec actions cannot enforce ordering after failure. Baseline commands
  therefore use a dedicated two-phase runner like `workspace add`/`pack
  install`; no verify-exec/install-exec sequence is acceptable.

## Task 1: Component hashing and evidence contracts

**Files:**

- Create: `src/baseline-evidence/schema.ts`
- Create: `src/baseline-evidence/hash.ts`
- Create: `src/baseline-evidence/catalog.ts`
- Test: `tests/baseline-evidence/schema.test.ts`
- Test: `tests/baseline-evidence/hash.test.ts`
- Test: `tests/baseline-evidence/catalog.test.ts`

1. Write failing schema tests for exact source pins, safe component IDs/paths,
   `pass|blocked` verdicts, findings, analyzer receipts, duplicate rejection,
   and strict unknown-key rejection.
2. Write failing hash tests proving deterministic order, byte sensitivity,
   path sensitivity, Windows separator normalization, and fail-closed handling
   for symlinks, hard links, escapes, unreadable entries, and collisions.
3. Run the focused tests and witness RED due to missing modules.
4. Commit the RED checkpoint with DCO signoff.
5. Implement the minimal schemas, catalog types, and pure tree hasher.
6. Run the focused tests GREEN and refactor without changing behavior.

## Task 2: Same-vetter vendor and org evidence generation

**Files:**

- Create: `src/baseline-evidence/vet.ts`
- Create: `src/baseline-evidence/vendor-lock.json`
- Create: `src/baseline-evidence/vendor.ts`
- Create: `src/baseline-evidence/commands.ts`
- Modify: `src/evidence/manifest.ts`
- Modify: `src/evidence/build.ts`
- Modify: `src/commands/index.ts`
- Modify: `package.json`
- Test: `tests/baseline-evidence/vet.test.ts`
- Test: `tests/baseline-evidence/commands.test.ts`
- Modify: `tests/evidence/build.test.ts`
- Modify: `tests/contract/command-surface.json`

1. Add RED tests for a vetter that scans only declared component paths, maps
   findings to that component, records deterministic hashes/analyzer receipts,
   emits `blocked` on any danger finding, and never converts unavailable
   analyzers into a pass when policy requires them.
2. Add RED CLI tests for `aih evidence vet-baseline <source> --pin <sha>
   --catalog ecc|superpowers --components <csv> --apply`. It must use the
   quarantined fetcher, write a typed artifact below
   `.aih/baseline-reports/`, and never install.
3. Extend `evidence build` RED tests so baseline reports are indexed as
   `baseline-evidence`, checksummed, and included in a signed bundle.
4. Implement the shared vetter and command using the existing dynamic-digest
   artifact pattern from `skill vet`.
5. Generate the initial vendor lock from the pinned source registry. Cover the
   ECC installer runtime, locked common modules, four common skills, the 16
   common agents, and the Superpowers plugin/runtime plus its installable skill
   components. Preserve blocked verdicts exactly as observed.
6. Add `baseline:vet`/`baseline:check` npm scripts: generation writes only when
   explicitly requested; check mode recomputes and fails on drift.
7. Update the additive command contract fixture and run focused tests GREEN.

## Task 3: Org-signed override verification

**Files:**

- Modify: `src/org-policy/schema.ts`
- Modify: `schemas/aih-org-policy.schema.json`
- Create: `src/baseline-evidence/org.ts`
- Modify: `src/bundle/index.ts`
- Test: `tests/baseline-evidence/org.test.ts`
- Modify: `tests/org-policy/org-policy.test.ts`
- Modify: `tests/config/json-schema.test.ts`
- Modify: `tests/bundle/bundle.test.ts`

1. Add RED policy tests for strict `trust.baselineOverrides[]` entries containing
   source, pin, local bundle path, GitHub signing repository, reason, reviewer,
   and approval timestamp.
2. Add RED verifier tests for checksum drift, missing signature, wrong GitHub
   repository, malformed/escaped bundle paths, source/pin/component mismatch,
   stale evidence, blocked/danger findings, and a valid signed fixture.
3. Export/refactor the existing bundle checksum and GitHub attestation verifier
   so baseline authorization uses the same implementation as
   `aih verify-bundle`; do not shell-compose arguments.
4. Implement org evidence resolution as an extension-only lookup after vendor
   lookup. Return explicit tier/issuer/bundle/evidence-hash provenance on
   success. Never let an org entry replace a vendor `blocked` result for the
   same bytes.
5. Regenerate the editor schema with the project’s existing schema command and
   run the focused policy/bundle tests GREEN.

## Task 4: Posture-aware component gate

**Files:**

- Create: `src/baseline-evidence/verify.ts`
- Modify: `src/support/findings.ts`
- Modify: `src/internals/verify.ts` (only if a new closed check code is required)
- Modify: `src/verification/constants.ts` (only if required by the existing
  closed taxonomy)
- Test: `tests/baseline-evidence/verify.test.ts`
- Modify: `tests/internals/check-code.test.ts`

1. Add RED matrix tests for covered/pass, uncovered, hash mismatch, source-pin
   mismatch, vendor-blocked, valid org coverage, invalid org signature, and
   danger findings across vibe/team/enterprise.
2. Prove missing/mismatch is warning-only at vibe and failing at
   team/enterprise, while blocked/danger fails at every posture.
3. Prove the returned authorization receipt carries component ID, content hash,
   source pin, `vendor|org` tier, evidence hash, and issuer without secrets or
   unbounded external text.
4. Implement the pure verifier/check mapper and support guidance.
5. Run focused tests GREEN.

## Task 5: Guarded two-phase baseline runner

**Files:**

- Create: `src/baseline-evidence/run.ts`
- Modify: `src/commands/index.ts`
- Test: `tests/baseline-evidence/run.test.ts`

1. Add RED runner tests showing dry-run fetch preview, apply-time quarantine
   fetch, no install-plan construction before a cleared gate, no install after
   fetch/hash/signature/verdict failure, same-tree re-hash before phase 2,
   cleanup on success/failure, JSON envelopes, support output, dirty-worktree
   behavior, and exec failure propagation.
2. Add a race test that mutates a covered file after clearance and prove phase
   2 refuses it.
3. Implement one runner shared by `ecc` and `superpowers`, following the
   `workspace add` lifecycle and using dependency injection for hermetic tests.
4. Register only these two existing commands through the custom runner. Keep
   all other command registration byte-equivalent.
5. Run focused tests GREEN.

## Task 6: ECC install integration from verified bytes

**Files:**

- Modify: `src/ecc/index.ts`
- Modify: `src/ecc/install.ts`
- Modify: `src/ecc/codex.ts` only where the verified checkout path must be
  threaded through
- Modify: `tests/ecc/ecc.test.ts`
- Create: `tests/ecc/evidence.test.ts`

1. Add RED tests proving every mutating ECC target resolves requested profile
   modules/components, requires runtime plus component evidence, and builds no
   installer actions when the gate fails.
2. Replace mutable `npx latest` execution with the exact quarantined pinned
   checkout. After clearance, run `npm ci --omit=dev --ignore-scripts`, then the
   checkout’s `scripts/install-apply.js` with existing target/profile/packs.
3. Preserve the Codex add-only merge path and Kiro Git Bash diagnostics, but
   source every invoked helper/script and copied component from the cleared
   checkout.
4. Treat `--ecc-path` or a newer `AIH_ECC_REF` as org-override candidates, not
   vendor coverage. An explicit local path without signed evidence may warn at
   vibe but must fail at team/enterprise; danger still fails everywhere.
5. Update summaries to name the pinned source and evidence tier. Remove claims
   that latest/mutable execution is the default.
6. Run ECC and baseline-evidence tests GREEN.

## Task 7: Superpowers integration without mutable post-check fetches

**Files:**

- Modify: `src/superpowers/index.ts`
- Modify: `src/superpowers/install.ts`
- Modify: `tests/superpowers/superpowers.test.ts`
- Create: `tests/superpowers/evidence.test.ts`

1. Add RED tests proving shell-runnable actions cannot fetch a mutable remote
   after a different pinned tree was verified.
2. Thread the cleared pinned checkout into supported local plugin-install
   adapters. If a target cannot consume a local checkout, emit an explicit
   evidence-bound manual instruction and no mutating exec; never claim a
   marketplace-selected version is covered by the vendor lock.
3. Gate the Kiro methodology bridge as first-party aih content separately; it
   must not be mislabeled as Superpowers vendor evidence.
4. Include selected Superpowers component receipts in the result digest for
   #408’s ledger writer.
5. Run Superpowers and baseline-evidence tests GREEN.

## Task 8: Vet-once CI, docs, and release payload proof

**Files:**

- Create: `.github/workflows/baseline-evidence.yml`
- Modify: `.github/workflows/ci.yml` if the repository requires the job to be
  part of the existing required `verify` surface
- Modify: `package.json`
- Modify: `README.md`
- Modify: `docs/SECURITY-OPERATIONS.md` or the owning existing trust document
  selected by `DOCS-MAP.md`
- Modify: `NOTICE.md` only if the pinned-source notice changes
- Test: `tests/baseline-evidence/package.test.ts`

1. Add RED tests that `npm pack --dry-run --json` includes the vendor lock and
   that a packed/built CLI can parse and verify it without the source tree or
   analyzers installed.
2. Add the vet-once workflow: checkout exact upstream pins, run the shared
   vetter/check mode, fail on hash/verdict/analyzer drift, and upload the report
   as a CI artifact. Never auto-commit regenerated evidence.
3. Document vendor vs org evidence, posture behavior, exact org-signing flow,
   blocked-component semantics, and the “covered seats do not rescan” property.
4. Run docs/contract validators and focused packaging tests GREEN.

## Task 9: Security review and completion gate

1. Run `code-review-graph update --brief`, then
   `code-review-graph detect-changes --base origin/main --brief --verify` and
   inspect every high-risk caller/consumer it identifies.
2. Run focused suites after each GREEN checkpoint.
3. Run the real built CLI against:
   - a covered/pass pinned fixture (install proceeds with analyzers absent),
   - an uncovered fixture at vibe (warns),
   - the same fixture at team (refuses before writes),
   - a post-clearance mutation (refuses), and
   - a signed org fixture plus a wrong-repository signature fixture.
4. Run `npm audit`, `npm run check:fast`, and finally `npm run verify`.
5. Review `git diff --check`, `git diff --stat`, full diff, generated schemas,
   vendor-lock provenance, package contents, and DCO signoffs.
6. Obtain two independent high-risk review lenses (security/trust and
   correctness/plan-executor integration) without merging the agent-authored
   PR. Address all actionable findings with new RED tests.
7. Push the branch and open the PR linked to #407. Stop for Samar’s required
   merge click; do not tag or publish.

