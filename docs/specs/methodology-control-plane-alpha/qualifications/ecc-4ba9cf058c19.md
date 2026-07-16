# ECC Q7 real-inert qualification

> Status: `QUALIFICATION_BLOCKED` at `plannable`. This is a Phase A source-data
> result, not authorization to install, activate, switch, or research mutation.

## Exact selected source

| Field | Value |
| --- | --- |
| Local root | `C:/Users/samar/Documents/Codex/2026-07-15/do-not-weaken-trust-rules-and/work/baseline-inputs/ECC` |
| Git remote identity | `samartomar/ECC` (`https://github.com/samartomar/ECC.git`) |
| Resolved commit | `4ba9cf058c19ff97a64f41df4844b479b3ec5f8c` |
| Source tree SHA-256 | `f4cff2e74badb2711808b6b6e52db9113286d534927baa778305ed694329ad81` |
| Canonical repository expected by the adapter | `affaan-m/ECC` |
| Canonical source match | no |

The checkout was clean before and after qualification. Its `package.json` declares
the upstream `affaan-m/ECC` repository, but package metadata is not a substitute for
the selected Git remote identity. This result therefore names the selected fork and
adds `PROVIDER_REPOSITORY_NONCANONICAL`; it does not relabel the fork as canonical.

## Inert discovery

The adapter read only the exact source tree, `package.json`, and fixed source paths.
It called `git -C <source-root> rev-parse --verify HEAD` before and after hashing the
tree. It did not import, spawn, preview, dry-run, install, repair, update, uninstall,
or otherwise execute ECC code.

| Field | Value |
| --- | --- |
| Provider kind | `hybrid-catalog-runtime` |
| Installer-contract fingerprint | `88dfda8e04898d6961ed0bdbc4ae7f58df6c4e43827668bedda349bb7ff5b1e8` |
| Inert proposed-plan digest | `e9f3f128c948f8ba6107969fed1fd9114063ed93c304d7721138780dcc35ad0b` |
| Provider code executed | no |
| Write, process, service, network, updater, runtime, uninstall impacts | all `unknown` |

The observed source topology contains `.agents`, `.codex`, `agents`, `commands`,
`hooks`, `mcp-configs`, `rules`, and `skills`. Static installer-related entries are
`install.ps1`, `install.sh`, `scripts/install-apply.js`, `scripts/install-plan.js`,
and `scripts/uninstall.js`; static update and repair entries are
`scripts/auto-update.js` and `scripts/repair.js`. These are source facts only. Their
presence does not prove an enabled updater, a destination, an installer contract, or
runtime behavior.

Declared source requirements are Node `>=18` and the pinned Yarn package-manager
string in the selected manifest. All proposed project-native, profile-home, and
machine-exclusive destinations remain `unknown`.

## Exact compatibility outcome

The evaluated tuple used Codex `0.144.1`, build `cbacbb97`, host-contract version
`codex-0.144.1-windows-x64-v1` with `partial` coverage, Windows `10.0.26200` x64,
Node `24.13.1`, npm `11.8.0`, profile-home isolation, and policy
`enterprise-core-v1`. The adapter implementation hash was
`3e53ebfdd837fb7aee460a1235c3d733f6662586ed48a7c1c9e66901b5b3935d` for this
evaluation.

No reviewed compatibility row matches that exact tuple. The result is:

```text
classification: QUALIFICATION_BLOCKED
support level: plannable
findings:
  - ADAPTER_COMPATIBILITY_UNKNOWN
  - PROVIDER_REPOSITORY_NONCANONICAL
mutation research eligible: no
provider code executed: no
```

No existing methodology evidence joined. The legacy AIH baseline lock names
`samartomar/ECC` at `16563d4a30f17d097cc4629f6d97e02adf823016`, whereas the selected
source is `4ba9cf058c19ff97a64f41df4844b479b3ec5f8c`; it also stores component-level
baseline evidence rather than this exact whole-source methodology tuple. It cannot
be inherited by this result.

## Stop condition

Do not add this tuple to the supported compatibility set, infer that the selected
fork is the canonical source, or begin Phase B. Q1's host contract remains partial,
and this checkout has no exact compatibility or isolation evidence. A later retry
requires a separately reviewed exact source identity, adapter tuple, and host
contract; provider execution remains out of scope until a separate Phase B
authorization.
