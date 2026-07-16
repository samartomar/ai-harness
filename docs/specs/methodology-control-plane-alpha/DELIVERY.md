# Final alpha delivery blueprint

> Status: final qualification-first, multi-session delivery plan. It incorporates
> the four-voice council and two independent external reviews. A clean cloud or
> Hyper-V session must be able to execute it without chat history.

## 1. Delivery mode

### Branch and base

```text
branch: alpha/2.12-methodology-control-plane
base tag: v2.11.0
base commit: eb8a1944cc37cf23a6104ea768abd4a27b2b3b26
current delivery: documentation only
```

The branch is local and uncommitted under an explicit no-commit/no-push instruction.
It is not durable or fetchable from another machine. Do not start cloud or Hyper-V
implementation until a maintainer separately authorizes a docs-only commit and a
reviewed transfer or push. Do not create a second manual copy of a changing plan.

### Phase A product boundary

Phase A is a **methodology qualification plane**. No product command:

- executes provider code, including an upstream preview or dry-run;
- invokes an installer, uninstaller, updater, doctor, or repair command;
- modifies provider-visible host state;
- writes project methodology authority or provider canon;
- installs, activates, switches, deactivates, or rolls back a provider;
- writes an activation receipt;
- claims `deliverable`, `activatable`, `switchable`, or `concurrent` support.

Phase A can inspect an exact local source as inert data, join trust evidence, derive a
pure plan, qualify compatibility and host visibility, and issue a deterministic report.

### Release channel

If authorized after qualification implementation, the first publishable candidate is
`2.12.0-alpha.1` under npm dist-tag `next`. It must not modify `latest`. Version changes
occur only during authorized release preparation.

A stable AIH core release does not require ECC or gstack to become activatable. Stable
eligibility covers the provider-neutral qualification plane. Provider activation, if
ever supported, is published as a separate compatibility/support matrix.

### Test modes

| Mode | Purpose | Provider code executed? | Allowed location |
| --- | --- | --- | --- |
| `fixture` | Schema, parser, and report tests. | No | Development machine/CI |
| `synthetic` | Deterministic conflict and unknown-state qualification. | Synthetic data only | Development machine/CI |
| `real-inert` | Read exact ECC/gstack checkouts as files and derive plans. | No | Clean checkout; disposable preferred |
| `manual-disposable-research` | Learn whether provider claims match behavior. | Yes | Separate authorized VM/cloud runbook only |

An existing workstation may contain global ECC, gstack, or another provider. A
non-mutating inventory can correctly report `UNOWNED_PROVIDER_CONFLICT`; do not repair
or suppress it. `real-inert` qualification must not invoke provider scripts and cannot
damage the current installation, but disposable execution is still preferred for clean
evidence.

## 2. Cold-start contract

Before implementation, read:

```text
AGENTS.md
ai-coding/RULE_ROUTER.md
ai-coding/project.md
ai-coding/rules/agent-behavior-core.md
ai-coding/rules/project-canon-extension.md
ai-coding/rules/engine-invariants.md
ai-coding/rules/product-principles.md
ai-coding/rules/review-protocol.md
STABILITY.md
RELEASING.md
docs/ARCHITECTURE.md
docs/THREAT_MODEL.md
docs/specs/methodology-control-plane-alpha/README.md
docs/specs/methodology-control-plane-alpha/FINDINGS.md
docs/specs/methodology-control-plane-alpha/SPEC.md
docs/specs/methodology-control-plane-alpha/PROVIDERS.md
docs/specs/methodology-control-plane-alpha/ACCEPTANCE.md
```

After the branch is authorized and made fetchable, a new machine starts with:

```powershell
git clone https://github.com/samartomar/ai-harness.git ai-harness-methodology-alpha
cd ai-harness-methodology-alpha
git checkout alpha/2.12-methodology-control-plane
git rev-parse HEAD
npm ci
npm run docs:lint
```

Until then, the only authority is the existing local worktree. Never reconstruct the
plan from memory or archived chat.

