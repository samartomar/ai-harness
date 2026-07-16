# Final acceptance criteria and acceptable states

> Status: normative Phase A qualification gates plus non-normative Phase B entry
> criteria. A qualification pass is not an installation or activation claim.

## 1. Phase A result classifications

### `QUALIFICATION_PASS`

The provider-neutral qualification mechanisms pass. Both ECC and gstack exact local
sources produce deterministic inert plans, and every required fact is either proven
or explicitly bounded. No provider code executes and no methodology authority changes.

This does not mean either provider is deliverable, installed, loaded, or active.

### `QUALIFICATION_FAIL_CLOSED`

One or both providers are rejected with a stable finding code. No provider code
executes, no provider-visible state changes, and no fallback occurs.

This is a successful safety result and can coexist with a stable provider-neutral AIH
qualification release.

### `QUALIFICATION_BLOCKED`

Source identity, evidence, plan determinism, compatibility, or host visibility cannot
be established reliably. Stop the affected qualification path; do not infer a safe
default.

### `MUTATION_RESEARCH_ELIGIBLE`

One exact provider/commit/installer-fingerprint/adapter/host/OS/isolation/policy tuple
meets every prerequisite for a separately authorized disposable Phase B experiment.

This state does not authorize provider execution and is not an activation support
claim.

### Phase A CLI exit codes

| Exit code | Outcome |
| --- | --- |
| `0` | `QUALIFICATION_PASS` or a completed read-only inspection, plan, or status command. |
| `2` | `QUALIFICATION_BLOCKED`. |
| `3` | `QUALIFICATION_FAIL_CLOSED`. |
| `1` | Invalid input or command failure. |

The process-level contract must cover every row. A warning envelope alone is not a
successful qualification outcome.

## 2. Phase A core invariants

| ID | Acceptance criterion |
| --- | --- |
| QA-INV-01 | Project enrollment cardinality is zero or one; an enrollment proposal contains exactly one provider. |
| QA-INV-02 | AIH policy remains authoritative for trust and permitted actions. |
| QA-INV-03 | No provider code executes, including preview, dry-run, setup, doctor, repair, updater, or imported provider module. |
| QA-INV-04 | No floating source ref is treated as exact authority. |
| QA-INV-05 | Provider source is inspected as inert data from an operator-supplied local checkout. |
| QA-INV-06 | No product command modifies provider-visible host state. |
| QA-INV-07 | No command writes project methodology authority, provider canon, activation receipt, or provider cache. |
| QA-INV-08 | Trust, conformance, compatibility, host coverage, isolation feasibility, and support level remain separate facts. |
| QA-INV-09 | Unknown compatibility or host coverage fails closed. |
| QA-INV-10 | No qualification failure triggers provider fallback. |
| QA-INV-11 | AIH does not vendor, re-host, or permanently cache provider source. |
| QA-INV-12 | Reports contain no secret values, prompts, customer content, or provider source content. |
| QA-INV-13 | Phase A never reports `deliverable`, `activatable`, `switchable`, or `concurrent`. |
| QA-INV-14 | Existing `aih init`, `aih ecc`, and `aih superpowers` behavior remains unchanged. |

Any invariant failure blocks Phase A release eligibility.

## 3. Source and evidence matrix

| ID | Scenario | Expected result |
| --- | --- | --- |
| QA-SRC-01 | Valid local Git checkout and full commit | Exact identity and inert tree hash produced. |
| QA-SRC-02 | `main`, `latest`, short SHA, malformed SHA | `PROVIDER_SOURCE_UNRESOLVED`; no inspection beyond boundary validation. |
| QA-SRC-03 | Checkout `HEAD` differs from requested commit | Coded stop; no evidence inheritance. |
| QA-SRC-04 | Tree changes during qualification | Hash mismatch; report not pass. |
| QA-SRC-05 | Link, hard-link, or path escape | Existing containment rules deny it. |
| QA-SRC-06 | Unknown provider or adapter | `PROVIDER_UNKNOWN`; no fallback. |
| QA-SRC-07 | Held/blocked exact evidence | Matching trust result; posture cannot force pass. |
| QA-SRC-08 | Evidence repository/commit/path/hash mismatch | Evidence excluded; qualification stops or remains unknown. |
| QA-SRC-09 | Legacy GSD source silently replaced by successor | Denied; successor requires a new source decision. |
| QA-SRC-10 | Provider file attempts to influence parser as instructions | Treated as inert text/data; no tool or command execution. |

