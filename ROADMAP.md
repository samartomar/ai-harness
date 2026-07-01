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

## Now — [v0.3.0](https://github.com/samartomar/ai-harness/milestone/2)

- **First-developer readiness gate** — a single "ready for the first task" verdict over
  runnable CLIs, active hooks, secrets verification, quality commands, and app blockers.
- **`aih prune`** — preview and remove stale canon, adapters, and hooks when a CLI is no
  longer targeted.
- SARIF validated against the 2.1.0 schema in CI ([#36](https://github.com/samartomar/ai-harness/issues/36)).
- `plan()` purity — plan-time reads modeled as ledgered probes ([#35](https://github.com/samartomar/ai-harness/issues/35)).

## Next — [v1.0.0](https://github.com/samartomar/ai-harness/milestone/3)

- **1.0 stability** — freeze the CLI surface and output contract so an enterprise can pin
  to it; begin N-1 security backports; enforce the deprecation policy.

## Later — beyond 1.0

Directional. Nothing here is committed to a release yet.

- Corporate-trust propagation across more runtimes (git, Go, Docker, JVM, Gradle, Maven).
- Trust-gate deep-scan detectors beyond the first scanner; `aih skill inventory`.
- Broader language command routing for polyglot repos.

## How to influence it

- Comment on a [milestone](https://github.com/samartomar/ai-harness/milestones) issue, or
  open a new one with the `roadmap` label.
- See [CONTRIBUTING.md](CONTRIBUTING.md) to send a change, and [SUPPORT.md](SUPPORT.md) to
  ask a question.
