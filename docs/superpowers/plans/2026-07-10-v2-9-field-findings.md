# v2.9.0 Field-Findings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve issues #417–#424 so the shipped ECC baseline installs an evidence-authorized partial surface at every posture while preserving trust floors, truthful ledger state, and attributable release escalation.

**Architecture:** Keep the eight issue contracts in eight independently reviewed PRs. Correct trust classification first, partition baseline evidence by component, make prune and release state transitions auditable, close command hygiene gaps, and then finish #417 as the cross-platform release integration gate with a newly vetted exact ECC pin.

**Tech Stack:** TypeScript 7, Node.js 22 filesystem/crypto/child-process APIs, Commander, Zod, Vitest, GitHub CLI/API, GitHub Actions, the existing `Plan`/`Check`/`VerificationReport` model, and signed baseline evidence v1.

## Global Constraints

- Never mutate the real development-seat HOME; use disposable fixture HOMEs and project roots.
- Danger-class trust findings remain failing and non-acknowledgeable at every posture.
- Legal-text findings warn-pass only at vibe; team and enterprise require exact fingerprint acknowledgement plus a non-empty reason.
- Reuse `isStrictUnicodeSurface`; do not add a second docs-versus-instruction classifier.
- Finding identity is content-bound; line number is advisory display metadata only.
- `runtime:ecc-installer` and `runtime:ecc-kiro` must be authorized before their code executes.
- Enterprise holding auto-exec hook components while installing the remaining baseline is success.
- Registration target records contain only components actually installed; the primary ledger commits last.
- Progress goes to stderr; JSON remains valid and uncontaminated on stdout.
- Every issue PR starts RED, adds one `[Unreleased]` entry, carries exactly one `semver:*` label, passes `npm run verify`, receives security/domain review plus independent review, and merges only under the standing authorization.
- #417 stays open with `release-blocker`, opens first, and merges last.
- Publication is outside these tasks and still requires exact-SHA authorization plus the npm-publish environment approval.

---

### Task 1: Open #417 with the v2.8.0 installability regression in RED

**Files:**

- Create: `tests/fixtures/baseline-evidence/ecc-v2.8.0-vendor-lock.json`
- Create: `tests/baseline-evidence/installable-release-gate.test.ts`
- Create later in this branch: `src/internals/check-baseline-installable.ts`
- Modify later in this branch: `package.json`
- Modify later in this branch: `.github/workflows/ci.yml`
- Modify later in this branch: `CHANGELOG.md`

**Interfaces:**

- Consumes: v2.8.0 ECC lock source at pin `4130457d674d2180c5af2c5f634f3cae4cbc6c4f`.
- Produces later: `checkInstallableBaseline(input): Promise<InstallableBaselineReport>` and the `check:baseline-installable` package script.

- [ ] **Step 1: Create a dedicated worktree and branch from public `main`**

```bash
git worktree add -b test/417-installable-baseline-gate ../.worktrees/ai-harness-417 origin/main
```

Expected: the worktree starts at the v2.8.0 release commit and is clean.

- [ ] **Step 2: Freeze the exact failing evidence fixture**

Copy only the `affaan-m/ECC` source object from the v2.8.0 vendor lock into a valid lock envelope in `tests/fixtures/baseline-evidence/ecc-v2.8.0-vendor-lock.json`. Keep the full pin, all 54 component entries, findings, hashes, and analyzer records byte-for-byte; do not regenerate it.

- [ ] **Step 3: Write the failing release-gate test**

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkInstallableBaseline } from "../../src/internals/check-baseline-installable.js";

