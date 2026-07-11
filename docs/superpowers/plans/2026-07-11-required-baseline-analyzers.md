# Required Baseline Analyzers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make vendor and org baseline evidence fail closed unless the exact pinned source bytes are scanned by `aih-native`, pinned SkillSpector through Docker, and pinned Cisco skill-scanner through offline `uvx` for every skill-bearing component before analyzer receipts can authorize scanner-free installs.

**Architecture:** A canonical baseline analyzer profile owns required detector names and attributable versions. Both baseline entry points pass a real runner/platform/environment plus that profile into the existing trust scanner; the vetter rejects any component missing a required receipt. The expensive vet-once workflow reproducibly provisions both external analyzers and byte-compares regenerated evidence, while ordinary verification performs a pure shipped-receipt check and the existing fixture-HOME install gate.

**Tech Stack:** TypeScript 7, Node.js 22/24, Vitest, Docker, NVIDIA/SkillSpector at `326a2b489411a20ed742ff13701be39ba00063c8`, `cisco-ai-skill-scanner==2.0.12`, `uvx --offline`, GitHub Actions, code-review-graph.

## Global Constraints

- Vendor baseline v1 requires exactly `aih-native`, `skillspector@docker`, and `cisco@uvx` for every component receipt.
- Missing, unavailable, failed, malformed, or unversioned applicable analyzers block evidence generation and release.
- SkillSpector runs the existing pinned image with `--network none`, `--read-only`, `--no-llm`, and the source mounted read-only.
- Cisco runs from the exact `cisco-ai-skill-scanner==2.0.12` distribution through the existing `uvx --offline --no-python-downloads --no-env-file` path.
- Analyzer provisioning may use network access; analyzer execution may not.
- Cisco applicability is persisted in the canonical catalog and independently
  checked against non-symlinked `SKILL.md` discovery at the exact source pin.
- Exact ECC and Superpowers source pins, component hashes, danger-class floors, and fork-pin bridge semantics remain unchanged.
- Vendor lock signing remains the npm tarball checksum/provenance/Sigstore envelope; do not invent an independent `vendor-lock.sigstore.json`.
- `module:hooks-runtime` may remain blocked. The accepted lock must authorize `runtime:ecc-installer` and at least one useful common/project component at every posture.
- Never apply the ECC installer to the real developer HOME; fixture homes only.

---

### Task 1: Lock the analyzer profile and receipt invariant

**Files:**
- Create: `src/baseline-evidence/analyzer-profile.ts`
- Modify: `src/baseline-evidence/vet.ts`
- Modify: `src/trust/detectors.ts`
- Test: `tests/baseline-evidence/vet.test.ts`
- Test: `tests/trust/scan.test.ts`

**Interfaces:**
- Produces: `REQUIRED_BASELINE_DETECTORS`, `REQUIRED_BASELINE_ANALYZERS`, `baselineAnalyzerVersions()`.
- Extends: `VetBaselineCatalogOptions.requiredAnalyzers?: readonly string[]`.
- Consumes: `VERSION`, SkillSpector source revision/digest, and exact Cisco package version.

- [ ] **Step 1: Write failing tests for the required receipt set**

Add a vet test that returns only `aih-native` while requesting all three required analyzers and expects rejection containing `missing required baseline analyzers: skillspector@docker, cisco@uvx`. Add a GREEN-shape test returning all three names and exact versions. Add a detector argv assertion that Cisco uses `cisco-ai-skill-scanner==2.0.12`.

- [ ] **Step 2: Run the focused tests and witness RED**

Run:

```bash
npx vitest run tests/baseline-evidence/vet.test.ts tests/trust/scan.test.ts
```

Expected: the required-analyzer tests fail because no canonical profile or per-component completeness check exists and Cisco is unpinned.

- [ ] **Step 3: Commit the RED checkpoint**

```bash
git add tests/baseline-evidence/vet.test.ts tests/trust/scan.test.ts
git commit -s -m "test: require full baseline analyzer receipts"
```

- [ ] **Step 4: Implement the minimal profile and completeness check**

Create a profile exporting:

```ts
export const CISCO_SKILL_SCANNER_VERSION = "2.0.12";
export const CISCO_SKILL_SCANNER_SPEC =
  `cisco-ai-skill-scanner==${CISCO_SKILL_SCANNER_VERSION}`;
export const REQUIRED_BASELINE_DETECTORS = ["skillspector", "cisco"] as const;
export const REQUIRED_BASELINE_ANALYZERS = [
  "aih-native",
  "skillspector@docker",
  "cisco@uvx",
] as const;
```

