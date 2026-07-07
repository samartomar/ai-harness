# Workspace contracts and snapshots

> Status: shipped behavior. Source-backed by `src/workspace/manifest.ts`,
> `src/workspace/snapshot.ts`, `src/workspace/state.ts`, and workspace report
> tests.

Federated workspaces use `.aih-workspace.json` as the parent manifest. Contract
edges and snapshots are optional evidence layers on top of that manifest.

## Manifest shape

The manifest parser accepts a root object with these implemented fields:

| Field | Behavior |
| --- | --- |
| `schemaVersion` | Preserved when numeric. |
| `workspaceType` | Preserved when string. |
| `graphScope` | Preserved when string. |
| `contextDir` | Defaults to `ai-coding`; normalized as a parent-relative path. |
| `repos` | String entries or object entries. |
| `edges` | Contract edges between repo ids. |
| `git` | `true` enables parent `.gitignore` child-repo checks. |
| `lastSnapshot` | Optional parent-relative path, normalized when present. |
| `generatedBy` | Preserved when string. |

Unknown fields are preserved in `raw` for compatibility, but implemented readers
only act on the fields above.

## Repo entries

A repo can be declared as a string:

```json
{
  "repos": ["ui"]
}
```

or as an object:

```json
{
  "repos": [
    {
      "id": "backend",
      "path": "services/backend",
      "kind": "api",
      "owner": "platform",
      "remote": "https://github.com/acme/backend.git",
      "ref": "release/v1.5.0",
      "router": "ai-coding/RULE_ROUTER.md"
    }
  ]
}
```

Implemented validation rejects parent traversal, absolute paths, Windows drive
paths, duplicate repo ids, duplicate repo paths, dash-leading path segments, and
Markdown/HTML/control syntax in printable fields. `remote` accepts safe HTTPS,
SSH, `git+ssh`, and scp-like Git remotes; `ref` accepts safe Git ref syntax.
Use `aih workspace link <path> --apply` to author repo entries without editing
the JSON by hand; it writes only parent workspace files.

## Contract edges

Edges declare evidence between child repos:

```json
{
  "edges": [
    {
      "id": "ui-backend-api",
      "from": "ui",
      "to": "backend",
      "kind": "api-contract",
      "contractPath": "backend/openapi.yaml",
      "consumerPath": "ui/src/api"
    }
  ]
}
```

Implemented edge fields:

| Field | Required | Notes |
| --- | --- | --- |
| `id` | Yes | Stable path-safe id. |
| `from` | Yes | Source repo id. |
| `to` | Yes | Target repo id. |
| `kind` | Yes | Printable contract type label. |
| `contractPath` | No | Parent-relative evidence file. |
| `consumerPath` | No | Parent-relative consumer evidence path. |

The workspace report grades edges as:

- `OK`: contract evidence exists, and consumer evidence exists when declared;
- `MISSING`: declared contract evidence is missing;
- `PARTIAL`: one side of the declared evidence exists and the other is missing;
- `UNKNOWN`: no `contractPath` was declared.

The edge check is an existence check, not semantic validation of an OpenAPI,
GraphQL, protobuf, or other contract file.

`aih workspace link <path> --from <repo-id> --to <repo-id> --kind <label>
--contract <path> --consumer <path> --apply` authors these edges and regenerates
the parent router/contracts docs. `--from` and `--to` must reference declared
repo ids; missing ids fail verification and no child repo files are written.

## Snapshots

`aih workspace snapshot` records the current declared child repo state. The
command requires a valid `.aih-workspace.json`.

Default output under `--apply`:

```text
.aih/workspace-snapshots/<timestamp>[-<label>].json
```

With `--lock`, the command also writes:

```text
<contextDir>/workspace-lock.json
```

Snapshot files have:

```json
{
  "schemaVersion": 1,
  "createdAt": "2026-07-01T00:00:00.000Z",
  "label": "known-good",
  "repos": [
    {
      "id": "ui",
      "path": "ui",
      "remote": "https://github.com/acme/ui.git",
      "branch": "main",
      "sha": "abc123",
      "dirty": false,
      "git": true,
      "ahead": 0,
      "behind": 0
    }
  ]
}
```

`remote`, `branch`, `sha`, `ahead`, and `behind` are present only when Git can
provide them. A missing or non-Git child still appears with `git: false` and
`dirty: false`.

## Changed-since-snapshot report

The workspace report compares current child rows with the newest readable
snapshot from `.aih/workspace-snapshots/*.json` or `<contextDir>/workspace-lock.json`.

Change statuses are:

```text
UNCHANGED, CHANGED, DIRTY, MISSING, UNKNOWN
```

Examples:

- no matching repo in the snapshot -> `UNKNOWN`;
- current Git state unavailable -> `MISSING`;
- current child worktree dirty -> `DIRTY`;
- branch or SHA changed -> `CHANGED`;
- branch/SHA match -> `UNCHANGED`.

## Boundaries

- Snapshot creation is local and dry-run gated like other write commands.
- The optional lock is a known-good baseline, not a remote checkout authority.
- Contract edges document evidence paths; they do not enforce API compatibility.
- Hydration can use recorded child metadata, but it does not edit remotes.

## Source links

- [`src/workspace/manifest.ts`](../../src/workspace/manifest.ts)
- [`src/workspace/snapshot.ts`](../../src/workspace/snapshot.ts)
- [`src/workspace/state.ts`](../../src/workspace/state.ts)
- [`tests/workspace/manifest.test.ts`](../../tests/workspace/manifest.test.ts)
- [`tests/report/workspace-report.test.ts`](../../tests/report/workspace-report.test.ts)
