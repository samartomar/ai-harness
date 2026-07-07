# Enterprise extension point

> Status: shipped reserved seam. The open-source CLI is complete without this
> package; `@aihq/enterprise` is an optional peer package name reserved for a
> private command pack.

`@aihq/enterprise` contributes exactly one kind of capability when detected:
additional top-level `CommandSpec` entries exported as `aihCommands`. Those
commands register through the same path as built-ins, so they inherit shared
flags, posture resolution, JSON output, the run ledger, verification behavior,
and the dirty-worktree preflight. The reserved package does not patch built-in
commands, replace policy logic, or load arbitrary runtime hooks.

## Capability contract

An installed package may export:

```ts
export const aihCommands: CommandSpec[];
```

Each command is additive and must satisfy the public `CommandSpec` shape. The
allowed contribution is a private command surface for enterprise-only workflows
such as managed-policy checks, internal evidence collectors, fleet reporting,
private support-ticket formatting, or organization-specific attestation gates.
Those commands may use the normal action model (`doc`, `digest`, `probe`, and
operator-gated `exec` actions) because installation of the package is the trust
decision. They do not receive a separate sandbox.

The open-source CLI keeps these constraints around every contributed command:

- Built-ins, parent groups, `help`, `version`, and built-in aliases always win.
- Plugin aliases and deprecated aliases are dropped; aliases are core-owned.
- `skipWorktreeGate` is dropped; plugin commands cannot bypass the worktree
  mutation preflight.
- Shared and reserved flags such as `--apply`, `--json`, `--posture`,
  `--help`, and `--version` cannot be redefined by plugin options.
- Invalid, colliding, or duplicate specs are skipped while valid sibling specs
  continue to register.

## Probe contract

The startup probe is intentionally narrow:

- The specifier is always the literal `@aihq/enterprise`; no env var, flag, repo
  config, or org policy can redirect it to another package.
- Before import, the package must resolve under the install tree that loaded
  `aih` (the `node_modules` chain above the running harness package). A planted
  `node_modules/@aihq/enterprise` in the target repo is refused when `aih` was
  launched globally or through `npx`.
- `AIH_NO_PLUGINS=1` skips the probe without resolving or importing anything.
- `aih --version` and `aih -V` take the zero-plugin fast path.
- The import has a startup budget. A slow, malformed, or failing package
  degrades to local-only behavior with one sanitized warning.

## Local-only fallback

Not installed is the normal community/OSS case and is silent: command output,
help text, and behavior stay local-only except that `--help` can list enterprise
commands when a valid package is present. If resolution fails for any reason
other than "package absent," the package resolves outside the allowed install
tree, the import times out, the export has the wrong shape, or every command is
invalid, `aih` continues with the built-in command set and emits at most a
one-line `aih: plugin:` warning.

This fallback is availability-oriented, not a security sandbox. If an operator
installs `@aihq/enterprise`, its module code runs during import like any other
installed dependency. The registry gate protects the core command surface from
shadowing and malformed specs after that trust decision.