Never run a mutating AIH project-governance command against the AIH checkout itself.
Product behavior uses temporary fixture roots.

## 3. Scope lock

### Phase A in scope

- strict provider/source/host/compatibility proposal schemas;
- separate trust, conformance, host, isolation, and support states;
- provider contract and host load-surface contract types;
- bounded compatibility key;
- exact local-source identity and inert tree hashing;
- existing evidence joins on exact identity;
- inert provider discovery and installer-contract fingerprinting;
- pure deterministic proposed plans;
- synthetic conflicting providers and deterministic failure fixtures;
- Codex-version-specific load-surface feasibility research;
- ECC and gstack exact-source real-inert qualification;
- deterministic `QualificationReport`;
- additive read-only methodology command surface;
- go/no-go decision for separately authorized mutation research.

### Phase A out of scope

- provider code execution of any kind;
- project authority or canonical provider writes;
- activation receipts, journals, locks, or mutation recovery code;
- real installation, switching, deactivation, rollback, or concurrency;
- remote acquisition and floating source resolution;
- support for additional providers;
- provider failover;
- fleet rollout, MDM, hosted services, or remote mutation;
- whole-repository ECC/gstack remediation;
- changing existing v2 defaults or legacy commands;
- publishing a release during implementation sessions.

## 4. Phase A dependency graph

```text
Q0 documentation mutation locked
  -> Q1 Codex load-surface feasibility spike
      -> G1 feasibility decision
          -> Q2 schemas and state
              -> Q3 provider/host/compatibility contracts
                  -> Q4 exact local source and evidence joins
                      -> Q5 inert discovery and pure plan
                          -> Q6 synthetic conflicts and reports
                              -> Q7 ECC real-inert qualification --+
                              -> Q8 gstack real-inert qualification +-> Q9 go/no-go
```

Q7 and Q8 may proceed in parallel after Q6. No provider-specific change may alter the
core contract independently; missing contract needs return to Q3 for one reviewed
change.

G1 is an early investment gate. If Codex offers no complete or defensibly bounded
load-surface contract, Phase A may still produce honest `plannable` reports, but work
toward activatable support stops unless the maintainer explicitly accepts a different
host or a qualification-only product outcome.

## 5. Phase A implementation steps

Each step is independently reviewable and contains its cold-start context, tasks,
verification, exit, and rollback.

### Q0 — Lock the revised plan

**Context:** Council and external review found that detection is not installer
confinement, receipts are not recovery journals, runtime absence needs a complete host
contract, and adapter support cannot cover arbitrary commits.

**Tasks:**

- Keep this directory internally consistent and qualification-only.
- Add methodology threats to `docs/THREAT_MODEL.md` only when code begins to ship.
- Draft a public-safe tracking issue; do not open it without authorization.
- Obtain explicit authorization before committing or transferring this branch.

**Verification:** `npm run docs:lint`, local link check, `git diff --check`.

**Exit:** No document presents Phase A as installation, activation, or switching.

**Rollback:** Documentation-only revert.

### Q1 — Codex load-surface feasibility spike

**Context:** Negative activation proof is impossible unless every runtime-visible
surface is known for an exact Codex build. This is the cheapest decisive experiment
and precedes adapter implementation.

**Tasks:**

- Select the exact Codex build and OS/architecture for the first matrix entry.
- Identify executable identity, project/global instruction precedence, skills/plugin
  paths, hooks, MCP/config, environment and CLI overrides, profile-home semantics,
  caches, inherited configuration, and session persistence.
- Identify possible positive and negative probe procedures without relying on provider
  claims.
- Assign coverage `complete`, `partial`, or `unknown`, with evidence for every row.
- Record whether complete coverage can be reproduced on a clean second environment.

**Likely files:**

```text
docs/specs/methodology-control-plane-alpha/host-contracts/codex-<version>.md
tests/fixtures/methodology/hosts/codex-<version>.json
```

**Verification:** documentation lint; fixture schema test when fixture code exists.

