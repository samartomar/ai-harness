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
- **[v2.0.0](https://github.com/samartomar/ai-harness/releases/tag/v2.0.0)** —
  the verified mainline release train for the completed v1.3.1, v1.4.0, v1.5.0,
  v1.6.0, and v2.0.0 milestones. It shipped workspace federation hardening,
  enterprise MCP approval/compliance paths, repo capability resolve/cache, init v3
  bootstrap intelligence, session guardrails, and the structured verification
  substrate/bridge work used by trust, skill, doctor, workspace, and report flows.
- **[v2.1.0](https://github.com/samartomar/ai-harness/releases/tag/v2.1.0)** —
  local usage and skill-economy reporting plus governance/docs hardening: the
  `.aih/usage.jsonl` sink, per-tool usage capture hooks, Zed `threads.db` import,
  Claude skill attribution, stack-scoped dormant ECC skills, as-built design docs,
  ECC installer resolution, approved skill sync into CLI machine roots, and
  fail-closed posture/baseline parsing.

## Now

The v2.1.0 release is published. Current GitHub milestone state on July 7, 2026:

- Of the remaining unreleased follow-up milestones, v2.3.0 and v2.4.0 have no
  open issues.
- v2.2.0 remains open only for
  [#255](https://github.com/samartomar/ai-harness/issues/255), which requires a
  real `fetch-analytics.mjs --run` Admin API sample. That item is blocked until
  an operator manually fetches the sample in a secure environment with
  `ANTHROPIC_ADMIN_KEY`; the sample must not be fabricated or captured in
  automated CI.
- The v2.3.0 and v2.4.0 issue work is merged on `main`, but release packaging stays
  gated by the older v2.2.0 live-sample confirmation.

## Later

Directional. Nothing here is committed to a release yet.

- Continue broadening enterprise trust evidence, release provenance, and multi-CLI
  ergonomics through GitHub milestone issues.

## How to influence it

- Comment on a [milestone](https://github.com/samartomar/ai-harness/milestones) issue, or
  open a new one with the `roadmap` label.
- See [CONTRIBUTING.md](CONTRIBUTING.md) to send a change, and [SUPPORT.md](SUPPORT.md) to
  ask a question.
