# Issue #967 — Workbench authoring core TDD receipt

Status: **in progress.** This is an implementation and acceptance map, not a
release receipt. The final full verification, browser lane, and performance
receipts remain pending until their command output is recorded by the release
owner.

## Implemented boundary

The Workbench is an offline typed browser over `authoring-catalog-bundle/v1`.
It records generic exact-pinned authoring intent, then Core rebuilds the catalog,
bindings, and effective policy with Core-owned compiler logic and the exact declared inputs. Schema-v2 remains a
supported input; schema-v3 requires `minimumCoreVersion: "0.6.0"` plus its
strict generic selection envelope.

A schema-v3 policy can contain two different byte transports:

- `authoringSources` carries an exact, bounded
  `organization-authoring-manifest/v1` input: source ID, source revision,
  digest, byte length, and canonical base64 bytes. It is only emitted for a
  source referenced by the saved exact pins. Core verifies the bytes, recompiles
  the manifest, prepares a new catalog, and rejects missing, duplicate,
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

| Acceptance | Primary evidence | Status |
| --- | --- | --- |
| Bundle parses normalized sources, assets, relations, groups, templates, provenance, evidence summaries, and exact detail bytes as one contract | `tests/org-policy/workbench/catalog-bundle.test.ts`; `tests/org-policy/workbench/compilers/registry.test.ts` | PENDING receipt |
| Exact root, dependency, request, and exclusion pins fail closed while exact subtraction permits repair | `tests/org-policy/workbench/selection-engine.test.ts`; `tests/org-policy/workbench/policy-import.test.ts` | PENDING receipt |
| Templates preserve optional/required closure, exclusions, and origins; requests stay separate from selected controls | `selection-engine.test.ts`; `tests/org-policy/workbench/compile-policy.test.ts` | PENDING receipt |
| Schema-v3 selection and authoring-source envelopes remain strict while schema-v2 input remains compatible | `tests/org-policy/workbench/policy-compatibility.test.ts`; `tests/org-policy/workbench/authoring-sources.test.ts` | PENDING receipt |
| Core recompiles exact organization declaration inputs and refuses their altered or unreferenced transports | `authoring-sources.test.ts` — `rejects missing, duplicate, unreferenced, mismatched-revision, and changed-byte inputs transactionally`; `tests/org-policy/workbench/policy-consumption.test.ts` | PENDING receipt |
| Opaque imported evidence and drafts do not self-promote to scanner trust, authority, approval, qualification, or effective policy | `tests/org-policy/studio-artifact-intake.test.ts`; `tests/org-policy/workbench/core/policy-compiler.test.ts`; `tests/org-policy/workbench/core/verified-evidence.test.ts` | PENDING receipt |
| Offline declarations and fresh applied preparation use distinct custody routes | `tests/org-policy/generate.test.ts` — `prepares one offline organization manifest before writing the portable workbench`, `requires an applied administrator route and exact paired files for fresh organization preparation`, and `runs a fresh organization manifest through the production runner witness and emits exact evidence` | PENDING receipt |
| Browser contract covers six generic journeys and one installed-package artifact smoke | `tests/org-policy/workbench/browser/generic-journeys.spec.ts`; `journeys.spec.ts`; `packed.spec.ts` | PENDING browser receipt |
| Required Workbench lane establishes its pure, contract, build, browser, and budget requirements | `npm run test:workbench:pr` | PENDING final receipt |

## Required commands

```sh
npm run test:workbench:pure
npm run test:workbench:contracts
npm run build:workbench
npm run test:workbench:ui
npm run test:workbench:pr
npm run docs:lint
```

The receipt intentionally records no pass count, coverage percentage, duration,
performance conclusion, or release assertion before an actual command receipt is
available.