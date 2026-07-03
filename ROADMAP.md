# Roadmap

Where `aih` is going, at the theme level. Treat it as direction, not a commitment —
scope and order shift as we learn. There are no fixed dates; a release ships when its
milestone's scope is done ([versioning policy](VERSIONING.md)).

The machine-readable version of this map is **[GitHub Milestones](https://github.com/samartomar/ai-harness/milestones)**;
every roadmap item is an issue on one of them. Shipped work lives in the
[CHANGELOG](CHANGELOG.md) and [Releases](https://github.com/samartomar/ai-harness/releases).

## Themes

Four threads run through every release:

- **Stability** — a CLI surface and output contract an enterprise can pin to.
- **Supply chain & trust** — provenance, SBOM, and the trust gate for external skills/MCP.
- **Governance** — policy, secrets, and evidence an org can audit.
- **Breadth** — more CLIs, more languages, more of the workstation covered.

## Shipped

- **[v0.2.0](https://github.com/samartomar/ai-harness/releases/tag/v0.2.0)** — first npm
  release. `@aihq/harness` on npm via OIDC Trusted Publishing with build **provenance** +
  SPDX SBOM, the `aih trust` external-source gate, version-coherence CI, and the
  release-management surface (this roadmap, versioning + support policy, release runbook).
- **[v0.3.0](https://github.com/samartomar/ai-harness/releases/tag/v0.3.0)** /
  **[v0.3.1](https://github.com/samartomar/ai-harness/releases/tag/v0.3.1)** —
  first-developer experience. The **`aih ready`** readiness gate, **`aih prune`** for stale
  per-CLI artifacts (with `--delete` / `--unrunnable`), SARIF validated against the 2.1.0
  schema in CI ([#36](https://github.com/samartomar/ai-harness/issues/36)), plan-time reads
  pinned as ledgered probes ([#35](https://github.com/samartomar/ai-harness/issues/35)),
  and the licensing/disclaimer docs pass.
- **[v0.4.0](https://github.com/samartomar/ai-harness/releases/tag/v0.4.0)** /
  **[v0.4.1](https://github.com/samartomar/ai-harness/releases/tag/v0.4.1)** — the **skill
  lifecycle**: `aih skill vet` / `card` / `approve` / `inventory` / `remove`, the committed
  `aih-skills.lock.json` approval authority, posture-gated install enforcement in
  `aih workspace add`, and `aih skill quarantine`.
- **[v0.5.0](https://github.com/samartomar/ai-harness/releases/tag/v0.5.0)** — **skill
  packs**: the committed `aih-packs.json` curation manifest and the `aih pack` command
  group (status / validate / authoring / gated batch install / uninstall), plus the
  report's per-pack governance rollup.
- **[v0.6.0](https://github.com/samartomar/ai-harness/releases/tag/v0.6.0)** —
  marketplace + additive enterprise seams: `aih marketplace build` / `validate` /
  `publish`, the pluggable CommandSpec registry, policy-bundle validation, and
  evidence-bundle generation.
- **[v1.0.0](https://github.com/samartomar/ai-harness/releases/tag/v1.0.0)** /
  **[v1.0.1](https://github.com/samartomar/ai-harness/releases/tag/v1.0.1)** — the
  stability release and documentation repositioning pass: CLI / JSON / SARIF contract
  freeze, alias-before-removal policy, N-1 security backports, STABILITY.md, and the 1.0
  public-docs cleanup.
- **[v1.2.0](https://github.com/samartomar/ai-harness/releases/tag/v1.2.0)** —
  enterprise unblock and verification depth. This package release includes the completed
  v1.0.2, v1.1.0, and v1.2.0 roadmap milestones: claim hygiene, proxy-aware quarantined
  fetches, in-tree symlink containment, pinned SkillSpector execution, contract/report
  fixes, the enterprise review pack, codebase-memory-mcp catalog wiring,
  `aih verify-release`, generated JSON Schemas, run-ledger schemaVersion 2, SIEM
  guidance, and mcp-scanner detector support.

## Now

The v1.0.2, v1.1.0, and v1.2.0 milestones have no open issues. The next public roadmap
milestone will be opened after the release package is published and any follow-up from
the v1.2.0 rollout is triaged.

## Later — beyond 1.0

Directional. Nothing here is committed to a release yet.

- Corporate-trust propagation across more runtimes (git, Go, Docker, JVM, Gradle, Maven).
- Trust-gate deep-scan detectors beyond the first scanner.
- Broader language command routing for polyglot repos.

## How to influence it

- Comment on a [milestone](https://github.com/samartomar/ai-harness/milestones) issue, or
  open a new one with the `roadmap` label.
- See [CONTRIBUTING.md](CONTRIBUTING.md) to send a change, and [SUPPORT.md](SUPPORT.md) to
  ask a question.