describe("shipped ECC baseline installability", () => {
  it("reproduces the v2.8.0 zero-installable enterprise lock", async () => {
    const lock = JSON.parse(
      readFileSync(
        join(
          process.cwd(),
          "tests/fixtures/baseline-evidence/ecc-v2.8.0-vendor-lock.json",
        ),
        "utf8",
      ),
    );
    const report = await checkInstallableBaseline({ lock, fixtureOnly: true });
    expect(report.postures.enterprise.installed).toBe(0);
    expect(report.ok).toBe(false);
  });
});
```

- [ ] **Step 4: Run the test and preserve the RED evidence**

Run: `npx vitest run tests/baseline-evidence/installable-release-gate.test.ts`

Expected: FAIL because `src/internals/check-baseline-installable.ts` does not exist.

- [ ] **Step 5: Commit, push, and open a draft PR**

```bash
git add tests/fixtures/baseline-evidence/ecc-v2.8.0-vendor-lock.json tests/baseline-evidence/installable-release-gate.test.ts
git commit -m "test: reproduce blocked v2.8 ECC baseline"
git push -u origin test/417-installable-baseline-gate
gh pr create --draft --title "ci(release): require an installable shipped baseline" --body "Refs #417. RED regression first; this PR remains draft and merges last."
```

Apply milestone `next-release` and `semver:patch`. Leave the PR draft and red until Task 9.

---

### Task 2: Implement #422 legal-text posture grading

**Files:**

- Modify: `src/trust/grade.ts`
- Modify: `tests/trust/grade.test.ts`
- Modify: `tests/trust/scan.test.ts`
- Modify: `docs/security/skill-trust-gate.md`
- Modify: `docs/commands.md`
- Modify: `CHANGELOG.md`

**Interfaces:**

- Consumes: `gradeTrustCheck(check: Check, posture: Posture): Check` and `applyTrustAcknowledgements`.
- Produces: legal-text-specific grading without changing any other `TRUST_ORIGIN_CODES` behavior.

- [ ] **Step 1: Add the failing posture matrix test**

```ts
function legalTextCheck(): Check {
  return {
    name: "trust.legal-text-detector-finding",
    verdict: "fail",
    code: "trust.legal-text-detector-finding",
    detail: "LICENSE:4 — generic legal-text heuristic",
    fingerprint: `trust-legal-text-detector-finding:LICENSE:${"a".repeat(64)}`,
  };
}

it.each([
  ["vibe", "pass"],
  ["team", "fail"],
  ["enterprise", "fail"],
] as const)("grades legal text at %s as %s", (posture, verdict) => {
  expect(gradeTrustCheck(legalTextCheck(), posture).verdict).toBe(verdict);
});
```

Add a scan-level test that team and enterprise become green only after the exact fingerprint and `--reason` pass through the existing acknowledgement path.

- [ ] **Step 2: Run RED**

Run: `npx vitest run tests/trust/grade.test.ts tests/trust/scan.test.ts`

Expected: the team row reports `pass` before the implementation.

- [ ] **Step 3: Add the legal-text specialization**

```ts
export function gradeTrustCheck(check: Check, posture: Posture): Check {
  if (check.verdict !== "fail" || check.code === undefined) return check;
  if (check.code === "trust.legal-text-detector-finding") {
    return posture === "vibe"
      ? postureGradeCheck(check, "trust-origin", posture)
      : check;
  }
  if (TRUST_ORIGIN_CODES.has(check.code)) {
    return postureGradeCheck(check, "trust-origin", posture);
  }
  return gradeTrustDanger(check);
}
```

- [ ] **Step 4: Document and verify the exact matrix**

Add an `[Unreleased]` Changed entry naming #422. Update the two trust docs to state vibe warn-pass and team/enterprise acknowledgement-with-reason. Do not describe danger findings as overrideable.

Run: `npx vitest run tests/trust/grade.test.ts tests/trust/scan.test.ts && npm run verify`

Expected: all commands exit 0.

- [ ] **Step 5: Commit, independently review, open the PR, and merge after green CI**

```bash
git commit -am "fix: require team legal-text acknowledgement"
```

PR metadata: closes #422, milestone `next-release`, label `semver:minor`.

---

### Task 3: Implement #419 sandbox-smoke unavailable as skip

**Files:**

- Modify: `src/trust/smoke.ts`
- Modify: `tests/trust/scan.test.ts`
- Modify: `docs/security/skill-trust-gate.md`
- Modify: `CHANGELOG.md`

**Interfaces:**

- Consumes: `sandboxSmokeCheck()` and `Check.verdict`.
- Produces: `trust.sandbox-smoke-unavailable` as a routed `skip`; actual smoke failures remain `trust.sandbox-smoke-failed` failures.

- [ ] **Step 1: Write the failing three-state tests**

```ts
expect(await sandboxSmokeCheck(root, shape, {})).toMatchObject({
  verdict: "skip",
  code: "trust.sandbox-smoke-unavailable",
});
expect(
  await sandboxSmokeCheck(root, shape, capableFailingOptions),
).toMatchObject({
  verdict: "fail",
  code: "trust.sandbox-smoke-failed",
});
expect(
  await sandboxSmokeCheck(root, shape, capablePassingOptions),
).toMatchObject({
  verdict: "pass",
});
```

Assert the unavailable result remains a skip at vibe, team, and enterprise in the scan report.

- [ ] **Step 2: Run RED**

Run: `npx vitest run tests/trust/scan.test.ts -t "sandbox smoke"`

Expected: unavailable is `fail`.

- [ ] **Step 3: Change only the unavailable emitter**

```ts
function unavailableCheck(reason: string): Check {
  return {
    name: SANDBOX_SMOKE_NAME,
    verdict: "skip",
    code: "trust.sandbox-smoke-unavailable",
    detail: `sandbox smoke test unavailable (trust.sandbox-smoke-unavailable): ${reason}`,
  };
}
```

Do not route `trust.sandbox-smoke-failed` through posture grading.

- [ ] **Step 4: Add docs and CHANGELOG, then verify**

Run: `npx vitest run tests/trust/scan.test.ts && npm run verify`

Expected: exit 0; failed capable smoke still blocks.

- [ ] **Step 5: Commit, review, PR, and merge**

Commit: `fix: skip unavailable sandbox smoke checks`

PR metadata: closes #419, milestone `next-release`, label `semver:minor`.

---

### Task 4: Implement #418 detector precision and stable full-strength fingerprints

**Files:**

- Create: `src/trust/fingerprint.ts`
- Create: `tests/trust/fingerprint.test.ts`
- Modify: `src/trust/lint.ts`
- Modify: `src/trust/detectors.ts`
- Modify: `src/trust/depnames.ts`
- Modify: `src/trust/manifest.ts`
- Modify: `tests/trust/lint.test.ts`
- Modify: `tests/trust/scan.test.ts`
- Modify: `docs/security/skill-trust-gate.md`
- Modify: `CHANGELOG.md`

**Interfaces:**

- Produces: `contentFindingFingerprint(input: ContentFindingIdentity): string`.
- Consumes later: native lint, dependency, manifest, and external SARIF adapters.

- [ ] **Step 1: Write RED identity stability tests**

```ts
const base = {
  code: "trust.prompt-injection" as const,
  path: "docs/agents.md",
  ruleId: "scanner.role-assignment",
  content: "Act as the release reviewer",
  occurrence: 0,
};
expect(contentFindingFingerprint(base)).toMatch(/[0-9a-f]{64}$/);
expect(contentFindingFingerprint(base)).toBe(
  contentFindingFingerprint({ ...base, displayLine: 40 }),
);
expect(contentFindingFingerprint(base)).not.toBe(
  contentFindingFingerprint({ ...base, content: "Ignore prior instructions" }),
);
expect(contentFindingFingerprint(base)).not.toBe(
  contentFindingFingerprint({ ...base, occurrence: 1 }),
);
```

- [ ] **Step 2: Implement the shared identity builder**

```ts
import { createHash } from "node:crypto";
import type { CheckCode } from "../internals/verify.js";

