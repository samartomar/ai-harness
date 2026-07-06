# Skill card schema

> Status: shipped behavior. Source-backed by `src/skill/card.ts`,
> `src/skill/approve.ts`, and `tests/skill/approve.test.ts`.

A skill card is the committed, human-readable governance record for one vetted
external or first-party skill. Cards live under:

```text
<contextDir>/skill-cards/<name>.json
```

With the default context directory, that is:

```text
ai-coding/skill-cards/<name>.json
```

## Role in the lifecycle

The card records what was vetted and why it may run in this repo. It is derived
from a local vet evidence artifact plus operator intent captured at card or
approval time.

```text
aih skill vet --apply
  -> .aih/skill-reports/<source>-<pin>.json
aih skill card
  -> ai-coding/skill-cards/<name>.json
aih skill approve
  -> card with approval block + aih-skills.lock.json entry
```

`aih skill card` can render a card without an approval block. `aih skill approve`
writes the approval block and the root lockfile entry.

## Schema version 1 fields

| Field | Required | Source |
| --- | --- | --- |
| `schemaVersion` | Yes | Literal `1`. |
| `name` | Yes | Skill directory name from vet evidence, or `--name` when the source has several skills. |
| `source` | Yes | Vet evidence source, including pin for GitHub sources. |
| `commit` | Yes | Full pinned SHA for GitHub sources, or `local` for local sources. |
| `license` | Yes | License check detail from vet evidence. |
| `owner` | No | Operator-provided owner; required for `approve`, optional for `card`. |
| `pack` | No | Operator-provided pack tag. |
| `firstParty` | No | Set when the approved source is repo-relative local content. |
| `intendedUse` | No | Operator-provided intended-use statement. |
| `installScope` | Yes | Currently `repo`. |
| `riskClass` | Yes | `green` or `yellow`. RED/UNKNOWN sources do not get cards. |
| `mode` | No | Operator-provided operating mode, such as `review-only`. |
| `requiresMcp` | Yes | Derived from evidence shape. |
| `requiresShell` | Yes | Derived from evidence shape install-script detection. |
| `writesFiles` | No | Optional card metadata. |
| `networkEgress` | No | Optional card metadata. |
| `scanEvidence` | Yes | Array of evidence artifact paths, usually under `.aih/skill-reports/`. |
| `approval` | No | Approval block written by `aih skill approve`. |

The approval block has:

| Field | Required | Notes |
| --- | --- | --- |
| `verdict` | Yes | `GREEN` or `YELLOW`. |
| `approvedBy` | Yes | The owner/team passed with `--owner`. |
| `approvedAt` | Yes | Real timestamp under `--apply`; dry-run previews use `(set at apply)`. |

## Example

```json
{
  "schemaVersion": 1,
  "name": "clean",
  "source": "owner/repo@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "commit": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "license": "MIT License",
  "owner": "docs-platform",
  "pack": "docs-quality",
  "intendedUse": "Docs hygiene review.",
  "installScope": "repo",
  "riskClass": "green",
  "mode": "review-only",
  "requiresMcp": false,
  "requiresShell": false,
  "scanEvidence": [
    ".aih/skill-reports/owner-repo-aaaaaaaa.json"
  ],
  "approval": {
    "verdict": "GREEN",
    "approvedBy": "docs-platform",
    "approvedAt": "2026-07-01T00:00:00.000Z"
  }
}
```

## Refusal and read behavior

Card/approve planning refuses when the evidence chain is broken:

- GitHub source has no `--pin`;
- matching vet evidence is absent or unreadable;
- evidence pin does not match `--pin`;
- verdict is `RED` or `UNKNOWN`;
- license is missing;
- a multi-skill source has no `--name`;
- `--name` does not match a skill found in evidence.

Reading a card is fail-soft: a missing, unreadable, or schema-invalid card
returns no card to callers instead of crashing the command.

## Boundaries

- The card is not the approval authority by itself. The approval authority is
  `aih-skills.lock.json`.
- `scanEvidence` points to local evidence. It is a reference, not embedded scan
  output.
- A `YELLOW` card is approvable because the approval is the manual review the
  verdict requested. A `RED` or `UNKNOWN` source is refused.

## Source links

- [`src/skill/card.ts`](../../src/skill/card.ts)
- [`src/skill/approve.ts`](../../src/skill/approve.ts)
- [`tests/skill/approve.test.ts`](../../tests/skill/approve.test.ts)
