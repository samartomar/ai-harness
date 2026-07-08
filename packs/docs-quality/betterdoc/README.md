# BetterDoc Skill

BetterDoc is a common-use documentation skill for source-grounded technical and product writing.

It replaces generic anti-slop editing with a claim-first workflow:

1. classify the document,
2. identify the reader task,
3. build a claim ledger,
4. check completeness,
5. improve structure,
6. edit prose,
7. run bounded anti-slop lint,
8. verify claims, scope, and artifacts.

It does not assume a particular product, repo, brand, maturity level, architecture, license, or governance model.

## Files

```text
packs/docs-quality/betterdoc/
├── SKILL.md
├── README.md
├── CHANGELOG.md
├── examples/
│   ├── before-after.md
│   └── invocations.md
└── references/
    ├── artifact-preservation.md
    ├── audit-output.md
    ├── claim-ledger.md
    ├── doc-types.md
    ├── evidence-and-scope.md
    └── slop-lint.md
```

## Recommended default prompt

```text
Use $betterdoc.

Edit this documentation for clarity, usefulness, and source-grounded accuracy.
Do not invent product, maturity, security, compliance, roadmap, customer, deployment, performance, license, or audit claims.
Preserve commands, paths, API names, config keys, code blocks, generated markers, diagrams, tables, and source-backed terminology.
Return the revised text or diff plus a short meaning and evidence audit.
```

## Packaging note

Shipped as a first-party ai-harness skill under the `docs-quality` pack. Licensed
Apache-2.0 (the `LICENSE` file here mirrors the ai-harness project license); the
project owner may relicense it.
