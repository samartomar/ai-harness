# Policy Workbench catalog providers

> Status: unreleased architecture on the current branch. It is not a statement
> about the current npm package.

The Policy Workbench starts with one offline `authoring-catalog-bundle/v1` from a
fixed registry of build-time providers. The packaged registry currently enrolls `ecc`,
`superpowers`, `aih`, `organization`, `mattpocock`, and `ponytail`. A provider prepares explicit
typed inputs for a registered compiler.
The registry is fixed in the package; it does not load arbitrary executable plugins.

The existing root entry remains the user-facing UI route:

```sh
npx @aihq/core --ui
```

That route builds and serves the same portable Workbench artifact. It does not
discover executable providers from the network or from an arbitrary local directory.
It also reads explicitly imported, authenticated source-data snapshots without
replacing the installed Core version. This data path is separate from executable
provider registration.

## Inputs and boundaries

ECC and Superpowers preparation begins with explicit baseline catalogs and their
matching vendor-lock source snapshots. The ECC provider derives source paths,
relations, members, metadata, and its enterprise composition from the pinned
inputs. The Superpowers provider is isolated from ECC implementation imports.
Its skill descriptions come from `superpowers-content-metadata.snapshot.json`,
bound to the same repository and commit as the baseline. The snapshot records
each source path and SHA-256; it does not infer tool permissions from missing
frontmatter. Regenerate it from the exact source checkout with the existing
`tools/update-ecc-content-metadata.mjs` extractor and its explicit `--repo`,
`--commit`, `--repository`, and `--output` arguments.

The built-in compiler also carries public MCP purpose and access disclosures
into detail chunks. These display fields and concise first-party pack summaries
do not alter control or pack declaration identities. Process commands,
environment values, and HTTP headers are excluded from that display projection.

The ECC product source is `affaan-m/ECC` at an exact qualified commit. A fork is
a contribution workspace, not an alternate catalog or installation source.
Required ECC changes go through upstream pull requests; consuming their merged
commits requires fresh source-bound evidence. Repository ownership remains part
of the evidence identity even when the commit and content digests are unchanged.
The separate ECC MCP reference inventory and packaged profile retain their own
reviewed pins; a baseline migration does not upgrade either surface.

The AIH source provider takes an explicit capability catalog and package
identity, then supplies the static AIH skill and agent declarations. Core-owned
MCP controls, global hooks, legacy compatibility bindings, and authority paths
remain outside that provider. The organization provider compiles an
organization authoring manifest through the same generic assembly shape.

The Matt Pocock provider packages the 25 skills listed in the upstream plugin
manifest at commit `3cca18b368ae95cdbdebbff572ccafa662551015` (version `1.2.3`).
It includes each `SKILL.md`, its explicitly referenced local support files, and
the MIT license. The skill-only compiler checks exact bytes and content hashes;
source pinning and the curated inventory belong to the provider. Development
files and unpublished skills are excluded.

In the Workbench, choose source **mattpocock/skills** and type
**Skills**, then select the skills to request. Exported schema-v3 policy preserves their exact source and
content pins; Core validates those pins again when consuming the policy. Matt
skills are additive and do not occupy the optional methodology slot. Selection
records requested intent: it does not install a skill, run its instructions,
or grant organization approval. Core attaches Scanner evidence only after
verifying its publication and exact content binding. Packaged Matt evidence and
Catalog qualification are separate records; selection grants neither.

Shared provider-facing shapes live in
`src/org-policy/catalog-provider-types.ts`. They include catalog assets and
composition plus AIH control, hook, and package-content shapes. This lets
providers and compiler inputs depend on neutral types instead of importing the
aggregate catalog façade.

Provider identity (`providerId` and `providerVersion`) identifies build
ownership. It does not grant compiler, evidence, qualification, policy, or
execution authority.

## Assembly and failure behavior

Every enrolled provider supplies a mandatory fixture through the provider
contract. The registry compiles those fixtures through the registered input
format, so a missing fixture or a format with no fixture fails the build-time
contract.

