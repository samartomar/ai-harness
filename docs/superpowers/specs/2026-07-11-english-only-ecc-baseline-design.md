# English-only ECC baseline design

Status: Approved by Samar on 2026-07-11.

## Problem

The pinned ECC module snapshot describes 32 vendor modules, including nine locale
documentation modules. The ECC `full` profile, scoped component descriptors, and
ai-harness materializer support only the 23 canonical English modules. The baseline
evidence catalog nevertheless expands every module in the vendor snapshot. As a result,
ai-harness scans and signs locale components that no supported install selection needs.

The over-scope is material: translated trees hold most discovered `SKILL.md` files and
dominate exact offline Cisco scan time. They also exposed recurring malformed YAML
frontmatter during the v2.9.0 readiness vet. A trust gate must completely vet what the
product ships; it should not claim support for unrelated vendor content merely because the
content exists at the pinned source commit.

## Decision

The supported ECC baseline is English-only for v2.9.0. The evidence catalog derives its
module components from the pinned ECC `full` profile, not from every entry in the vendor
module snapshot.

The complete vendor module snapshot remains checked in. It is still useful for validating
profile dependencies, target support, and future explicit locale work. The nine current
`docs-*` modules are absent from the shipped catalog, generated vendor lock, authorization
set, and release vet. Native, pinned Docker/SkillSpector, and applicable exact offline Cisco
remain mandatory for every supported component.

Non-English support may be added later only as an explicit product capability with a
selected locale, matching install behavior, complete evidence, and its own release review.
It never appears automatically because a vendor adds another translated directory.

## Boundaries and data flow

`ecc-modules.json` remains the complete pinned module metadata snapshot.
`ecc-profiles.json` remains the pinned install-profile snapshot and is the authority for the
supported `full` module set. Catalog construction validates that every `full` profile module
exists, preserves profile order, and emits only those 23 `module:*` components.

The runtime installer, Kiro runtime, direct common-skill receipts, and common-agent receipts
remain unchanged. Scoped selection continues to map component declarations to the same
English modules and direct receipts. A full selection continues to invoke the upstream
`full` profile, so evidence and materialization now describe the same surface.

The baseline generator scans the reduced canonical catalog and writes a lock without any
`module:docs-*` component. The pure analyzer release gate compares that generated lock
against the same canonical catalog, so a stale lock that retains locale modules fails as an
extra-component mismatch and a lock missing an English module fails as incomplete.

## Failure behavior

- An unknown module named by the pinned `full` profile fails catalog construction.
- A duplicate `full` profile module fails rather than producing duplicate evidence.
- Locale modules or `docs/<locale>` paths in generated evidence fail catalog tests and the
  canonical release gate.
- Missing native, SkillSpector, or applicable Cisco receipts continue to fail closed.
- Vendor source paths outside the catalog are neither installed nor represented as vetted.

## Tests and release evidence

Tests assert that the ECC catalog contains exactly 23 `module:*` components in pinned
`full` profile order, contains no `module:docs-*` ids or `docs/<locale>` paths, and retains
the runtime/direct-skill/common-agent components. Existing evidence/materialization tests
continue proving full and scoped selections request only authorized components.

The v2.9.0 readiness run regenerates the vendor lock and install preview at the exact fork
and Superpowers pins, runs the complete analyzer-envelope gate, verifies installability at
all three postures, and completes `npm run verify`. The finalized PR documents the reduced
surface and its scan-count/runtime effect without presenting untranslated support as a
security bypass.

## Alternatives rejected

1. Keep all locale modules in evidence. This preserves unsupported scope, recurring vendor
   translation fragility, and unnecessary scan cost.
2. Skip Cisco or downgrade findings only for locale modules. This would sign content without
   the required evidence and violates the fail-closed model.
3. Delete locale entries from the pinned vendor snapshot. This makes the snapshot less
   faithful and discards useful metadata; filtering catalog construction at the supported
   profile boundary is narrower and auditable.

## Non-goals

- No runtime locale selector or translated install mode ships in v2.9.0.
- No weakening of analyzer versions, danger classes, posture grading, or signature/hash
  verification.
- No removal of translation hygiene fixes from upstream ECC PR #2503; those remain useful
  vendor fixes even though translations no longer block this release.