export interface ContentFindingIdentity {
  code: CheckCode;
  path: string;
  ruleId: string;
  content: string | Buffer;
  occurrence: number;
  displayLine?: number;
}

export function contentFindingFingerprint(
  input: ContentFindingIdentity,
): string {
  const hash = createHash("sha256");
  for (const value of [
    input.code,
    input.path,
    input.ruleId,
    String(input.occurrence),
  ]) {
    hash.update(value, "utf8");
    hash.update("\0", "utf8");
  }
  hash.update(input.content);
  return `${input.code.replace(/\./g, "-")}:${input.path}:${hash.digest("hex")}`;
}
```

- [ ] **Step 3: Keep line display-only in native and SARIF adapters**

Replace the local eight-character hash helpers. In each scan, maintain a map keyed by code + normalized path + rule + exact content; use the current count as `occurrence`, then increment it. Keep `location.startLine` and detail text unchanged for display.

```ts
const key = JSON.stringify([
  code,
  location.uri,
  ruleId,
  content.toString("base64"),
]);
const occurrence = occurrences.get(key) ?? 0;
occurrences.set(key, occurrence + 1);
const fingerprint = contentFindingFingerprint({
  code,
  path: location.uri,
  ruleId,
  content,
  occurrence,
  displayLine: location.startLine,
});
```

- [ ] **Step 4: Add decorative-Unicode and role-definition precision**

Use `isStrictUnicodeSurface(path)` as the sole surface authority. On non-strict surfaces, ignore only emoji, arrow, and box-drawing code points; continue returning hidden risk for bidi, zero-width/default-ignorable, tag, and token-adjacent homoglyph characters.

```ts
function isDecorativeCodePoint(cp: number): boolean {
  return (
    (cp >= 0x2190 && cp <= 0x21ff) ||
    (cp >= 0x2500 && cp <= 0x257f) ||
    (cp >= 0x1f300 && cp <= 0x1faff)
  );
}
```

For external prompt-injection results, suppress narrow role-definition language only when `!isStrictUnicodeSurface(location.uri)` and the message/finding content matches a role-assignment rule without override, secret, upload, URL, or exfiltration language.

- [ ] **Step 5: Pin the field and malicious fixtures**

Add tests for decorative Markdown and agent-role prose passing, seeded bidi/zero-width/tag/homoglyph and classic jailbreak fixtures failing, strict `SKILL.md` remaining blocking, unrelated line insertion retaining the fingerprint, finding-content change invalidating it, and duplicate identical lines receiving distinct stable occurrence IDs.

Run: `npx vitest run tests/trust/fingerprint.test.ts tests/trust/lint.test.ts tests/trust/scan.test.ts`

Expected: exit 0.

- [ ] **Step 6: Update docs/CHANGELOG and run the full gate**

Run: `npm run verify`

Expected: exit 0 with all fingerprint fixtures updated to 64-hex content-bound identities.

- [ ] **Step 7: Commit, review, PR, and merge**

Commit: `feat: stabilize and narrow trust findings`

PR metadata: closes #418, milestone `next-release`, label `semver:minor`.

---

### Task 5: Implement #420 per-component authorization and partial ECC install

**Files:**

- Modify: `src/baseline-evidence/verify.ts`
- Modify: `src/baseline-evidence/run.ts`
- Modify: `src/baseline-evidence/pipeline.ts`
- Modify: `src/ecc/evidence.ts`
- Modify: `src/ecc/pipeline.ts`
- Modify: `src/ecc/verified.ts`
- Modify: `tests/baseline-evidence/verify.test.ts`
- Modify: `tests/baseline-evidence/run.test.ts`
- Modify: `tests/ecc/pipeline.test.ts`
- Modify: `tests/ecc/verified.test.ts`
- Modify: `tests/ecc/reconcile.test.ts`
- Modify: `docs/commands.md`
- Modify: `README.md`
- Modify: `CHANGELOG.md`

**Interfaces:**

- Produces: `BaselineHeldComponent`, `BaselineVerificationResult.held`, and a gate containing both `authorizations` and `held`.
- Consumes: exact vendor/org receipts and ECC component-to-materialization mappings.

- [ ] **Step 1: Write RED partition tests**

```ts
expect(verifyBaselineComponents(mixedInput)).toMatchObject({
  authorizations: [
    expect.objectContaining({ componentId: "module:rules-core" }),
  ],
  held: [
    {
      componentId: "module:hooks-runtime",
      codes: ["baseline.evidence-blocked"],
      details: expect.any(Array),
    },
  ],
});
```

Add pipeline tests proving mixed input calls the install builder once with only authorized receipts; zero-authorized input never calls it and exits non-zero; malformed signature/catalog/source input aborts before partition use.

- [ ] **Step 2: Add the partition type and stable grouping**

```ts
export interface BaselineHeldComponent {
  componentId: string;
  codes: string[];
  details: string[];
}

