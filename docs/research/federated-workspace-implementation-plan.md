# Federated Workspace Implementation Plan

**Date:** 2026-06-30  
**Status:** accepted direction, staged implementation  
**Scope:** `aih workspace`, `aih doctor`, `aih report`, child repo telemetry rollup, cross-repo routing

## Decision

`ai-harness` workspaces will be a **federated bridge across independent repos**, not a fake monorepo.

The parent workspace owns routing, topology, cross-repo contracts, snapshots, and rollup reports. Each child repo remains the source of truth for its own canon, report, usage, track history, drift, commands, skills, and git state.

```text
Child repo = owns its own canon, report, usage, track, drift, commands, docs
Parent workspace = knows the children, routes agents, summarizes health, links drilldowns
```

This preserves the current `aih workspace` boundary: parent writes parent files only; child repos are initialized and governed independently.

## Product Problem

Teams often work across separate repos such as frontend, backend, infrastructure, docs, and shared libraries. Agents need a safe way to answer:

- Which repo owns this behavior?
- Which child canon should be read before editing?
- Which API/deploy/schema contract connects these repos?
- Which child repo is missing `aih` adoption or stale telemetry?
- Which child commits were known to work together?
- What changed since the last known-good workspace snapshot?

The workspace should solve those coordination questions without absorbing child source files, child history, or child canon into the parent.

## Current Foundation

`aih workspace` already provides the correct seed:

```text
parent workspace
  .aih-workspace.json
  <workspace>.code-workspace
  ai-coding/cross-repo-architecture.md
  ai-coding/repo-discipline.md
  CLAUDE.md
  AGENTS.md
  .mcp.json spanning child repos
```

Current guarantees to preserve:

- `aih workspace` is parent-only.
- Child repos remain independent git repos.
- Child repos are ignored by parent git under `workspace --git`.
- Child repos run `aih init` separately.
- Parent `cross-repo-architecture.md` is write-once and user-owned.
- Parent MCP/filesystem access can span children for blast-radius discovery.
- Parent workspace git never creates a remote; remote setup is user-owned.

## Non-Goals

- Do not turn disconnected repos into a monorepo.
- Do not track child source files in parent git.
- Do not copy full child canon into parent docs.
- Do not auto-edit child canon from the parent by default.
- Do not imply local `.aih/` telemetry is team-wide truth.
- Do not make parent `git diff` a substitute for child repo change detection.
- Do not merge all child report details into one giant workspace report.

## Core Boundary

```text
parent writes parent bridge files
parent reads child evidence
child repos own child truth
recursive child mutation requires explicit opt-in
```

Examples:

- Parent may write `ai-coding/workspace-router.md`.
- Parent may read `ui/ai-coding/RULE_ROUTER.md`.
- Parent may read `backend/.aih/history.jsonl`.
- Parent may link to `infra/.aih/reports/local-v9.html`.
- Parent must not silently rewrite `ui/ai-coding/RULE_ROUTER.md`.

## Evidence Model

Workspace rollups must label child evidence honestly.

Committed parent files are shared topology:

```text
.aih-workspace.json
ai-coding/workspace-router.md
ai-coding/workspace-contracts.md
ai-coding/cross-repo-architecture.md
ai-coding/repo-discipline.md
```

Gitignored parent `.aih/` files are local derived evidence:

```text
.aih/workspace-report.json
.aih/workspace-report.html
.aih/workspace-snapshots/*.json
```

Gitignored child `.aih/` files are local child evidence:

```text
<repo>/.aih/history.jsonl
<repo>/.aih/usage.jsonl
<repo>/.aih/reports/*.html
```

Important rule: parent reports may summarize local child evidence, but must not present it as universal team truth.

## Workspace Manifest

### Compatibility Requirement

Current manifests use `repos: string[]`. Future manifests may use richer `repos: object[]`. All readers must use one central parser before any writer starts emitting the richer shape.

Existing v0 shape:

```json
{
  "workspaceType": "multi-repo",
  "graphScope": "combined-child-repos",
  "contextDir": "ai-coding",
  "repos": ["ui", "backend", "infra"],
  "git": true,
  "generatedBy": "aih workspace"
}
```

Future v1 shape:

```json
{
  "schemaVersion": 1,
  "workspaceType": "multi-repo",
  "graphScope": "combined-child-repos",
  "contextDir": "ai-coding",
  "repos": [
    {
      "id": "ui",
      "path": "ui",
      "kind": "frontend",
      "router": "ai-coding/RULE_ROUTER.md"
    },
    {
      "id": "backend",
      "path": "backend",
      "kind": "api",
      "router": "ai-coding/RULE_ROUTER.md"
    },
    {
      "id": "infra",
      "path": "infra",
      "kind": "infra",
      "router": "ai-coding/RULE_ROUTER.md"
    }
  ],
  "edges": [
    {
      "id": "ui-consumes-backend-api",
      "from": "ui",
      "to": "backend",
      "kind": "api-contract",
      "contractPath": "backend/openapi.yaml",
      "consumerPath": "ui/src/api"
    },
    {
      "id": "backend-deployed-by-infra",
      "from": "backend",
      "to": "infra",
      "kind": "deployment-contract",
      "contractPath": "infra/services/backend.md"
    }
  ],
  "lastSnapshot": "ai-coding/workspace-lock.json",
  "generatedBy": "aih workspace"
}
```

### Parser Contract

Add a central parser, for example `src/workspace/manifest.ts`.

It should return normalized repos:

```ts
interface WorkspaceRepo {
  id: string;
  path: string;
  kind?: string;
  router: string;
}
```

Rules:

- `repos: ["ui"]` normalizes to `{ id: "ui", path: "ui", router: "ai-coding/RULE_ROUTER.md" }`.
- Object repo paths must be relative and must not traverse parents.
- Repo ids must be stable, unique, and path-safe.
- Unknown future fields are preserved when merge-writing.
- Invalid manifests should degrade to `UNKNOWN` or `ERROR` in reports, not crash unrelated commands.

## Workspace Router

Add a generated parent file:

```text
ai-coding/workspace-router.md
```

Purpose: give agents a simple top-level table of contents into child truth.

Example:

```md
# Workspace Router

This is a federated workspace, not a monorepo.

## Repos

| Repo | Path | Role | Router |
|---|---|---|---|
| ui | ui/ | frontend | ui/ai-coding/RULE_ROUTER.md |
| backend | backend/ | api | backend/ai-coding/RULE_ROUTER.md |
| infra | infra/ | infra | infra/ai-coding/RULE_ROUTER.md |

## Rule

Before editing a child repo, read that child repo's router first.
```

Keep `repo-discipline.md` for compatibility and continuity. `workspace-router.md` becomes the clearer future-facing routing surface.

## Workspace Report Rollup

The next major feature is workspace report rollup.

Invocation:

```bash
aih report <workspace-root>
aih report <workspace-root> --workspace
aih report <workspace-root> --apply --format html --out .aih/workspace-report.html
```

Behavior:

- Auto-detect workspace mode when `.aih-workspace.json` exists.
- Read the normalized workspace manifest.
- Inspect each child repo read-only.
- Summarize child health and link to child drilldowns.
- Keep child details in child reports.
- Emit terminal, JSON, Markdown, and HTML-ready model data through existing report paths.

Suggested matrix:

| Repo | Git | Canon | Report | Usage | Track | Drift | Last sample | Status |
|---|---|---|---|---|---|---:|---|---|
| ui | OK | OK | OK | OK | OK | 0 | today | OK |
| backend | OK | OK | MISSING | OK | OK | 1 | yesterday | WARN |
| infra | OK | NOT_ONBOARDED | MISSING | MISSING | MISSING | n/a | n/a | NOT_ONBOARDED |

### Status Vocabulary

Use user-facing states, not raw `pass/skip/fail`.

```text
OK
WARN
MISSING
STALE
NOT_ONBOARDED
NOT_COLLECTED
PARTIAL
UNKNOWN
ERROR
```

Definitions:

- `OK`: expected evidence exists and is fresh.
- `WARN`: usable, but one or more non-blocking risks exist.
- `MISSING`: expected file or artifact is absent.
- `STALE`: evidence exists but is older than the freshness threshold.
- `NOT_ONBOARDED`: child repo has no `aih` canon.
- `NOT_COLLECTED`: telemetry hook/report was not run locally.
- `PARTIAL`: some required evidence exists, some does not.
- `UNKNOWN`: unable to determine safely.
- `ERROR`: read/parse/probe failed.

### Child Evidence Checks

For each child repo:

- Path exists.
- Path is a git repo.
- Parent git ignores the child path when workspace git is enabled.
- Child branch, dirty state, ahead/behind if available.
- Child `ai-coding/RULE_ROUTER.md` exists.
- Child `.aih-config.json` exists and agrees with context dir when present.
- Child `.aih/history.jsonl` exists.
- Child `.aih/history.jsonl` latest sample age.
- Child `.aih/usage.jsonl` exists.
- Child report artifact exists under `.aih/reports/`.
- Child drift count, if available in history/report data.
- Child local report link, if available.
- Child local usage count, if available.