Normal provider output may contain source descriptors, declarations, relations,
groups, templates, detail bytes, and non-authoritative evidence summaries. It
cannot claim Core verification or qualification. Core alone can consume its
opaque, fresh organization preparation and attach the resulting evidence
summary under its custody rules.

Provider validation and assembly reject an empty provider result, unsupported assembly fields,
duplicate sources, declarations, detail chunks, groups, templates, or ambiguous
relations. It also rejects declarations whose immutable source or registered
compiler does not match. A rejected included provider therefore prevents the
combined artifact from being produced; the Workbench does not publish a partial
catalog.

The selection engine permits zero or one distinct methodology key. Methodology
profiles are optional. Assets that carry the same methodology key may compose,
but selections with different keys are rejected.

## Testing ownership

The source-preparation contract has a focused, non-browser check:

```sh
npm exec -- vitest run tests/org-policy/catalog-providers.test.ts
```

It covers explicit source inputs, façade parity, source identity and pin
rejection, curation and verdict projection, and Superpowers import isolation.
Provider fixtures and combined assembly have their own Workbench contract
tests. Packed-artifact and browser journeys remain shared Workbench coverage;
`npm run test:workbench:ui` is the broad browser command. They are not
source-specific journeys and are not a replacement for the focused provider
test.

CI emits a versioned receipt with the affected provider IDs, exact contract tests,
and separate packed-artifact and generic-browser requirements. A change to a
registered provider entry runs its provider and consumer tests, one whole-package
build, and the shared packed smoke. A shared UI or contract change uses the full
Workbench lane. Mixed changes use that broader lane once; the required-check
gate rejects a skipped mandatory lane.

Provider ownership covers reviewed entry modules and explicitly enrolled data
snapshots. Matt snapshot changes run Matt provider and consumer checks; the
shared skill compiler retains broader Workbench coverage.
ECC metadata and skill-catalog snapshots still feed legacy aggregate consumers,
so their changes retain broader checks. Baseline inventory providers used by
installers retain a full-suite fallback. Unknown provider paths and selector or
shared-lock changes also broaden coverage. This isolates semantic checks where
ownership is proven; TypeScript builds, packaging, and release remain shared.

## Public evidence delivery

Bundled source content requires exact current verified report coverage before a
Workbench release is ready. `npm run check:workbench-evidence` reports coverage
gaps separately from recorded security outcomes. A verified report containing
findings remains a report; a failing scan is never relabeled as passing to make
the delivery check green. Derived Core methodology declarations require their
own composition integrity check and constituent reports, not an invented
upstream scan.

The internal `prepare:workbench-evidence` operation consumes the existing
operational administrator evidence verifier and writes a new module for review:

```bash
npm run prepare:workbench-evidence -- --admin-root /absolute/preparation-root --output /absolute/new-proof-module.ts
```

It requires actual publication verification. A parsed report, cloned resolver
result, provider declaration, or adjacent checksum cannot author this proof.
The packaged proof retains the verified Core vendor publisher, original dates,
artifact subject and vendor-lock digest. Displayed findings and outcomes are
derived from that exact lock rather than duplicated in the proof. The Scanner
analyzer policy is an expected preparation input, not an observed Scanner run
identity. Release verification independently checks the actual protected
publication attestation; the offline coverage check is not a signature verifier.

The default `npx @aihq/core --ui` flow consumes only package-owned prepared data.
It does not require the user to run Scanner or install GitHub CLI. The browser
does not fetch or verify evidence. Original verification expiry is preserved;
historical findings remain visible after the current verification interval ends.
Public report freshness defaults to 90 days from the authenticated Scanner
envelope's original signing date. The original envelope verification window
remains a separate protocol fact. Downloading, re-verifying, or repackaging a
report cannot renew its freshness. Administrator cache retention and operational
workspace scan lifetimes remain separate policies.

