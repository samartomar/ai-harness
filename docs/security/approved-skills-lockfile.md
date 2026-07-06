# Approved skills lockfile

> Status: shipped behavior. Source-backed by `src/skill/lockfile.ts`,
> `src/skill/approve.ts`, `src/workspace/acquire.ts`, `src/pack/status.ts`,
> and skill/pack tests.

`aih-skills.lock.json` is the committed root-level approval authority for
external and first-party skills.

It is intentionally not under `.aih/`: `.aih/` holds local diagnostics and
generated evidence, while the lockfile is team-shared repo state.

## Role in the lifecycle

`aih skill approve` writes or replaces one lock entry by skill name after the vet
evidence chain passes:

```text
pin -> evidence -> approvable verdict -> license -> owner -> lock entry
```

Downstream surfaces use the lockfile as authority:

- `workspace add` checks approval before promoting skills at team/enterprise
  posture;
- `skill inventory` joins on-disk skills with approvals and cards;
- `pack status` and `pack validate` cross-check pack refs against lock entries;
- `pack install` refuses missing approvals or pin mismatches before scanning;
- `marketplace build` reads approved skills from the lock.

## File shape

```json
{
  "schemaVersion": 1,
  "skills": [
    {
      "name": "clean",
      "source": "owner/repo@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "commit": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "verdict": "GREEN",
      "pack": "docs-quality",
      "firstParty": false,
      "scope": "repo",
      "card": "ai-coding/skill-cards/clean.json",
      "evidenceSha256": "0000000000000000000000000000000000000000000000000000000000000000",
      "approvedBy": "docs-platform",
      "approvedAt": "2026-07-01T00:00:00.000Z"
    }
  ]
}
```

## Entry fields

| Field | Required | Notes |
| --- | --- | --- |
| `name` | Yes | Skill name; slash-separated path segments are allowed, but traversal, absolute paths, backslashes, drive letters, and control characters are rejected. |
| `source` | Yes | Approved source string. GitHub approvals include the pinned source form. |
| `commit` | Yes | Full pinned SHA for GitHub sources, or `local` for local sources. |
| `verdict` | Yes | `GREEN` or `YELLOW`. |
| `pack` | No | Pack tag copied from `aih skill approve --pack`. |
| `firstParty` | No | True when approving repo-relative local content. |
| `scope` | Yes | Currently `repo`. |
| `card` | Yes | Repo-relative committed skill-card path. |
| `evidenceSha256` | Yes | SHA-256 of the vet evidence bytes approved. |
| `approvedBy` | No | Owner/team that approved. `approve` requires `--owner`. |
| `approvedAt` | Yes | Approval timestamp; dry-run previews use a placeholder. |

## Read and write behavior

Reads are fail-soft:

- missing file -> empty lock;
- malformed JSON -> empty lock;
- malformed entry -> dropped;
- duplicate name -> first valid entry wins, later duplicates are dropped.

Writes are immutable updates:

- `upsertSkillLockEntry` replaces by `name`;
- entries are sorted by name for stable diffs;
- sibling entries are preserved.

The duplicate-name behavior protects downstream joins that key by skill name.
A duplicate can only come from hand-edited state because aih writers dedupe by
name.

## Relationship to cards and evidence

The lock entry points to:

- a committed card under `<contextDir>/skill-cards/<name>.json`;
- a local evidence artifact hash from `.aih/skill-reports/`.

The card explains what was approved. The lock entry is what install and pack
gates enforce.

## Relationship to packs

`aih-packs.json` is curation, not approval. Each pack ref repeats `{name, source,
commit}` as a fail-closed cross-check against the lock entry:

- no lock entry -> `pack.missing-approval`;
- source or commit disagreement -> `pack.pin-mismatch`;
- duplicate skill names across packs -> `pack.duplicate-name`.

## Boundaries

- The lockfile records approval for a specific source and commit. A same-named
  skill from another source does not inherit approval.
- RED and UNKNOWN vet verdicts are not approvable.
- The lockfile does not embed evidence content; it records the evidence hash and
  card path.

## Source links

- [`src/skill/lockfile.ts`](../../src/skill/lockfile.ts)
- [`src/skill/approve.ts`](../../src/skill/approve.ts)
- [`tests/skill/lockfile.test.ts`](../../tests/skill/lockfile.test.ts)
- [`tests/skill/approve.test.ts`](../../tests/skill/approve.test.ts)
- [`tests/pack/status.test.ts`](../../tests/pack/status.test.ts)