### Freshness Thresholds

Initial defaults:

- Track sample stale after 7 days.
- Report artifact stale after 7 days.
- Usage missing is `NOT_COLLECTED`, not failure.
- Child canon missing is `NOT_ONBOARDED`.

Expose thresholds later if needed.

## Cross-Repo Contracts

After report rollup, add `edges[]` to `.aih-workspace.json` and generate:

```text
ai-coding/workspace-contracts.md
```

Purpose: encode the dependencies that make separate repos need coordination.

Examples:

- UI consumes backend API.
- Backend emits events consumed by worker.
- Backend deployment is owned by infra.
- Shared schema is consumed by multiple services.

Report should show:

```text
Contract: ui -> backend API
Status: OK / MISSING / STALE / UNKNOWN
Contract file: backend/openapi.yaml
Consumer path: ui/src/api
```

Contract status rules:

- `OK`: declared contract file exists.
- `MISSING`: declared contract file is absent.
- `UNKNOWN`: path cannot be checked safely.
- `STALE`: reserved until contract timestamp/hash checking exists.
- `PARTIAL`: one side exists, another side is missing.

Do not infer too much at first. Explicit `edges[]` beat clever guessing.

## Workspace Snapshots and Locks

Keep local snapshot history separate from shared locks.

Local history:

```text
.aih/workspace-snapshots/*.json
```

Shared known-good lock:

```text
ai-coding/workspace-lock.json
```

Command:

```bash
aih workspace snapshot --apply
aih workspace snapshot --apply --label known-good-before-login-api-change
```

Local snapshot example:

```json
{
  "schemaVersion": 1,
  "createdAt": "2026-06-30T20:00:00Z",
  "label": "known-good-before-login-api-change",
  "repos": [
    {
      "id": "ui",
      "path": "ui",
      "branch": "main",
      "sha": "abc123",
      "dirty": false
    },
    {
      "id": "backend",
      "path": "backend",
      "branch": "main",
      "sha": "def456",
      "dirty": false
    },
    {
      "id": "infra",
      "path": "infra",
      "branch": "main",
      "sha": "789aaa",
      "dirty": false
    }
  ]
}
```

Workspace report can then show:

```text
Changed since last snapshot:
- ui: +2 commits
- backend: unchanged
- infra: dirty
```

Do not point a committed manifest at gitignored local snapshot history unless the missing-file state is explicitly handled.

## Workspace Task Plans

Later command:

```bash
aih workspace plan "change login API and update UI"
```

Output:

```text
.aih/workspace-plans/<timestamp>-login-api.md
```

Plan sections:

```text
repos touched
read order
contracts affected
implementation order
test order
rollback checklist
per-repo commit checklist
```

Template:

```md
# Workspace Plan

## Repos Touched

- backend
- ui
- infra

## Read Order

1. backend/ai-coding/RULE_ROUTER.md
2. ui/ai-coding/RULE_ROUTER.md
3. infra/ai-coding/RULE_ROUTER.md

## Contracts Affected

- backend/openapi.yaml
- ui/src/api/generated-client.ts
- infra/service-config.md

## Implementation Order

1. Backend contract
2. Backend implementation
3. Backend tests
4. UI client update
5. UI tests
6. Infra config
7. End-to-end verification

## Rollback

- backend commit:
- ui commit:
- infra commit:
```

## Security and Governance

### MCP Version Pinning

The workspace filesystem MCP package can be version-pinned via `AIH_MCP_FS_VERSION`. When unset, dev convenience is acceptable, but enterprise posture should warn or fail.

Policy:

- vibe/team posture: `WARN` when workspace filesystem MCP package is unpinned.
- enterprise posture: `FAIL` or gate when unmanaged/unpinned MCP is present.

Report text:

```text
Workspace MCP filesystem server is unpinned.
Set AIH_MCP_FS_VERSION or enforce a managed MCP policy.
```

### Path Safety

All workspace paths must be:

- relative to the parent workspace,
- normalized to POSIX-style manifest paths,
- non-empty,
- non-absolute,
- unable to traverse parents,
- safe to print in reports.

### Child Mutation Safety

Default:

```text
parent-only writes
```

Future opt-in:

```bash
aih workspace init-children --apply --repos ui,backend
```

That command must be explicit and should be designed separately.

