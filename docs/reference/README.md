# Reference captures

Captured artifacts kept under version control so their contents can be reviewed
and their history followed. Nothing in this directory is loaded, executed, or
consumed by the product or its tests — these are records, not configuration.

## `claude-hook-settings.snapshot.json`

A verbatim copy of one maintainer workstation's project-scoped Claude hook
configuration, captured 2026-08-06 from `.claude/settings.json` in this
checkout. It records 22 hook entries across 7 events, registered by a
third-party runtime (ECC) rather than by this project.

It is kept because it is the concrete example the hook-registrar work is
measured against: several independent writers registering entries into one
client configuration file, where the file itself carries no record of which
writer owns which entry.

Reading it, note that:

- The paths in its `env` block and several of its commands are absolute and
  specific to the machine it was captured on. It will not work if copied into
  another checkout, and it is not intended to be copied.
- The launcher strings belong to the third-party runtime that wrote them. They
  are reproduced unchanged, and this project neither interprets nor runs them.
- It is a point-in-time capture, not a supported format or a template. The live
  file it came from is untracked, as `.gitignore` requires for client
  configuration in this worktree.