## 4. No-execution and plan determinism matrix

| ID | Scenario | Expected result |
| --- | --- | --- |
| QA-PLAN-01 | Adapter inspects manifest and script files | Files parsed without import, eval, spawn, or hook execution. |
| QA-PLAN-02 | Provider advertises a dry-run/preview | Entry point recorded only; never invoked. |
| QA-PLAN-03 | Same exact source/host/adapter tuple qualified twice | Byte-identical plan digest and equivalent report. |
| QA-PLAN-04 | Proposed destination is shared machine home | Isolation feasibility conflict; no support above `plannable`. |
| QA-PLAN-05 | Network, child process, service, updater, or uninstall behavior unknown | Explicit unknown finding; no safe default. |
| QA-PLAN-06 | Installer fingerprint changes with same adapter | Compatibility unknown/unsupported. |
| QA-PLAN-07 | Adapter requests execution-capable operation | Contract rejects it before planning. |
| QA-PLAN-08 | Provider plan contains path escape or control characters | Invalid plan finding; no output treated as safe. |
| QA-PLAN-09 | Provider has incomplete uninstall semantics | Recorded as Phase B blocker, not repaired by AIH. |
| QA-PLAN-10 | Provider includes a self-updater | `PROVIDER_SELF_UPDATE_ENABLED`; no mutation eligibility until bounded. |

## 5. Compatibility acceptance

The compatibility key contains:

```text
provider repository and resolved commit
installer-contract fingerprint
adapter ID, contract version, implementation hash
host ID and exact version/build
host load-surface contract version and coverage
OS, version, architecture
isolation mode
runtime versions
policy version
```

| ID | Scenario | Expected result |
| --- | --- | --- |
| QA-COMP-01 | Complete known tuple | Adapter may qualify through the supported level. |
| QA-COMP-02 | Exact provider commit is new to adapter | `ADAPTER_COMPATIBILITY_UNKNOWN`. |
| QA-COMP-03 | Installer fingerprint differs from known tuple | `PROVIDER_CONTRACT_UNSUPPORTED` or unknown. |
| QA-COMP-04 | Host build differs from host contract | `HOST_LOAD_SURFACE_UNKNOWN`. |
| QA-COMP-05 | OS/runtime version outside bounded tuple | Compatibility unknown; no mutation eligibility. |
| QA-COMP-06 | Adapter update with same ID but new implementation hash | New compatibility decision required. |
| QA-COMP-07 | Later provider version remains plannable only | AIH core release remains unblocked. |

## 6. Codex load-surface acceptance

For the exact first Codex build, the host contract covers:

- executable/build identity;
- project and global instruction precedence;
- skill/plugin discovery;
- hook discovery;
- MCP/config discovery;
- environment and command-line overrides;
- profile-home behavior;
- caches and session persistence;
- inherited configuration;
- positive and negative probe procedures.

| ID | Scenario | Expected result |
| --- | --- | --- |
| QA-HOST-01 | Every surface has authoritative evidence and reproducible probe | Coverage may be `complete`. |
| QA-HOST-02 | One relevant surface is unenumerated | Coverage `partial` or `unknown`; no future activation claim. |
| QA-HOST-03 | Filesystem inventory is complete but session/cache behavior unknown | Coverage not complete. |
| QA-HOST-04 | Provider-authored probe is the only absence evidence | Coverage not complete. |
| QA-HOST-05 | Clean second environment reproduces contract | Reproduction evidence recorded. |
| QA-HOST-06 | Codex build changes | New host-contract identity required. |

The Q1 feasibility decision is:

```text
HOST_CONTRACT_FEASIBLE
HOST_CONTRACT_PARTIAL
HOST_CONTRACT_UNKNOWN
```

Only the first permits later activation research on that host. The latter two still
allow honest Phase A qualification up to `plannable`.