`baselineAnalyzerVersions()` must return `VERSION` for `aih-native`, the pinned SkillSpector revision plus verified image digest for `skillspector@docker`, and `2.0.12` for `cisco@uvx`. In `vetBaselineCatalog`, compare every component scan's unique analyzer names with `requiredAnalyzers` before constructing evidence; throw rather than emit a partial lock.

- [ ] **Step 5: Pin Cisco execution to the shared exact spec**

Replace the unversioned detector package constant with `CISCO_SKILL_SCANNER_SPEC`; retain `uvx --offline --no-python-downloads --no-env-file` and argument-array execution.

- [ ] **Step 6: Run focused tests GREEN and commit**

```bash
npx vitest run tests/baseline-evidence/vet.test.ts tests/trust/scan.test.ts
git add src/baseline-evidence/analyzer-profile.ts src/baseline-evidence/vet.ts \
  src/trust/detectors.ts tests/baseline-evidence/vet.test.ts tests/trust/scan.test.ts
git commit -s -m "fix: require complete baseline analyzer receipts"
```

### Task 2: Wire the real runtime into both baseline vet paths

**Files:**
- Modify: `src/baseline-evidence/generate.ts`
- Modify: `src/baseline-evidence/commands.ts`
- Test: `tests/baseline-evidence/commands.test.ts`
- Create: `tests/baseline-evidence/generate.test.ts`

**Interfaces:**
- Consumes: `defaultRunner`, `resolvePlatform`, `process.env`, and the Task 1 profile.
- Produces: deterministic vendor generation and org reports that use the identical required analyzer set.

- [ ] **Step 1: Add RED tests for runtime/profile propagation**

The command test must assert its injected vetter receives `scanOptions.run`, `scanOptions.platform`, `scanOptions.env`, `scanOptions.requiredDetectors`, `requiredAnalyzers`, and exact analyzer versions. Extract a testable generator function so the generator test can inject a runner/platform/environment and prove the same propagation without spawning real tools.

- [ ] **Step 2: Run the focused RED tests**

```bash
npx vitest run tests/baseline-evidence/commands.test.ts tests/baseline-evidence/generate.test.ts
```

Expected: propagation assertions fail because `generate.ts` supplies no runtime and `commands.ts` supplies no required profile or versions.

- [ ] **Step 3: Commit the RED checkpoint**

```bash
git add tests/baseline-evidence/commands.test.ts tests/baseline-evidence/generate.test.ts
git commit -s -m "test: expose missing baseline analyzer runtime"
```

- [ ] **Step 4: Implement shared runtime options**

Pass the following into every production `vetBaselineCatalog` call:

```ts
{
  scanOptions: {
    run,
    platform,
    env,
    posture: "enterprise",
    requiredDetectors: REQUIRED_BASELINE_DETECTORS,
  },
  requiredAnalyzers: REQUIRED_BASELINE_ANALYZERS,
  analyzerVersions: baselineAnalyzerVersions(),
}
```

Do not use shell-composed command strings and do not forward secret-bearing environment variables beyond the existing detector `scrubFetchEnv` boundary.

- [ ] **Step 5: Run focused tests GREEN and commit**

```bash
npx vitest run tests/baseline-evidence/commands.test.ts tests/baseline-evidence/generate.test.ts
git add src/baseline-evidence/generate.ts src/baseline-evidence/commands.ts \
  tests/baseline-evidence/commands.test.ts tests/baseline-evidence/generate.test.ts
git commit -s -m "fix: run required analyzers during baseline vetting"
```

### Task 3: Add a cheap release receipt gate and reproducible CI provisioning

**Files:**
- Create: `src/internals/check-baseline-analyzers.ts`
- Modify: `package.json`
- Modify: `.github/workflows/baseline-evidence.yml`
- Modify: `.github/workflows/release.yml`
- Test: `tests/baseline-evidence/vendor.test.ts`
- Test: `tests/baseline-evidence/package.test.ts`

**Interfaces:**
- Produces: `npm run check:baseline-analyzers`, a pure lock inspection included in `npm run verify` and the tag workflow.
- Keeps: `npm run baseline:check` as the expensive exact-source re-vet performed in the dedicated workflow.

- [ ] **Step 1: Add RED lock and workflow tests**

