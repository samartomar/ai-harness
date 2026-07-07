# ai-harness Workspace Federated Bridge

> Status: largely shipped. `aih workspace` scaffolds the parent bridge —
> `.aih-workspace.json`, `<contextDir>/workspace-router.md`, `workspace-contracts.md`,
> `cross-repo-architecture.md`, `repo-discipline.md`, thin bootloaders, and a spanning
> `.mcp.json` (`src/workspace/index.ts` + `templates.ts`). The manifest reader supports
> object repos and `edges[]` (`src/workspace/manifest.ts`). Snapshots
> (`aih workspace snapshot` → `.aih/workspace-snapshots/`) and task plans
> (`aih workspace plan` → `.aih/workspace-plans/`) shipped (`src/workspace/snapshot.ts`,
> `task-plan.ts`). The parent report rollup is implemented in `src/report/workspace.ts`
> with the honest status vocabulary below (plus a `NOT_COLLECTED` state). Trust-gated
> skill acquisition is `aih workspace add` (`src/workspace/acquire.ts`). Child repo
> registration and contract-edge authoring are `aih workspace link` (`src/workspace/link.ts`).
> Not implemented: the recursive child-write opt-ins (`--recursive`, `--refresh-children`).
> The body below is the original design record.

## One-line positioning

```text
ai-harness workspace is a federated bridge across disconnected repos, not a monorepo replacement.
```

## Correct model

```text
Child repo owns truth.
Parent workspace owns routing.
Parent report owns rollup.
```

## Three layers

### 1. Child repo owns truth

Each child repo owns:

```text
ai-coding/RULE_ROUTER.md
ai-coding/project-guardrails.md
ai-coding/design.md
ai-coding/project.md
ai-coding/api.md
usage
track history
report
drift
commands
code-review graph
skills
MCP config
repo-specific docs
```

The parent should not copy or merge all of this.

### 2. Parent workspace owns routing

The parent owns:

```text
repo inventory
one link to each child router
cross-repo map
contract edges
workspace snapshots
workspace task plans
```

Minimum routing rule:

```text
Before editing ui/, read ui/ai-coding/RULE_ROUTER.md.
Before editing backend/, read backend/ai-coding/RULE_ROUTER.md.
Before editing infra/, read infra/ai-coding/RULE_ROUTER.md.
```

### 3. Parent report owns rollup

The parent report should summarize health, not pretend to own all details.

It should show:

```text
repo health matrix
child report links
canon status
usage status
track status
drift summary
stale/missing states
contract status
what changed since last snapshot
```

## Target files

```text
.aih-workspace.json
  stable workspace manifest: repos, edges, contextDir, lastSnapshot

ai-coding/workspace-router.md
  generated repo -> child RULE_ROUTER.md index

ai-coding/workspace-contracts.md
  generated/merge-safe cross-repo contract relationships

ai-coding/cross-repo-architecture.md
  user-owned narrative and system map

ai-coding/repo-discipline.md
  existing compatibility file; keep while adding workspace-router.md

.aih/workspace-report.json
.aih/workspace-report.html
  rollup and drilldowns

.aih/workspace-snapshots/*.json
  known-good child repo SHA snapshots

.aih/workspace-plans/*.md
  multi-repo task plans
```

## Manifest v1

Keep backward compatibility with the current string-array repo list, but support richer objects.

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
      "router": "ai-coding/RULE_ROUTER.md",
      "owner": "frontend"
    },
    {
      "id": "backend",
      "path": "backend",
      "kind": "api",
      "remote": "https://github.com/acme/backend.git",
      "ref": "main",
      "router": "ai-coding/RULE_ROUTER.md",
      "owner": "platform"
    },
    {
      "id": "infra",
      "path": "infra",
      "kind": "infra",
      "router": "ai-coding/RULE_ROUTER.md",
      "owner": "devops"
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
  "lastSnapshot": ".aih/workspace-snapshots/latest.json",
  "generatedBy": "aih workspace"
}
```

`repos[]` can remain a bare string path for lightweight workspaces. Object-form
entries keep the required `path` plus stable `id`, optional role/source metadata
(`kind`, `remote`, `ref`), and the child router path. `remote` and `ref` are
metadata only here: `aih workspace` records and validates them without fetching or
mutating any child repo.

`aih workspace snapshot --lock --apply` also carries the child repo's local `origin`
URL into `workspace-lock.json` when present. Snapshot collection reads only
child-local Git config, so ambient/global Git config cannot inject a fetch
location, and unavailable or unsafe values are omitted.

## Workspace router

Path:

```text
ai-coding/workspace-router.md
```

Template:

```md
# Workspace Router