## 7. Fresh-clone and status acceptance

| ID | Scenario | Expected result |
| --- | --- | --- |
| QA-STATE-01 | Project has no methodology file | Valid unenrolled state; status success; no provider selected. |
| QA-STATE-02 | Fresh clone has a valid future `aih-methodology.json` but no Phase B state | `selected-but-inactive`; no installation/activation claim; zero mutation. |
| QA-STATE-03 | Future intent file is malformed | `METHODOLOGY_INTENT_INVALID`; no fallback. |
| QA-STATE-04 | Existing global provider files are detected | Report owned/unowned/unknown only; do not delete or adopt. |
| QA-STATE-05 | Latest qualification result is absent | Status reports unknown/not-qualified, not failure repair guidance. |
| QA-STATE-06 | Qualification report is supplied | Status reproduces support level and exact compatibility key. |

## 8. Synthetic conflict acceptance

Synthetic fixtures do not execute vendor code or write real host state.

| ID | Scenario | Expected result |
| --- | --- | --- |
| QA-SYN-01 | ECC/gstack propose same destination | `ISOLATION_CONFLICT`; neither gains mutation eligibility. |
| QA-SYN-02 | Provider requires machine-exclusive home | Not concurrent; qualification remains bounded. |
| QA-SYN-03 | Provider proposes undeclared daemon | Contract incomplete; fail closed. |
| QA-SYN-04 | Provider self-update cannot be disabled from declared contract | Mutation research ineligible. |
| QA-SYN-05 | Non-selected-provider absence cannot be proved over host contract | No activatable support claim. |
| QA-SYN-06 | Report generation is interrupted | No project authority exists to reconcile; rerun from exact input. |
| QA-SYN-07 | Two qualification commands run concurrently | Both are read-only and deterministic; outputs do not contend for authority. |

## 9. Provider qualification acceptance

These tests use operator-selected exact sources. This document supplies no provider
pin or approval.

### ECC

| ID | Acceptance criterion |
| --- | --- |
| QA-ECC-01 | Checkout identity and tree hash are exact. |
| QA-ECC-02 | Evidence joins only on exact source/path/hash. |
| QA-ECC-03 | Installer and uninstall entry points are fingerprinted without execution. |
| QA-ECC-04 | Proposed methodology closure is explicit; unknown closure fails closed. |
| QA-ECC-05 | Hooks, MCP, rules, skills, agents, commands, repair, and updater assumptions are reported. |
| QA-ECC-06 | Proposed destinations and runtime dependencies are deterministic. |
| QA-ECC-07 | Host/isolation feasibility is bounded to the exact compatibility tuple. |
| QA-ECC-08 | Existing ECC baseline pin and evidence files are unchanged. |
| QA-ECC-09 | No ECC command, script, hook, package lifecycle, or preview executes. |
| QA-ECC-10 | Result is no higher than `mutation-research-eligible`. |

### gstack

| ID | Acceptance criterion |
| --- | --- |
| QA-GST-01 | Checkout identity and tree hash are exact. |
| QA-GST-02 | Setup/uninstall entry points are fingerprinted without execution. |
| QA-GST-03 | Bun/Node/browser/daemon/child-process/service assumptions are reported. |
| QA-GST-04 | Team/self-update and network behavior are explicit. |
| QA-GST-05 | Proposed Codex destinations and canon changes are deterministic. |
| QA-GST-06 | Host/isolation feasibility is bounded to the exact compatibility tuple. |
| QA-GST-07 | No clone, pull, setup, dry-run, preview, or provider import executes. |
| QA-GST-08 | Unknown browser or daemon state blocks mutation eligibility. |
| QA-GST-09 | AIH does not create a support obligation for later unknown commits. |
| QA-GST-10 | Result is no higher than `mutation-research-eligible`. |

## 10. Qualification report acceptance