**Exit:** G1 records one of:

- `HOST_CONTRACT_FEASIBLE` — complete coverage appears implementable;
- `HOST_CONTRACT_PARTIAL` — qualification can continue, activation research stops;
- `HOST_CONTRACT_UNKNOWN` — stop and redesign or select another host.

**Rollback:** Remove experimental fixture; retain evidence-backed decision record.

### Q2 — Add strict schemas and state axes

**Likely files:**

```text
src/methodology/schema.ts
src/methodology/state.ts
schemas/aih-methodology-qualification.schema.json
tests/methodology/schema.test.ts
```

**Tasks:**

- Parse provider, exact local source, host, compatibility proposal, and optional future
  intent shape.
- Define support ladder through `mutation-research-eligible`.
- Reject malformed paths, unknown fields, control characters, short commits, and
  unsupported enum values.
- Model unenrolled project as valid and selected-but-inactive as non-active.
- Add stable Phase A finding codes.

**Verification:** targeted tests, `npm run typecheck`, `npm run lint`.

**Exit:** Invalid input never reaches source inspection or adapter logic.

**Rollback:** Remove unused module/schema; no owned state exists.

### Q3 — Add provider, host, and compatibility contracts

**Likely files:**

```text
src/methodology/contracts/provider.ts
src/methodology/contracts/host.ts
src/methodology/contracts/compatibility.ts
tests/methodology/contracts.test.ts
```

**Tasks:**

- Implement Phase A adapter operations only.
- Implement `HostLoadSurfaceContract` with explicit coverage.
- Implement the complete compatibility key from [SPEC.md](SPEC.md).
- Unknown tuples fail closed.
- Use deterministic result envelopes with root-cause hint, safe retry, and stop
  condition.
- Add no mutation, installer, launch, receipt, or rollback interface.

**Verification:** contract tests, typecheck, lint.

**Exit:** The qualification core contains no provider-name branching outside the
registry and no execution-capable interface.

**Rollback:** Contract remains isolated from commands and persistence.

### Q4 — Resolve exact local source and evidence joins

**Likely files:**

```text
src/methodology/source.ts
src/methodology/evidence.ts
tests/methodology/source.test.ts
tests/methodology/evidence.test.ts
```

**Tasks:**

- Accept only operator-supplied local Git checkouts in Phase A.
- Require `HEAD` to match the requested full commit.
- Hash the inert source tree without following escaping links.
- Join existing evidence only on exact repository, commit, paths, and tree hash.
- Never invoke Git hooks, package scripts, provider commands, or remote acquisition.
- Detect source changes between qualification stages.

**Verification:** local fixture repositories, path/link tests, evidence mismatch tests,
typecheck/lint.

**Exit:** Qualification always names the exact inert bytes it analyzed.

**Rollback:** Temporary quarantine is removed; no persistent vendor cache.

### Q5 — Implement inert discovery and pure proposed plans

**Likely files:**

```text
src/methodology/discover.ts
src/methodology/plan.ts
tests/methodology/discover.test.ts
tests/methodology/plan.test.ts
```

**Tasks:**

- Parse provider manifests/scripts as data.
- Identify installer entry point without loading or importing it.
- Fingerprint the installer contract from declared source closure.
- Derive proposed writes, processes, services, network, updater, runtime, and uninstall
  assumptions.
- Mark every unknown; do not infer a safe default.
- Produce byte-stable plans for unchanged input.
- Reject any adapter attempt to execute an upstream preview or dry-run.

**Verification:** deterministic golden tests, malicious manifest fixtures, no-spawn
assertions, typecheck/lint.

**Exit:** Same source/contract input produces the same plan digest with zero provider
execution.

**Rollback:** No provider or authority state exists.

### Q6 — Add synthetic conflicts and qualification reports

**Likely files:**

```text
src/methodology/qualify.ts
src/methodology/report.ts
tests/fixtures/methodology/providers/
tests/methodology/qualify.test.ts
tests/methodology/report.test.ts
```

**Tasks:**

