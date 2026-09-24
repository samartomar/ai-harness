# Contracts published by `@aihq/core`

Every format Core produces or reads across a package boundary, with the source that
defines it, the field that carries its identity, the bound on its size, and the exact
refusal a reader produces for an identity it does not know. The sibling packages
`@aihq/scan` and `@aihq/catalog` own their own formats in their own repositories; the
last table here records only which Core artifact each of them mirrors, and by which
digest.

This document is not the contract. The source is. Every `file:line` below is pinned by
[tests/contract/contracts-inventory.test.ts](tests/contract/contracts-inventory.test.ts),
which re-reads that line, the constants this build exports and the schema bytes this
package ships, so a renamed constant, a bumped literal or a moved definition fails CI
instead of leaving this page quietly wrong. It covers library contracts only; the CLI
surface, `--json` envelope, exit codes and SARIF are covered by [STABILITY.md](STABILITY.md).

Nothing named here approves a subject. A recognised format is read and checked; it is
not authority, qualification or admission, and consumption never installs, applies or
executes anything.

## Reading these tables

- **Identity** is the field a reader checks before it reads anything else.
- **Refusal** is the code a Core reader returns for an identity it does not know. An
  unknown version is never read as though it were a known one.
- A refusal code is a `GovernanceInputRefusalV1` member
  (`src/org-policy/governance-input-v1.ts:137`) unless the row says otherwise.

## Documents Core reads and writes

| Contract | Authoritative definition | Identity | Bound | Refusal of an unknown identity |
| --- | --- | --- | --- | --- |
| Governance input v1 | `src/org-policy/governance-input-v1.ts:79` (`GOVERNANCE_INPUT_V1_FORMAT`) | `format: "aih-governance-input"`, `version: 1` | 8192 bytes (`src/org-policy/governance-input-v1.ts:81`) | `unknown-contract-version` (`src/org-policy/governance-input-v1.ts:1457`), field `bytes`; bytes that declare v1 and break it are `non-canonical-bytes`, bytes that are not UTF-8 JSON are `malformed-bytes`, and oversize bytes are `oversize-bytes` |
| Organization evidence envelope v1 | `src/org-policy/qualification-v1.ts:15` (`ORGANIZATION_EVIDENCE_ENVELOPE_V1_FORMAT`); schema `schemas/aih-organization-evidence-envelope-v1.schema.json` | `format: "aih-organization-evidence"`, `version: 1` | 4096 bytes (`src/org-policy/qualification-v1.ts:17`) | consumption: `unknown-contract-version` (`src/org-policy/governance-input-v1.ts:1483`), field `evidence`; preparation: `unknown-contract-version` (`src/org-policy/governance-input-v1.ts:613`), field `evidenceBytes`. Bytes that declare v1 and break it stay `malformed-bytes` |
| Upstream artifact manifest v1 | `src/org-policy/upstream-artifact-manifest-v1.ts:20` (`UPSTREAM_ARTIFACT_MANIFEST_V1_FORMAT`); schema `schemas/aih-upstream-artifact-manifest-v1.schema.json` | `format: "aih-upstream-artifact-manifest"`, `version: 1` | 512 KiB (`src/org-policy/upstream-artifact-manifest-v1.ts:21`), 256 files (`src/org-policy/upstream-artifact-manifest-v1.ts:22`) | `unknown-contract-version` with field `observation.manifestPath` (`src/org-policy/governance-input-v1.ts:1248`), so it is never confused with the saved document's own version refusal. A manifest that declares v1 and breaks it stays `observation-manifest-mismatch` |
| Upstream observation receipt v1 | `src/org-policy/upstream-observation-receipt-v1.ts:46` (`UPSTREAM_OBSERVATION_RECEIPT_V1_FORMAT`); schema `schemas/aih-upstream-observation-receipt-v1.schema.json` | `format: "aih-upstream-observation-receipt"`, `version: 1` | window of at most 24 hours | `parseUpstreamObservationReceiptV1` (`src/org-policy/upstream-observation-receipt-v1.ts:97`) throws a Zod error; it has no named refusal code. A caller must catch it |
| Governance decision v2 | `src/org-policy/governance-decision-v2.ts:242`; schema `schemas/aih-governance-decision-v2.schema.json` | `format: "aih-governance-decision"`, `version: 2` | read only inside a verified authority receipt v3 | a decision of another version fails the receipt's own schema, so the receipt does not verify: `authority-unverified` |
| Authority receipt v3 | `src/org-policy/authority-v3.ts:60` | `format: "aih-policy-authority-receipt"`, `version: 3` (`src/org-policy/authority-v3.ts:61`) | per the policy bundle | `authority-version` (`src/org-policy/governance-input-v1.ts:1786`) when a verified receipt is not v3; a receipt of a version the verifier does not know does not verify: `authority-unverified` |
| Authority receipt v1 and v2 (legacy schema branches) | `schemas/aih-policy-authority-receipt.schema.json`, a `oneOf` whose branches are `version` 1, 2 and 3 | same `format`, `version` 1 or 2 | — | **not an input to governance consumption.** Only v3 is exported (`src/index.ts`); a verified v1 or v2 receipt is refused `authority-version` |
| aih-supported qualification receipt v2 | `src/org-policy/supported-qualification-receipt-v2.ts:103`; schema `schemas/aih-supported-qualification-receipt-v2.schema.json` | `format: "aih-supported-qualification-receipt"`, `version: 2` | 5970 bytes (`src/org-policy/supported-qualification-receipt-v2.ts:36`) | `qualification-receipt-malformed` (`src/org-policy/governance-input-v1.ts:1049`); not version-specific |