## Implementation Sequence

### PR 69: Workspace Bootloader Recognition

Keep scoped:

- Parent workspace bootloaders validate workspace docs.
- `doctor` and report loadability do not require repo-level `RULE_ROUTER.md` in the parent bridge repo.
- Tests cover workspace parent loadability.

Do not expand this PR into the full workspace rollup.

### PR 70: Manifest Parser and Workspace Report Rollup

Primary goal: make parent report useful.

Likely files:

```text
src/workspace/manifest.ts
src/report/workspace.ts
src/report/index.ts
tests/report/workspace-report.test.ts
```

Acceptance:

- Reads current `repos: string[]` manifest.
- Reads future `repos: object[]` manifest.
- Detects child git repo state.
- Detects child canon status.
- Detects child `.aih/history.jsonl` presence and freshness.
- Detects child `.aih/usage.jsonl` presence.
- Detects child report artifact presence.
- Shows `NOT_ONBOARDED` for child repos without canon.
- Shows `NOT_COLLECTED` for missing local telemetry.
- Emits structured JSON model.
- Adds terminal report section.
- HTML/v9 can render a compact workspace matrix, or initially carry the structured digest.

Test fixtures:

- all children onboarded,
- one child missing canon,
- one child missing telemetry,
- one child path missing,
- malformed manifest,
- v0 string repo manifest,
- v1 object repo manifest,
- stale history sample.

### PR 71: Workspace Router

Primary goal: make child canon discoverable from parent.

Likely files:

```text
src/workspace/templates.ts
src/workspace/index.ts
tests/workspace/workspace.test.ts
```

Generate:

```text
ai-coding/workspace-router.md
```

Keep:

```text
ai-coding/repo-discipline.md
```

Acceptance:

- Router lists every child repo.
- Router links to each child `RULE_ROUTER.md`.
- Router says this is a federated workspace, not a monorepo.
- Router is regenerated idempotently.
- `cross-repo-architecture.md` remains write-once.

### PR 72: Contract Edges

Primary goal: encode cross-repo dependencies explicitly.

Add manifest field:

```text
edges[]
```

Generate:

```text
ai-coding/workspace-contracts.md
```

Acceptance:

- Parser supports `edges[]`.
- Report shows contract status.
- Missing contract paths are reported clearly.
- Contract docs are parent-owned.
- No child files are modified.

Optional CLI later:

```bash
aih workspace link --from ui --to backend --kind api-contract --contract backend/openapi.yaml --consumer ui/src/api
```

### PR 73: Workspace Snapshots and Shared Lock

Primary goal: record known-good child repo SHAs.

Command:

```bash
aih workspace snapshot --apply
```

Files:

```text
.aih/workspace-snapshots/*.json
ai-coding/workspace-lock.json
```

Acceptance:

- Snapshot records each child repo branch, SHA, dirty state.
- Local snapshot history is gitignored.
- Shared lock is committed only when explicitly written.
- Report shows changes since latest available snapshot/lock.
- Dirty child repos are labeled clearly.

### PR 74: Workspace Task Plan

Primary goal: help agents sequence multi-repo changes.

Command:

```bash
aih workspace plan "<task>"
```

Acceptance:

- Plan lists read order by child router.
- Plan includes contract edges relevant to touched repos.
- Plan includes implementation order.
- Plan includes test order.
- Plan includes rollback checklist.
- Plan writes under `.aih/workspace-plans/` only under `--apply`.

## Report Design Principles

- Prefer a matrix over prose.
- Summarize, then link to child detail.
- Make missing telemetry honest, not scary.
- Avoid implying generated local files are committed team truth.
- Keep child repo rows independently understandable.
- Use deterministic ordering.
- Degrade gracefully when a child repo is absent or malformed.

## Done Criteria for the Workspace Lane

The workspace lane is complete when:

- A parent workspace can show all child repos and their current adoption status.
- A parent workspace can route an agent to each child canon.
- A parent workspace can show local child telemetry freshness.
- A parent workspace can show declared cross-repo contracts.
- A parent workspace can record known-good child commit sets.
- A parent workspace can create a multi-repo task plan.
- No default command mutates child repos from the parent.
- Child repos remain independent git repos with independent remotes, branches, commits, and `aih` adoption.

## Positioning

```text
ai-harness workspace does not turn separate repos into a monorepo.
It gives agents a safe map across repo boundaries while each repo keeps its own canon and evidence.
```

This is the differentiator: a governed federated control plane for disconnected AI-coded repos.
