# Versioning & support policy

`aih` follows [Semantic Versioning 2.0.0](https://semver.org/spec/v2.0.0.html). The
version is the contract between the CLI and the repos and workstations it manages.

## What a version means

`MAJOR.MINOR.PATCH`, where the public surface is:

- the **CLI** — command names, flags, and their documented behavior;
- the **generated artifacts** — the canon, adapters, bootloaders, and config files a
  command writes;
- the **machine-readable output** — `--json`, `--sarif`, and exit codes.

| Bump | Means |
|---|---|
| **PATCH** | Bug or security fix. No surface change. |
| **MINOR** | New commands, flags, or artifacts. Backward compatible for existing use. |
| **MAJOR** | A change that can break an existing invocation, script, or generated file. |

The new `@aihq/core` package line starts at `0.1.0` and uses `v-core-X.Y.Z`
GitHub tags. That one-time bootstrap version is explicit because the frozen
npm-deprecated `@aihq/harness` line ended at `6.1.0`; use `@aihq/core` for
current AIH. The lower Core version is not a downgrade or a continuation of the
legacy package's SemVer sequence.

After `v-core-0.1.0`, the bump is not chosen by hand: each **merged PR** carries exactly one
`semver:none|patch|minor|major` label (authoritative — issue-level labels are advisory
planning hints, and issueless PRs such as dependency or docs updates are labeled
directly), and the release cut takes the highest class among the PRs merged since the
previous tag. `semver:none` means the merge changes only repository documentation,
tests, CI, or maintainer tooling and does not require new public package bytes. It rides
the open train but cannot start or bump a package cut; a train containing only
`semver:none` changes is not releasable. When labeling, apply the surface definition above — a change to verdicts,
exit codes, or generated-artifact content is a surface change (**MINOR** at least),
even when the commit is typed `fix:`. The `semver-label` check enforces exactly one
class per PR before merge. Runtime dependency updates default to `semver:patch`; CI-only
dependency updates default to `semver:none`; either is re-labeled when the actual public
surface requires another class.

The cut also declares an intent class with
`npm run release:preflight -- --intent <patch|minor|major>`. Computation remains authoritative:
when the highest merged-PR class exceeds intent, preflight emits the full manifest and fails before
the release PR opens. Proceeding requires the exact acknowledgement token emitted by the manifest;
it binds candidate SHA, declared intent, and computed bump, records the scope decision, and never
lowers or overrides the computed version. The first Core cut sweeps changes since
the final legacy tag but records `0.1.0` as the new package-line bootstrap; later
cuts compute from the preceding `v-core-*` tag.

### Pre-1.0 (0.x)

While the major version is `0`, the surface is still settling. A **minor** bump
(`0.2 → 0.3`) may include a breaking change; any such change is called out in the
[CHANGELOG](CHANGELOG.md) under **Changed** and labeled `breaking-change` on the issue.
A **patch** (`0.2.0 → 0.2.1`) never breaks.

### The path to 1.0

`1.0.0` marks a stability commitment. It ships when:

- the CLI surface and generated-artifact shape are stable enough to pin against —
  the enforced contract (surfaces, tests, what each bump may change) is
  [STABILITY.md](https://github.com/samartomar/ai-harness/blob/main/STABILITY.md);
- a maintenance-release lane exists, if N-1 support is committed at that point (see below);
- the deprecation policy below is in force.

## Release train and promotion

Merging, cutting, publishing, and promoting are separate effects. Related changes
accumulate in one coherent train. A release PR assigns one version to that train; the
protected tag workflow publishes the immutable candidate under npm `next` and marks the
GitHub Release as a prerelease. It never changes `latest`. Public installed acceptance
must exercise those exact registry bytes with the compatible Scanner and Catalog
baseline. A separate owner authorization may then promote the same version—without a
rebuild or republish—to npm `latest` and stable GitHub Release status.

An ordinary defect discovered during candidate acceptance joins the same open train when
the candidate has not been published. If immutable candidate bytes are already public,
the correction uses a new version but remains off `latest` until its own acceptance.
Immediate hotfix trains are reserved for security defects, installation blockers,
evidence corruption, data loss, or comparable material user harm. Documentation and CI
cleanup do not create a release on their own.

## Supported versions

| Phase | Supported |
|---|---|
| **All phases (current policy)** | The **promoted stable train** receives fixes. Candidate versions under `next` are evaluation builds, not an upgrade instruction. |

Security and bug fixes land on the promoted stable train. A release note states whether
adoption is no action, recommended, required by a date, or security urgent; a larger
version number by itself is not an upgrade instruction. An N-1 backport commitment requires a maintenance-release
lane (releases cut from the previous tag's line) that does not exist yet; if that lane
is built, this policy will be re-amended **first** — the promise follows the mechanism,
never the other way around. Security reporting is in
[SECURITY.md](https://github.com/samartomar/ai-harness/blob/main/SECURITY.md).

## Deprecation policy

We do not remove or repurpose a flag or behavior without warning.

1. **Announce** — the deprecation is noted in the release that introduces the replacement
   (CHANGELOG **Deprecated**), and the CLI prints a one-line notice when the deprecated
   path is used.
2. **Grace period** — the deprecated path keeps working for at least **one minor release**.
3. **Remove** — removal happens in the next eligible release (a **major** at/after 1.0; a
   **minor** while pre-1.0), documented under **Removed**.

For a command rename, steps 1–2 are built in: the old name ships as a deprecated
alias of the new command — same flags, same behavior, one stderr notice — until the
removing major (mechanics in
[STABILITY.md](https://github.com/samartomar/ai-harness/blob/main/STABILITY.md#deprecation-alias-before-removal)).

## Node.js support

`aih` supports the Node.js versions in `package.json` `engines` (currently `>=20`).
Dropping a Node major is a breaking change and follows the same announce → grace → remove
path.
