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

At release time the bump is not chosen by hand: each **merged PR** carries exactly one
`semver:patch|minor|major` label (authoritative — issue-level labels are advisory
planning hints, and issueless PRs such as dependency or docs updates are labeled
directly), and the release cut takes the highest class among the PRs merged since the
previous tag. When labeling, apply the surface definition above — a change to verdicts,
exit codes, or generated-artifact content is a surface change (**MINOR** at least),
even when the commit is typed `fix:`. The `semver-label` check enforces exactly one
class per PR before merge; Dependabot PRs are labeled `semver:patch` automatically and
re-labeled by hand when a bump changes our surface.

The cut also declares an intent class with
`npm run release:preflight -- --intent <patch|minor|major>`. Computation remains authoritative:
when the highest merged-PR class exceeds intent, preflight emits the full manifest and fails before
the release PR opens. Proceeding requires an explicit acknowledgement bound to that manifest's full
candidate SHA; it records the scope decision and never lowers or overrides the computed version.

### Pre-1.0 (0.x)

While the major version is `0`, the surface is still settling. A **minor** bump
(`0.2 → 0.3`) may include a breaking change; any such change is called out in the
[CHANGELOG](CHANGELOG.md) under **Changed** and labeled `breaking-change` on the issue.
A **patch** (`0.2.0 → 0.2.1`) never breaks.

### The path to 1.0

`1.0.0` marks a stability commitment. It ships when:

- the CLI surface and generated-artifact shape are stable enough to pin against —
  the enforced contract (surfaces, tests, what each bump may change) is
  [STABILITY.md](STABILITY.md);
- a maintenance-release lane exists, if N-1 support is committed at that point (see below);
- the deprecation policy below is in force.

## Supported versions

| Phase | Supported |
|---|---|
| **All phases (current policy)** | Only the **latest minor** receives fixes. Upgrade to the latest release line to get security and bug fixes. |

Support is latest-minor-only: security and bug fixes land on the latest minor, and the
fix path is upgrading to it. An N-1 backport commitment requires a maintenance-release
lane (releases cut from the previous tag's line) that does not exist yet; if that lane
is built, this policy will be re-amended **first** — the promise follows the mechanism,
never the other way around. Security reporting is in [SECURITY.md](SECURITY.md).

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
removing major (mechanics in [STABILITY.md](STABILITY.md#deprecation-alias-before-removal)).

## Node.js support

`aih` supports the Node.js versions in `package.json` `engines` (currently `>=20`).
Dropping a Node major is a breaking change and follows the same announce → grace → remove
path.
