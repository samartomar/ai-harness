# Issue #967 — Workbench authoring core TDD receipt

Status: **final local Workbench lane evidenced.** Five fresh
`npm run test:workbench:pr` runs at
`675a1e1ed15019b1299c3f83466af93cdaf3716c` exited 0. This receipt covers the
Workbench lane only; repository-wide verification and current PR readiness are
recorded in PR #974's validation section.

## Implemented boundary

The Workbench is an offline typed browser over `authoring-catalog-bundle/v1`.
It records generic exact-pinned authoring intent, then Core rebuilds the catalog,
bindings, and effective policy with Core-owned compiler logic and the exact
declared inputs. Schema-v2 remains a supported input; schema-v3 requires
`minimumCoreVersion: "0.6.0"` plus its strict generic selection envelope.

A schema-v3 policy can contain two different byte transports:

- `authoringSources` carries an exact, bounded
  `organization-authoring-manifest/v1` input: source ID, source revision,
  digest, byte length, and canonical base64 bytes. It is only emitted for a
  source referenced by saved exact pins. Core verifies the bytes, recompiles the
  manifest, prepares a new catalog, and rejects missing, duplicate,
  unreferenced, identity-mismatched, or altered inputs. This envelope provides
  no evidence, action, binding, capability, or authority; those remain
  Core-derived.
- `drafts` preserve bounded exact declaration bytes for local organization
  manifests, imported policies, and `imported-evidence`. They are opaque in the
  browser. Core verifies byte length, canonical base64, and digest before it can
  project a policy, but validation of draft bytes does not turn a scanner claim
  into evidence, qualification, approval, or an effective control.

The optional offline route is
`aih policy generate --organization-manifest <path>` (repeatable). It reads a
bounded regular UTF-8 declaration, recompiles it for the generated browser, and
makes no scan, authority, or target-repository policy claim. There is no public
`aih policy author` command and no command that treats saved raw scanner data as
trusted evidence.

Fresh evidence preparation is a separate applied administrator route:

```text
aih policy generate <admin-root> --apply \
  --fresh-organization-manifest <manifest> \
  --fresh-artifact-intake <intake>
```

The fresh manifest and artifact-intake flags are repeatable only as equal,
ordered, non-empty pairs. Core obtains an operational scan witness, exact-matches
each manifest `scanSubject` to one intake item and its source pin, and produces
bounded display facts from that same-process witness. The preparation value is
opaque; cloned or serialized lookalikes do not carry scan custody. The route
still does not create organization authority, approvals, or runtime effects.

## Acceptance ledger

| Acceptance | Primary evidence | Final local evidence |
| --- | --- | --- |
| Bundle parses normalized sources, assets, relations, groups, templates, provenance, evidence summaries, and exact detail bytes as one contract | `tests/org-policy/workbench/catalog-bundle.test.ts`; `tests/org-policy/workbench/compilers/registry.test.ts` | Five fresh PR-lane receipts passed. |
| Exact root, dependency, request, and exclusion pins fail closed while exact subtraction permits repair | `tests/org-policy/workbench/selection-engine.test.ts`; `tests/org-policy/workbench/policy-import.test.ts` | Five fresh PR-lane receipts passed. |
| Templates preserve optional/required closure, exclusions, and origins; requests stay separate from selected controls | `selection-engine.test.ts`; `tests/org-policy/workbench/compile-policy.test.ts` | Five fresh PR-lane receipts passed. |
| Schema-v3 selection and authoring-source envelopes remain strict while schema-v2 input remains compatible | `tests/org-policy/workbench/policy-compatibility.test.ts`; `tests/org-policy/workbench/authoring-sources.test.ts` | Five fresh PR-lane receipts passed. |
| Core recompiles exact organization declaration inputs and refuses altered or unreferenced transports | `authoring-sources.test.ts` — `rejects missing, duplicate, unreferenced, mismatched-revision, and changed-byte inputs transactionally`; `tests/org-policy/workbench/policy-consumption.test.ts` | Five fresh PR-lane receipts passed. |
| Opaque imported evidence and drafts do not self-promote to scanner trust, authority, approval, qualification, or effective policy | `tests/org-policy/studio-artifact-intake.test.ts`; `tests/org-policy/workbench/core/policy-compiler.test.ts`; `tests/org-policy/workbench/core/verified-evidence.test.ts` | Five fresh PR-lane receipts passed. |
| Offline declarations and fresh applied preparation use distinct custody routes | `tests/org-policy/generate.test.ts` — `prepares one offline organization manifest before writing the portable workbench`, `requires an applied administrator route and exact paired files for fresh organization preparation`, and `runs a fresh organization manifest through the production runner witness and emits exact evidence` | Five fresh PR-lane receipts passed. |
| Browser contract covers six generic journeys and one installed-package artifact smoke | `tests/org-policy/workbench/browser/generic-journeys.spec.ts`; `journeys.spec.ts`; `packed.spec.ts` | Seven Chromium tests passed in every final local receipt. |
| Required Workbench lane establishes its pure, build, contract, browser, and budget requirements | `npm run test:workbench:pr` | Five fresh local receipts passed; the slowest was below the 60 s lane budget. |