This is a federated workspace, not a monorepo.

## Child repos

| Repo | Path | Role | Router |
|---|---|---|---|
| ui | ui/ | frontend | ui/ai-coding/RULE_ROUTER.md |
| backend | backend/ | api | backend/ai-coding/RULE_ROUTER.md |
| infra | infra/ | infra | infra/ai-coding/RULE_ROUTER.md |

## Rule

Before editing a child repo, read that child repo's router first.

## Read order for common changes

- UI-only change: ui router only.
- API change: backend router, then UI router, then contract edge.
- Deploy change: infra router, then affected service repo router.
- Cross-cutting change: start with this workspace router, then each affected child router.
```

## Workspace contracts

Path:

```text
ai-coding/workspace-contracts.md
```

Template:

```md
# Workspace Contracts

This file records relationships across child repos. It does not copy child canon.

## Contract edges

| From | To | Kind | Contract | Consumer |
|---|---|---|---|---|
| ui | backend | API contract | backend/openapi.yaml | ui/src/api |
| backend | infra | Deployment contract | infra/services/backend.md | n/a |

## Rules

- If a producer contract changes, check all consumers.
- If backend API changes, update UI client and tests.
- If service runtime changes, check infra deployment config.
- If auth/session behavior changes, check UI, backend, and infra edge config.
```

## Workspace report matrix

The parent report should look like this.

| Repo | Git | Canon | Report | Usage | Track | Drift | Contracts | Last sample | Status |
|---|---|---|---|---|---|---:|---|---|---|
| ui | OK | OK | OK | OK | OK | 0 | OK | today | OK |
| backend | OK | OK | MISSING | OK | OK | 1 | STALE | yesterday | WARN |
| infra | OK | NOT_ONBOARDED | MISSING | MISSING | MISSING | n/a | PARTIAL | n/a | NOT_ONBOARDED |

Use honest states:

```text
OK
WARN
MISSING
STALE
NOT_ONBOARDED
PARTIAL
UNKNOWN
ERROR
```

Do not show only pass/fail.

## Workspace snapshot

Path:

```text
.aih/workspace-snapshots/<timestamp>.json
.aih/workspace-snapshots/latest.json
```

Command:

```bash
aih workspace snapshot --apply
aih workspace snapshot --label known-good-before-login-api-change --apply
```

Snapshot example:

```json
{
  "schemaVersion": 1,
  "createdAt": "2026-07-01T00:00:00Z",
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

Report should show:

```text
Changed since last snapshot:
  ui: +2 commits
  backend: unchanged
  infra: dirty
```

## Workspace task plan

Command:

```bash
aih workspace plan "change login API and update UI"
```

Output:

```text
.aih/workspace-plans/<timestamp>-change-login-api-and-update-ui.md
```

Template:

```md
# Workspace Plan

## Task

change login API and update UI

## Repos touched

- backend
- ui
- infra, if deploy config changes

## Read order

1. ai-coding/workspace-router.md
2. backend/ai-coding/RULE_ROUTER.md
3. ui/ai-coding/RULE_ROUTER.md
4. infra/ai-coding/RULE_ROUTER.md, only if deploy config changes

## Contracts affected

- backend/openapi.yaml
- ui/src/api
- infra/services/backend.md, if runtime/deploy changes

## Implementation order

1. Update backend API contract.
2. Update backend implementation.
3. Update backend tests.
4. Update UI client.
5. Update UI tests.
6. Update infra config if required.
7. Run cross-repo verification.

## Rollback checklist

- backend commit:
- ui commit:
- infra commit:
- snapshot before change:
```

## Parent write boundary

Firm rule:

```text
parent writes parent files only
child repos remain independent
child canon/report/usage belongs to child
recursive child writes require explicit opt-in
```

Allowed by default:

```text
write .aih-workspace.json
write ai-coding/workspace-router.md
write ai-coding/workspace-contracts.md
write ai-coding/cross-repo-architecture.md
write parent .mcp.json / workspace config
write .aih/workspace-report.*
write .aih/workspace-snapshots/*
```

Not allowed by default:

```text
writing child ai-coding/RULE_ROUTER.md
installing child skills
rewriting child bootloaders
modifying child MCP config
committing child changes
```

Requires explicit opt-in:

```bash
aih workspace init --recursive --apply
aih workspace report --refresh-children --apply
aih pack install product-ui --repo ui --apply
```

## Final workspace statement

```text
ai-harness workspace is intended to give agents a reviewable map across repo boundaries while each repo keeps its own truth, report, usage, and guardrails.
```
