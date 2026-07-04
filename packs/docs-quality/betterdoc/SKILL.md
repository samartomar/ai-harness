---
name: betterdoc
description: Edit, review, and create source-grounded technical and product documentation for common use across software projects. Use for READMEs, quickstarts, API and SDK docs, generated API docs, schema/data model docs, tutorials, how-to guides, runbooks, architecture docs, ADRs, security/assurance docs, SECURITY.md, deployment/IaC docs, test or eval docs, migration guides, incident postmortems, PR summaries, changelogs, release notes, website copy, and enterprise/customer-facing technical prose. Replaces generic anti-slop passes with a claim-first, evidence-aware documentation workflow.
---

# BetterDoc

BetterDoc improves documentation without weakening truth.

Use this skill when drafting, editing, reviewing, or restructuring technical/product documentation. It is intentionally common-use: it does not assume a specific repository, product, maturity level, architecture, brand, or governance model.

## Core Rule

Do not trade correctness for smoothness.

A better document is:

1. true,
2. useful to the intended reader,
3. scoped to what the source supports,
4. easy to follow,
5. clear and concise.

Clean prose is not enough. A polished unsupported claim is worse than a rough accurate sentence.

## Non-Goals

BetterDoc is not:

- a branding authority,
- a product-renaming authority,
- a production-readiness authority,
- a compliance-certification authority,
- a roadmap generator,
- a hype generator,
- a license selector,
- a generic anti-AI-style cleaner.

Do not add claims, maturity status, security guarantees, customer proof, compliance language, license terms, roadmap commitments, or product names unless the source supports them or the user explicitly provides them.

## Priority Order

When rules conflict, use this order:

1. User's explicit instruction.
2. Source material and repository facts.
3. Safety, security, legal, and compliance accuracy.
4. Document type and reader task.
5. Project-specific style or terminology, when present in the source.
6. Claim preservation and evidence scope.
7. Information architecture and usability.
8. Plain, concise prose.
9. Anti-slop style lint.

Style lint never overrides source truth.

## Source-Grounded Rule

Use the supplied text, nearby repository context, linked source files, tests, CI output, committed docs, API schemas, generated docs, runbooks, product requirements, issue/PR context, and user-provided facts as source material.

Do not fill gaps with plausible implementation details.

When support is missing:

- omit the claim,
- weaken the claim,
- label it as planned, assumed, unknown, or user-provided,
- or flag it as an open question.

## Conflict Resolution Rule

Do not smooth over conflicting sources.

Use this default order when sources disagree:

1. Current source code, schemas, tests, generated artifacts, CI output, or reproducible commands.
2. Current committed docs, ADRs, runbooks, deployment manifests, or release artifacts.
3. Current issue/PR descriptions.
4. Older docs, stale issue comments, or historical notes.
5. User-provided facts.
6. Assumptions.

If user-provided facts conflict with repository source, use the user's fact only when the user explicitly asks you to treat it as authoritative. Otherwise, flag the conflict.

For versioned docs, keep claims scoped to the version, environment, or release named by the source. Do not merge v1/v2 behavior unless the source says both apply.

## Project Profile Rule

BetterDoc can use a project-specific profile if one is present or provided by the user, such as:

- `STYLE.md`,
- `CONTRIBUTING.md`,
- `AGENTS.md`,
- `CLAUDE.md`,
- `docs/README.md`,
- a brand guide,
- a documentation canon,
- a glossary,
- an architecture decision record.

Treat project-specific terms as source-backed only for that project. Do not carry them into other projects unless the new source also supports them.

Project profiles are preservation inputs, not invention licenses.

## Editing Workflow

Use this sequence.

### 1. Classify the document

Identify the document type before editing. Common types include:

