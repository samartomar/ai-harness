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

## Product

- [product/pack-manifest.md](product/pack-manifest.md) — the committed `aih-packs.json`
  curation manifest: schema, worked example, and the bump-pin → re-vet → re-approve →
  install flow. Shipped.
- [product/enterprise-packaging-model.md](product/enterprise-packaging-model.md) —
  enterprise skill pack model; the earlier design exploration behind
  pack-manifest.md. Design/proposed.

## Workspace

- [workspace/federated-bridge.md](workspace/federated-bridge.md) — federated bridge
  across disconnected repos. Design/proposed.

## Security and governance

- [security/skill-trust-gate.md](security/skill-trust-gate.md) — vet, pin, and approve
  skills under policy. Design/proposed; the shipped surface is `aih trust` / `aih skill`
  in the root README.

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
- [research/cli-coverage-matrix-plan.md](research/cli-coverage-matrix-plan.md) —
  plan for the per-CLI coverage matrix + loadability validation.
- [coverage/language-coverage.md](coverage/language-coverage.md) — language coverage
  matrix, generated from deterministic local fixtures.

## Roadmap

- [roadmap/workspace-and-skills-roadmap.md](roadmap/workspace-and-skills-roadmap.md) —
  workspace + skills build order. Design/proposed.
- [roadmap/docs-placement.md](roadmap/docs-placement.md) — where design docs live in
  this repo.
