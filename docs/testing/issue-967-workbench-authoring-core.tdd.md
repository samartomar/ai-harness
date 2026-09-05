# Issue #967 — Workbench authoring core TDD receipt

Status: **local PR lane evidenced; final verification pending.** Five fresh local
`npm run test:workbench:pr` runs exited 0. This receipt does not certify the
full `npm run verify`, Ubuntu CI, release, or publication gates.

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

| Acceptance | Primary evidence | Current evidence |
| --- | --- | --- |
| Bundle parses normalized sources, assets, relations, groups, templates, provenance, evidence summaries, and exact detail bytes as one contract | `tests/org-policy/workbench/catalog-bundle.test.ts`; `tests/org-policy/workbench/compilers/registry.test.ts` | Local PR lane passed 5/5; CI pending. |
| Exact root, dependency, request, and exclusion pins fail closed while exact subtraction permits repair | `tests/org-policy/workbench/selection-engine.test.ts`; `tests/org-policy/workbench/policy-import.test.ts` | Local PR lane passed 5/5; CI pending. |
| Templates preserve optional/required closure, exclusions, and origins; requests stay separate from selected controls | `selection-engine.test.ts`; `tests/org-policy/workbench/compile-policy.test.ts` | Local PR lane passed 5/5; CI pending. |
| Schema-v3 selection and authoring-source envelopes remain strict while schema-v2 input remains compatible | `tests/org-policy/workbench/policy-compatibility.test.ts`; `tests/org-policy/workbench/authoring-sources.test.ts` | Local PR lane passed 5/5; CI pending. |
| Core recompiles exact organization declaration inputs and refuses altered or unreferenced transports | `authoring-sources.test.ts` — `rejects missing, duplicate, unreferenced, mismatched-revision, and changed-byte inputs transactionally`; `tests/org-policy/workbench/policy-consumption.test.ts` | Local PR lane passed 5/5; CI pending. |
| Opaque imported evidence and drafts do not self-promote to scanner trust, authority, approval, qualification, or effective policy | `tests/org-policy/studio-artifact-intake.test.ts`; `tests/org-policy/workbench/core/policy-compiler.test.ts`; `tests/org-policy/workbench/core/verified-evidence.test.ts` | Local PR lane passed 5/5; CI pending. |
| Offline declarations and fresh applied preparation use distinct custody routes | `tests/org-policy/generate.test.ts` — `prepares one offline organization manifest before writing the portable workbench`, `requires an applied administrator route and exact paired files for fresh organization preparation`, and `runs a fresh organization manifest through the production runner witness and emits exact evidence` | Local PR lane passed 5/5; CI pending. |
| Browser contract covers six generic journeys and one installed-package artifact smoke | `tests/org-policy/workbench/browser/generic-journeys.spec.ts`; `journeys.spec.ts`; `packed.spec.ts` | Seven Chromium tests passed in each of five local PR-lane runs; CI pending. |
| Required Workbench lane establishes its pure, contract, build, browser, and budget requirements | `npm run test:workbench:pr` | Local reference met the lane budgets in five fresh runs; full verify, CI, and release remain pending. |

## Local PR-lane receipt

Receipts are `\.aih-scratch/workbench-evidence/pr-lane-run-1.json` through
`pr-lane-run-5.json`, with matching logs. They ran on the local Windows
reference: Node `v24.18.0`, Windows `10.0.26200`, 24 processors, and Chrome for
Testing `151.0.7922.34`. This is not an Ubuntu CI result.

| Run | Pure | Build | Parallel acceptance | Total | Peak process-tree resident memory |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 3.123 s | 3.930 s | 45.736 s | 52.795 s | 2,370.8 MiB |
| 2 | 3.325 s | 4.003 s | 43.916 s | 51.249 s | 2,354.9 MiB |
| 3 | 3.374 s | 3.936 s | 44.472 s | 51.789 s | 2,296.9 MiB |
| 4 | 2.977 s | 3.916 s | 43.713 s | 50.612 s | 2,422.7 MiB |
| 5 | 3.011 s | 3.879 s | 43.786 s | 50.682 s | 2,475.4 MiB |

The median total was 51.249 s; the slowest total was 52.795 s. The maximum pure
stage wall time was 3.374 s, and the largest sampled process-tree resident peak
was 2,595,618,816 bytes (2,475.4 MiB).

Each run recorded 84 pure tests, 221 retained/contracts tests, and seven
Chromium tests as passed. Pure coverage was 91.12% statements, 85.91% branches,
92.85% functions, and 91.97% lines. Retained/contracts coverage was 90.14%
statements, 83.58% branches, 94.44% functions, and 92.94% lines. The generic DOM
receipt recorded 920 initial nodes and 13 changed nodes for each synthetic
catalog size: 10, 1,000, and 10,000 assets.
## Broader local evidence

A separate full local unit-suite run passed 8,631 tests, including its coverage,
build, published-package, and packed-document stages. It is not a successful
`npm run verify` receipt: that command currently reaches its final cold helper
and fails because the helper still names a removed preset. The fix is in progress.
Hosted CI remains pending a new push.

## Commands and pending gates
```sh
npm run test:workbench:pr
npm run verify
```

`npm run test:workbench:pr` is the measured local evidence command above. Its
receipts record the pure coverage stage, `npm run build`, and the parallel
acceptance projects. `npm run verify`, Ubuntu CI, release qualification, and
publication remain pending; this receipt makes no claim for them.