# Q9 command boundary and go/no-go decision

> Decision: no-go for Phase B mutation research and release preparation. The Phase A
> command surface remains read-only and qualification-only.

## Implemented command boundary

The alpha branch adds only these additive commands:

```text
aih methodology inspect <ecc|gstack> --source-root <absolute-path> [--json]
aih methodology plan <ecc|gstack> --source-root <absolute-path> --host codex-0.144.1-windows-x64-v1 [--json]
aih methodology qualify <ecc|gstack> --source-root <absolute-path> --host codex-0.144.1-windows-x64-v1 [--json]
aih methodology status [--root <path>] [--json]
```

The commands accept canonical ECC or gstack identifiers only. They resolve the supplied local Git
HEAD, read provider files as inert data, and emit a deterministic plan or qualification envelope.
They do not fetch a source, execute provider code, or write provider-visible host state. The command
surface has no `--apply` or `--force` option.

`status` reads an already-present `aih-methodology.json` proposal only to distinguish
`unenrolled` from `selected-but-inactive`. It never writes an enrollment, qualification result,
receipt, canon, cache, or provider state.

## Inputs reviewed for the decision

| Input | Result |
| --- | --- |
| Q1 Codex `0.144.1` / Windows host contract | `HOST_CONTRACT_PARTIAL` |
| Q7 official ECC source `ed387446052dfbc6b52de149406b70efa65edc59` | `QUALIFICATION_BLOCKED` at `plannable` |
| Q8 official gstack source `a3259400a366593e0c909dd9ac3e59752efd2488` | `QUALIFICATION_BLOCKED` at `plannable` |
| Exact reviewed compatibility tuple | absent for both providers |
| Provider isolation and updater state | unproven for both providers |
| Host negative activation proof | unavailable with partial host coverage |

Neither provider result inherited trust from the other provider, an earlier fork, or the AIH ECC
baseline. Neither result executed provider code.

## Decision

Phase B requires an exact tuple at `mutation-research-eligible`, complete host load-surface
coverage, independently reviewed isolation and updater evidence, externally enforced disposable
containment, and a new maintainer authorization. None is present.

Therefore:

```text
Phase A qualification commands: continue as read-only branch work
Phase B provider execution or mutation research: no-go
Provider setup, installation, activation, switching, or concurrency: no-go
2.12.0-alpha release preparation: no-go without separate release authority and a clean completion gate
```

The full completion gate currently has unrelated Windows timing failures in existing reconciliation
and release-preflight coverage tests; their exact non-coverage rerun passed. That does not justify
weakening the gate or treating it as a release pass. A later release decision requires a clean gate,
the normal review process, and separate authorization.

## Safe next action

Keep the branch qualification-only. A later retry must start from an exact provider/adapter/host/OS/
runtime/policy tuple and independently establish the missing compatibility and host evidence. It
must not run provider code until a separate Phase B authorization names that tuple and its disposable
environment.