The `Evidence & versions` disclosure distinguishes Core's version, its Scanner
library pin and allowed publisher from evidence actually included. Missing
Catalog head provenance is explicit. Catalog qualification and organization
approval remain separate from scan provenance and results.
The catalog digest and bundled report-lock digest identify the data in this
artifact even when a development build retains the published package version.

Matt and Ponytail request preparation verifies every packaged file against the
exact upstream checkout, hashes the complete materialized source tree, and maps
the selected component file sets to their distinct compiler asset digests. The
`coverage-map.json` companion is non-authoritative. Core must recompute it from
its pinned provider input when consuming a publication; merely uploading the
companion does not establish custody. AIH MCP declarations do not constitute
scans of external packages or private hosted-service implementations.

For ECC, Superpowers, Matt and Ponytail, the internal preparation command accepts a local directory
of `batch-001`, `batch-002`, and subsequent published four-file release sets:

```bash
npm run prepare:workbench-collection-evidence -- --catalog mattpocock --source /absolute/pinned-checkout --publication-root /absolute/batches --output /absolute/new-report.json
```

It recomputes requests and coverage, checks the checkout pin, performs actual
GitHub publication verification, and retains the observed publisher and original
attestation dates with the report. It rejects uploaded attestation claims and
never runs analyzers or signs a publication. The output remains non-authoritative
transport until the protected Core release validates it and includes the sealed
record in the inputless package loader. Catalog qualification is a separate
step. An expired immutable release cannot be refreshed by retrying its existing
tag. Scanner publication supports an opaque eight-digit renewal generation:
the new address runs the analyzers again, while retries verify and reuse the
same completed generation. The generation is never an evidence timestamp.

Catalog qualification has its own original issuance, not-before, and exclusive
expiry. Its default maximum lifetime is also 90 days, shortened by an earlier
signed receipt or Catalog-head expiry. A current qualification never refreshes
an expired scan, and a fresh scan never renews qualification. Expired findings
remain visible as history. Qualification does not grant organization approval.

Changed source revisions or content digests cannot inherit old reports or
qualifications. Upstream availability can be checked during connected release
preparation; the offline Workbench cannot discover new upstream versions.
There is no background refresh, automatic version switch, or browser network
requirement.

AIH uses the same collection command with `--catalog aih` and an exact Core
checkout. Its preparer materializes the three delivered packs, generated usage
hook, and six MCP configuration declarations outside the checkout. Copied pack
files must match the pinned Git objects. Configuration scans do not cover a
hosted MCP service's private implementation. Operational temporary material is
removed after verification, including failed attempts.

Scanner's protected producer route uses
`node --import tsx tools/prepare-aih-delivery-baseline-requests.mjs --source /absolute/core-checkout --core-commit <full-commit> --output /absolute/new-request-directory`
to author those generated delivery subjects before scanning. The helper writes
canonical request batches, `coverage.json`, and an inert `materialization.json`
that binds the generated tree to the Core commit. Scanner must scan that generated
tree; scanning the ordinary repository checkout does not cover these declarations.
This preparation does not sign, publish, or qualify evidence.

The scanned Core commit and the final packaging commit are distinct identities.
An evidence-only packaging change can retain a report only when freshly generated
materials match: package version, compiler inputs, asset identities, component
files, and generated content. The original scanned commit remains in the report.
A changed pack, hook, MCP declaration, or compiler input requires new matching
evidence; changing only the evidence records does not renew report dates.

AIH scan coverage and Catalog qualification have different scopes. Pack
qualification covers the declared pack files and manifest. MCP qualification
can cover configuration declarations only, not the external server binary or
hosted implementation. The current Catalog subject schema has no hook kind,
so a hook can have a verified scan without a Catalog qualification. It must
not inherit qualification by being relabeled as a tool or profile.

The internal Catalog preparation command consumes the four bounded files
`receipt.json`, `receipt-set.json`, `member.json`, and `closure.json`. The local
transport names differ from the authenticated publisher subjects: the receipt
subject is derived from its exact entry ID, and the set subject is
`qualification-receipt-set.json`.