- Add synthetic providers representing shared destinations, self-updaters, unknown
  processes, incomplete uninstall, incompatible commits, and incomplete host coverage.
- Implement `QualificationReport` and result classifications.
- Prove unknown facts fail closed without fallback.
- Prove reports contain no secret values or provider source content.
- Add fresh-clone scenario: valid future intent, no activation state, selected but
  inactive, zero mutation.

**Verification:** qualification matrix in [ACCEPTANCE.md](ACCEPTANCE.md), golden JSON,
secret scrub, typecheck/lint.

**Exit:** Every control failure can be reproduced without vendor bytes or mutation.

**Rollback:** Remove additive qualification modules; no external state.

### Q7 — Qualify ECC as inert source

**Context:** ECC is a research subject, not an AIH baseline prerequisite. Existing ECC
evidence can be joined only on exact identity.

**Likely files:**

```text
src/methodology/adapters/ecc-qualification.ts
tests/methodology/ecc-qualification.test.ts
```

**Tasks:**

- Read an operator-selected exact ECC checkout as inert data.
- Identify provider kind, methodology closure, installer fingerprint, proposed
  destinations, update/repair behavior, hooks/MCP/rules/skills/agents/commands, and
  runtime requirements.
- Join exact existing evidence without changing the ECC baseline pin.
- Evaluate the exact compatibility tuple and Codex host contract.
- Produce `QUALIFICATION_PASS`, `QUALIFICATION_FAIL_CLOSED`, or
  `QUALIFICATION_BLOCKED` without executing ECC code.

**Verification:** fixture tests plus `real-inert` qualification on a clean checkout.

**Exit:** ECC is honestly classified no higher than
`mutation-research-eligible`; no source repair or install occurs.

**Rollback:** Remove adapter; no ECC state changed.

### Q8 — Qualify gstack as inert source

**Likely files:**

```text
src/methodology/adapters/gstack-qualification.ts
tests/methodology/gstack-qualification.test.ts
```

**Tasks:**

- Read an operator-selected exact gstack checkout as inert data.
- Identify setup/uninstall entry points, installer fingerprint, proposed Codex
  destinations, Bun/Node/browser/daemon requirements, child processes, network, team
  mode, and self-update behavior.
- Evaluate the exact compatibility tuple and Codex host contract.
- Produce a deterministic plan and qualification result without importing or executing
  gstack code.

**Verification:** fixture tests plus `real-inert` qualification on a clean checkout.

**Exit:** gstack is honestly classified no higher than
`mutation-research-eligible`; no setup occurs.

**Rollback:** Remove adapter; no gstack state changed.

### Q9 — Add read-only CLI and make the go/no-go decision

**Likely files:**

```text
src/methodology/index.ts
src/commands/index.ts
tests/methodology/command.test.ts
tests/contract/command-surface.json
docs/commands.md
CHANGELOG.md
```

**Tasks:**

- Add only `inspect`, `plan`, `qualify`, and `status`.
- Preserve JSON envelope and exit-code contracts.
- Regenerate the additive command-surface fixture.
- Keep all legacy commands and defaults unchanged.
- Run the complete Phase A acceptance matrix.
- Record whether any exact ECC/gstack compatibility tuple reaches
  `mutation-research-eligible`.
- Recommend Phase B, remain qualification-only, select another host, or stop.

**Verification:** targeted command/contract tests, docs lint, typecheck, lint, test,
build, then `npm run verify`.

**Exit:** One evidence-backed qualification result and go/no-go decision. Completion
does not authorize Phase B or release publication.

**Rollback:** Remove additive commands before stable release if the qualification
surface has no defensible product value.

## 6. Separately authorized Phase B research

Phase B is not part of Phase A implementation authority. It begins only after a new
maintainer instruction and a specific compatibility tuple reaches
`mutation-research-eligible`.