## Values and seams Core publishes

| Contract | Authoritative definition | Identity | Refusal |
| --- | --- | --- | --- |
| Accepted decision-schema digests | `src/org-policy/governance-decision-v2.ts:19` (`ACCEPTED_DECISION_SCHEMA_DIGESTS_V2`, exported from the package root) | bare sha-256 of `schemas/aih-governance-decision-v2.schema.json`, oldest first, the current schema last: `27295aee8d8be333abe2c73adc72884b534b1c9980a9b7a39d12be8d34c5caff`, `7fdf101568cd7caa28516d0be37704c0dfd51198bc54d41d65829abbe77547cc` | when verified scan facts declare `coreContract`, a `decisionSchemaSha256` outside the set, or a declaration Core cannot read, is refused `scan-core-contract-unknown` (`src/org-policy/governance-input-v1.ts:1575`), checked by `declaredCoreContractAcceptedV1` (`src/org-policy/governance-input-v1.ts:932`). The declared commit is read, never pinned. No declaration changes nothing |
| `SUPPORTED_CLIS` | `src/internals/clis.ts:9`, exported at `src/index.ts:19` | no version field: the array is the contract — 11 lowercase ids, unique, in a fixed order | Core publishes no shape check; a consumer validates it at its own seam |
| Schema subpath export | `package.json` `exports["./schemas/*.json"]` | `@aihq/core/schemas/<name>.json`, pure data | — |
| Scan verification seam | `src/org-policy/governance-input-v1.ts:719` (`ScanVerificationAdapterV1`) | the application injects Scan's verifier; governance consumption never imports Scan | a throw is `scan-attestation-unverified` |
| Scan execution seam (Workstream D) | `src/org-policy/governance-input-v1.ts:743` (`ScanExecutionAdapterV1`) | `listDetectorCapabilitiesV1` and `runDetectorV1`, unknown in and unknown out; the consumer narrows | threaded through the trust scan options, not consumption: a refused or throwing adapter leaves that detector unavailable and the scan reports `DEGRADED-COVERAGE` with the adapter's reason |
| `@aihq/scan` at run time | `src/scan-package/load-scan-package.ts:112` (`loadScanPackageExportsV1`); the execution seam is filled from the installed package by `src/scan-package/load-scan-package.ts:141` (`loadScanExecutionAdapterV1`), the availability probe by `src/scan-package/load-scan-package.ts:157` (`loadScanDetectorProbeV1`) and the Cisco shard runner by `src/scan-package/load-scan-package.ts:167` (`loadScanCiscoShardRunnerV1`) | an optional peer dependency, range `src/scan-package/load-scan-package.ts:22` (`SCAN_PACKAGE_PEER_RANGE`); the only `import("@aihq/scan")` in Core, never bundled, each caller's exports checked by `typeof` | package-level, not a consumption refusal (`src/scan-package/load-scan-package.ts:26`): `scan-package-unavailable` when the package cannot be imported, `scan-package-incompatible` when it lacks an export Core calls; both name the install command. Baseline request authoring, publication consumption, the trust scan, the baseline vet and the binding scan gate throw it as `AIH_SCAN_PACKAGE` |
| Detectors run by the installed Scan | `src/trust/detectors.ts:1252` (`SCAN_DETECTOR_IDS`), the native findings through `src/trust/detectors.ts:1994` (`resolveScanTrustLintRouteV1`), the binding gate's FAST tier through `src/binding/scan-binding-gate.ts:32` (`BINDING_GATE_DETECTOR_ID`), Cisco source shards through `src/trust/cisco-shard-delegation.ts:157` (`runCiscoSourceShardThroughScanV1`) and the baseline preflight through `src/trust/detector-availability.ts:56` (`probeScanDetectorsV1`) | every detector runs in Scan; Core runs none. Core names the profile (`src/trust/detectors.ts:1269` host uv by default, `src/trust/detectors.ts:1271` in-process trust lint, `src/trust/detectors.ts:1273` local SkillSpector) and reads SARIF plus Scan's facts; classification, grading and the gate decision stay in Core. Each result names its executor (`scan`, `precomputed-sarif`, `none`). Core accepts only the analyzer identities it pins in `src/trust/scan-analyzer-identity.ts:34` (`ACCEPTED_SCAN_ANALYZER_IDENTITIES_V1`), checked against both Scan's declaration and the run's evidence; a baseline vet names its analyzers from that table | a missing or incompatible Scan refuses the native findings, the binding gate, the Cisco shard and the preflight as `AIH_SCAN_PACKAGE`; a third-party detector Scan cannot run is unavailable with Scan's own reason, never run by Core. Scan's `detector.aih-native` (`src/trust/detectors.ts:1249`) is recorded only as an identity observation, never as findings |
| `@aihq/catalog` at run time | `src/catalog-package/load-catalog-package.ts:157` (`loadCatalogPackageV1`) | an optional peer dependency, range `src/catalog-package/load-catalog-package.ts:31` (`CATALOG_PACKAGE_PEER_RANGE`); the only `import("@aihq/catalog")` in Core, never bundled; the readers Core calls are checked by `typeof`, and the public data subpaths it reads (`./catalog-index.json`, `./catalog-runtime-descriptors.json`, `./catalog-framework-plugins.json`) are resolved through Catalog's own `exports` | package-level (`src/catalog-package/load-catalog-package.ts:36`): `catalog-package-unavailable` only when the package is not installed; `catalog-package-incompatible` when it is installed but cannot be loaded, lacks a reader or does not publish a subpath; both name the install command. Thrown as `AIH_CATALOG_PACKAGE` |
| Framework host API subpath | `package.json` `exports["./framework-host"]`, version `src/framework-host/index.ts:17` (`FRAMEWORK_HOST_API_VERSION`) | `@aihq/core/framework-host`, version 1: the framework plugin contract types, plan builders, render helpers, `AihError` and the strict JSON parser. Effectful services (evidence-gated installs, plan execution) reach a plugin only through the operation context the invoking Core builds | a plugin built against another host API version is `framework-plugin-incompatible` |
| Framework plugins at run time | `src/framework-plugin/load-framework-plugin.ts:349` (`loadFrameworkPluginV1`); the closed set `src/framework-plugin/contract-v1.ts:31` (`FRAMEWORK_PLUGIN_PACKAGE_NAMES`) | `@aihq/framework-ecc` and `@aihq/framework-superpowers`, optional peers imported only by literal specifier from that module and never bundled; each must resolve inside Core's install tree with the module its literal import loads inside its own real package directory, implement contract `src/framework-plugin/contract-v1.ts:23` (`FRAMEWORK_PLUGIN_CONTRACT_VERSION`) under its own package name and version and, when Catalog is installed, equal Catalog's `./catalog-framework-plugins.json` identity record. Core accepts only command results its own host services produced | package-level (`src/framework-plugin/load-framework-plugin.ts:53`): `framework-plugin-unavailable` only when the package is not installed; anything else is `framework-plugin-incompatible`, including an installed Catalog Core cannot read identities from; both name the install command. Thrown as `AIH_FRAMEWORK_PLUGIN`; `aih init` reports its Superpowers phase as refused with the reason (coded skip `framework-plugin.unavailable`, failure `framework-plugin.incompatible`) |
| Historical ECC runtime descriptor | `src/ecc/runtime-descriptor-resolver.ts:455` (`resolveHistoricalEccRuntimeDescriptorV1`), in the order `src/ecc/runtime-descriptor-resolver.ts:128` (`HISTORICAL_ECC_RUNTIME_DESCRIPTOR_RESOLUTION_ORDER_V1`) | the `ecc-runtime-descriptor/v1` bytes, accepted from the installed Catalog only by the sha256 Core pins at `src/ecc/runtime-descriptor-resolver.ts:147` (`ACCEPTED_CATALOG_ECC_RUNTIME_DESCRIPTORS_V1`); Catalog is the carrier and its signature is not consulted. Order: a matching verified local source-data receipt, then the installed Catalog; Core's embedded Workbench data is not a descriptor fallback. The result records `descriptorSource` and the stages consulted | `src/ecc/runtime-descriptor-resolver.ts:157`: absent Catalog is `catalog-package-unavailable`; an unusable installed Catalog is `catalog-package-incompatible`, both surfaced as `AIH_CATALOG_PACKAGE` when no local receipt matches. `catalog-index-refused`, `catalog-runtime-descriptors-refused` (including unknown sidecar versions), `catalog-descriptor-absent`, `catalog-descriptor-unverified` and `catalog-descriptor-not-accepted` are `AIH_TRUST` refusals; none fall back to embedded bytes |
| Assessment material seam | `src/org-policy/governance-input-v1.ts:769` (`AssessmentMaterialResolverV1`) | returns published assessment bytes only | `assessment-unavailable`, `assessment-declaration-unreadable` |
| Qualification seams (Workstream A) | `src/org-policy/governance-input-v1.ts:787` (`QualificationMaterialResolverV1`) and `src/org-policy/governance-input-v1.ts:809` (`QualificationAttestationVerifierV1`) | the resolver returns receipt bytes only; the application-injected verifier returns the verified statement, and only that statement is matched against the operator's publisher pin | `qualification-receipt-unavailable`, `qualification-receipt-malformed`, `qualification-receipt-subject-mismatch`, `qualification-receipt-not-current`, `qualification-attestation-unverified`, `qualification-route-mismatch` |

