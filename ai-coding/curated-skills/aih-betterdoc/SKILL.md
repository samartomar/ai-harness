---
name: aih-betterdoc
description: Create, edit, and review ai-harness public documentation with BetterDoc's claim-first, evidence-aware workflow. Use for README and website copy, quickstarts, reference docs, architecture and ADRs, security and assurance docs, runbooks, migration guides, changelogs, release notes, PR summaries, or any other public technical prose in this repository. Preserve technical artifacts, scope every claim to repository evidence, keep private companion material out of public text, and validate with the repository's direct documentation checks without running AIH against this checkout.
---

# BetterDoc (ai-harness)

This is the project-curated, CLI-neutral copy of the BetterDoc skill distributed
from `packs/docs-quality/aih-betterdoc/`. Load it through the repository's shared
canon routing. Do not create per-client copies or run AIH to install, refresh,
or validate it in this checkout.

BetterDoc improves documentation without weakening truth.

Use this skill when drafting, editing, reviewing, or restructuring public
technical or product documentation. It does not authorize new product claims,
private disclosures, implementation changes, publishing, or release actions.

## Repository profile

Before editing public documentation, read:

1. `ai-coding/rules/doc-and-truth-homes.md` for public/private truth routing.
2. `PUBLIC_DOCS_POLICY.md` for prohibited material and claims discipline.
3. The closest document-specific source of truth and the code, schemas, tests,
   generated artifacts, or CI evidence that support its claims.
4. `docs/CONTROL_MATRIX.md` when the document describes controls, enforcement,
   or evidence surfaces.

This repository is public. Never copy strategy, competitive analysis, pricing,
customer information, private roadmap sequencing, maintainer runbooks, private
repository references, or session handoff text from the private companion into
public documentation. Sanitize examples and label demo data as required by
`PUBLIC_DOCS_POLICY.md`.

Never hand-edit generated or byte-locked documentation. Edit its renderer or
source. Never run AIH against this checkout, including to lint, regenerate, or
project documentation. Use direct repository checks such as
`npm run docs:lint`, focused tests, and the validation commands named by the
changed document's owning code.

## Core rule

Do not trade correctness for smoothness.

A better document is:

1. true,
2. useful to the intended reader,
3. scoped to what the source supports,
4. easy to follow,
5. clear and concise.

Clean prose is not enough. A polished unsupported claim is worse than a rough
accurate sentence.

## Non-goals

BetterDoc is not:

- a branding authority,
- a product-renaming authority,
- a production-readiness authority,
- a compliance-certification authority,
- a roadmap generator,
- a hype generator,
- a license selector,
- a generic anti-AI-style cleaner.

Do not add claims, maturity status, security guarantees, customer proof,
compliance language, license terms, roadmap commitments, or product names
unless repository evidence supports them or the user explicitly provides them.

## Priority order

When rules conflict, use this order:

1. User's explicit instruction, within the repository's privacy, safety, and
   external-action boundaries.
2. Current repository facts and source material.
3. Safety, security, legal, privacy, and compliance accuracy.
4. Document type and reader task.
5. Project-specific policy, style, terminology, and truth homes.
6. Claim preservation and evidence scope.
7. Information architecture and usability.
8. Plain, concise prose.
9. Anti-slop style lint.

Style lint never overrides source truth.

## Source-grounded rule

Use the supplied text, nearby repository context, linked source files, tests,
CI output, committed docs, API schemas, generated docs, runbooks, product
requirements, issue or PR context, and user-provided facts as source material.

Do not fill gaps with plausible implementation details.

When support is missing:

- omit the claim,
- weaken the claim,
- label it as planned, assumed, unknown, or user-provided,
- or flag it as an open question.

## Conflict resolution

Do not smooth over conflicting sources. Prefer, in order:

1. Current source code, schemas, tests, generated artifacts, CI output, release
   artifacts, or reproducible direct repository commands.
2. Current committed docs, ADRs, runbooks, deployment manifests, or evidence
   bundles.
3. Current issue or PR descriptions.
4. Older docs, stale issue comments, or historical notes.
5. User-provided facts.
6. Assumptions.

