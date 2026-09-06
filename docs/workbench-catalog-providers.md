# Policy Workbench catalog providers

> Status: unreleased architecture on the current branch. It is not a statement
> about the current npm package.

The Policy Workbench builds one offline `authoring-catalog-bundle/v1` from a
fixed registry of build-time providers. The registry currently enrolls `ecc`,
`superpowers`, `aih`, and `organization`. A provider prepares explicit typed inputs for a registered compiler.
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

The AIH source provider takes an explicit capability catalog and package
identity, then supplies the static AIH skill and agent declarations. Core-owned
MCP controls, global hooks, legacy compatibility bindings, and authority paths
remain outside that provider. The organization provider compiles an
organization authoring manifest through the same generic assembly shape.

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

Provider ownership is intentionally limited to the registered entry modules.
ECC metadata and skill-catalog snapshots still feed legacy aggregate consumers,
so their changes retain broader checks. Baseline inventory providers used by
installers retain a full-suite fallback. Unknown provider paths and selector or
shared-lock changes also broaden coverage. This isolates semantic checks where
ownership is proven; TypeScript builds, packaging, and release remain shared.

## Deliberate limits

Providers are statically registered at build time. There is no arbitrary
runtime provider loader, independent provider availability when one included
provider fails, independent provider release, or persistent provider cache.
The existing process-local compilation cache remains a combined-artifact
implementation detail.

Adding an ordinary provider requires a reviewed provider module, static
registry enrollment, declared ownership and dependencies, and a mandatory
fixture and contract coverage. New executable behavior, projectors, policy
rules, or authority semantics require separate Core contracts.