export interface BaselineVerificationResult {
  checks: Check[];
  authorizations: BaselineAuthorization[];
  held: BaselineHeldComponent[];
}
```

For every requested component without an authorization, append exactly one held record. Invalid lock/schema/signature and unsafe source failures remain exceptions or pre-gate failing reports; they do not become held records.

- [ ] **Step 3: Replace the all-or-nothing cleared gate**

```ts
export interface BaselineGate {
  sourceRoot: string;
  catalog: BaselineCatalog;
  componentIds: readonly string[];
  posture: Posture;
  vendorLock: BaselineEvidenceLock;
  vendorLockSha256: string;
  orgEvidence?: OrgBaselineEvidence;
  authorizations: BaselineAuthorization[];
  held: BaselineHeldComponent[];
}
```

`captureBaselineGate()` throws `BaselineEvidenceBlockedError` only when `authorizations.length === 0`. `baselineInstallPhasePlan()` re-verifies, passes only current authorizations to the builder, and includes a structured held-component digest/check stream.

- [ ] **Step 4: Intersect ECC selection before constructing operations**

Add `authorizedEccSelection(selection, authorizations)` in `src/ecc/evidence.ts`. Map authorization IDs back to whole modules, leaf skills, and leaf agents, then filter selection components. Before any npm/upstream step, require the matching runtime authorization:

```ts
function requireAuthorizedRuntime(
  authorizations: readonly BaselineAuthorization[],
  componentId: "runtime:ecc-installer" | "runtime:ecc-kiro",
): void {
  if (!authorizations.some((entry) => entry.componentId === componentId)) {
    throw new AihError(
      `refusing unauthorized ECC runtime ${componentId}`,
      "AIH_TRUST",
    );
  }
}
```

Construct manifests, file operations, MCP writes, and target ledger registrations from the filtered selection only. Never invoke a held helper runtime.

- [ ] **Step 5: Prove truthful partial ledger and prune behavior**

Add an enterprise mixed fixture where rules/agents install and hooks-runtime is held. Assert the target ledger omits hooks, retains receipt tiers for installed components, the human/JSON digest lists held IDs/codes, and prune removes an orphaned installed component without inventing a held component.

Run: `npx vitest run tests/baseline-evidence tests/ecc tests/prune`

Expected: exit 0.

- [ ] **Step 6: Update public contract and full verification**

Document partial success, held remediation, runtime authorization, and target-ledger truth. Add the #420 `[Unreleased]` Added entry.

Run: `npm run verify`

Expected: exit 0.

- [ ] **Step 7: Commit, review, PR, and merge**

Commit: `feat: install authorized ECC component subsets`

PR metadata: closes #420, milestone `next-release`, label `semver:minor`.

---

### Task 6: Implement #423 prune transaction ordering and divergence evidence

**Files:**

- Modify: `src/prune/index.ts`
- Modify: `src/ecc/prune-reconcile.ts`
- Modify: `src/ecc/reconcile-driver.ts`
- Modify: `tests/prune/command.test.ts`
- Modify: `tests/ecc/reconcile-driver.test.ts`
- Modify: `docs/commands.md`
- Modify: `CHANGELOG.md`

**Interfaces:**

- Consumes: current hash-bound reconciliation driver and whole-target dropped CLI set.
- Produces: a single ledger-last mutation boundary plus explicit target-named `EccPruneDivergence` evidence.

- [ ] **Step 1: Write the failing multi-target interleaving test**

Create two target fixtures. Inject failure after the first upstream uninstall mutates its target. Assert the old ledger bytes remain and the report either shows byte-identical rollback or contains `target=claude` plus affected paths under a divergence code.

```ts
expect(readFileSync(ledgerPath, "utf8")).toBe(beforeLedger);
expect(result.stderr).toMatch(/ECC prune divergence.*target=claude/);
```

- [ ] **Step 2: Move aih-owned removals into reconciliation input**

Replace unconditional `remove`/managed-block write actions in `prunePlan()` with typed reconciliation changes. `eccPruneReconciliationActions()` receives dropped targets and all aih-owned target removals, validates them, and emits the one driver action.

- [ ] **Step 3: Add explicit divergence output**

```ts
interface EccPruneDivergence {
  target: Cli;
  paths: string[];
  reason: string;
}

