# Workspace report rollup

> Status: shipped behavior. Source-backed by `src/report/workspace.ts`,
> `tests/report/workspace-report.test.ts`, and `docs/commands.md`.

The workspace report rollup is a read-only parent-level digest for a federated
workspace. It appears when the parent repo has `.aih-workspace.json`; it does
not make the parent repo the source of truth for child repos.

## Purpose

The rollup answers:

- Which child repos are declared?
- Which child repos exist and look like Git repos?
- Which children have their canon, local usage, history, and report artifacts?
- Which declared contract edges have evidence files?
- Has a child changed since the latest workspace snapshot?
- Is the parent MCP config scoped to declared child repos?

## Inputs

The report reads local files and Git state:

| Input | Use |
| --- | --- |
| `.aih-workspace.json` | Declared repos, edges, context directory, and git-ignore policy. |
| child repo path | Existence and Git-state checks. |
| child `ai-coding/RULE_ROUTER.md` or configured router | Canon/onboarding presence. |
| child `.aih-config.json` | Child context-dir consistency. |
| child `.aih/history.jsonl` | Latest track sample, age, and drift count when present. |
| child `.aih/usage.jsonl` | Local usage-event count. |
| child `.aih/reports/*.{html,md,json}` | Newest child report artifact and age. |
| `.aih/workspace-snapshots/*.json` or `<contextDir>/workspace-lock.json` | Baseline for changed-since-snapshot rows. |
| parent `.mcp.json` | Workspace graph MCP scope checks. |

## Status vocabulary

Rows and contract checks use the workspace evidence vocabulary:

```text
OK, WARN, MISSING, STALE, NOT_ONBOARDED, NOT_COLLECTED, PARTIAL, UNKNOWN, ERROR
```

Examples from the implementation:

- missing child router -> `NOT_ONBOARDED`;
- missing usage/history/report files -> `NOT_COLLECTED`, not failure;
- stale history or report files older than the freshness window -> `STALE`;
- malformed `.aih-workspace.json` -> `ERROR` digest with no child rows;
- missing parent `.gitignore` entries for child repos -> `WARN`;
- unsafe symlinked child paths outside the parent workspace -> fail closed.

## Child health rows

Each child row includes:

- `id`, `path`, optional `kind`, and configured `router`;
- Git availability and observed branch/SHA/dirty/ahead/behind data when Git can
  be read;
- canon, config, parent-ignore, history, usage, report, and drift cells;
- an aggregate row status derived from the cell statuses.

Child Git reads are bounded through the workspace repo mapper, with concurrency
capped at four child repos.

## MCP governance checks

The parent `.mcp.json` check is scoped to workspace safety:

- broad filesystem MCP servers produce a warning;
- stale parent-root code-review-graph MCP config produces a warning;
- generated `aih-workspace-graph-*` servers must be scoped to declared repos
  with absolute root-anchored paths;
- graph entries for absent declared repos, undeclared repos, relative paths, or
  invalid server shapes produce warnings.

Labels read from MCP config are sanitized before rendering.

## Outputs

The digest text starts with:

```text
Local child evidence is summarized here; child repos remain the source of truth.
```

When requested through the report command's workspace artifact path, the report
writes workspace artifacts under `.aih/workspace-report.*`.

## Boundaries

- The rollup reads child repos; it does not write them.
- Missing local telemetry is reported as not collected, not as a failed child.
- A malformed manifest is reported without crashing the full report.
- The parent report is a summary; child repos retain their own canon, history,
  usage logs, reports, commands, and guardrails.

## Source links

- [`src/report/workspace.ts`](../../src/report/workspace.ts)
- [`tests/report/workspace-report.test.ts`](../../tests/report/workspace-report.test.ts)
- [`docs/commands.md#aih-workspace`](../commands.md#aih-workspace)