- README,
- quickstart,
- tutorial,
- how-to guide,
- API reference,
- SDK/reference docs,
- generated API docs,
- OpenAPI/Swagger docs,
- schema/data model docs,
- architecture/explanation,
- ADR/design doc,
- runbook/operations doc,
- security/assurance doc,
- `SECURITY.md` or vulnerability disclosure doc,
- deployment/IaC doc,
- test strategy or eval harness doc,
- admin/operator guide,
- troubleshooting guide,
- incident postmortem,
- migration/upgrade guide,
- `CONTRIBUTING.md` or governance doc,
- PR summary,
- changelog,
- release notes,
- website/product page,
- investor/customer-facing technical copy,
- prompt, agent, or tooling operation guidance.

Use `references/doc-types.md` for document-specific requirements.

Do not use one tone or structure for all docs.

### 2. Identify the reader and task

Ask:

- Who is the reader?
- What are they trying to do?
- What must they know before they start?
- What should they be able to verify after reading?
- What could go wrong if the wording is too vague, too strong, or incomplete?

### 3. Build a claim ledger

For each meaningful claim, identify:

- Claim: What does the text assert?
- Evidence: What source supports it?
- Scope: Where, when, and for whom is it true?
- Status: implemented, tested, deployed, runtime-verifiable, documented, local-only, prototype/POC, beta, experimental, planned, deprecated, unknown, user-provided, assumed, or aspirational.
- Risk: What happens if this claim is weakened, broadened, or overstated?
- Action: preserve, scope, remove, replace, flag, or ask for source.

Use `references/claim-ledger.md` for the template and examples.

Preserve claims that matter. Remove or label claims that are not supported.

### 4. Check completeness

Before polishing, check whether the section still works as documentation.

Verify:

- intended reader is clear,
- prerequisites are named when needed,
- commands, API paths, file paths, config names, schema names, and examples are preserved exactly,
- examples are executable or clearly illustrative,
- generated markers and generated content boundaries are preserved,
- diagrams, captions, tables, and callouts match the source,
- links and references point to the right concept,
- status labels remain precise,
- the section answers the reader's likely next question,
- failure modes or troubleshooting pointers exist when the task can fail.

Do not invent missing implementation details. Flag missing context.

### 5. Improve structure

Prefer this order when it fits:

1. What this is.
2. Who it is for.
3. What problem it solves or task it supports.
4. How it works at a useful level of detail.
5. How to use or verify it.
6. Boundaries, limits, risks, or maturity status.
7. Where to go next.

For task docs, lead with the outcome and then the steps.

### 6. Edit prose

Make the writing:

- direct,
- specific,
- concise,
- scannable,
- consistent,
- reader-oriented,
- technically precise.

Cut filler, vague drama, repeated claims, needless modifiers, and business jargon.

### 7. Run bounded anti-slop lint

Apply the anti-slop rules in `references/slop-lint.md` only after the meaning and completeness passes.

Do not mechanically delete precise technical words, scoped absolutes, useful passive voice, canonical thesis language, hedges that reflect evidence limits, or required terminology.

### 8. Verify final text

Before delivering, check:

- Did any claim become broader than the source supports?
- Did any true claim get weakened by smoothing?
- Did any maturity, security, compliance, deployment, performance, customer, or roadmap status change?
- Did commands, paths, code, field names, links, generated markers, diagrams, tables, callouts, and examples remain intact?
- Does the doc help the reader complete the task?

## No-Invention Rule

Do not add architecture, deployment, security, compliance, performance, roadmap, customer, funding, production-readiness, market-positioning, legal, license, or audit claims unless they are present in source material or explicitly provided by the user.

Do not replace one product name with another unless the source or user explicitly requests the rename.

Do not upgrade maturity language. Do not downgrade maturity language. Preserve what the source proves.

## Scope Rule

Keep claims scoped.

Avoid broad claims like:

```md
The platform is fail-closed.
```

Prefer scoped claims when supported:

```md
Runtime authorization fails closed when the required audience is missing.
```

Avoid broad claims like:

```md
The system is compliant.
```

Prefer mechanism claims when supported:

```md
The system records approval events in the audit log.
```

The general pattern:

```md
[Specific component/control] does [specific behavior] under [specific condition], with [specific evidence/output].
```

## Maturity Rule

Maturity wording must be source-grounded.

Preserve distinctions among:

