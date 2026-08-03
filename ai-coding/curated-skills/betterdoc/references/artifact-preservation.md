# Artifact Preservation

Use this reference for generated documentation, diagrams, tables, callouts, and technical blocks.

## Generated Documentation

Generated content includes OpenAPI output, JSDoc/TSDoc output, protobuf docs, GraphQL schema docs, code-generated markdown, CLI help output, migration output, reports, and docs inside generated markers.

Default rules:

- Do not manually rewrite generated sections unless explicitly asked.
- Preserve generated markers, source-of-truth comments, and timestamps when present.
- Preserve field names, enum values, route names, status codes, examples, default values, and ordering unless the source says they changed.
- Edit surrounding hand-authored prose to explain, link, or scope the generated content.
- If generated output appears stale, flag it instead of silently correcting it.

Safe edit:

```md
The following section is generated from the OpenAPI schema. Regenerate it after changing endpoint definitions.
```

Risky edit:

```md
Manually renaming generated schema fields for readability.
```

## Diagrams

Diagrams include Mermaid, PlantUML, sequence diagrams, architecture images, flow charts, trust-boundary diagrams, and screenshots used as evidence.

Rules:

- Preserve diagram source blocks unless asked to edit them.
- Do not add components, actors, data flows, trust boundaries, storage locations, or failure behavior not shown in source.
- Captions must say what the diagram actually shows.
- If the diagram is illustrative, say so.
- If the diagram is normative or operational, it needs source support.
- Flag mismatches between diagram and prose.

Better caption:

```md
This diagram shows the request path used by the local development environment. It does not describe production networking.
```

Avoid:

```md
This diagram proves the platform is secure.
```

## Tables

Tables often carry claims row-by-row.

Rules:

- Preserve factual cells.
- Improve vague headers when meaning is clear.
- Keep units, versions, dates, environments, and status labels visible.
- Do not fill empty cells with guesses.
- Use `Unknown`, `TBD`, or `Needs source` when the source is missing.
- Do not normalize statuses across rows unless the source supports the same status for each row.
- Prefer a table when readers need to compare repeated attributes.
- Prefer prose when there are only one or two facts and no comparison.

Good table headers:

```md
| Control | Enforcement point | Evidence | Limit |
```

Weak table headers:

```md
| Thing | Notes | Status |
```

## Callouts

Callouts include `Note`, `Warning`, `Important`, `Tip`, and admonition blocks in Docusaurus, MkDocs, mdBook, GitHub markdown, and similar systems.

Rules:

- Use `Warning` only for real risk: data loss, security exposure, breaking changes, irreversible actions, costs, or operational impact.
- Use `Important` for required prerequisites or constraints.
- Use `Note` for helpful context that does not affect correctness.
- Use `Tip` for optional convenience.
- Do not use callouts to add unsupported claims.

Example:

```md
> Important: Run this command from the repository root. The generated paths are relative to the current working directory.
```

## Code and Command Blocks

Default rule: preserve exactly.

Only change technical blocks when:

- the user explicitly asks,
- the source proves the block is wrong,
- or the task is to update the code/config itself.

When changing a block, mention why in the audit.