Require every shipped component's analyzer names and versions to equal the canonical applicable profile: native plus SkillSpector everywhere, and Cisco where the declared component tree contains `SKILL.md`. Require `verify` and `release.yml` to run `check:baseline-analyzers`. Require `baseline-evidence.yml` to check out the pinned SkillSpector source, build the pinned image, assert its controlled digest, install `uv` with `astral-sh/setup-uv@11f9893b081a58869d3b5fccaea48c9e9e46f990`, cache/install `cisco-ai-skill-scanner==2.0.12`, and run `baseline:check` only after both analyzers are healthy.

- [ ] **Step 2: Run focused tests and witness RED**

```bash
npx vitest run tests/baseline-evidence/vendor.test.ts tests/baseline-evidence/package.test.ts
```

Expected: native-only receipts and absent workflow provisioning fail the new assertions.

- [ ] **Step 3: Commit the RED checkpoint**

```bash
git add tests/baseline-evidence/vendor.test.ts tests/baseline-evidence/package.test.ts
git commit -s -m "test: gate releases on analyzer-complete baseline evidence"
```

- [ ] **Step 4: Implement the pure analyzer receipt check**

`check-baseline-analyzers.ts` must parse the shipped lock, report source/component plus missing, extra, or wrong-version receipts, write no files, and exit non-zero on any mismatch. Add it before installability in `verify` and before packaging in the release workflow.

- [ ] **Step 5: Provision exact external analyzers in vet-once CI**

Use pinned `actions/checkout` for SkillSpector at the canonical revision. Build the documented tag with the source-revision label, then assert `docker image inspect` equals the controlled digest. Use pinned `setup-uv`, populate the exact Cisco distribution, and prove the detector's offline version check succeeds before calling `baseline:check`. No analyzer step receives publishing credentials.

- [ ] **Step 6: Run focused tests GREEN and commit**

```bash
npx vitest run tests/baseline-evidence/vendor.test.ts tests/baseline-evidence/package.test.ts
git add src/internals/check-baseline-analyzers.ts package.json \
  .github/workflows/baseline-evidence.yml .github/workflows/release.yml \
  tests/baseline-evidence/vendor.test.ts tests/baseline-evidence/package.test.ts
git commit -s -m "ci: enforce reproducible baseline analyzer profile"
```

### Task 4: Provision locally and regenerate exact-pin evidence

**Files:**
- Modify: `src/baseline-evidence/vendor-lock.json`
- Modify only if authorization changes: `src/baseline-evidence/ecc-install-preview.json`

**Interfaces:**
- Consumes: `samartomar/ECC@32cec153324c5435673f3490c6594ab293d5fcdc` and `obra/Superpowers@d884ae04edebef577e82ff7c4e143debd0bbec99`.
- Produces: analyzer-complete component evidence at those exact source hashes.

- [ ] **Step 1: Build and verify pinned SkillSpector**

```bash
VET_ROOT="$(mktemp -d)"
AIH_ROOT="$PWD"
git clone https://github.com/NVIDIA/SkillSpector.git "$VET_ROOT/SkillSpector"
git -C "$VET_ROOT/SkillSpector" checkout --detach \
  326a2b489411a20ed742ff13701be39ba00063c8
docker build \
  --provenance=false \
  --build-arg SOURCE_DATE_EPOCH=1782883813 \
  -f "$AIH_ROOT/tools/skillspector.Dockerfile" \
  -t skillspector:aih-326a2b489411 \
  "$VET_ROOT/SkillSpector"
test "$(docker image inspect skillspector:aih-326a2b489411 --format '{{.Id}}')" = \
  "sha256:ee8a107dfd1c258e0afed303016a4220d174ba54bd1510bf73ed91f2825075ec"
```

Expected: the checked-out commit equals the pinned revision and the final digest assertion exits 0. A mismatch blocks the task rather than becoming an implicit local approval.

- [ ] **Step 2: Install/cache and verify exact Cisco scanner**

```bash
uv tool install --force 'cisco-ai-skill-scanner==2.0.12'
uvx --offline --no-python-downloads --no-env-file \
  --from 'cisco-ai-skill-scanner==2.0.12' skill-scanner --version
```

Expected: exit 0 and version `2.0.12`.

- [ ] **Step 3: Run the real full-profile vet**

```bash
git clone https://github.com/samartomar/ECC.git "$VET_ROOT/ECC"
git -C "$VET_ROOT/ECC" checkout --detach \
  32cec153324c5435673f3490c6594ab293d5fcdc
git clone https://github.com/obra/Superpowers.git "$VET_ROOT/Superpowers"
git -C "$VET_ROOT/Superpowers" checkout --detach \
  d884ae04edebef577e82ff7c4e143debd0bbec99
npm run baseline:vet -- \
  --ecc-root "$VET_ROOT/ECC" \
  --superpowers-root "$VET_ROOT/Superpowers"
```