function divergenceError(value: EccPruneDivergence): Error {
  return new Error(
    `ECC prune divergence: target=${value.target}; paths=${value.paths.join(",")}; ${value.reason}; registration ledger not advanced`,
  );
}
```

The driver restores aih-owned changes on failure. If an upstream uninstall reports failure after it may have mutated, emit this error and skip target-state plus ledger replacement. Do not claim rollback of upstream-owned bytes.

- [ ] **Step 4: Pin success, rollback, divergence, and ledger-last tests**

Run: `npx vitest run tests/ecc/reconcile-driver.test.ts tests/prune/command.test.ts`

Expected: exit 0; every injected failure leaves the ledger unchanged.

- [ ] **Step 5: Update docs/CHANGELOG and full verify**

Run: `npm run verify`

Expected: exit 0.

- [ ] **Step 6: Commit, review, PR, and merge**

Commit: `fix: keep prune removals ledger-consistent`

PR metadata: closes #423, milestone `next-release`, label `semver:patch`.

---

### Task 7: Implement #424 GitHub-bound escalation acknowledgement

**Files:**

- Create: `src/internals/release-intent-artifact.ts`
- Create: `tests/release/intent-artifact.test.ts`
- Modify: `src/internals/release-preflight.ts`
- Modify: `tests/release/preflight.test.ts`
- Modify: `RELEASING.md`
- Modify: `docs/security/release-slsa.md`
- Modify: `CHANGELOG.md`

**Interfaces:**

- Produces: `IntentAcknowledgementArtifact` and `resolveIntentAcknowledgementComment()`.
- Consumes: existing `intentAcknowledgementToken(candidateSha, declaredIntent, computedBump)`.

- [ ] **Step 1: Write RED artifact validation tests**

```ts
const artifact = {
  repository: "samartomar/ai-harness",
  issueNumber: 900,
  commentId: 123456,
  commentUrl:
    "https://github.com/samartomar/ai-harness/issues/900#issuecomment-123456",
  author: "samartomar",
  authorAssociation: "OWNER" as const,
  createdAt: "2026-07-10T23:00:00Z",
  token: `${candidateSha}:patch:minor`,
};
expect(validateIntentAcknowledgementArtifact(input, artifact)).toEqual(
  artifact,
);
```

Add rejection cases for wrong repository, non-tracker issue, mismatched token, changed SHA/intent/bump, missing immutable ID, and association outside OWNER/MEMBER/COLLABORATOR.

- [ ] **Step 2: Define and validate the artifact**

```ts
export interface IntentAcknowledgementArtifact {
  repository: string;
  issueNumber: number;
  commentId: number;
  commentUrl: string;
  author: string;
  authorAssociation: "OWNER" | "MEMBER" | "COLLABORATOR";
  createdAt: string;
  token: string;
}
```

Parse GitHub issue-comment URLs strictly, fetch with `gh api repos/{owner}/{repo}/issues/comments/{id}`, and validate the returned `html_url`, `issue_url`, body token, user login, author association, and creation timestamp. Return data only; keep the pure preflight evaluator network-free.

- [ ] **Step 3: Replace raw-token acceptance in preflight**

Change `PreflightData` to accept `intentAcknowledgementArtifact?: IntentAcknowledgementArtifact`. `runPreflight()` accepts escalation only when the artifact token equals the required token and its repository/issue match the gathered release tracker. Include the artifact in `Manifest`.

Replace `--ack-intent-escalation <token>` with `--ack-intent-escalation-comment <url>`. Live mode resolves the URL before `runPreflight`; `--input` fixtures carry an already resolved artifact and make no network call.

- [ ] **Step 4: Pin CLI and residual-risk behavior**

Tests prove a raw token alone cannot pass, a valid comment artifact can pass, and the JSON manifest includes immutable ID, URL, author/authority, timestamp, and SHA/intent/bump-bound token.

Update docs to say a fully credentialed runner can still post the comment; the gain is public timestamped attributable evidence, not automation-proof authorization.

- [ ] **Step 5: Run gates and commit**

Run: `npx vitest run tests/release && npm run verify`

Expected: exit 0.

Commit: `feat: bind release escalation to GitHub evidence`

PR metadata: closes #424, milestone `next-release`, label `semver:minor`; independently review and merge after CI.

---

### Task 8: Implement #421 cleanup, progress, bounded inventory, and dry-run preview

**Files:**

- Create: `src/trust/inventory.ts`
- Create: `tests/trust/inventory.test.ts`
- Create: `src/ecc/install-preview.ts`
- Create: `src/baseline-evidence/ecc-install-preview.json`
- Modify: `src/internals/plan.ts`
- Modify: `src/commands/run.ts`
- Modify: `src/trust/scan.ts`
- Modify: `src/trust/detectors.ts`
- Modify: `src/trust/depnames.ts`
- Modify: `src/trust/manifest.ts`
- Modify: `src/trust/fetch.ts`
- Modify: `src/ecc/pipeline.ts`
- Modify: `tests/commands/run.test.ts`
- Modify: `tests/trust/scan.test.ts`
- Modify: `tests/ecc/pipeline.test.ts`
- Modify: `tests/contract/command-surface.json`
- Modify: `docs/commands.md`
- Modify: `CHANGELOG.md`

**Interfaces:**

- Produces: optional `PlanContext.progress`, cleanup registration, `TrustFileInventory`, and deterministic contingent ECC install previews.
- Consumes: the shipped catalog/preview metadata; dry-run performs no fetch or mutation.

- [ ] **Step 1: Write RED command-boundary cleanup tests**

Capture a temporary GitHub trust source, inject block and throw paths, and assert no `aih-quarantine-*` directory remains. Add a `--keep-quarantine` case that retains exactly one directory and prints its path on stderr.

- [ ] **Step 2: Add optional progress and cleanup seams to `PlanContext`**

```ts
export interface PlanContext {
  // existing fields remain unchanged
  progress?: (message: string) => void;
  deferCleanup?: (cleanup: () => void | Promise<void>) => void;
}
```

In `runCapability()`, collect deferred cleanup callbacks, execute them in a `finally` block in reverse order, and wire progress to `process.stderr.write(message + "\n")`. Tests inject writers so stdout and stderr remain separately assertable. Cleanup errors append a secondary diagnostic without replacing the primary thrown/report failure.

- [ ] **Step 3: Register trust quarantine ownership once**

When `trustScanPlanForSource()` owns a GitHub quarantine, call `ctx.deferCleanup(() => cleanupQuarantine(source))` immediately after source resolution unless `keepQuarantine === true`. Remove cleanup from the dynamic digest so every success/block/throw path shares the command-level boundary. Add `--keep-quarantine` to the scan option and command contract fixture.

- [ ] **Step 4: Build and reuse one bounded inventory**

```ts
export interface TrustFileEntry {
  absolutePath: string;
  relativePath: string;
  size: number;
}

