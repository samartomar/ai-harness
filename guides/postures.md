---
status: guide
owner: AI-Harness maintainers
last_verified: 2026-07-07
truth_home: true
purpose: Human-readable guide to posture behavior and positioning.
---

# Posture Guide

This guide explains how to reason about `vibe (developer)`, `team`, and `enterprise` posture without turning posture into pricing language or mixing shipped behavior with unshipped plans.

Current command baseline: shipped behavior through `@aihq/harness@2.4.0`, including capability intent/cache, workspace reconstruction, pack governance, BetterDoc/docs-lint, project-truth sidecars, and release verification.

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
| `vibe (developer)` | Individual developer or evaluator | Fast adoption and useful defaults. | Broad defaults, low friction, auto-light-up where safe. | Warn, explain, and keep moving unless danger is proven. |
| `team` | Shared repo/team workflow | Team hygiene without a central admin board. | Sensible defaults, warn-on-add, committed intent. | Promote repeatable risk into policy or an approval note. |
| `enterprise` | Governed org/fleet | Least privilege, auditability, admin-pinned behavior. | Admin-pinned surfaces, approval paths, fail-closed enforcement where configured. | Require explicit approval, signed/pinned policy, or a decision record. |

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

## Team Posture

`team` optimizes for repeatability across a shared repo without requiring a central admin service.

Use this posture when several developers need consistent behavior from committed repo files, shared policy, and stable defaults.

Behavior rules:

- Defaults should be sensible, not maximal. Auto-detected capabilities can be suggested or added when low risk, but broad or risky additions should warn first.
- Team-shared intent belongs in committed files: policy, manifests, lockfiles, feature notes, and decisions. Do not leave team state only in `.aih/` or a chat transcript.
- Local derived caches such as `~/.aih/` are rebuildable convenience state, never the source of truth.
- Defects that affect repeatable team behavior should be verified against code, CLI behavior, or GitHub/npm evidence before they are treated as active work.
- If the same warning keeps recurring, convert it into a policy, decision, or tracked work item instead of letting each agent rediscover it.
- Capability decisions should be committed when shared. The machine cache can be pruned and rebuilt from repo manifests.
- Packs should be named team choices. Use `pack status` and `pack validate` to join pack curation, approval lock, and install state.
- Sidecar use is a team workflow choice. When used, `truth verify` belongs in the same review path as docs and evidence gates.

Examples:

| Case | Team behavior |
|---|---|
| MCP server not in allowed list | Warn or require local approval depending on policy surface. |
| Missing optional detector | Warn with degraded coverage; do not hard-fail unless configured as required. |
| Git absent for readiness | Gate at team+ when the workflow depends on git. |
| Shared package source | Prefer pinned source references and committed manifests. |
| Claim-ledger drift | Fail the docs gate and update docs/control matrix or tests. |
| Workspace child writes | Require explicit commands such as `workspace init --recursive` or `workspace report --refresh-children`. |

## Enterprise Posture

`Enterprise` optimizes for least privilege, auditability, admin-pinned predictability, and supportability.

Use this posture for governed environments, fleet rollout, regulated teams, or organizations with egress, audit, or approval requirements.

Behavior rules:

- The machine should materialize only the admin-pinned approved set. Surfaces outside policy should remain hints or approval requests instead of materialized files.
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

| Condition | `vibe (developer)` | `team` | `Enterprise` |
|---|---|---|---|
| Proven dangerous content | Deny | Deny | Deny |
| Origin/provenance ambiguity | Warn | Warn or require local approval | Deny unless approved |
| Optional detector absent | Degraded warning | Degraded warning | Fail only if configured as required |
| Required detector absent | Degraded warning | Degraded warning unless team policy says otherwise | Fail closed |
| Hosted remote MCP with no stable artifact | Warn with runtime advice | Warn/approval path | Deny or admin approval |
| Plaintext committed secret | Warn/gate by command rule | Gate where team rule requires | Gate |
| Claim-ledger orphan | Fail `docs-lint` | Fail `docs-lint` | Fail `docs-lint` |
| Truth sidecar drift | Fail when sidecar workflow is used | Fail when sidecar workflow is used | Fail when sidecar workflow is used |

## Capability And Package Behavior

| Surface | Vibe | Team | Enterprise |
|---|---|---|---|
| Common baseline | Default-on where safe. | Sensible default; document and commit shared intent. | Admin-pinned. |
| Stack/domain detection | Auto-light-up standard needs. | Suggest or add with warning for broader impact. | Hint or require approval. |
| Regulated domains | Approved-but-off-by-default. | Approved-but-off-by-default. | Approved-but-off-by-default plus policy approval. |
| Machine store `~/.aih/` | Derived cache for convenience. | Derived cache; never team truth. | Derived cache projected from policy. |
| Package graph registry | Open governance data model. | Shared source of declared membership. | Signed/admin-authored projection. |
| Capability intent | Auto-add decisions where evidence supports them. | Commit shared intent; warn on broader impact. | Approval-required hints unless policy permits. |
| BetterDoc / docs-quality | Install through pack flow when approval exists. | Curate and validate as a named pack. | Seed only with repo-local approval evidence and policy fit. |
| `docs-lint` claim gate | Local public-doc check. | CI/review gate for public claims. | Release/evidence gate for public claims. |
| Truth sidecar | Optional local workflow. | Optional shared workflow with reviewed promotion. | Optional evidence workflow; stale packs fail closed. |

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
