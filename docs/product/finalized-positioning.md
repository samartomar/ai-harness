# Finalized positioning

> Status: shipped public positioning for the open-source CLI. Source-backed by
> `README.md`, `docs/ARCHITECTURE.md`, and `docs/CONTROL_MATRIX.md`.

`aih` is a local TypeScript CLI for preparing developer workstations and
repositories for reviewable, governed AI-assisted coding. Its public position is
not "an AI platform" or a compliance product. It is a command surface that turns
setup, governance, reporting, and evidence capture into plans that can be
reviewed before local changes are applied.

## Reader

This document is for maintainers writing public docs, issue text, release notes,
or product summaries for `aih`.

## Short statement

Use this when a concise description is needed:

```text
aih is a cross-platform CLI that prepares developer workstations and repositories
for reviewable, governed AI-assisted coding. It uses dry-run plans, local
guardrails, repo canon, skill approval records, and offline report/evidence
artifacts to make agent-assisted development easier to inspect.
```

## What is shipped

The shipped open-source CLI includes these surfaces:

- Workstation and runtime checks for certificates, PATH, MCP pre-flight, VDI,
  hardware sizing, and readiness.
- Repo bootstrap for agent canon, stack profiling, command contracts, guardrails,
  MCP config, sandbox config, and secret-scan rules.
- Skill governance for external skills: `trust`, `skill`, `pack`,
  `marketplace`, `policy`, `evidence`, and release/bundle verification commands.
- Reporting and local telemetry: offline `aih report` artifacts, local
  `.aih/history.jsonl` tracking, and local `.aih/usage.jsonl` usage samples.
- A dry-run-first action model where managed writes wait for `--apply`.

## Trust and mutation boundaries

The normal action model is local. Plans can produce typed local actions such as
`write`, `remove`, `exec`, `envblock`, `probe`, `digest`, and `doc`.

Remote mutation is not a normal plan action. The documented carve-outs are
explicit provenance/signing flows: GitHub attestations can write to GitHub's
attestation store, and keyless cosign signing can append to Rekor.

The supported privacy wording is "no default phone-home" and "no hidden telemetry
transmission." Do not claim every command is offline-only: release verification,
source acquisition/trust flows, marketplace validation, cert probes, and signing
can invoke network-capable tools when the operator runs those commands.

## Skill-governance position

External skill sources are treated as untrusted until vetted, pinned, and
approved. The shipped governance loop is:

```text
vet -> card/approve -> pack -> marketplace/evidence
```

The approval authority is the committed root `aih-skills.lock.json` file. Pack
manifests and marketplace artifacts are derived from or cross-checked against
that approval record; they are not independent approval authorities.

## What not to claim

Do not describe `aih` as:

- certified, compliant, or formally audited;
- a warranty, SLA, support, indemnity, or consulting offering;
- an exploit scanner or attack platform;
- a guarantee that AI-generated code is safe;
- a hosted service;
- a replacement for repo-specific review, CI, or security ownership.

Prefer mechanism claims:

- "dry-run by default for managed project changes";
- "pack refs are cross-checked against `aih-skills.lock.json`";
- "reports are offline artifacts by default";
- "skill installs are approval-gated at team/enterprise posture";
- "normal plans do not include remote mutation actions."

## Source links

- [`README.md`](../../README.md)
- [`docs/ARCHITECTURE.md`](../ARCHITECTURE.md)
- [`docs/CONTROL_MATRIX.md`](../CONTROL_MATRIX.md)