If user-provided facts conflict with repository source, use the user's fact
only when the user explicitly asks you to treat it as authoritative. Otherwise,
flag the conflict. Keep versioned claims scoped to the version, environment, or
release named by the source.

## Editing workflow

### 1. Classify the document

Identify the document type before editing. Use `references/doc-types.md` for
document-specific requirements. Do not force one tone or structure onto every
document.

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
- Evidence: What repository source supports it?
- Scope: Where, when, and for whom is it true?
- Status: implemented, tested, deployed, runtime-verifiable, documented,
  local-only, prototype/POC, beta, experimental, planned, deprecated, unknown,
  user-provided, assumed, or aspirational.
- Risk: What happens if this claim is weakened, broadened, or overstated?
- Action: preserve, scope, remove, replace, flag, or ask for source.

Use `references/claim-ledger.md` for the template and examples. Preserve claims
that matter. Remove or label claims that are not supported.

### 4. Check completeness

Before polishing, verify:

- the intended reader is clear,
- prerequisites are named when needed,
- commands, API paths, file paths, config names, schema names, and examples are
  preserved exactly,
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

Make the writing direct, specific, concise, scannable, consistent,
reader-oriented, and technically precise. Cut filler, vague drama, repeated
claims, needless modifiers, and business jargon.

### 7. Run bounded anti-slop lint

Apply `references/slop-lint.md` only after the meaning, evidence,
artifact-preservation, and completeness passes.

Do not mechanically delete precise technical words, scoped absolutes, useful
passive voice, canonical thesis language, hedges that reflect evidence limits,
or required terminology.

### 8. Verify final text

Before delivering, check:

- Did any claim become broader than repository evidence supports?
- Did any true claim get weakened by smoothing?
- Did any maturity, security, compliance, deployment, performance, customer,
  or roadmap status change?
- Did commands, paths, code, field names, links, generated markers, diagrams,
  tables, callouts, and examples remain intact?
- Did any public text expose private-companion material?
- Does the document help the reader complete the task?
- Did the applicable direct repository documentation checks pass?

## Claim and maturity rules

Do not add architecture, deployment, security, compliance, performance,
roadmap, customer, funding, production-readiness, market-positioning, legal,
license, or audit claims without source support. Preserve current product,
component, command, and surface names unless the source or user explicitly
requests a rename.

Keep claims scoped. Prefer:

```md
[Specific component/control] does [specific behavior] under [specific condition], with [specific evidence/output].
```

Preserve distinctions among production, deployed, tested, runtime-verifiable,
documented, local-only, prototype, proof of concept, beta, experimental,
planned, deprecated, historical, and unknown. Test existence proves the tested
assertion, not broad product maturity.

Do not imply formal compliance, certification, audit completion, legal
assurance, customer deployment, production hardening, or supply-chain
assurance unless current repository evidence explicitly supports it. Follow
the stricter banned-claim list in `PUBLIC_DOCS_POLICY.md`.

## Technical artifact preservation

Do not rewrite these unless explicitly asked or repository evidence proves the
artifact is wrong:

- commands and flags,
- API routes and URLs,
- package, file, and branch names,
- environment variables and config keys,
- schema fields and error codes,
- code examples and generated markers,
- diagram source blocks,
- version numbers and CLI output,
- SQL, YAML, JSON, and TOML blocks.

Use `references/artifact-preservation.md` for generated content, diagrams,
tables, callouts, code, and command blocks. If generated output appears stale,
flag it and route the change to its source or renderer.

## Output contract

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
5. missing evidence or documentation gaps.

If creating new documentation, return:

1. the new draft,
2. source assumptions,
3. verification checklist,
4. suggested next source links or tests to add.

Keep audits short unless the user asks for a deep review.

## Quick invocation

```text
Use $aih-betterdoc.

Edit this ai-harness documentation for clarity, usefulness, and source-grounded accuracy.
Follow PUBLIC_DOCS_POLICY.md and ai-coding/rules/doc-and-truth-homes.md.
Do not invent product, maturity, security, compliance, roadmap, customer, deployment, performance, license, or audit claims.
Preserve commands, paths, API names, config keys, code blocks, generated markers, diagrams, tables, and source-backed terminology.
Return the revised text or diff plus a short meaning and evidence audit.
```
