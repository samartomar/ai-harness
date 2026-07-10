# ai-harness Docs

Design, spec, and plan docs for [aih](../README.md) — the user-facing overview and
one-line command surface live in the root README. Three kinds of doc live here: the
**command reference** ([commands.md](commands.md)) carries the long-form per-command
detail, **direction docs** carry a "design/proposed, not shipped" status note (tracked
in [ROADMAP.md](../ROADMAP.md)), and **specs / implementation plans** are build records
that carry their own status line.

## Reference

- [commands.md](commands.md) — the command reference: long-form behavior detail for
  every `aih` command plus the support-ticket contract, relocated from the README's
  command surface. Shipped.
- [ARCHITECTURE.md](ARCHITECTURE.md) — shipped component map, data boundaries, and
  write/remote-mutation model.
- [CONTROL_MATRIX.md](CONTROL_MATRIX.md) — public claim -> implementation -> test
  map, including posture grading and offline/no-default-phone-home boundaries.
- [THREAT_MODEL.md](THREAT_MODEL.md) — supported actors, assets, trust boundaries, and
  fail-closed expectations.
- [ENTERPRISE_ONBOARDING.md](ENTERPRISE_ONBOARDING.md) — enterprise rollout checklist,
  policy examples, and verification gates.

## Product

- [product/finalized-positioning.md](product/finalized-positioning.md) — shipped
  public positioning, claim boundaries, and wording guardrails for `aih`.
- [product/pack-manifest.md](product/pack-manifest.md) — the committed `aih-packs.json`
  curation manifest: schema, worked example, and the bump-pin → re-vet → re-approve →
  install flow. Shipped.
- [product/enterprise-extension-point.md](product/enterprise-extension-point.md) —
  shipped contract for the reserved `@aihq/enterprise` optional command-pack seam and
  local-only fallback.
- [product/enterprise-packaging-model.md](product/enterprise-packaging-model.md) —
  enterprise skill pack model; the earlier design exploration behind
  pack-manifest.md. Design/proposed.

## Workspace

- [workspace/workspace-report-rollup.md](workspace/workspace-report-rollup.md) —
  shipped parent-level workspace report digest, inputs, status vocabulary, and MCP
  scope checks.
- [workspace/workspace-contracts-and-snapshots.md](workspace/workspace-contracts-and-snapshots.md) —
  shipped `.aih-workspace.json` contract-edge and workspace snapshot behavior.
- [workspace/federated-bridge.md](workspace/federated-bridge.md) — federated bridge
  across disconnected repos, including parent-only defaults and recursive child-write opt-ins.

## Security and governance

- [security/skill-card-schema.md](security/skill-card-schema.md) — shipped committed
  skill-card schema and card/approve lifecycle.
- [security/approved-skills-lockfile.md](security/approved-skills-lockfile.md) —
  shipped `aih-skills.lock.json` approval authority and downstream enforcement model.
- [security/skill-trust-gate.md](security/skill-trust-gate.md) — vet, pin, and approve
  skills under policy. Design/proposed; the shipped surface is `aih trust` / `aih skill`
  in the root README.
- [security/skillspector.md](security/skillspector.md) — pinned local SkillSpector
  image workflow and review guidance.
- [security/baseline-evidence.md](security/baseline-evidence.md) — shipped exact-pin
  vendor/org component evidence for ECC and Superpowers installs.
- [security/release-slsa.md](security/release-slsa.md) — shipped SLSA v1.2 Build
  assessment for tagged release artifacts.
- [security/run-ledger-siem.md](security/run-ledger-siem.md) — run-ledger v2 field map
  and SIEM import recipe.

## Specs and implementation plans

Each carries its own status note.

- [specs/local-report-v9/SPEC.md](specs/local-report-v9/SPEC.md) — architecture of the
  `aih report --v9` developer-console dashboard;
  [CAPABILITIES.md](specs/local-report-v9/CAPABILITIES.md) — the read-only data digests
  behind its panels (implemented in `src/report/v9-panels.ts`);
  [DEMO-DATA.md](specs/local-report-v9/DEMO-DATA.md) — the `--demo` dataset.
- [specs/usage-metering/DESIGN.md](specs/usage-metering/DESIGN.md) — the `aih usage`
  capture layer. Implemented.
- [heal-plan.md](heal-plan.md) — the `aih heal` diagnose-and-repair plan. Implemented;
  §10 records as-built deviations.
- [analytics-report-plan.md](analytics-report-plan.md) — the `aih report` analytics
  dashboard plan. Shipped.
- [coverage/language-coverage.md](coverage/language-coverage.md) — language coverage
  matrix, generated from deterministic local fixtures.

## Research and design records

- [research/cli-coverage-matrix-plan.md](research/cli-coverage-matrix-plan.md) —
  implemented plan for the per-CLI coverage matrix + loadability validation.
- [research/deferred-analytics-tiers.md](research/deferred-analytics-tiers.md) —
  deferred Tier 2 shared-collector and Tier 3 hosted-SaaS analytics decision record.
- [research/external-skill-packs.md](research/external-skill-packs.md) — shipped
  as-built design note for external skill packs and `aih-packs.json` behavior.
- [research/fastmcp-vs-mcp-skills-over-mcp.md](research/fastmcp-vs-mcp-skills-over-mcp.md) —
  verified FastMCP 3.x vs official `mcp` SDK comparison for the skills-over-MCP
  decision context.
- [research/locked-skills-mcp-framework.md](research/locked-skills-mcp-framework.md) —
  framework/language decision for a future locked-skills MCP server.

## Roadmap

- [roadmap/workspace-and-skills-roadmap.md](roadmap/workspace-and-skills-roadmap.md) —
  workspace + skills build order. Design/proposed.
- [roadmap/docs-placement.md](roadmap/docs-placement.md) — where design docs live in
  this repo.
