# aih Architecture

> Status: shipped architecture for the open-source CLI. Directional ideas live in
> separate design docs and must not be read as shipped behavior.

`aih` is a local TypeScript CLI that turns repo/workstation setup into reviewed,
repeatable plans. The implementation is intentionally boring: each capability
exports a command spec, the command registry applies shared flags and posture,
and the executor is the only layer that performs filesystem or process effects.

## Component Map

- **Command registry** (`src/commands/`) wires built-in command specs, shared
  flags, posture, JSON envelope handling, and the run ledger.
- **Planner/executor** (`src/internals/`) turns capability plans into typed
  actions (`write`, `remove`, `exec`, `envblock`, `probe`, `digest`, `doc`) and
  applies them transactionally.
- **Repo canon** (`src/bootstrap-ai/`, `src/contract/`, `src/profile/`) detects
  the stack, writes tool bootloaders, and emits `ai-coding/project.json`.
- **Project truth** (`src/truth/`) owns the opt-in external sidecar, token-bounded
  truth packs, drift verification, acceptance preflight, and declarative
  agent-evidence file probes.
- **Trust and skill governance** (`src/trust/`, `src/skill/`, `src/pack/`,
  `src/marketplace/`) vets external skill sources, pins commits, records
  approvals, and blocks unapproved installs at team/enterprise posture.
- **Policy and schemas** (`src/org-policy/`, `src/config/`, `schemas/`) validate
  committed org policy and bootstrap markers.
- **Evidence and release verification** (`src/evidence/`, `src/bundle/`,
  `src/release/`) package local audit material and verify published releases.
- **Reporting and local telemetry** (`src/report/`, `src/logging/`,
  `src/usage/`) render local diagnostics. They do not transmit prompts or costs.

## Data Boundaries

- `.aih-config.json`, `ai-coding/`, lock files, `aih-capabilities.json`, and
  policy files are committed repo state.
- `.aih/` is local diagnostics and generated output. The run ledger under
  `.aih/runs/YYYY-MM.jsonl` is gitignored and should be shared through
  `aih evidence build` when tamper evidence is needed.
- Optional project-truth sidecars live outside the repository by default
  (sibling `<repo>-ai`). The repo carries only the sidecar pointer and code
  binding; staged truth packs stay outside committed source until a human
  promotes any repo-owned change.
- `~/.aih/capabilities/cache.json` is a machine-local derived cache of repo
  capability needs. It is rebuildable from committed repo manifests and policy;
  deleting it loses convenience state, not authority.
- `.env*` and `secrets/**` are denied inputs. Agents must not read or log them;
  validate presence with `aih secrets --verify`.
- External skill sources are treated as hostile until vetted, pinned, and
  approved. A same-named skill from a different source never inherits approval.

## Mutation Model

Dry runs are the default for managed project changes. Under `--apply`, the
executor can write local files, remove local files through guarded actions, run
local commands, emit shell environment blocks, compute digests, run read-only
probes, and print operator-run docs.

Remote mutation is outside the normal action model. The only explicit exceptions
are provenance paths: GitHub attestations can write to GitHub's attestation
store, and keyless cosign signing can append to Rekor. Cloud, SSO, MDM,
gateway, and observability-backend setup remains `doc` output for a human.

## Optional Extensions

The only optional peer package the open-source CLI probes for is
`@aihq/enterprise`, by literal name from the install tree that loaded `aih`.
It is a reserved extension point for additive enterprise `CommandSpec` commands;
the contract and fallback are defined in
[product/enterprise-extension-point.md](product/enterprise-extension-point.md).
Not installed means local-only behavior.

MCP configuration is generated per supported CLI. MCP servers are never loaded
just-in-case by the CLI; they are emitted into tool-specific config for the
operator's AI coding tool to use.

ECC registration is component-scoped even though upstream installation is module-shaped.
`scanRepo` and repeatable `--with` declarations contribute project intent; aih resolves those
components to verified module paths, filters generated operations at leaf granularity, and installs
the additive machine union. `~/.aih/ecc/registration-ledger.json` is the single carved-out primary
machine store because a deleted project cannot report its former contribution; installed capability
content remains derived and recomputable. Project-local MCP files receive the current project's set,
while global target files receive the machine union. The ledger is committed after the sequential
install driver, never before it. `aih prune` is the inverse: it classifies registered roots without
following links, reduces the live union, and filters only operations claimed by strict target install
state. A local transaction driver revalidates planned hashes and contained regular-file paths,
backs up every changed file, writes target states, and commits the primary ledger last; any earlier
failure restores the prior bytes. User-owned config and components still shared by a live project
remain outside the removal set. Whole-target uninstall actions remain authoritative for dropped
CLIs, and an uninstall failure blocks the dependent ledger transaction.

## Release Integrity

Published releases use npm trusted publishing, GitHub release assets, SPDX SBOMs,
checksums, a keyless cosign bundle for `SHA256SUMS.txt`, and GitHub build
provenance. Tagged release artifacts claim SLSA Build L2 under the SLSA v1.2
Build track; the evidence map and the Build L3 gap are documented in
[security/release-slsa.md](security/release-slsa.md). Operators can run
`aih verify-release [version]` to verify npm signatures, the GitHub release
cosign bundle, and the npm tarball hash, and can verify the release provenance
attestation with `gh attestation verify`.
