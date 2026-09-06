# Issue #977 — Pinned Ponytail catalog

Status: focused source, Core, and CI ownership checks passed. Combined Workbench
and hosted acceptance results are recorded in the linked PR.

## Boundary

The provider packages six skills, three hook declarations, one MCP declaration,
and an optional methodology profile from Ponytail v4.9.0, commit
`974d940a1c5344210874150b98ff0d2c861fab6a`. The closed inventory contains 56
files, including the exact MIT license. Each raw blob was compared with its path
in the non-truncated pinned Git tree using Git blob SHA-1, SHA-256, and byte length;
all matched. A separately reviewed literal digest seals the component metadata,
relations, and file references as well as those bytes.

The neutral `pinned-component-collection/v1` format carries component and profile
data without source-specific branches. Only the provider owns Ponytail identity,
its reviewed snapshots, and upstream declarations. Automatic contracts use a tiny
synthetic fixture. No generic UI file or browser journey is added.

## Regression evidence

The initial Core scenarios failed because the packaged provider was not available
through default preparation. The final 11-test suite proves exact export/import,
Core requested intent, separate request and control counts, stale and missing
source/asset rejection, and optional methodology conflicts in both selection
orders. Every rejected pin leaves candidates, MCP servers, external selections,
capability packages, approvals, and activations inert. Applying the methodology
template never adds implicit hook or MCP requests.

Review found insufficiently independent snapshot custody, source identity in the
shared compiler, missing boundary bounds, and hidden request relationships.
Regressions now cover literal snapshot pinning, metadata and file-reference
mutations, strict plain JSON, bounded canonical base64 and ordering, safe primary
paths, file ownership, duplicate and invalid relations, and request-target denial.

## Focused validation

| Command or scope | Result |
| --- | --- |
| Compiler, provider, and Core Vitest files | 30 tests passed |
| Strengthened Core consumption Vitest file | 11 tests passed; 4.36 s |
| CI impact, required-lane gate, and provider ownership Vitest files | 75 tests passed |
| `tsc --noEmit --pretty false` | Passed |
| Scoped Biome and `git diff --check` | Passed |

## Runtime limits

Hook and MCP rows record exact requests; this change does not install or activate
upstream programs. Declared hosts are source metadata, not Core support claims.
The private MCP subtree is absent from the upstream root npm package and has no
lockfile. A runtime adapter needs separately reviewed acquisition, dependency
locking, installation, and activation contracts. Benchmark support files are
covered source material, not a runtime materialization list.

## Combined acceptance after Matt integration

The six Matt and Ponytail compiler/provider/Core files passed together: 46 tests
in 4.32 s. The complete Workbench lane passed in 50.865 s; pure coverage took
4.776 s, and peak summed RSS was 2,914,615,296 bytes with no heap override. All
seven existing Chromium journeys passed, including the installed-package UI and
deterministic offline artifact. No source-specific browser test was added.