| ID | Acceptance criterion |
| --- | --- |
| QA-REP-01 | Report names exact source tree, adapter, compatibility key, and host contract. |
| QA-REP-02 | Trust, conformance, compatibility, host coverage, isolation, and support are separate fields. |
| QA-REP-03 | Unknown facts remain unknown and have stable codes. |
| QA-REP-04 | Guidance/plannable does not render as installed or active. |
| QA-REP-05 | Report records `providerCodeExecuted: false`. |
| QA-REP-06 | Human and JSON outputs describe the same result. |
| QA-REP-07 | Secret/prompt/customer/provider-content scrub passes. |
| QA-REP-08 | No fallback field implies an attempted fallback. |

## 11. Phase A release gates

### Ready for implementation review

- Q0 documentation is internally consistent and fetchably durable after explicit
  authorization.
- Q1 feasibility result is recorded.
- Every Phase A invariant has a planned test.
- No mutation interface or execution-capable adapter operation exists.

### Ready for real-inert qualification

- Q2–Q6 pass.
- Exact ECC and gstack sources are selected and handled as inert data.
- No provider tool/runtime dependency is required merely to inspect source.
- Existing global provider installations are not modified.

### Ready for `2.12.0-alpha.N` consideration

- Q0–Q9 exit criteria pass.
- `npm run verify` passes without weakening unrelated gates.
- Command stability and schema review complete.
- Public docs state qualification-only semantics.
- Existing release authorization and `next` dist-tag process is followed.

### Stable provider-neutral AIH core eligibility

1. Qualification schemas and contracts are stable and minor-compatible.
2. Exact local-source resolution and evidence joins are deterministic.
3. No-execution controls and synthetic conflict tests pass.
4. Unknown compatibility/host coverage fails closed.
5. Qualification reports are honest and scrubbed.
6. No provider mutation occurs through the stable surface.
7. Upgrade from v2.11 leaves existing defaults and legacy commands unchanged.
8. A clean second machine reproduces the provider-neutral tests.
9. Release authorization is separately granted under `RELEASING.md`.

ECC or gstack may remain `evaluable` or `plannable` without blocking stable AIH core.
Provider activation support, if ever shipped, uses a separate support matrix.

## 12. Phase B entry gate

Phase B is not authorized by Phase A completion. Entry requires:

1. Separate maintainer authorization naming one exact compatibility tuple.
2. `MUTATION_RESEARCH_ELIGIBLE` for that tuple.
3. Complete host load-surface coverage.
4. Provider-native exact-source and exact-destination installer contract.
5. Externally enforced disposable containment.
6. Silent updates disabled or bounded.
7. Durable journal/lock/lease/restart design reviewed before provider execution.
8. Fresh-host nonce handshake design.
9. Environment-taint and snapshot destruction criteria.
10. A disposable environment with no credentials or customer data.

Phase B later defines separate results:

```text
MUTATION_RESEARCH_PASS
MUTATION_RESEARCH_FAIL_CLOSED
ROLLBACK_REQUIRED
ROLLBACK_FAILED
ENVIRONMENT_TAINTED
```

It must test concurrent transaction contention, process death at every journal state,
lock expiry, pending activation, fresh-session timeout, unexpected writes, incomplete
negative probes, bounded recovery, and taint escalation.

## 13. Final acceptable outcomes

Acceptable:

- qualification core ships while both providers remain plannable only;
- one or both providers fail closed with exact codes;
- host coverage is partial and activation research stops;
- Phase B is deferred or abandoned;
- a later provider/host tuple independently reaches activation support.

Unacceptable:

- weakening trust or analyzer requirements;
- executing provider previews in Phase A;
- treating disposable research as workstation confinement;
- force-passing compatibility or host coverage;
- claiming installation/activation from source analysis;
- making ECC and gstack behavior prerequisites for unrelated AIH releases;
- silent fallback, repair, update, or adoption;
- committing, pushing, opening a PR, or publishing without authorization.

## 14. Evidence bundle for handoff

A completed qualification records:

- AIH branch/commit and OS;
- exact local provider source identity and tree hash;
- adapter and compatibility key;
- host-contract identity and coverage;
- trust/conformance evidence joins;
- plan and qualification digests;
- acceptance IDs with command outputs;
- final classification and remaining unknowns;
- explicit statement that no provider code executed.

Do not include provider source trees, VM disks, credentials, prompts, browser profiles,
or customer data.
