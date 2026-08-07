# Reference captures

Captured artifacts kept under version control so their contents can be reviewed
and their history followed. Nothing in this directory is loaded or executed by
the product — these are records, not configuration. A capture may be read as
read-only INPUT by a test that needs a real-world shape, and one is
(see below); nothing here is ever written back to.

## `claude-hook-settings.snapshot.json`

A verbatim copy of one maintainer workstation's project-scoped Claude hook
configuration, captured 2026-08-06 from `.claude/settings.json` in this
checkout. It records 22 hook entries across 7 events, registered by a
third-party runtime (ECC) rather than by this project.

It is kept because it is the concrete example the hook-registrar work is
measured against: several independent writers registering entries into one
client configuration file, where the file itself carries no record of which
writer owns which entry.

`tests/org-policy/hook-registrar-reference-capture.test.ts` reads it as
read-only input, copies it into a temporary fixture root, and runs the
registrar's whole journey against that copy — report, adopt, re-project,
revoke. It is used there because every shape in it (a `matcher` on every group,
`description`, `id`, per-hook `async` and `timeout`) is a shape a hand-written
fixture would not have thought to include, and a projector that cannot carry
them cannot touch a real client configuration at all.

Reading it, note that:

- The paths in its `env` block and several of its commands are absolute and
  specific to the machine it was captured on. It will not work if copied into
  another checkout, and it is not intended to be copied.
- The launcher strings belong to the third-party runtime that wrote them. They
  are reproduced unchanged, and this project neither interprets nor runs them.
- It is a point-in-time capture, not a supported format or a template. The live
  file it came from is untracked, as `.gitignore` requires for client
  configuration in this worktree.