Expected: both sources scan every declared component with native + SkillSpector,
and every skill-bearing component with Cisco as well. Missing applicable analyzer
receipts fail before either artifact is written.

- [ ] **Step 4: Inspect evidence and installability**

Run `npm run check:baseline-analyzers`, `npm run baseline:check -- ...`, focused vendor/installability tests, and `npm run check:baseline-installable`. Confirm the installer runtime and a useful subset remain authorized while genuine danger findings remain blocked.

- [ ] **Step 5: Commit regenerated evidence**

```bash
git add src/baseline-evidence/vendor-lock.json src/baseline-evidence/ecc-install-preview.json
git commit -s -m "chore: re-vet baseline with required analyzers"
```

Do not stage the preview when it is byte-identical.

### Task 5: Documentation, security review, and merge gate

**Files:**
- Modify: `docs/security/baseline-evidence.md`
- Modify: `docs/security/skillspector.md`
- Modify: `CHANGELOG.md`
- Modify if mapped: `docs/CONTROL_MATRIX.md`

**Interfaces:**
- Produces: an honest user/operator description of full vetting, provisioning versus execution egress, receipt semantics, and the release envelope.

- [ ] **Step 1: Document the exact analyzer contract**

State that covered seats skip scanning only because native plus SkillSpector, and Cisco for every skill-bearing component, ran during vet-once. Document that missing applicable analyzers block generation, provisioning may download pinned tools, execution is offline/no-network, and “no findings” is not a security guarantee.

- [ ] **Step 2: Add one `[Unreleased]` CHANGELOG entry**

Describe the release-blocker fix without claiming certification or comprehensive security.

- [ ] **Step 3: Run security review checks**

Verify command execution is argv-based, sources and packages are exact-pinned, analyzer environments are scrubbed, Docker is networkless/read-only, no secrets enter analyzer subprocesses, and lock writing remains all-or-nothing after complete scans.

- [ ] **Step 4: Run graph and complete verification**

```bash
code-review-graph update --brief
code-review-graph detect-changes --base origin/main
npm audit
npm run verify
```

Expected: graph reports the intended baseline/trust/workflow impact, audit has no release-blocking vulnerabilities, and verification exits 0.

- [ ] **Step 5: Open the finalized PR and obtain independent review**

Push only after reviewing `git diff origin/main...HEAD`. Open one finalized PR that `Refs #417`, with `type:security`, `area:ci`, `semver:patch`, and milestone `v2.9.0`. Independent review must focus on fail-closed analyzer completeness, exact pinning, no-egress execution, receipt attribution, genuine finding preservation, CI reproducibility, and release-envelope claims.

- [ ] **Step 6: Merge only after required CI and independent review are green**

After authorized merge, close #417 only with exact workflow/commit evidence. The release tracker remains open.

### Task 6: Restore the prepared v2.9.0 cut to readiness

**Files:**
- Update branch: `release/v2.9.0`
- Regenerate: `src/baseline-evidence/vendor-lock.json`
- Verify existing version surfaces and `CHANGELOG.md`

**Interfaces:**
- Consumes: merged Task 1–5 commit and the existing release preparation commit `fce90815f13b1d2ac2afb11fa9003a78fb3ba1fe`.
- Produces: a clean, pushed release branch with 2.9.0 analyzer receipts and all gates green, but no release PR or publication until the user's additional work is added.

- [ ] **Step 1: Incorporate the blocker fix without losing release preparation**

Rebase or merge the prepared release branch onto current `main` according to the session git contract; preserve the 2.9.0 version/CHANGELOG/surface edits.

- [ ] **Step 2: Regenerate receipts with analyzer version `2.9.0`**

Run the full three-analyzer `baseline:vet` again from the exact source checkouts so `aih-native` receipts match the release version. Verify the only expected release-only evidence change is the native analyzer version.

- [ ] **Step 3: Run readiness gates**

Run full-profile `baseline:check`, `check:baseline-analyzers`, fixture-home installability, `npm run verify`, `node dist/cli.js --version`, and graph change detection. Push the refreshed release branch.

- [ ] **Step 4: Stop before the release PR**

Report exact SHA and verification evidence. Wait for the user's additional work; do not open/merge the release PR, tag, publish, or reconcile shipped documentation yet.
