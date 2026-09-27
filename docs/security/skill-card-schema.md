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

## Schema version 2 fields

| Field | Required | Source |
| --- | --- | --- |
| `schemaVersion` | Yes | `2`. Version 1 files (aih 0.6.2 and earlier) are still read, with version 1's values only (`green`/`yellow` and `GREEN`/`YELLOW`); a version 1 file carrying another value is malformed. aih rewrites a file as version 2 only when it writes it. |
| `name` | Yes | Skill directory name from vet evidence, or `--name` when the source has several skills. |
| `source` | Yes | Vet evidence source, including pin for GitHub sources. |
| `commit` | Yes | Full pinned SHA for GitHub sources, or `local` for local sources. |
| `license` | Yes | License check detail from vet evidence. |
| `owner` | No | Operator-provided owner; required for `approve`, optional for `card`. |
| `pack` | No | Operator-provided pack tag. |
| `firstParty` | No | Set when the approved source is repo-relative local content. |
| `intendedUse` | No | Operator-provided intended-use statement. |
| `installScope` | Yes | Currently `repo`. |
| `riskClass` | Yes | The vet verdict as a label: `green`, `yellow`, `red` or `unknown`. Every vetted source can get a card. |
| `mode` | No | Operator-provided operating mode, such as `review-only`. |
| `requiresMcp` | Yes | Derived from evidence shape. |
| `requiresShell` | Yes | Derived from evidence shape install-script detection. |
| `writesFiles` | No | Optional card metadata. |
| `networkEgress` | No | Optional card metadata. |
| `scanEvidence` | Yes | Array of evidence artifact paths, usually under `.aih/skill-reports/`. |
| `sourceScope` | No | Present for scoped `aih skill vet --name` evidence; records selected skill names, included paths, and excluded sibling skill paths. |
| `approval` | No | Approval block written by `aih skill approve`. |

The optional `sourceScope` block has:

| Field | Required | Notes |
| --- | --- | --- |
| `selectedSkillNames` | Yes | Non-empty array of validated skill names. Scoped approval records exactly one selected skill. |
| `includedPaths` | Yes | Non-empty array of relative POSIX source paths included in the scoped artifact. Scoped approval records exactly one included path. |
| `excludedSkillPaths` | Yes | Relative POSIX source paths for sibling skill roots that were outside the scoped artifact. Empty means no sibling skill root was recorded. |

The approval block has:

| Field | Required | Notes |
| --- | --- | --- |
| `verdict` | Yes | The vet verdict the approval recorded: `GREEN`, `YELLOW`, `RED` or `UNKNOWN`. |
| `approvedBy` | Yes | The owner/team passed with `--owner`. |
| `approvedAt` | Yes | Real timestamp under `--apply`; dry-run previews use `(set at apply)`. |

## Example

```json
{
  "schemaVersion": 2,
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
    ".aih/skill-reports/owner-repo-aaaaaaaa/clean.json"
  ],
  "sourceScope": {
    "selectedSkillNames": [
      "clean"
    ],
    "includedPaths": [
      "skills/clean"
    ],
    "excludedSkillPaths": [
      "skills/bad"
    ]
  },
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
- a multi-skill source has no `--name`;
- `--name` does not match a skill found in evidence;
- scoped evidence omits `sourceScope`, records an included path that does not
  promote to `--name`, overlaps included and excluded paths, or lacks the
  matching `skill source scope` pass-check from vet.

A `RED` or `UNKNOWN` verdict and a missing license (recorded as `not determined`)
are labels on the card, not refusals.

Reading a card is fail-soft: a missing, unreadable, or schema-invalid card
returns no card to callers instead of crashing the command.

## Boundaries

- The card is not the approval authority by itself. The approval authority is
  `aih-skills.lock.json`.
- `scanEvidence` points to local evidence. It is a reference, not embedded scan
  output.
- The card carries the vet verdict as its label; the approval records the
  consumer's decision and does not depend on the verdict.

## Source links

- [`src/skill/card.ts`](../../src/skill/card.ts)
- [`src/skill/approve.ts`](../../src/skill/approve.ts)
- [`tests/skill/approve.test.ts`](../../tests/skill/approve.test.ts)