```text
M0 approve one provider/commit/adapter/host/OS/isolation tuple
M1 durable write-ahead journal, locks, ownership, and leases
M2 externally enforced containment and staging boundary
M3 pending-activation state and fresh-host nonce handshake
M4 positive and negative runtime attestation over complete host contract
M5 bounded authority transition and deactivation
M6 kill, contention, lock-expiry, drift, and recovery fault injection
M7 environment-taint handling and snapshot destruction criteria
M8 decide whether any mutation command may enter an npm alpha
```

Manual provider execution occurs only in a disposable environment. Before/after
inventories are evidence, not confinement. If a provider can affect state outside a
bounded observable surface, the result is `INSTALLER_CONFINEMENT_UNPROVEN` and no
product apply command is built.

Phase B must distinguish:

- `ROLLBACK_REQUIRED` — recovery has not yet completed but the bounded prior state is
  still positively reconstructable;
- `ENVIRONMENT_TAINTED` — prior state cannot be positively reconstructed; destroy or
  restore the environment snapshot;
- `ROLLBACK_FAILED` — an attempted bounded restoration failed and transitions to
  `ENVIRONMENT_TAINTED`.

## 7. Verification cadence

During implementation:

```powershell
npx vitest run tests/methodology
npm run typecheck
npm run lint
npm run docs:lint
```

Before a reviewable unit or release decision:

```powershell
npm run verify
```

Do not change baseline evidence, analyzer requirements, trust verdicts, or unrelated
tests to make qualification pass.

## 8. Plan mutation protocol

Evidence that invalidates the plan is recorded before implementation continues.

Required entry:

```text
Date:
Step:
Evidence:
Decision:
Files/contract changed:
Acceptance impact:
Rollback impact:
Approved by:
```

Allowed mutations:

- **Split** a step when it cannot remain independently reviewable.
- **Insert** a prerequisite when a trust or visibility boundary is missing.
- **Reorder** only when dependency edges remain valid.
- **Replace provider** only after documenting why ECC or gstack cannot test the
  intended contract and selecting an equal-or-harder qualification subject.
- **Abandon** when safe progress requires turning AIH into a runtime, vendor mirror,
  or uncontrolled installer.

No session silently relaxes acceptance or converts blocked into pass.

### Mutation ledger

```text
Date: 2026-07-15
Step: D0 / global delivery scope from the original draft
Evidence:
Four-voice council and two independent reviews determined that unexpected-write
detection and terminal receipts do not provide installer confinement or crash
recovery. Runtime absence requires a version-specific complete host load-surface
contract, and adapter support must be bounded to an exact compatibility tuple.

Decision:
Replace the installation/switching first alpha with qualification-only Phase A.
Move all provider execution, journal/lock work, activation, switching, rollback,
and concurrency into separately authorized Phase B research. Make Codex load-surface
feasibility the first technical gate.

Files/contract changed:
README.md, FINDINGS.md, SPEC.md, PROVIDERS.md, DELIVERY.md, ACCEPTANCE.md

Acceptance impact:
Replace ALPHA_PASS/FAIL_CLOSED/BLOCKED with qualification-specific states. Stable
AIH core eligibility no longer depends on ECC and gstack becoming activatable.

Rollback impact:
Documentation-only. No runtime or project authority state exists.

Approved by:
Maintainer direction to form the final delivery plan from council and external review.
```

## 9. Handoff checklist

Every session leaves durable repository evidence containing:

- branch and HEAD;
- `git status --short`;
- completed qualification IDs with commands and outputs;
- incomplete step and exact blocker;
- plan mutations entered above;
- no secrets, provider trees, VM images, or real logs tracked;
- no installation/activation claim from a qualification result;
- no commit, push, PR, or publish without separate authorization.

Before transfer to cloud/Hyper-V, verify:

1. Documentation lint and local links pass.
2. Maintainer explicitly authorizes a docs-only commit.
3. The commit is made on this alpha branch without unrelated worktree changes.
4. Maintainer separately authorizes push or names a reviewed transfer mechanism.
5. The destination checks out the exact committed SHA and reruns docs lint.

Until those five conditions hold, development stays on this local worktree.
