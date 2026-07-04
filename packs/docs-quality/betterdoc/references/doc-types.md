# Document Type Patterns

Use document type to choose structure, not just tone.

## README

A README should answer:

- What is this?
- Who is it for?
- What problem does it solve?
- What is the fastest safe way to try it?
- How do I verify it worked?
- Where are the deeper docs?
- What is the current maturity/status?

Good README traits:

- direct opening,
- quickstart before deep architecture,
- copy-pasteable commands,
- clear source-of-truth links,
- honest maturity language,
- minimal marketing filler.

## Quickstart

A quickstart should get a qualified reader to first value quickly.

Include:

- prerequisites,
- install/setup,
- first successful command or API call,
- expected output,
- verification step,
- cleanup or next step.

Avoid optional architecture, advanced deployment, or historical background before first value.

## Tutorial

A tutorial teaches through a guided path.

Include:

- learning goal,
- assumptions,
- safe sample data,
- step-by-step flow,
- expected result after each major step,
- explanation only when it helps the learner continue.

## How-To Guide

A how-to helps an already-oriented reader complete a task.

Include:

- task outcome,
- prerequisites,
- steps,
- expected output,
- troubleshooting,
- rollback or cleanup when relevant.

Do not turn a how-to into a conceptual essay.

## API Reference

API reference should be complete and predictable.

Include:

- endpoint or method name,
- purpose,
- authentication/authorization requirements,
- parameters,
- request body,
- response body,
- status/error codes,
- examples,
- rate limits or pagination if relevant,
- versioning or deprecation notes.

Preserve field names exactly.

## Generated API Docs / OpenAPI / Swagger

Generated API docs are source-shaped artifacts, not marketing copy.

Include or preserve:

- generator/source note when present,
- schema version,
- endpoint and method names,
- request/response schemas,
- examples,
- auth requirements,
- error models,
- deprecation/versioning notes.

Edit surrounding prose. Do not manually rewrite generated schema names, field names, enums, defaults, or examples unless the source proves they are wrong.

## Schema / Data Model Docs

Schema docs explain contracts.

Include:

- schema purpose,
- entity/object names,
- field names and types,
- required vs optional fields,
- defaults,
- constraints,
- examples,
- versioning and migration notes,
- source of truth.

Avoid inventing business rules from field names alone.

## Architecture / Explanation

Architecture docs explain why the system is shaped as it is.

Include:

- problem/context,
- major components,
- boundaries and trust assumptions,
- data/control flow,
- diagrams when useful,
- tradeoffs,
- alternatives considered when known,
- operational implications,
- links to implementation.

For diagrams, state whether they are illustrative, current-state, target-state, or normative.

## ADR / Design Decision

Include:

- status,
- context,
- decision,
- consequences,
- alternatives,
- migration or rollback notes.

Do not rewrite an accepted decision into a vague explanation.

## Runbook / Operations

Runbooks must be executable under pressure.

Include:

- symptoms,
- severity/impact,
- prerequisites and access,
- diagnostic commands,
- expected outputs,
- remediation steps,
- rollback/restore path,
- verification,
- escalation.

Avoid poetic or marketing language.

## Security / Assurance

Security docs should be scoped, precise, and evidence-oriented.

Include:

- threat or risk,
- control,
- enforcement point,
- denied/allowed condition,
- failure behavior,
- audit/log evidence,
- known limitations,
- residual risk,
- operational ownership.

Avoid unsupported blanket assurances.

## SECURITY.md / Vulnerability Disclosure

A vulnerability disclosure doc is a process contract.

Include:

- supported versions,
- how to report vulnerabilities,
- what information reporters should include,
- expected acknowledgement/response process if source-backed,
- safe harbor language only if source-approved,
- disclosure/coordinated-release expectations,
- security update channels.

Do not invent legal safe harbor, SLA, bounty, certification, or disclosure commitments.

## Deployment / IaC Docs

Deployment docs and infrastructure-as-code docs should be operationally precise.

Include:

- supported environments,
- prerequisites,
- required secrets/config,
- plan/apply/deploy commands,
- expected outputs,
- rollback/destroy steps,
- environment boundaries,
- cost or scaling notes only when source-backed.

Preserve Terraform, CDK, Helm, Docker Compose, YAML, and environment-variable names exactly.

## Test Strategy / Eval Harness Docs

Test and eval docs should explain what is proven and what is not.

Include:

- test/eval purpose,
- command to run,
- expected result,
- fixtures/data used,
- assertion scope,
- coverage limits,
- known gaps,
- CI or artifact links when available.

Do not convert test existence into broad product proof.

## Troubleshooting

Include:

- symptom,
- likely cause,
- diagnostic command/check,
- fix,
- verification,
- escalation path.

## Incident Postmortem

A postmortem explains what happened and how recurrence risk changes.

Include:

- date/time and detection path,
- impact,
- timeline,
- contributing factors,
- what worked,
- what failed,
- corrective actions,
- owners and follow-up status.

Avoid blame language and unsupported root-cause certainty.

## Migration / Upgrade Guide

A migration guide helps users change safely.

Include:

- who must migrate,
- supported source and target versions,
- breaking changes,
- prerequisites,
- step-by-step migration,
- verification,
- rollback path,
- compatibility notes,
- known issues.

Do not hide breaking changes in release-note prose.

## CONTRIBUTING / Governance

Contributor and governance docs set project expectations.

Include:

- contribution workflow,
- branch/PR expectations,
- test and lint requirements,
- review/approval process,
- issue triage rules,
- code of conduct or DCO/CLA only if source-backed,
- release authority if source-backed.

Do not invent legal contributor terms.

## PR Summary

A PR summary should help reviewers.

Include:

- what changed,
- why,
- files/components affected,
- verification performed,
- risk/migration notes,
- screenshots or examples when useful,
- open questions.

Do not overstate test coverage.

## Changelog

A changelog is a chronological source/history record.

Include:

- version/date,
- added,
- changed,
- fixed,
- deprecated,
- removed,
- security,
- migration notes when relevant.

Use source-backed dates and versions. Do not use release-note marketing tone.

## Release Notes

Release notes are user-facing change communication.

Include:

- who should care,
- user-visible changes,
- upgrade instructions,
- breaking changes,
- deprecations,
- known issues,
- verification or rollback notes.

Avoid internal implementation detail unless it affects users.

## Prompt / Agent / Tooling Operation Docs

Agent and tooling docs should make behavior and boundaries explicit.

Include:

- target tool or agent,
- invocation pattern,
- allowed inputs,
- prohibited actions,
- source-of-truth files,
- safety or review gates,
- expected outputs,
- failure/hand-off behavior.

Do not claim model behavior is deterministic unless the source proves an enforced boundary.

## Website / Product Page

Lead with:

- audience,
- problem,
- outcome,
- mechanism,
- proof/evidence,
- limits or fit.

Confident is fine. Unsupported hype is not.

## Customer / Investor Technical Copy

Keep:

- strategic framing,
- mechanism,
- proof points,
- honest status,
- boundaries.

Avoid unsupported customer, revenue, compliance, traction, production, security, or certification claims.