## Final local PR-lane receipt

Receipts are `.aih-scratch/workbench-evidence/pr-lane-snapshot-run-1.json`
through `pr-lane-snapshot-run-5.json`, with matching logs and
`five-run-snapshot-summary.json`. They ran at source
`675a1e1ed15019b1299c3f83466af93cdaf3716c` on the local Windows reference:
Node `v24.18.0`, Windows `10.0.26200`, 24 processors, and Chrome for Testing
`151.0.7922.34`.

`vitest.workbench-retained.config.ts` reserves two available CPUs and caps
retained-test workers at four: `max(1, min(4, availableParallelism() - 2))`.
The 24-CPU local reference therefore used four retained workers; the four-CPU
host used two. This retained-lane setting is distinct from the general suite
runtime.

The pinned-baseline compiler reads one defensive vendor-lock snapshot for each
source compilation and reuses it for source identity, declarations, and
evidence. This optimization preserves the canonical ECC and Superpowers catalog
bytes; `registry.test.ts` also verifies the single read and retained exact
evidence-pin rejection.

| Run | Pure | Build | Parallel acceptance | Total | Peak process-tree resident memory |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 3.220 s | 4.177 s | 36.148 s | 43.551 s | 2,153.5 MiB |
| 2 | 3.258 s | 4.075 s | 35.732 s | 43.070 s | 2,376.1 MiB |
| 3 | 3.105 s | 4.076 s | 35.142 s | 42.329 s | 2,430.5 MiB |
| 4 | 3.158 s | 4.037 s | 35.310 s | 42.511 s | 2,605.1 MiB |
| 5 | 3.136 s | 3.975 s | 35.867 s | 42.983 s | 2,181.5 MiB |

All five runs exited 0. The median total was 42.983 s; the slowest total was
43.551 s. The maximum pure stage wall time was 3.258 s, and the largest sampled
process-tree resident peak was 2,731,655,168 bytes (2,605.1 MiB).

Each run recorded 84 pure tests, 224 retained/contracts tests, and seven
Chromium tests as passed. Pure coverage was 91.12% statements, 85.91% branches,
92.85% functions, and 91.97% lines. Retained/contracts coverage was 90.14%
statements, 83.58% branches, 94.44% functions, and 92.94% lines. The generic DOM
receipt recorded 920 initial nodes and 13 changed nodes for each synthetic
catalog size: 10, 1,000, and 10,000 assets.

## Hosted Workbench confirmation

CI run `33953023879` passed one Workbench lane at the same source
`675a1e1ed15019b1299c3f83466af93cdaf3716c`. Its Ubuntu 24 receipt is
`.aih-scratch/workbench-evidence/ci-snapshot-final/workbench-evidence/pr-lane.json`:
58.671 s total, 2.408 s pure stage, and 2,888,839,168 bytes peak summed
process-tree resident memory. The matching job log
`.aih-scratch/workbench-evidence/ci-snapshot-final-workbench.log` reports 84 pure
tests, 224 retained/contracts tests, and seven Chromium tests. This is one
hosted run, separate from the five
local measurements.

## Reproducing the local receipt

```sh
npm run test:workbench:pr
npm run docs:lint
```

The PR-lane command records the pure coverage stage, `npm run build`, and the
parallel acceptance projects. Repository-wide verification and PR readiness are
outside this Workbench receipt and remain in PR #974's validation section.