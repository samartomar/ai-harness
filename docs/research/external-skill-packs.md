# External skill packs

> Status: shipped as-built design note. Source-backed by `src/pack/`,
> `tests/pack/`, and `docs/product/pack-manifest.md`.

External skill packs are implemented as a committed curation manifest over the
per-skill approval lifecycle. The shipped file is:

```text
aih-packs.json
```

This is not the earlier proposed built-in pack catalog. The shipped model lets a
repo curate named sets of already-approved skills, with `aih-skills.lock.json`
remaining the pin and approval authority.

## Manifest shape

```json
{
  "schemaVersion": 1,
  "packs": [
    {
      "name": "docs-quality",
      "description": "Docs writing and review set",
      "requiredChecks": ["license", "pin"],
      "skills": [
        {
          "name": "betterdoc",
          "source": "owner/repo@aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "commit": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        }
      ]
    }
  ]
}
```

Fields:

| Field | Required | Notes |
| --- | --- | --- |
| `schemaVersion` | Yes | Literal `1`. |
| `packs[].name` | Yes | Path-safe pack name. |
| `packs[].description` | No | Curation prose. |
| `packs[].requiredChecks` | No | Per-pack tightening metadata. |
| `packs[].skills` | Yes | Non-empty list of skill refs. |
| `skills[].name` | Yes | Must match a lock entry and promoted skill name. |
| `skills[].source` | Yes | Cross-check against the lock entry source. |
| `skills[].commit` | Yes | Cross-check against the lock entry commit. |

## Authority model

The pack manifest never approves a skill and never invents a pin. Every ref is
derived from or checked against `aih-skills.lock.json`.

The approval axis has three states:

```text
approved, missing-approval, pin-mismatch
```

The install axis has four states:

```text
installed, not-installed, quarantined, stale-pin
```

`not-installed` is normal for "approved now, install later." It is not a pack
validation failure.

## Commands

| Command | Behavior |
| --- | --- |
| `aih pack status [--pack <name>]` | Read-only digest: manifest x lockfile x inventory. |
| `aih pack validate [--pack <name>]` | Read-only CI gate with coded findings. Missing manifest is a skip. |
| `aih pack add --pack <pack> --skill <name>` | Adds a ref derived from the named lock entry. |
| `aih pack remove-entry --pack <pack> --skill <name>` | Removes a curation ref. If the pack becomes empty, the pack is dropped. |
| `aih pack init --pack <pack>` | Seeds a new pack from lock entries tagged `pack=<pack>`. |
| `aih pack plan --pack <pack>` | Read-only install preview. It does not fetch or write. |
| `aih pack install --pack <pack> --apply` | Runs the gated two-phase acquisition pipeline per source. |
| `aih pack uninstall --pack <pack> --apply` | Removes installed members through `skill remove` semantics under the standard apply gate; the manifest remains. |

## Validation findings

Implemented coded findings include:

- `pack.unknown-manifest`: `aih-packs.json` exists but yields no valid packs;
- `pack.missing-approval`: a pack ref has no matching lock entry;
- `pack.pin-mismatch`: a pack ref disagrees with the lock entry source or commit;
- `pack.duplicate-name`: the same skill name appears more than once in the
  manifest, either within one pack or across packs.

## Authoring behavior

Authoring commands are write commands and remain dry-run gated. They use a
strict manifest read before rewriting. If an existing `aih-packs.json` cannot be
round-tripped as a full valid file, authoring refuses instead of silently
dropping malformed sibling packs.

`add` and `init` derive refs from lock entries. An operator names a skill; aih
copies `{name, source, commit}` from `aih-skills.lock.json`.

## Install behavior

`pack install` is fail-closed before fetch or scan:

- every ref must have a clean approval;
- source and commit must match the lock;
- `--acknowledge` and `--acknowledge-all` are refused because acknowledgements
  are per source, not per pack;
- GitHub refs resolve to the lock-pinned commit;
- local refs resolve to the recorded local path.

When applying, install gates all sources before promoting any skill. If one
source fails the trust scan or gate, no source is promoted. Promotion is subset
exact: only skills referenced by the pack are promoted, even when a source
contains extra skills.

If an installed pack member has drifted from trust-lock receipts, it is routed
back through the gate and reinstalled instead of being counted as already done.

## Uninstall behavior

`pack uninstall` composes the same removal engine as `aih skill remove`:

- installed members are archived reversibly under `.aih/legacy/`;
- `--delete` uses a hard-delete backup path;
- approval and card records are dropped for removed members;
- manifest curation is not changed;
- one blocked member refuses the whole plan at plan time.

Uncurating a skill is `aih pack remove-entry`, not `pack uninstall`.

## Boundaries

- A pack is not a registry or marketplace.
- A pack is not a second lockfile.
- A pack can be ready even when some members are not installed.
- A clean pack validation does not mean a skill is safe forever; it means the
  manifest agrees with the current committed approvals and inventory checks.

## Source links

- [`docs/product/pack-manifest.md`](../product/pack-manifest.md)
- [`src/pack/manifest.ts`](../../src/pack/manifest.ts)
- [`src/pack/status.ts`](../../src/pack/status.ts)
- [`src/pack/authoring.ts`](../../src/pack/authoring.ts)
- [`src/pack/install.ts`](../../src/pack/install.ts)
- [`src/pack/uninstall.ts`](../../src/pack/uninstall.ts)
- [`tests/pack/status.test.ts`](../../tests/pack/status.test.ts)
- [`tests/pack/install.test.ts`](../../tests/pack/install.test.ts)
