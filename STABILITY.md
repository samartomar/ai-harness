# Stability

`aih` 1.0 is a compatibility commitment: a consumer pinning `@aihq/harness@^1` can
script against the surfaces below and take every minor and patch without breakage.
The contract is not prose — every covered surface is pinned by a committed test in
[tests/contract/](tests/contract/), and any drift fails CI (see
[Enforcement](#enforcement)). This document claims only what those tests enforce.

## Covered surface

- **CLI command surface** — every command and subcommand name, positional argument
  (name, required, order), and flag (plus its string/boolean default), and any
  deprecated alias still in its grace window. The committed snapshot
  [tests/contract/command-surface.json](tests/contract/command-surface.json) **is**
  the surface — what is not in that file is not covered. (The fixture walks the core
  CLI; commands added by the optional `@aihq/enterprise` plugin are versioned by the
  plugin, not this contract.)
- **`--json` envelope** — the success envelope always carries `capability`,
  `applied`, `writes`, `docs`, `probes`, `execs`, `digests`, `backups`, `removed`;
  `report` (`ok`, `counts.{pass,fail,skip}`, `checks`) appears when verification
  ran, and `support` when the report has checks. The error envelope is
  `{ error: { code, message } }`. Consumers must tolerate unknown keys — additive
  keys are minor-safe by design. Pinned by
  [tests/contract/envelope-schema.ts](tests/contract/envelope-schema.ts) +
  [json-envelope.test.ts](tests/contract/json-envelope.test.ts).
- **Exit codes** — `0`: success — plan computed, apply committed, and every
  verification check passed or was skipped (a skip never fails a run, so
  tool-absent probes cannot break CI). `1`: a failing verification check, a failed
  non-`allowFailure` exec under `--apply`, or a refusal/crash. There are no other
  exit codes on this path. Pinned by
  [tests/contract/exit-codes.test.ts](tests/contract/exit-codes.test.ts).
- **SARIF** — `--sarif` output validates against the official SARIF 2.1.0 schema
  (vendored, offline) in
  [tests/internals/sarif-schema.test.ts](tests/internals/sarif-schema.test.ts).
- **Owned on-disk layouts** — the layouts aih writes and re-reads: the committed
  control files `.aih-config.json`, `aih-skills.lock.json`, `aih-packs.json`,
  `aih-capabilities.json`; the `.aih/` output dir (`runs/` ledger, `legacy/` and
  `quarantine/` archives, fleet/evidence/marketplace bundle outputs); the
  derived machine cache `~/.aih/capabilities/cache.json`; and the marketplace
  artifact + evidence-bundle manifests. The structured families carry
  `schemaVersion: 1` — changing one incompatibly means bumping that version,
  which is a major.

Not covered: human-oriented text — summaries, help prose, warning wording, the
report dashboard HTML. Parse `--json`, not text.

## What each bump may change

| Bump | May change |
|---|---|
| **PATCH** | Fixes within the contract. No surface change. |
| **MINOR** | Additive only: new commands/subcommands/flags/positionals, new `--json` keys, new checks and artifacts — and renames that ship WITH their deprecated alias (both names keep working). The fixture is regenerated in the same PR. |
| **MAJOR** | Removing or renaming anything pinned above without its alias; removing a deprecated alias; an incompatible `--json`/SARIF/exit-code change; an incompatible owned-layout change (a `schemaVersion` bump). |

## Deprecation: alias before removal

A command rename never breaks a pinned consumer outright. The renamed command
declares its old name in `deprecatedAliases`
([src/internals/plan.ts](src/internals/plan.ts)): the old name keeps dispatching
the same action with the same flags, prints one stderr line —
`aih: <old> is deprecated — use <new> (removal comes with the next major)` — and
appears in the contract fixture as an alias, so dropping it early is a visible
fixture diff, not a silent break. The alias lives for at least one minor release;
only the next major removes it. Announce/grace/remove lifecycle:
[VERSIONING.md](VERSIONING.md#deprecation-policy). Plugin commands cannot carry
aliases — the registry strips the field, and a built-in's old name stays reserved
against plugin names for its whole grace window.

## Security backports (N-1)

From 1.0, a security fix lands on both the latest minor and the previous minor of
the current major. The support-window policy lives in
[VERSIONING.md](VERSIONING.md#supported-versions); reporting is in
[SECURITY.md](SECURITY.md).

## Enforcement

[tests/contract/](tests/contract/) runs in CI on every push and PR: any surface
diff fails the build. Updating the fixture is a reviewed contract decision — an
additive change regenerates it in the same PR
(`AIH_REGEN_CONTRACT=1 npx vitest run tests/contract/command-surface.test.ts`) and
labels the PR `contract:additive`; a removal or rename waits for a major. The
envelope schemas are deliberately non-strict, so an additive key can never fail a
pinned consumer that follows the tolerate-unknown-keys rule.
