# Changelog

## v0.2.0 - Corrected Skill Draft

### Added

- Claim ledger reference with template, status labels, conflict rules, and worked example.
- Artifact preservation reference for generated docs, diagrams, tables, callouts, and technical blocks.
- Before/after examples showing scope preservation, generated-content handling, and changelog vs. release-note distinction.
- Document type coverage for generated API docs, OpenAPI/Swagger, schema/data model docs, `SECURITY.md`, deployment/IaC docs, test/eval docs, incident postmortems, migration guides, contributing/governance docs, and prompt/agent/tooling operation docs.

### Changed

- Expanded the skill description and classification workflow to cover modern documentation types without making the skill project-specific.
- Made the claim ledger operational with explicit status, scope, risk, and action fields.
- Added conflict-resolution rules for code/tests/generated artifacts vs. stale docs, issue comments, user-provided facts, and assumptions.
- Tightened evidence guidance for indirect evidence, PII/data protection, supply chain, performance, scalability, multi-tenancy, and best-effort subsystems.
- Refined anti-slop rules for passive voice, technical qualifiers, calibrated hedging, lists/tables/prose, and callouts.
- Aligned the quick invocation text across `SKILL.md`, `README.md`, and invocation examples.
- Documented the shipped Apache-2.0 license file in the pack README.

### Not Added

- No strict/pragmatic mode split was added; the skill now uses explicit claim status labels instead.
