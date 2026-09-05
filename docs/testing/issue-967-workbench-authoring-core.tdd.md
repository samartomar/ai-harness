# Issue #967 — Workbench authoring core TDD receipt

Status: **final local Workbench lane evidenced.** Five fresh
`npm run test:workbench:pr` runs at
`f79bc5347c6b0456ce2c9fd744f755903f765cc6` exited 0. This receipt covers the
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

Receipts are `.aih-scratch/workbench-evidence/pr-lane-leaf-run-1.json` through
`pr-lane-leaf-run-5.json`, with matching logs and
`five-run-leaf-summary.json`. They ran at source
`f79bc5347c6b0456ce2c9fd744f755903f765cc6` on the local Windows reference:
Node `v24.18.0`, Windows `10.0.26200`, 24 processors, and Chrome for Testing
`151.0.7922.34`.

`vitest.workbench-retained.config.ts` reserves two available CPUs and caps
retained-test workers at four: `max(1, min(4, availableParallelism() - 2))`.
The 24-CPU local reference therefore used four retained workers. This
retained-lane setting is distinct from the general suite runtime.

The pinned-baseline compiler reads one defensive vendor-lock snapshot for each
source compilation and reuses it for source identity, declarations, and
evidence. This preserves the canonical ECC and Superpowers catalog bytes;
`registry.test.ts` also verifies the single read and retained exact evidence-pin
rejection. The unchanged integrity verifier and finding arrays live in two
small modules, reducing the tiny fixture's local dependency inputs from 122 to
21 while preserving the existing module exports.

| Run | Pure | Build | Parallel acceptance | Total | Peak process-tree resident memory |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 | 3.224 s | 4.015 s | 35.446 s | 42.690 s | 2,094.6 MiB |
| 2 | 3.109 s | 4.005 s | 35.067 s | 42.187 s | 2,204.3 MiB |
| 3 | 3.149 s | 4.019 s | 35.325 s | 42.499 s | 2,194.4 MiB |
| 4 | 3.127 s | 4.022 s | 34.989 s | 42.144 s | 2,301.3 MiB |
| 5 | 3.076 s | 3.960 s | 35.117 s | 42.158 s | 2,138.8 MiB |

All five runs exited 0. The median total was 42.187 s; the slowest total was
42.690 s. The maximum pure stage wall time was 3.224 s, and the largest sampled
process-tree resident peak was 2,413,068,288 bytes (2,301.3 MiB).

Each run recorded 84 pure tests, 224 retained/contracts tests, and seven
Chromium tests as passed. Pure coverage was 91.12% statements, 85.91% branches,
92.85% functions, and 91.97% lines. Retained/contracts coverage was 90.14%
statements, 83.58% branches, 94.44% functions, and 92.94% lines. The generic DOM
receipt recorded 920 initial nodes and 13 changed nodes for each synthetic
catalog size: 10, 1,000, and 10,000 assets.

## Hosted Workbench status

Hosted CI status and its receipts are recorded in PR #974's Validation section.
This tracked receipt preserves the five local reference runs and does not carry a
fixed hosted snapshot.

## Reproducing the local receipt

```sh
npm run test:workbench:pr
npm run docs:lint
```

The PR-lane command records the pure coverage stage, `npm run build`, and the
parallel acceptance projects. Repository-wide verification and PR readiness are
outside this Workbench receipt and remain in PR #974's validation section.
## Catalog discovery follow-up

The Source and Type filters expose the prepared catalog's skills, agents,
profiles, and every observed asset kind. Source identity includes the exact
source id so inputs with the same upstream locator remain distinguishable.
Filtering and paging leave policy intent unchanged, preserve source disclosure
state, and render at most 50 matching rows. Empty categories describe the
prepared catalog. Structural roots retain their explicit status and removal
intent. Templates display optional readable labels while their exact ids remain
inspectable; labels are validated and bound into template digests. Previously
expanded roots remain independent of later template label changes.

The existing generic browser journey first failed because the Source combobox
was absent (one failed, two passed). The template contract test first failed on
its missing label, then on a whitespace-only label that had been accepted. The
local RED logs are navigation-browser-red.log, navigation-label-red.log, and
navigation-label-whitespace-red.log under .aih-scratch/workbench-evidence.
The repository pre-commit gate rejected a RED-only checkpoint, so these failure
receipts accompany a combined GREEN implementation commit; no hook was bypassed.

The added pure browse contract uses tinyStudioModel and does not import the
production catalog compiler graph. The existing browser journey covers Source,
Type, the second result page, an empty category, filter reset, unchanged policy
bytes, disclosure restoration, structural selection status, and template label
inspection. The browser suite remains six generic journeys and one packed smoke.
Production contracts verify ECC and Superpowers template names and that the
prepared Superpowers pin contains 14 skills, one runtime, one methodology
profile, and no standalone agent. Its reviewer prompt is included beneath the
requesting-code-review skill.

The first combined navigation lane passed all 87 pure contracts and all seven
Chromium journeys, but 56 retained assertions failed because their lightweight
DOM did not expose the global Option constructor. The repair creates option
nodes through document.createElement, assigns inert text and values, and avoids
introducing a test-only polyfill. The preserved failing receipt is
navigation-option-red.log with navigation-option-red.json.

The completed navigation PR lane passed 87 pure tests, 226 retained/contracts
tests, and all seven Chromium journeys. Its pure stage was 3.218 s;
the complete lane was 44.673 s. Peak sampled process-tree resident memory
was 2,319,560,704 bytes, without a heap override. Pure coverage was
91.35% statements, 86.00% branches, 92.89% functions, and 92.15% lines;
retained coverage stayed above all existing thresholds. The DOM receipt records
933 initial nodes and 13 changed nodes for a request action at each of
10, 1,000, and 10,000 assets. The local receipts are navigation-pr-lane.json,
navigation-acceptance-projects.json, and navigation-dom-scale.json. These are
one follow-up measurement, separate from the five historical local runs above.