```bash
npm run prepare:workbench-catalog-qualification -- --source /absolute/pinned-checkout --provider mattpocock --artifacts /absolute/verified-publication --output /absolute/new-catalog-data.ts
```

It emits the complete inert package-data module: original receipt material,
independent Core material bindings, and minimal display projections. Only a
reviewed Core release replaces `catalog-qualification-data.ts` with that output.
The fixed publisher policies must advance to the reviewed Scanner and Catalog
release commits when their publication workflows change. Development pins cannot
establish missing production reports or qualifications.

`check:workbench-publication` is a connected release-only gate. It acquires
registered sources at exact Git pins through bounded GitHub archives and
downloads bounded files from exact immutable Scanner publication addresses.
Source downloads are limited to 64 MiB compressed and 256 MiB expanded. Unsafe
paths and changes to acquired material are rejected. Symlinks are never created
or followed: their literal metadata preserves source identity, and scan coverage
that intersects an omitted link is rejected. The gate reconsumes the actual reports
and Catalog receipts and compares the prepared records, preserving original
dates. It never runs analyzers or publishes. Temporary acquisition trees are
removed on success and failure. The normal offline Studio never calls this gate.

Release readiness checks the proofs actually included in the package. Preparation
commands alone do not establish that every offered source has a matching report.
The authenticated refresh path below can deliver compatible source data after
the initial package release.

## Provider loading limits

Executable providers are statically registered at build time. There is no arbitrary
runtime executable-provider loader or independent executable-provider release.
A malformed included provider prevents package assembly. Independently signed
source-data refreshes use compiler formats already supported by Core. Accepted
data snapshots and local verification receipts persist across processes;
process-local compilation caches remain implementation details.
Matt validates its packaged snapshot on first use and reuses a sealed compilation
with detached outputs. Ponytail lazily validates its private packaged snapshot,
rejects malformed or accessor-bearing values before cloning, and caches the
complete sealed provider compilation while returning detached copies. Explicit
caller inputs are always revalidated and are not admitted through that cache.
A local recurring-preparation measurement fell from 23.205 ms to 0.059 ms; it
does not establish a total Workbench-lane improvement.

Adding an ordinary provider requires a reviewed provider module, static
registry enrollment, declared ownership and dependencies, and a mandatory
fixture and contract coverage. New executable behavior, projectors, policy
rules, or authority semantics require separate Core contracts.

## Authenticated source-data refresh

`aih policy data prepare`, `sign`, and `import` form an explicit operator workflow;
each writes only with `--apply`. A compatible inventory, source pin, Scanner proof,
or Catalog qualification update does not require a Core/npm release. The
configured signer must have the `workbench-source-data/v1` role and the exact
source scope. That signature does not grant Scanner or Catalog authority: import
independently verifies their original publications and exact source bytes.
Unsupported compiler formats and executable behavior require a Core change.

The initial Core package can include prepared source records and their verified
report summaries. Release preparation reconstructs the exact compiler input from
the pinned upstream archive and replays the original published proofs before the
package can ship. Opening that package's Workbench does not download source files,
run scanners, call GitHub, or require the user to manage verification keys.
Later compatible source updates use the separate import workflow above.
The initial package source identities remain pinned across compatible Core
releases; the checked identity fixture guards against replacing or removing them.
Routine source revisions belong in authenticated data snapshots, whose retained
history can satisfy saved policy pins. A missing historical snapshot requires
importing that exact snapshot; Core rejects mismatched material instead of moving
the selection. Evidence for an unchanged initial source may be refreshed, but its
original report dates remain binding. An expired report requires a genuine new
scan before it can meet the release freshness gate.

Raw Scanner replay supports `pinned-skill-collection/v1`,
`pinned-component-collection/v1`, and `pinned-baseline/v1`. A broader published component can cover several
offered assets only after complete file-and-digest containment checks. The UI
identifies broader source reports and retains their findings and failed outcomes.
This does not establish runtime behavior or organization approval.

