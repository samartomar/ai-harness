# BetterDoc Invocation Examples

## Generic edit

```text
Use $betterdoc.

Edit this documentation for clarity, usefulness, and source-grounded accuracy.
Do not invent product, maturity, security, compliance, roadmap, customer, deployment, performance, license, or audit claims.
Preserve commands, paths, API names, config keys, code blocks, generated markers, diagrams, tables, and source-backed terminology.
Return the revised text plus a short meaning and evidence audit.
```

## README

```text
Use $betterdoc.

Improve README.md for first-time users. Keep the product identity, maturity status, quickstart commands, verification steps, and source-of-truth links accurate. Remove filler only after checking claims and completeness.
Return a unified diff and a short audit.
```

## API docs

```text
Use $betterdoc.

Review this API documentation for completeness and accuracy. Preserve endpoint names, parameters, request/response examples, auth requirements, error codes, versioning, and generated schema details. Flag missing evidence rather than inventing behavior.
```

## Generated OpenAPI or schema docs

```text
Use $betterdoc.

Improve the hand-authored explanation around this generated API/schema documentation. Preserve generated markers, field names, enum values, examples, defaults, and ordering. Flag stale generated output instead of manually correcting it unless source evidence proves the correction.
```

## Security docs

```text
Use $betterdoc.

Review this security documentation. Scope every assurance claim to the control, enforcement point, failure behavior, and evidence shown in the source. Remove unsupported compliance, certification, customer deployment, or formal audit language.
```

## Runbook

```text
Use $betterdoc.

Rewrite this runbook so an on-call engineer can execute it under pressure. Preserve commands exactly. Add placeholders or TODOs for missing expected outputs, rollback steps, or escalation paths instead of inventing them.
```

## Test or eval harness docs

```text
Use $betterdoc.

Review this test/eval documentation. Separate what the tests directly prove from what they only suggest. Preserve commands, fixture names, expected outputs, and known gaps. Do not convert test existence into broad product assurance.
```

## Migration guide

```text
Use $betterdoc.

Improve this migration guide. Preserve source and target versions, commands, config names, breaking changes, rollback steps, and verification checks. Flag missing compatibility or rollback information instead of inventing it.
```

## PR summary

```text
Use $betterdoc.

Turn this change list into a reviewer-friendly PR summary. Include what changed, why, affected files/components, verification performed, risks, migration notes, and open questions. Do not overstate test coverage.
```

## Product/customer copy

```text
Use $betterdoc.

Improve this customer-facing technical copy. Keep it confident but source-grounded. Explain value through mechanism and proof. Remove unsupported enterprise, production, compliance, security, customer, revenue, or certification claims.
```
