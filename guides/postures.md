---
status: guide
owner: AI-Harness maintainers
last_verified: 2026-08-08
truth_home: true
purpose: Human-readable guide to posture behavior and positioning.
---

# Posture Guide

This guide explains how to reason about `vibe` and `enterprise` posture without turning posture into pricing language or mixing shipped behavior with unshipped plans.

The current release baseline is `@aihq/harness@6.0.1`. The `vibe`/`enterprise` model below is shipped behavior in the 5.x line; use the installed version's release notes and CLI help as the syntax authority.

## Read this as

Posture is a governance dial. It changes defaults, friction, escalation, and enforcement. It does not decide which capabilities exist.

Use this guide when:

- planning feature behavior that differs by posture
- deciding whether a defect is a local friction issue or an org-control issue
- writing docs, issue drafts, or roadmap notes that mention posture
- reviewing capability/package-manager, trust-gate, MCP, workspace, or policy changes

Use the command reference and `aih <command> --help` as syntax authorities. This guide explains posture behavior at a higher level and avoids describing unshipped admin-plane or commercial behavior as available setup.

## Shared invariants

These apply across posture modes:

- Posture mode is not a capability catalog by itself. Skills, agents, MCP servers, packages, marketplace/evidence/trust primitives, and local posture selection stay governed by their own command and policy rules.
- Posture is not a public entitlement ladder. Do not describe it as "free vs paid" and do not create upgrade prompts around it.
- The CLI reads committed/signed policy and derived local state. The supported public claim is no default phone-home and no hidden telemetry transmission; network-capable behavior exists only in named command surfaces invoked by the operator.
- Commands should reject hostile or malformed input and report explicit degraded coverage when optional tools, scanners, or network access are absent.
- Registered package membership is not an exemption from checks. A registered source still needs trust, provenance, policy, and content verification appropriate to the surface.
- Regulated domain packages stay approved-but-off-by-default until explicitly selected.
- Public documentation claims must stay evidence-bound. `aih docs-lint` is a read-only BetterDoc/claim-ledger gate: prose guidance is advisory, while orphaned claim markers, missing control-matrix rows, missing named tests, and feature-doc drift fail closed.
- Project-truth sidecars are optional, external, and commit-bound. `aih truth verify` fails closed on sidecar drift, malformed assertions, unsafe paths, stale agent evidence, and acceptance-preflight blockers according to the shipped command rules.
- Machine-local caches such as `.aih/` and `~/.aih/` are derived state unless a command explicitly says otherwise. Committed files, signed bundles, lockfiles, and sidecar bindings carry authority.

## Posture Summary

| Posture | Primary user | Intent | Default behavior | Escalation posture |
|---|---|---|---|---|
| `vibe` | Developer, evaluator, or locally managed shared repository | Fast adoption and useful defaults. | Broad defaults, low friction, auto-add where safe. | Warn, explain, and keep moving unless danger is proven. |
| `enterprise` | Governed organization or fleet | Least privilege, auditability, admin-pinned behavior. | Approval paths and fail-closed enforcement where configured. | Require explicit approval, signed/pinned policy, or a decision record. |

## Developer / Vibe Posture

`vibe (developer)` optimizes for individual momentum while preserving the hard safety floor.

Use this posture for a developer evaluating the tool, dogfooding on one machine, or working in a repo without formal org policy.

Behavior rules:

- Capability manager defaults should be broad where safe: common baseline, standard stack/domain detection, role profiles, and helpful catalog entries can light up automatically.
- Warnings are acceptable for origin ambiguity, missing optional detectors, absent network, or incomplete provenance, provided the action does not import proven dangerous content.
- Proven dangerous trust findings still deny. Examples: malicious code, prompt injection, hidden Unicode, auto-exec hooks, dependency confusion, and tree-escaping artifacts.
- Missing required infrastructure should be explained as a setup gap, not treated as a governance violation unless the feature cannot operate honestly.
- Developer-facing docs should be concrete and action-oriented: what happened, why it matters, and the next command or file to inspect.
- Do not add central-admin concepts to the first-run path. The posture should feel local and useful without enrollment.
- `aih capability resolve` may auto-add evidence-backed capability intent at this posture, but it still writes committed intent only under `--apply` and keeps `$HOME/.aih/capabilities/cache.json` rebuildable.
- `docs-quality` and BetterDoc can be installed through the normal pack flow when approval exists; a seeded pack still needs vet/approve evidence in a new repo before install.

Examples:

| Case | Vibe behavior |
|---|---|
| Untrusted but not proven-dangerous source | Warn/advisory; record evidence. |
| Optional external scanner absent | Degrade with banner; do not imply green coverage. |
| Plaintext secret in repo | Warn or gate according to the command's existing posture rule; never auto-fix. |
| Regulated domain package | Keep off by default until selected. |
| Public doc claim marker missing evidence | `aih docs-lint` fails; fix the claim, matrix, or named test. |
| Truth sidecar absent | No issue unless the workflow chose to use sidecars. |

