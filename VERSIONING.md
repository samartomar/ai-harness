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

### Pre-1.0 (0.x)

While the major version is `0`, the surface is still settling. A **minor** bump
(`0.2 → 0.3`) may include a breaking change; any such change is called out in the
[CHANGELOG](CHANGELOG.md) under **Changed** and labeled `breaking-change` on the issue.
A **patch** (`0.2.0 → 0.2.1`) never breaks.

### The path to 1.0

`1.0.0` marks a stability commitment. It ships when:

- the CLI surface and generated-artifact shape are stable enough to pin against;
- N-1 security backports begin (see below);
- the deprecation policy below is in force.

## Supported versions

| Phase | Supported |
|---|---|
| **Pre-1.0 (now)** | Only the **latest minor** receives fixes. Upgrade to the latest `0.x` to get security and bug fixes. |
| **1.0 onward** | The **latest minor** plus the **previous minor** (N-1) receive security backports. |

Security reporting is in [SECURITY.md](SECURITY.md). Fixes ship as a patch on the
supported line(s).

## Deprecation policy

We do not remove or repurpose a flag or behavior without warning.

1. **Announce** — the deprecation is noted in the release that introduces the replacement
   (CHANGELOG **Deprecated**), and the CLI prints a one-line notice when the deprecated
   path is used.
2. **Grace period** — the deprecated path keeps working for at least **one minor release**.
3. **Remove** — removal happens in the next eligible release (a **major** at/after 1.0; a
   **minor** while pre-1.0), documented under **Removed**.

## Node.js support

`aih` supports the Node.js versions in `package.json` `engines` (currently `>=20`).
Dropping a Node major is a breaking change and follows the same announce → grace → remove
path.