export interface TrustFileInventory {
  files: readonly TrustFileEntry[];
  matching(
    predicate: (entry: TrustFileEntry) => boolean,
  ): Iterable<TrustFileEntry>;
}
```

Construct it once in `scanTrustTreeWithAnalyzers()`, pass it to native, dependency, manifest, and detector adapters, and read file contents only inside the active bounded worker. Emit progress before inventory, after every 250 processed files, and at each external detector boundary. Do not store file contents in the inventory.

- [ ] **Step 5: Prove stderr progress and clean JSON stdout**

Use a 3,149-file fixture and an injected slow runner. Assert progress is observable before completion, stdout parses as one JSON value, inventory construction occurs once, and the run completes. Assert counters/state are bounded; do not assert elapsed milliseconds.

- [ ] **Step 6: Ship deterministic contingent ECC install preview metadata**

Generate `src/baseline-evidence/ecc-install-preview.json` from the exact pinned upstream manifest during baseline vet. Each entry contains target, operation kind, source/destination template, and owning component ID. Artifact checks bind the preview file to the same pinned SHA.

```ts
export interface ContingentEccInstallOperation {
  target: Cli;
  kind: "copy-file" | "merge-json" | "managed-block" | "exec";
  source?: string;
  destination: string;
  componentId: string;
  contingentOn: "evidence-authorization";
}
```

For remote dry-run, filter the shipped preview by requested target and selected components, emit stable sorted digest/JSON operations, and return without `trustFetchExec`, filesystem mutation, or runtime invocation.

- [ ] **Step 7: Run focused and full gates**

Run: `npx vitest run tests/commands/run.test.ts tests/trust tests/ecc/pipeline.test.ts tests/contract && npm run verify`

Expected: exit 0.

- [ ] **Step 8: Commit, review, PR, and merge**

Commit: `fix: make trust scans observable and self-cleaning`

PR metadata: closes #421, milestone `next-release`, label `semver:patch`.

---

### Task 9: Finish #417 with vet-once evidence and real fixture-HOME installs

**Files:**

- Create: `src/internals/check-baseline-installable.ts`
- Modify: `tests/baseline-evidence/installable-release-gate.test.ts`
- Modify: `src/internals/baseline-sources.ts`
- Modify: `src/baseline-evidence/vendor-lock.json`
- Modify: `src/baseline-evidence/vendor-lock.sigstore.json`
- Modify: `src/baseline-evidence/ecc-install-preview.json`
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/release.yml`
- Modify: `CHANGELOG.md`

