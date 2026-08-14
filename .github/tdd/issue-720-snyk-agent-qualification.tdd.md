# Issue #720 — Snyk Agent Scan behavioral qualification

## Source and journeys

The journeys were derived from issue #720.

- As a maintainer, I want a manually dispatched Snyk qualification so the repository secret is
  never exposed to pull-request or scheduled workflows.
- As a security reviewer, I want the qualification to scan only generated benign skill content so
  the AIH checkout and MCP commands never cross the external scanner boundary.
- As a release reviewer, I want a commit-bound sanitized artifact proving the exact governed
  analyzer completed before its ledger disposition changes.

## Task report

### RED — workflow contract

Command:

```text
npm test -- --run tests/workflows/snyk-agent-qualification.test.ts
```

Result: **FAIL**, 1 file / 3 tests failed. Every failure stopped at the assertion that
`.github/workflows/snyk-agent-qualification.yml` did not exist. This was the intended missing-
implementation failure and is preserved in commit `9e7cfc26`.

### GREEN — manual qualification workflow

Command:

```text
npm test -- --run tests/workflows/snyk-agent-qualification.test.ts
```

Result: **PASS**, 1 file / 3 tests passed.

The workflow is manual-only, read-only, pins every action by immutable SHA, scopes
`SNYK_TOKEN` to the scan step, builds AIH, warms the exact committed uv environment, and invokes
the built CLI with a generated temporary skill as both root and scan target. It uploads only a
five-day sanitized summary containing the commit, workflow run identity, analyzer identity,
status, target class, and SHA-256 of the ephemeral raw result.

### Review-driven RED — ref and evidence integrity

Independent CI/trust and security review found that the first draft used a repository secret on a
branch-selectable manual workflow and accepted whole-document magic strings as qualification. The
review reproducer was committed at `0543802e`.

Command:

```text
npm test -- --run tests/workflows/snyk-agent-qualification.test.ts tests/workflows/snyk-agent-qualification-validator.test.ts
```

Result: **FAIL**, 2 files / 5 tests failed. The workflow lacked a protected environment and main
ref guard; the structured validator did not exist.

### Review-driven GREEN — protected environment and structured receipt

Command:

```text
npm test -- --run tests/workflows/snyk-agent-qualification.test.ts tests/workflows/snyk-agent-qualification-validator.test.ts
```

Result: **PASS**, 2 files / 6 tests passed. The workflow now requires the
`snyk-agent-qualification` environment, checks `refs/heads/main`, runs trust scan with `--verify`,
and delegates receipt creation to a bounded validator. The validator requires exactly one named
Snyk detector check with `verdict: pass`, cross-checks its exact analyzer list against the trust
runtime advisory, rejects magic strings in unavailable details, and requires numeric GitHub run
identities.

## Test specification

| # | What is guaranteed | Test | Type | Result |
|---|---|---|---|---|
| 1 | Only `workflow_dispatch` can provide the credential, and permissions are `contents: read` | `is manual-only, read-only, and keeps the secret scoped to the scan step` | workflow contract | PASS |
| 2 | The token is referenced once, only on the scan step, and is never echoed | same | secret boundary | PASS |
| 3 | AIH targets a `mktemp` skill fixture, never `.`, and no MCP configuration or dangerous auto-run flag appears | `targets only a disposable skill fixture and never enables MCP execution` | security regression | PASS |
| 4 | Checkout, Node, Python, uv, and artifact actions use immutable commit pins | `uses immutable actions, the exact locked runtime, and a sanitized short-lived artifact` | supply-chain regression | PASS |
| 5 | The committed Snyk lock is warmed and the exact `snyk-agent-scan@uv:0.5.17` identity must appear in AIH output | same | behavioral contract | PASS locally; live credentialed run pending |
| 6 | A branch ref cannot satisfy the committed workflow contract, and the token-bearing job names the protected environment | `is manual-only, read-only, and keeps the secret scoped to the scan step` | secret-boundary regression | PASS |
| 7 | An unavailable check carrying the expected magic strings cannot produce a qualification receipt | `rejects an unavailable check even when its detail contains every magic string` | negative security regression | PASS |
| 8 | Missing GitHub run identities fail instead of producing `unknown` evidence | `rejects missing GitHub run identities instead of writing unknown placeholders` | evidence-integrity regression | PASS |

## Coverage and known gaps

The repository declares npm with Vitest in `package.json`; the generic
`scripts/setup-package-manager.js --detect` helper referenced by the TDD skill is not present, so
the repository contract and lockfile were used instead.

The workflow cannot be dispatched from a pull-request-only branch because GitHub requires a
`workflow_dispatch` workflow to exist on the default branch. This first PR therefore references,
but does not close, issue #720. After it merges, the workflow must run against the exact `main`
commit. The ledger remains `blocked` until that run succeeds and its public run URL is recorded in
a follow-up evidence change.

## Merge evidence

- RED checkpoint: `9e7cfc26 test: require safe Snyk qualification workflow`
- GREEN checkpoint: `4038b6f6 ci: qualify Snyk on a synthetic fixture`
- Review RED checkpoint: `0543802e test: harden Snyk qualification evidence`
- Review GREEN checkpoint: `a5f3605c fix: protect Snyk qualification evidence`