An archived Scanner publication retains its original custody-signature window
and verification context. Core verifies that context and checks that the
independently authenticated publication time fell within the original window.
That short window is separate from current report freshness, which is bounded
to 90 days from the original signed report date. Re-verification, publication,
and import do not restart that age. Catalog qualification keeps its own signed
expiry; neither kind of evidence grants organization permission.

For ECC, a verified data snapshot can also retain an exact-version runtime
descriptor for the existing materializer. Core reconstructs its component paths,
required dependencies, optional riders, and source-tree digest from verified
material. Before acquisition, Core checks that its current target adapter can
interpret that descriptor. Unsupported destinations remain refusals; a snapshot
cannot introduce an installer, executable adapter, or new permission.

An authenticated local snapshot matching the saved policy takes precedence over
packaged data. If that matching snapshot is expired or incompatible, Core stops
instead of falling back to older packaged evidence. A different source revision
does not replace the saved policy's revision. Source bytes are checked again at
both baseline evidence gates before materialization.

Historical ECC materialization receipts use version 2 to record separate
descriptor, original-report, Core-derived evaluation, and projection digests,
plus the original report component references for the materialized selection.
The original report remains in the verified descriptor. The derived evaluation
is an internal input to Core's existing checks, not a new Scanner report;
mapped failed findings remain failures. Existing version 1 receipts remain
readable. Neither receipt version grants organization approval.

Large publications may be retained as digest-addressed proof files beside the
signed snapshot and supplied with `--proof-root` during import. Verification
requires `gh` at import time. Ordinary cached UI preparation needs neither `gh`
nor those raw files; it validates protected machine-local receipts. Unrelated
source trust additions do not invalidate an accepted source. Changes to its
applicable signer scope or publisher policy require re-verification.

Saved policies retain their exact source revisions and content pins. A new
revision does not silently move a saved selection. Back up the signed snapshots,
referenced proof files, exact source material, and public trust configuration.
For independently added updates, another PC must import the required snapshot chain using its own
local verifier key. Copying the browser artifact or public cache does not
establish verification on that PC. See [the command reference](commands.md) for
import paths and requirements.

## Ponytail collection

The Ponytail provider packages six skills, three hook declarations, and one MCP
declaration from commit `974d940a1c5344210874150b98ff0d2c861fab6a` (v4.9.0). Its
56-file source inventory includes the exact MIT license and referenced support
files. A literal reviewed digest binds the complete snapshot, including component
metadata and file references. Snapshot validation happens on first preparation.

Use the existing Source selector for `source:ponytail` and the Type selector to
browse Skills, Profiles, Hooks, or MCP. The main Ponytail skill and optional
methodology profile share one methodology key; the five auxiliary skills are
additive. Applying the methodology template selects its pinned skill closure.
Hook and MCP requests must be recorded explicitly and have separate counts from
selected controls. They never become implicit template dependencies.

Hook details preserve the upstream command, event, matcher where present, status
message, five-second timeout, and declared Claude Code/Codex hosts. MCP details
record its stdio launch, prompt and tool names, modes, and declared dependency
ranges. These fields describe upstream source; they do not establish Core runtime
support, a locked dependency closure, organization approval, or scanner evidence.

The root upstream npm package does not include the private MCP subtree, which has
no dependency lock. A future Core runtime adapter would need an exact acquisition
source, independently locked dependencies, and its own reviewed installation and
activation contracts. The Workbench currently records pinned requests only.

File references identify covered source bytes. In particular, the gain skill's
benchmark files are supporting material, not an installation or execution list.
Any future materialization must define a separate Core-owned file allow-list.

The neutral `pinned-component-collection/v1` format stores shared files once and
expresses primary paths, component metadata, relations, profiles, and templates
as data. It uses a tiny synthetic fixture for automatic contracts. Source-local
Ponytail changes use the provider lane and existing packed smoke; changes to the
shared format use broader Workbench coverage.