**Interfaces:**

- Produces: `InstallableBaselineReport` and `npm run check:baseline-installable`.
- Consumes: final #418/#419/#420/#422 trust/install semantics, shipped vendor evidence, and fixture-HOME CLI execution.

- [ ] **Step 1: Rebase the draft #417 branch after Tasks 2–8 merge**

```bash
git fetch origin main
git rebase origin/main
```

Expected: the original v2.8.0 RED fixture remains unchanged.

- [ ] **Step 2: Vet an exact upstream ECC commit once**

Resolve upstream `main` to a full 40-character SHA, inspect the diff since the shipped pin, and prepare exact ECC and Superpowers checkouts for the existing analyzer-backed generator:

```bash
ECC_ROOT="$(mktemp -d)/ECC"
SUPERPOWERS_ROOT="$(mktemp -d)/Superpowers"
ECC_PIN="$(gh api repos/affaan-m/ECC/commits/main --jq .sha)"
SUPERPOWERS_PIN="$(node -e "const s=require('node:fs').readFileSync('./src/internals/baseline-sources.ts','utf8'); const m=s.match(/owner: \"obra\",[\\s\\S]{0,120}?pinnedSha: \"([0-9a-f]{40})\"/); if (!m) process.exit(1); process.stdout.write(m[1])")"
test "${#ECC_PIN}" -eq 40
test "${#SUPERPOWERS_PIN}" -eq 40
git clone https://github.com/affaan-m/ECC.git "$ECC_ROOT"
git -C "$ECC_ROOT" checkout --detach "$ECC_PIN"
git clone https://github.com/obra/superpowers.git "$SUPERPOWERS_ROOT"
git -C "$SUPERPOWERS_ROOT" checkout --detach "$SUPERPOWERS_PIN"
git -C "$ECC_ROOT" diff 4130457d674d2180c5af2c5f634f3cae4cbc6c4f.."$ECC_PIN" --stat
```

