# The pack manifest (`aih-packs.json`)

> Status: shipped. For the earlier design exploration, see
> [enterprise-packaging-model.md](enterprise-packaging-model.md).

`aih-packs.json` is a **committed curation manifest at the repo root**: it names sets of
already-approved skills ("packs") so a team reasons about *the docs-quality set*, not N
individual approvals. It is deliberately **not a second lockfile** — the committed
`aih-skills.lock.json` stays the single pin authority, and every ref in the manifest is only a
fail-closed cross-check against the lock entry of the same name. A manifest that disagrees with
the lock is stale or tampered; it blocks (`pack.pin-mismatch`), it never re-pins.

## Schema

```jsonc
{
  "schemaVersion": 1,
  "packs": [
    {
      // Required. The pack's unique name (one name, one owning pack — a skill
      // listed in two packs fails `aih pack validate` with pack.duplicate-name).
      "name": "docs-quality",
      // Optional curation prose, recorded when the pack is created.
      "description": "Docs writing + review skills the platform team approved.",
      // Optional per-pack TIGHTENING of org-policy's required-check list
      // (superset semantics).
      "requiredChecks": ["trust.scan"],
      // Required, at least one ref. Each field is a CROSS-CHECK against the
      // aih-skills.lock.json entry of the same name — never an independent pin.
      "skills": [
        {
          "name": "style-guide",              // must match a lock entry name
          "source": "owner/repo@<full-sha>",  // must equal the lock entry's source
          "commit": "<full-sha>"              // must equal the lock entry's commit ("local" for local sources)
        }
      ]
    }
  ]
}
```

Reads are fail-soft (a malformed pack entry is dropped, valid siblings survive); authoring
writes are fail-closed (`aih pack add`/`remove-entry`/`init` refuse to rewrite a file they
cannot faithfully round-trip, so a hand-mangled sibling pack is never silently deleted).

## Worked example

```console
# 1. Approve the skills (per-skill lifecycle — vet evidence → committed approval).
aih skill vet owner/docs-skills --pin <sha> --apply
aih skill approve owner/docs-skills --pin <sha> --owner docs-platform --pack docs-quality --apply

# 2. Curate. `init` seeds a pack from every lock entry tagged pack=docs-quality;
#    `add` curates one-by-one (the ref is DERIVED from the lock entry).
aih pack init --pack docs-quality --description "Docs writing + review set" --apply

# 3. Gate in CI — coded findings, non-zero exit when blocked.
aih pack validate

# 4. Install on any clone — fail-closed at every posture: every ref needs a clean
#    approval BEFORE any fetch; all sources gate before any promotes; only the
#    pack's refs are promoted (subset-exact); re-runs resume idempotently.
aih pack plan --pack docs-quality
aih pack install --pack docs-quality --apply

# 5. Retract — per-member `skill remove` semantics (reversible archive, approval +
#    card dropped); the manifest curation stays. One blocked member refuses the
#    whole plan.
aih pack uninstall --pack docs-quality --apply
```

## Updating a pack to a new upstream commit

The lock is the pin authority, so an update flows **through the per-skill lifecycle first**,
and the manifest follows:

1. **Bump the pin**: `aih skill vet <source> --pin <new-sha> --apply` — fresh evidence at the
   new commit.
2. **Re-approve**: `aih skill approve <source> --pin <new-sha> --owner <team> --apply` — the
   lock entry now carries the new commit; the manifest ref is now a `pack.pin-mismatch`.
3. **Re-derive the ref**: `aih pack remove-entry --pack <pack> --skill <name> --apply` then
   `aih pack add --pack <pack> --skill <name> --apply` (add copies `{source, commit}` from the
   fresh lock entry).
4. **Status green**: `aih pack status --pack <pack>` shows `ready`; `aih pack validate` passes.
5. **Install**: `aih pack install --pack <pack> --apply` — the drifted/stale member is routed
   back through the gated pipeline and re-promoted at the new pin.

Never edit the manifest's `commit` by hand to "update" a skill: the lock still carries the old
pin, so the edit only manufactures a `pack.pin-mismatch` (fail-closed by design).