- production,
- deployed,
- tested,
- runtime-verifiable,
- documented,
- live in dev/staging,
- prototype,
- proof of concept,
- local-only,
- beta,
- experimental,
- planned,
- deprecated,
- historical,
- unknown.

Do not import maturity language from examples. Do not call something production, prototype, enterprise-ready, not deployed, or planned unless the source supports that status.

## Compliance and Assurance Guardrail

Do not imply formal compliance, certification, audit completion, legal assurance, customer deployment, production hardening, or supply-chain assurance unless the source explicitly supports it.

Avoid unsupported phrases such as:

- compliant,
- certified,
- enterprise-grade,
- production-proven,
- battle-tested,
- SOC 2-ready,
- HIPAA-compliant,
- SLSA-compliant,
- zero-risk,
- secure by default,
- fully audited,
- guaranteed.

Prefer precise mechanism language:

- audit log,
- approval record,
- authentication check,
- authorization boundary,
- schema validation,
- policy decision,
- encryption at rest,
- TLS/mTLS where source-backed,
- redaction behavior,
- retention policy,
- rollback path,
- least-privilege role,
- allowlist/denylist behavior,
- SBOM,
- provenance,
- signed release artifact,
- checksum verification.

## Technical Artifact Preservation

Do not rewrite these unless explicitly asked:

- commands,
- flags,
- API routes,
- URLs,
- package names,
- file paths,
- branch names,
- environment variables,
- schema fields,
- config keys,
- error codes,
- code examples,
- generated markers,
- diagram source blocks,
- version numbers,
- CLI output,
- SQL queries,
- YAML/JSON/TOML blocks.

When editing around a technical artifact, preserve the artifact exactly and improve only the surrounding explanation.

Use `references/artifact-preservation.md` for generated content, diagrams, tables, and callouts.

## Generated, Visual, and Tabular Artifacts

Generated docs, diagrams, tables, and callouts are documentation artifacts, not decorative text.

Default rules:

- Do not rewrite generated sections unless explicitly asked.
- Preserve generated markers and source-of-truth comments.
- Preserve Mermaid, PlantUML, OpenAPI, JSON Schema, protobuf, GraphQL, SQL, and config syntax unless asked to edit it.
- Verify captions and surrounding prose against the artifact.
- Improve table headers and grouping, but do not invent missing cells.
- Keep `Note`, `Warning`, `Important`, and `Tip` blocks scoped to the evidence.

## Protected-Term Density

Protected terms preserve meaning; they are not keywords to stuff.

Use the minimum number of domain terms needed to keep the claim precise. If two terms make the same claim, keep the more specific one and remove the duplicate.

Bad:

```md
The deterministic governed secure policy-enforced runtime control plane provides mandatory auditable controls.
```

Better:

```md
The runtime enforces policy decisions before executing protected actions.
```

## Output Contract

Return the artifact the user requested.

If editing a file or section, return:

1. the revised text or unified diff,
2. a short meaning audit,
3. an evidence/scope audit when claims changed or could be risky,
4. assumptions or open questions.

If reviewing without rewriting, return:

1. verdict,
2. material risks,
3. suggested edits,
4. claim-preservation notes,
5. missing evidence or doc gaps.

If creating new documentation, return:

1. the new draft,
2. source assumptions,
3. verification checklist,
4. suggested next source links or tests to add.

Keep audits short unless the user asks for a deep review.

## Meaning Audit Format

```md
### Meaning audit

**What got clearer**
- ...

**Claims preserved or scoped**
- ...

**Unsupported claims removed or flagged**
- ...

**Tradeoffs / assumptions**
- ...
```

## Quick Invocation

```text
Use $betterdoc.

Edit this documentation for clarity, usefulness, and source-grounded accuracy.
Do not invent product, maturity, security, compliance, roadmap, customer, deployment, performance, license, or audit claims.
Preserve commands, paths, API names, config keys, code blocks, generated markers, diagrams, tables, and source-backed terminology.
Return the revised text or diff plus a short meaning and evidence audit.
```