After reviewing the upstream diff, update only the ECC pin in `src/internals/baseline-sources.ts`, then regenerate with:

```bash
npm run baseline:vet -- --ecc-root "$ECC_ROOT" --superpowers-root "$SUPERPOWERS_ROOT"
```

Accept the pin only if the installer runtime and at least one common/project component are authorized at every posture. Do not require hooks-runtime to pass at enterprise. Update the source registry, signed per-component lock, signature bundle, and install-preview artifact atomically from the accepted run.

- [ ] **Step 3: Implement the fixture-HOME gate**

```ts
export interface InstallablePostureResult {
  installed: number;
  installedComponentIds: string[];
  held: Array<{ componentId: string; codes: string[] }>;
  ledgerPath: string;
}

export interface InstallableBaselineReport {
  pin: string;
  postures: Record<Posture, InstallablePostureResult>;
  ok: boolean;
}
```

`checkInstallableBaseline()` creates a temporary HOME and project for each of `vibe`, `team`, and `enterprise`, runs the built CLI with the matching explicit `--posture` plus `ecc --cli claude --apply --yes`, reads the target state and registration ledger, verifies every installed component has an exact receipt/hash, and removes the fixture root in `finally`. It sets HOME/USERPROFILE to the fixture and rejects any resolved path outside it.

Set `ok` only when all three postures install at least one component, ledgers equal the actual installed sets, held components are named with codes, and no unauthorized runtime or source/evidence drift appears.

- [ ] **Step 4: Keep the v2.8.0 regression and add GREEN current-lock tests**

The frozen v2.8.0 lock remains `installed === 0` and `ok === false` at enterprise. The current shipped lock must produce `installed > 0` and `ok === true` for vibe, team, and enterprise. Add an explicit assertion that enterprise may hold `module:hooks-runtime` with `trust.auto-exec-hook` while remaining green.

- [ ] **Step 5: Wire CI and release gates**

Add `"check:baseline-installable": "tsx src/internals/check-baseline-installable.ts"` to `package.json` and call it from `verify`. Add a named CI step on Linux, Windows, and macOS after build. Add the same step before packaging in `release.yml`. Any zero-install posture exits 1 and blocks the workflow.

- [ ] **Step 6: Run the full local release gate in fixture homes**

Run: `npm run verify`

Expected: exit 0, including current-lock installs at all three postures and the frozen v2.8.0 regression proving the old lock fails.

- [ ] **Step 7: Add CHANGELOG, independent reviews, and finish the draft PR**

Add the #417 `[Unreleased]` Fixed entry. Run security/domain review and independent code review, address all findings, mark the PR ready, and wait for every required GitHub check to pass.

Commit: `ci: gate releases on installable baseline evidence`

PR metadata: closes #417, milestone `next-release`, label `semver:patch`. Merge last under standing authorization, then verify #417 is closed and no `release-blocker` remains open.

---

### Task 10: Reconcile the train before release preparation

**Files:**

- Modify only if required by merged truth: internal companion `CURRENT.md`, `NEXT.md`, `PIPELINE.md`, feature notes, and release history inputs.
- Do not bump public version files in this task.

**Interfaces:**

- Consumes: merged PRs for #417–#424 and train #33.
- Produces: a swept, internally reconciled train ready for the separate cut procedure.

- [ ] **Step 1: Verify public state**

Run:

```bash
gh issue list --milestone next-release --state open
gh pr list --state open
npm run release:preflight -- --milestone next-release --intent minor
```

Expected before the tracker exists or while unclassified work remains: named findings only. Expected after sweep: no open non-tracker blocker and computed bump `minor`.

- [ ] **Step 2: Verify every merged PR contract**

Confirm one authoritative semver label, milestone #33, `[Unreleased]` entry, independent reviewer record, green required checks, and correct closing issue for each of the eight PRs.

- [ ] **Step 3: Reconcile internal canon and run its docs gate**

Run: `pwsh -NoLogo -NoProfile -File tools/check-docs.ps1`

Expected: `problems=0 warnings=0`.

- [ ] **Step 4: Stop before publication**

Prepare the release-cut plan using the computed minor result. Do not tag or publish until the exact final main SHA receives the canonical authorization sentence and the npm-publish environment approval is clicked.
