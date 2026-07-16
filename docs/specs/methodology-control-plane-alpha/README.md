# Methodology control plane alpha

> Status: design/proposed on `alpha/2.12-methodology-control-plane`. Nothing in
> this directory is shipped behavior. The branch starts from AIH `v2.11.0`, commit
> `eb8a1944cc37cf23a6104ea768abd4a27b2b3b26`.

This directory is the sole handoff package for a qualification-first AIH alpha.
Phase A determines whether a provider can ever be governed safely; it does not
install, activate, switch, or deactivate a provider. Controlled mutation is a
separately authorized Phase B research program and is not implied by completion
of Phase A.

The intended product boundary is:

- AIH owns policy, source verification, plan/apply, isolation checks, receipts,
  activation verification, drift detection, and rollback.
- A future enrolled host session has exactly one selected methodology provider.
  An unenrolled project has zero provider intent and is valid.
- AIH delegates installation to a verified provider installer; it does not
  vendor, re-host, or permanently cache provider source.
- AIH-owned auxiliary skills and deterministic detectors may remain additive,
  but they do not silently replace the selected methodology.
- Different projects on one machine may eventually activate different providers
  only when a complete host load-surface contract and provider-native isolation
  prove that their runtime surfaces do not overlap.

## Read order

1. [FINDINGS.md](FINDINGS.md) — critical findings that justify the work and the
   failure modes the alpha must expose.
2. [SPEC.md](SPEC.md) — normative architecture, authority model, proposed state,
   adapter contract, lifecycle, commands, and trust boundaries.
3. [PROVIDERS.md](PROVIDERS.md) — provider taxonomy, legacy mappings, and why ECC
   plus gstack are the first conflict-heavy pair.
4. [DELIVERY.md](DELIVERY.md) — cold-start, multi-session implementation blueprint,
   dependency order, verification commands, and rollback strategy.
5. [ACCEPTANCE.md](ACCEPTANCE.md) — acceptable states, fail-closed results, test
   matrix, and alpha/stable release gates.
6. [host-contracts/codex-0.144.1-windows-x64.md](host-contracts/codex-0.144.1-windows-x64.md)
   — Q1 evidence and the `HOST_CONTRACT_PARTIAL` decision for the first exact
   Codex/Windows tuple.
7. [qualifications/ecc-4ba9cf058c19.md](qualifications/ecc-4ba9cf058c19.md)
   — Q7 real-inert ECC result for the operator-authorized local checkout. It is
   `QUALIFICATION_BLOCKED`; it is not install, activation, or Phase B evidence.

## Decision summary

The alpha is opt-in and read-only with respect to provider code and
provider-visible host state. It proposes additive `aih methodology inspect`,
`plan`, `qualify`, and `status` commands. It does not change `aih init`, the
current ECC or Superpowers commands, project methodology authority, or any
default in Phase A.

ECC and gstack are the first qualification subjects. They were selected to
maximize collision pressure, not because either is pre-approved. Phase A reads
their exact local source inertly and never invokes their installer, including an
upstream preview or dry-run. If compatibility, host visibility, isolation, or
plan determinism cannot be bounded, the correct result is a coded stop.

## Non-goals

- No universal workflow assembled from pieces of several providers.
- No AIH agent runtime, dispatcher, workboard, or model client.
- No permanent AIH mirror or cache of vendor content.
- No execution of floating `main`, `latest`, marketplace, or TUI selections.
- No execution of any provider code in Phase A, including installer previews or
  commands described as dry-run.
- No silent provider selection, upgrade, repair, or fallback.
- No full-catalog repair requirement for an AIH release.
- No claim that a successful source scan proves runtime activation.
- No real apply, activation receipt, canonical provider write, switch, rollback,
  or concurrent-provider support claim in Phase A.
- No stable `2.12.0` release until the stable gates in
  [ACCEPTANCE.md](ACCEPTANCE.md) are satisfied.

## Ownership of truth

This directory is the complete public-safe design and handoff record. Do not use
session memory, archived chat, or a personal note as an additional authority. The
branch is committed and pushed; a new machine may fetch the branch, but it must
still receive separate authorization before any disposable execution research. The
Q7 checkout remains an operator-selected local source, not a distributed provider
artifact or an implicit approval. When implementation changes a decision, update
these files in the same change and record the reason in the plan-mutation ledger in
[DELIVERY.md](DELIVERY.md).
