# Policy Workbench catalog providers

> Status: unreleased architecture on the current branch. It is not a statement
> about the current npm package.

The Policy Workbench builds one offline `authoring-catalog-bundle/v1` from a
fixed registry of build-time providers. The registry currently enrolls `ecc`,
`superpowers`, `aih`, `organization`, `mattpocock`, and `ponytail`. A provider prepares explicit
typed inputs for a registered compiler.
The registry is fixed in the package; it does not load arbitrary executable plugins.

The existing root entry remains the user-facing UI route:

```sh
npx @aihq/core --ui
```

That route builds and serves the same portable Workbench artifact. It does not
discover providers from the network or from an arbitrary local directory.

## Inputs and boundaries

ECC and Superpowers preparation begins with explicit baseline catalogs and their
matching vendor-lock source snapshots. The ECC provider derives source paths,
relations, members, metadata, and its enterprise composition from the pinned
inputs. The Superpowers provider is isolated from ECC implementation imports.

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

In the Workbench, choose the source containing `source:mattpocock` and type
**Skills**, then select the skills to request. Exported schema-v3 policy preserves their exact source and
content pins; Core validates those pins again when consuming the policy. Matt
skills are additive and do not occupy the optional methodology slot. Selection
records requested intent: it does not install a skill, run its instructions,
or grant organization approval. Scanner evidence remains missing until Core
has verified evidence bound to the same content.

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

## Deliberate limits

Providers are statically registered at build time. There is no arbitrary
runtime provider loader, independent provider availability when one included
provider fails, independent provider release, or persistent cross-process
provider cache. Process-local compilation caches remain implementation details.
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