## Shared Repository Practice

A shared repository can use either posture. Keep shared intent in committed policy, manifests, lockfiles, and decision records; local caches remain derived state. Use `vibe` when the workflow needs advisory defaults, and set an `enterprise` policy floor when the repository requires approved, enforced controls.

## Enterprise Posture

`Enterprise` optimizes for least privilege, auditability, admin-pinned predictability, and supportability.

Use this posture for governed environments, fleet rollout, regulated teams, or organizations with egress, audit, or approval requirements.

Behavior rules:

- Admin-pinned surfaces should materialize only the policy-approved set when a command has an explicit compliant/enforcement mode, such as `aih mcp --posture enterprise --mcp-compliant`. Without that mode, enterprise posture reports denials and verification failures instead of silently rewriting generated config.
- Adds become hints, approval requests, or hard stops unless policy already permits them.
- Required detectors and required checks fail closed when configured and absent.
- Hosted or mutable supply-chain surfaces should deny when they cannot be pinned or verified to the enterprise policy standard.
- Evidence must be explicit: which policy bundle/version was enforced, which checks ran, which degraded, and which artifacts were approved.
- Public docs should not include non-public pricing, customer, telemetry, entitlement, tenant, or unshipped commercial/admin-plane details.
- Enterprise behavior remains local-first in the CLI. If a future admin-plane feature is not shipped in the CLI, label it as future-facing or omit it from setup guidance.
- Capability resolution produces approval-required hints unless policy already authorizes the capability. It must not fetch, install, or vendor third-party bytes as part of resolution.
- `docs-lint`, `truth verify`, `policy verify`, `pack validate`, `marketplace validate --require-signature`, and `verify-bundle --require-signature` are enterprise-friendly gates because they turn missing or drifting evidence into explicit findings.
- Missing required detectors, malformed policy, denied MCP residue, unverified truth packs, or signature requirements fail closed when the command/policy requires that behavior.

Examples:

| Case | Enterprise behavior |
|---|---|
| Untrusted publisher/source | Deny unless approved by committed/signed policy. |
| Required detector absent | Fail closed if policy requires it. |
| Hosted MCP with no pinning surface | Deny or require explicit admin approval. |
| Policy bundle signature mismatch | Refuse activation and keep last-good policy. |
| Truth-pack assertion drift | Refuse to index the stale pack into evidence. |
| First-party pack seeded into another repo | Require that repo's own vet/approve evidence before install. |

## Trust And Verdict Examples

| Condition | `vibe` | `enterprise` |
|---|---|---|
| Proven dangerous content | Deny | Deny |
| Origin/provenance ambiguity | Warn | Deny unless approved |
| Optional detector absent | Degraded warning | Fail only if configured as required |
| Required detector absent | Degraded warning | Fail closed |
| Hosted remote MCP with no stable artifact | Warn with runtime advice | Deny or admin approval |
| Plaintext committed secret | Warn/gate by command rule | Gate |
| Claim-ledger orphan | Fail `docs-lint` | Fail `docs-lint` |
| Truth sidecar drift | Fail when sidecar workflow is used | Fail when sidecar workflow is used |

## Capability And Package Behavior

| Surface | Vibe | Enterprise |
|---|---|---|
| Common baseline | Default-on where safe. | Admin-pinned. |
| Stack/domain detection | Auto-add standard needs. | Require approval. |
| Regulated domains | Approved-but-off-by-default. | Approved-but-off-by-default plus policy approval. |
| Machine store `~/.aih/` | Derived cache for convenience. | Derived cache projected from policy. |
| Package graph registry | Open governance data model. | Signed/admin-authored projection. |
| Capability intent | Auto-add decisions where evidence supports them. | Approval-required hints unless policy permits. |
| BetterDoc / docs-quality | Install through pack flow when approval exists. | Seed only with repo-local approval evidence and policy fit. |
| `docs-lint` claim gate | Local public-doc check. | Release/evidence gate for public claims. |
| Truth sidecar | Optional local workflow. | Optional evidence workflow; stale packs fail closed. |

## Public Documentation Boundary

Use public language that is tied to shipped behavior:

- posture dial
- local/offline CLI behavior
- policy config or policy bundle where implemented
- trust, evidence, verification, and package/source membership
- explicit approval records, pinned sources, signed bundles, and local diagnostics

Avoid public language that implies unshipped or unsupported commitments:

- "free tier" or "paid tier" posture framing
- upgrade prompts
- customer names, tenant IDs, telemetry plans, pricing, GTM, or entitlement details
- formal compliance, certification, audit-readiness, production-proof, or legal-safe-harbor claims
- admin-plane behavior unless the command reference and release evidence show it is shipped

When posture behavior changes, update the command reference, relevant guide, and tests or release evidence together. Keep future-facing concepts out of setup instructions until they are shipped.