**Why a set and not one value.** Core's governance-decision schema changed additively
between the two accepted digests. Evidence built against either is still readable, so
both are accepted; a third value is refused by name. Accepting a digest states only that
Core can read evidence built against that contract. It is not approval of a Scan release.

## Where siblings mirror a Core artifact

| Sibling | Mirror | Core artifact | Digest the mirror claims |
| --- | --- | --- | --- |
| `@aihq/scan` 0.4.0 (published) | `src/core/core-contract-lock-v2.ts` `AI_HARNESS_DECISION_V2_SCHEMA_SHA256` | `schemas/aih-governance-decision-v2.schema.json` | `27295aee8d8be333abe2c73adc72884b534b1c9980a9b7a39d12be8d34c5caff` (a member of Core's accepted set, not the current schema) |
| `@aihq/scan` (package-boundaries line) | `src/core/core-contract-lock-v2.ts` `AI_HARNESS_DECISION_V2_SCHEMA_SHA256_ACCEPTED` | `schemas/aih-governance-decision-v2.schema.json` | both `27295aee8d8be333abe2c73adc72884b534b1c9980a9b7a39d12be8d34c5caff` and `7fdf101568cd7caa28516d0be37704c0dfd51198bc54d41d65829abbe77547cc` |
| `@aihq/scan` | `src/core/core-contract-lock-v2.ts` `AI_HARNESS_ORGANIZATION_EVIDENCE_ENVELOPE_V1_SCHEMA_SHA256` | `schemas/aih-organization-evidence-envelope-v1.schema.json` | `88c0a36e9177201660e773351958d89059c7d5b54e1c437d0afd06f48c5288bc` |
| `@aihq/catalog` | `src/supported/signed-catalog-v2.ts` `STRICT_V2_CORE_LOCK.schemaSha256` and `tools/verify-core-v2-lock.mjs` | `schemas/aih-governance-decision-v2.schema.json` | `7fdf101568cd7caa28516d0be37704c0dfd51198bc54d41d65829abbe77547cc` |
| `@aihq/catalog` | `src/supported/signed-catalog-v2.ts` `STRICT_V2_CORE_LOCK.receiptSchemaSha256` and `tools/verify-core-v2-lock.mjs` | `schemas/aih-supported-qualification-receipt-v2.schema.json` | `eb02f082e0adb11be1e2d67694fbe90666d7fff3725195b4c0ed9ce07b43f50c`, with a 5970-byte receipt bound |
| AIH UI service | `tools/service/core-targets.mjs` | `SUPPORTED_CLIS` | none: it rejects a non-array, an empty array, a malformed id and a duplicate |

Every digest in this table is recomputed by the inventory test from the schema this
package ships, or checked for membership in `ACCEPTED_DECISION_SCHEMA_DIGESTS_V2`. The
sibling files themselves are not read by that test; each sibling proves its own mirror.

## The reproducibility rule

Every compatibility run records the exact tarball sha256 and the registry integrity of
each package it tested, the resolved version and dist-tag (or the git SHA for a
branch-built tarball), and the sha256 of the consumer's `package-lock.json`. A promotion
authorization is valid only for the byte set it names; if `next` moves to different
bytes, the earlier result cannot authorize that candidate.

These records are evidence for a gate, not dependency pins imposed on users. No consumer
is required to install a tested trio, and no release of one package requires a release
of the other two. Compatibility is decided by the declared `format` and `version` of each
artifact and by the accepted digest sets each package publishes — never by
version-number equality and never by a frozen trio. A recorded hash answers *what did we
test*; it never answers *what may you install*.

## Compatibility evidence for sibling promotion

Core produces one artifact that the promotion readers of `@aihq/scan` and `@aihq/catalog`
consume: `format: "core-sibling-compatibility"`, `version: 2`, written by the summary job
of `.github/workflows/sibling-compatibility.yml` as
`compatibility/core-sibling-compatibility.json` in the run artifact
`core-sibling-compatibility`. The producer is `tools/sibling-compatibility-checks.mjs`
(`buildCompatibilityArtifact`). Readers refuse version 1, which recorded one promotable
leg per package resolved from `next` in a single all-`next` trio, by name as an unknown
format or version.

Each run resolves the npm dist-tags once. The *current Core* is what `@aihq/core`
`latest` names at that moment: one supported Core, a test snapshot, never a dependency
pin. Each combination installs one trio into its own disposable consumer:

| Combination | `@aihq/core` | `@aihq/scan` | `@aihq/catalog` | Promotable for |
| --- | --- | --- | --- | --- |
| `baseline` | latest | latest | latest | nothing |
| `scan-candidate` | latest | next | latest | `@aihq/scan` |
| `catalog-candidate` | latest | latest | next | `@aihq/catalog` |
| `core-candidate` | next | latest | latest | `@aihq/core` (recorded; no reader gate yet) |
| `all-next` | next, or latest without one | next, or latest without one | next, or latest without one | nothing |
| `branch` | packed checkout | packed checkout | packed checkout | nothing |

The artifact carries `runId`, `runAttempt`, the Core repository and commit, `resolvedAt`,
the resolved `baseline` (each package's `latest` and `next` with version, tarball sha256
and registry integrity, or `null`), `candidates`, every raw leg report under
`observations`, and a `limitation`. A `candidates` entry exists only for a
`scan-candidate`, `catalog-candidate` or `core-candidate` combination that was tested,
at most one each, and never from `baseline`, `all-next` or `branch`. It names its
`combination`; the `candidate` package at `distTag: "next"` with version, sha256 and
integrity; a `baseline` array naming the other two packages once each at
`distTag: "latest"`; the `environment` (`os`, `node`, and `npm` when known); the
consumer's own `lockfileSha256`; and `contractChecks` as `{id, status}` for every check,
in the producer's order, with status `passed`, `failed` or `unavailable`.

Producer checks, in order: `catalog-readers`, `catalog-subject-digests`, `scan-organization-evidence-schema-lock`, `scan-decision-schema-lock`, `catalog-decision-schema-lock`, `catalog-qualification-receipt-schema-lock`, `supported-clis-shape`, `refusal-input-unknown-version`, `refusal-evidence-unknown-version`, `refusal-scan-core-contract-unknown`, `refusal-catalog-index-unknown-version`, `scan-custody-negative`.

Check results are recorded, not gating: a combination job fails only when its trio could
not be obtained or installed or its checks could not run. Each reader requires, in its
own candidate combination, every check in its list present exactly once and `passed`;
`unavailable` is never read as passed. A reader's list names only its own package's
checks and Core's, so one sibling's promotion never waits on the other sibling's state:

| Reader | Combination | Required checks |
| --- | --- | --- |
| `@aihq/scan` | `scan-candidate` | `scan-organization-evidence-schema-lock`, `scan-decision-schema-lock`, `scan-custody-negative`, `supported-clis-shape`, `refusal-input-unknown-version`, `refusal-evidence-unknown-version`, `refusal-scan-core-contract-unknown` |
| `@aihq/catalog` | `catalog-candidate` | `catalog-readers`, `catalog-subject-digests`, `catalog-decision-schema-lock`, `catalog-qualification-receipt-schema-lock`, `supported-clis-shape`, `refusal-input-unknown-version`, `refusal-catalog-index-unknown-version` |

At promotion time a reader also re-observes each `baseline` entry on the registry and
refuses when that package's `latest` moved or its bytes differ: the run must be repeated
against the Core and sibling that are current then. These lists are pinned to the
producer's exported `READER_REQUIRED_CHECKS` by the inventory test; each reader enforces
its own list in its own repository.

## Changing a contract here

A new accepted digest, a new refusal code or an additive export is `semver:minor`
([VERSIONING.md](VERSIONING.md)). Removing an accepted digest, renaming a format or
bumping a version is `semver:major`, because an installed consumer that reads the old
identity would start being refused. A change to a file under `schemas/` changes its
digest: add the new digest as the last member of `ACCEPTED_DECISION_SCHEMA_DIGESTS_V2`
in the same change, and keep the old one while evidence built against it is in support.
