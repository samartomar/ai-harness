# Issue #967 — Workbench authoring core TDD receipt

Status: **final local Workbench lane evidenced.** Five fresh
`npm run test:workbench:pr` runs at
`8daf7da54eab43e042a1b2bebac6cf77f7a5d4c9` exited 0. This receipt covers the
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

Receipts are `\.aih-scratch/workbench-evidence/pr-lane-final-run-1.json` through
`pr-lane-final-run-5.json`, with matching logs and
`five-run-final-summary.json`. They ran at source
`8daf7da54eab43e042a1b2bebac6cf77f7a5d4c9` on the local Windows reference:
Node `v24.18.0`, Windows `10.0.26200`, 24 processors, and Chrome for Testing
`151.0.7922.34`.

`vitest.workbench-retained.config.ts` reserves two available CPUs and caps
retained-test workers at four: `max(1, min(4, availableParallelism() - 2))`.
The 24-CPU local reference therefore used four retained workers; the four-CPU
host used two. This retained-lane setting is distinct from the general suite
runtime.

| Run | Pure | Build | Parallel acceptance | Total | Peak process-tree resident memory |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 3.197 s | 3.978 s | 41.515 s | 48.696 s | 2,299.0 MiB |
| 2 | 3.073 s | 3.953 s | 40.127 s | 47.159 s | 2,421.9 MiB |
| 3 | 3.038 s | 3.920 s | 39.713 s | 46.676 s | 2,214.7 MiB |
| 4 | 3.125 s | 4.000 s | 39.529 s | 46.659 s | 2,389.0 MiB |
| 5 | 3.108 s | 4.048 s | 41.039 s | 48.201 s | 2,402.7 MiB |

The median total was 47.159 s; the slowest total was 48.696 s. The maximum pure
stage wall time was 3.197 s, and the largest sampled process-tree resident peak
was 2,539,503,616 bytes (2,421.9 MiB).

Each run recorded 84 pure tests, 223 retained/contracts tests, and seven
Chromium tests as passed. Pure coverage was 91.12% statements, 85.91% branches,
92.85% functions, and 91.97% lines. Retained/contracts coverage was 90.14%
statements, 83.58% branches, 94.44% functions, and 92.94% lines. The generic DOM
receipt recorded 920 initial nodes and 13 changed nodes for each synthetic
catalog size: 10, 1,000, and 10,000 assets.

## Hosted Workbench confirmation

CI run `33948840550` passed the Workbench lane at source `cb08456d`. Its single
Ubuntu 24 hosted receipt is
`.aih-scratch/workbench-evidence/ci-balanced/workbench-evidence/pr-lane.json`:
48.015 s total, 1.858 s pure stage, and 2,699,272,192 bytes peak summed
process-tree resident memory. It recorded 84 pure tests, 223 retained/contracts
tests, and seven Chromium tests. This is one hosted run, not five hosted runs.

## Reproducing the local receipt

```sh
npm run test:workbench:pr
npm run docs:lint
```

The PR-lane command records the pure coverage stage, `npm run build`, and the
parallel acceptance projects. Repository-wide verification and PR readiness are
outside this Workbench receipt and remain in PR #974's validation section.